import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

import {
  chunkText,
  extractAgentText,
  makeApprovalCode,
  normalizeWasenderSender,
  parseApprovalInstruction,
  parseWasenderInbound,
  safeEqual,
} from "./wasender-bridge.js";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
  // Avoid forwarding legacy variables into OpenClaw subprocesses.
  // OpenClaw logs a warning when deprecated CLAWDBOT_* variables are present.
  delete process.env[oldKey];
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Optional WAsender bridge. It stays disabled until all three secrets/access
// controls below are configured in Railway Variables.
const WASENDER_API_KEY = process.env.WASENDER_API_KEY?.trim();
const WASENDER_WEBHOOK_SECRET = process.env.WASENDER_WEBHOOK_SECRET?.trim();
const WASENDER_AGENT_ID = process.env.WASENDER_AGENT_ID?.trim() || "cavad-aem-ba";
const WASENDER_PROVIDER = process.env.WASENDER_PROVIDER?.trim().toLowerCase() || "wasenderapi";
const WASENDER_ALLOW_GROUPS = process.env.WASENDER_ALLOW_GROUPS === "true";
const WASENDER_GROUP_AGENT_ROUTES = parseGroupAgentRoutes(process.env.WASENDER_GROUP_AGENT_ROUTES);
const WASENDER_PROJECT_FLOWS = parseProjectFlows(process.env.WASENDER_PROJECT_FLOWS);
const WASENDER_ADMIN_NUMBER = normalizeWasenderSender(process.env.WASENDER_ADMIN_NUMBER || "");
const WASENDER_ALLOWED_SENDERS = new Set(
  (process.env.WASENDER_ALLOWED_SENDERS || "")
    .split(",")
    .map(normalizeWasenderSender)
    .filter(Boolean),
);
const WASENDER_API_URL =
  process.env.WASENDER_API_URL?.trim() ||
  (WASENDER_PROVIDER === "wasender-dev"
    ? "https://api.wasender.dev/messages/text"
    : "https://www.wasenderapi.com/api/send-message");

const AYES_TASK_URL = (process.env.AYES_TASK_URL?.trim() || "https://task.ayesbook.com").replace(/\/$/, "");
const AYES_TASK_EMAIL = process.env.AYES_TASK_EMAIL?.trim();
const AYES_TASK_PASSWORD = process.env.AYES_TASK_PASSWORD;
const AYES_TASK_PROJECT_ID = process.env.AYES_TASK_PROJECT_ID?.trim();
const AYES_TASK_TYPE_ID = process.env.AYES_TASK_TYPE_ID?.trim();
const AYES_TASK_EXECUTOR_IDS = splitIds(process.env.AYES_TASK_EXECUTOR_IDS);
const AYES_TASK_REVIEWER_IDS = splitIds(process.env.AYES_TASK_REVIEWER_IDS);
const AYES_TASK_APPROVER_IDS = splitIds(process.env.AYES_TASK_APPROVER_IDS);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";

function splitIds(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseGroupAgentRoutes(value) {
  if (!value?.trim()) return new Map();
  try {
    const parsed = JSON.parse(value);
    return new Map(
      Object.entries(parsed)
        .map(([groupJid, agentId]) => [normalizeWasenderSender(groupJid), String(agentId || "").trim()])
        .filter(([groupJid, agentId]) => groupJid.endsWith("@g.us") && agentId),
    );
  } catch {
    console.warn("[wasender] WASENDER_GROUP_AGENT_ROUTES must be a JSON object");
    return new Map();
  }
}

function normalizeGroupName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("az-AZ");
}

function parseProjectFlows(value) {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("expected an array");
    return parsed
      .map((flow) => ({
        name: String(flow?.name || "Layihə").trim(),
        agentId: String(flow?.agentId || "").trim(),
        intakeGroupJid: normalizeWasenderSender(flow?.intakeGroupJid || ""),
        intakeGroupName: String(flow?.intakeGroupName || "").trim(),
        approvalGroupJid: normalizeWasenderSender(flow?.approvalGroupJid || ""),
      }))
      .filter(
        (flow) =>
          flow.agentId &&
          flow.approvalGroupJid.endsWith("@g.us") &&
          (flow.intakeGroupJid.endsWith("@g.us") || flow.intakeGroupName),
      );
  } catch {
    console.warn("[wasender] WASENDER_PROJECT_FLOWS must be a JSON array");
    return [];
  }
}

function ayesTaskConfigured() {
  return Boolean(
    AYES_TASK_EMAIL &&
      AYES_TASK_PASSWORD &&
      AYES_TASK_PROJECT_ID &&
      AYES_TASK_TYPE_ID &&
      AYES_TASK_EXECUTOR_IDS.length &&
      AYES_TASK_REVIEWER_IDS.length &&
      AYES_TASK_APPROVER_IDS.length,
  );
}

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to root.
      const paths = ["/openclaw", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

const wasenderSeenIds = new Set();
const wasenderSenderQueues = new Map();
const WASENDER_PENDING_PATH = path.join(STATE_DIR, "wasender-pending.json");
let wasenderPending = loadWasenderPending();

function loadWasenderPending() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WASENDER_PENDING_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveWasenderPending() {
  fs.mkdirSync(path.dirname(WASENDER_PENDING_PATH), { recursive: true });
  const entries = Object.entries(wasenderPending)
    .sort((a, b) => String(b[1]?.createdAt).localeCompare(String(a[1]?.createdAt)))
    .slice(0, 200);
  wasenderPending = Object.fromEntries(entries);
  const temporary = `${WASENDER_PENDING_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(wasenderPending, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, WASENDER_PENDING_PATH);
}

function wasenderSenderAllowed(sender) {
  return WASENDER_ALLOWED_SENDERS.has("*") || WASENDER_ALLOWED_SENDERS.has(sender);
}

function rememberWasenderMessage(id) {
  if (!id) return true;
  if (wasenderSeenIds.has(id)) return false;
  wasenderSeenIds.add(id);
  if (wasenderSeenIds.size > 2_000) {
    const oldest = wasenderSeenIds.values().next().value;
    wasenderSeenIds.delete(oldest);
  }
  return true;
}

async function sendWasenderText(to, text) {
  const recipient = /^\d+$/.test(to) ? `+${to}` : to;
  const payload =
    WASENDER_PROVIDER === "wasender-dev"
      ? { to: recipient, body: text }
      : { to: recipient, text };
  const response = await fetch(WASENDER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WASENDER_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`WAsender send failed (${response.status}): ${detail}`);
  }
}

const wasenderGroupNameCache = new Map();

async function getWasenderGroupName(groupJid) {
  if (wasenderGroupNameCache.has(groupJid)) return wasenderGroupNameCache.get(groupJid);

  const response = await fetch(
    `https://www.wasenderapi.com/api/groups/${encodeURIComponent(groupJid)}/metadata`,
    {
      headers: {
        Authorization: `Bearer ${WASENDER_API_KEY}`,
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WAsender group metadata failed (${response.status})`);
  const name = String(body.data?.subject || body.data?.name || body.subject || body.name || "").trim();
  if (name) wasenderGroupNameCache.set(groupJid, name);
  return name;
}

async function resolveProjectIntakeFlow(groupJid) {
  const direct = WASENDER_PROJECT_FLOWS.find((flow) => flow.intakeGroupJid === groupJid);
  if (direct) return direct;

  const namedFlows = WASENDER_PROJECT_FLOWS.filter((flow) => flow.intakeGroupName);
  if (!namedFlows.length) return null;
  const groupName = await getWasenderGroupName(groupJid);
  return (
    namedFlows.find(
      (flow) => normalizeGroupName(flow.intakeGroupName) === normalizeGroupName(groupName),
    ) || null
  );
}

function voiceFileExtension(mimetype) {
  const type = String(mimetype || "").toLowerCase();
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("wav")) return "wav";
  if (type.includes("webm")) return "webm";
  return "ogg";
}

async function transcribeWasenderVoice(inbound) {
  if (!inbound.audio) return inbound.text;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for voice transcription");

  const decrypted = await fetch("https://www.wasenderapi.com/api/decrypt-media", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WASENDER_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      data: {
        messages: {
          key: { id: inbound.id },
          message: { audioMessage: inbound.audio },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const decryptedBody = await decrypted.json().catch(() => ({}));
  if (!decrypted.ok || !decryptedBody.publicUrl) {
    throw new Error(`WAsender audio decrypt failed (${decrypted.status})`);
  }

  const audioResponse = await fetch(decryptedBody.publicUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!audioResponse.ok) throw new Error(`WAsender audio download failed (${audioResponse.status})`);
  const audioBytes = await audioResponse.arrayBuffer();
  if (audioBytes.byteLength === 0 || audioBytes.byteLength > 25 * 1024 * 1024) {
    throw new Error("Voice message is empty or exceeds 25 MiB");
  }

  const mimetype = String(inbound.audio.mimetype || "audio/ogg").split(";")[0];
  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBytes], { type: mimetype }),
    `voice-${inbound.id || Date.now()}.${voiceFileExtension(mimetype)}`,
  );
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("response_format", "json");

  const transcription = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const transcriptionBody = await transcription.json().catch(() => ({}));
  const text = String(transcriptionBody.text || "").trim();
  if (!transcription.ok || !text) {
    throw new Error(`OpenAI voice transcription failed (${transcription.status})`);
  }
  return text;
}

async function runWasenderAgent(sessionSender, message, agentId = WASENDER_AGENT_ID) {
  const safeSessionSender = sessionSender.replace(/[^a-zA-Z0-9_-]/g, "-");
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "agent",
      "--agent",
      agentId,
      "--session-key",
      `agent:${agentId}:wasender-${safeSessionSender}`,
      "--message",
      message,
      "--json",
      "--timeout",
      "300",
    ]),
    { timeoutMs: 330_000 },
  );
  if (result.code !== 0) {
    throw new Error(`OpenClaw agent failed (${result.code}): ${result.output.slice(-2_000)}`);
  }
  const answer = extractAgentText(result.output);
  if (!answer) throw new Error("OpenClaw agent returned no text reply");
  return answer;
}

async function sendWasenderLongText(to, text) {
  for (const message of chunkText(text)) await sendWasenderText(to, message);
}

function parseAgentJson(text) {
  const value = String(text || "").trim();
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function ayesTaskRequest(pathname, options = {}) {
  const response = await fetch(`${AYES_TASK_URL}/api/v1${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AYES Task request failed (${response.status}): ${body.message || "unknown error"}`);
  return body;
}

async function createAyesTask(draft) {
  const login = await ayesTaskRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: AYES_TASK_EMAIL, password: AYES_TASK_PASSWORD }),
  });
  if (!login.accessToken) throw new Error("AYES Task login returned no access token");

  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  deadline.setMinutes(0, 0, 0);
  return ayesTaskRequest("/tasks", {
    method: "POST",
    token: login.accessToken,
    body: JSON.stringify({
      title: String(draft.title || "WhatsApp-dan daxil olan məsələ").slice(0, 250),
      description: String(draft.description || ""),
      link: "",
      projectId: AYES_TASK_PROJECT_ID,
      taskTypeId: AYES_TASK_TYPE_ID,
      category: ["NEW_FEATURE", "DEVELOPMENT", "BUG"].includes(draft.category)
        ? draft.category
        : "BUG",
      priority: ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(draft.priority)
        ? draft.priority
        : "MEDIUM",
      deadline: deadline.toISOString(),
      estimatedMinutes: Number.isFinite(draft.estimatedMinutes) ? draft.estimatedMinutes : 0,
      executorIds: AYES_TASK_EXECUTOR_IDS,
      reviewerIds: AYES_TASK_REVIEWER_IDS,
      approverIds: AYES_TASK_APPROVER_IDS,
      attachments: [],
    }),
  });
}

function latestPendingApproval(code = "", approvalTarget = "") {
  if (code) {
    const entry = wasenderPending[code] || null;
    return entry && (!approvalTarget || entry.approvalTarget === approvalTarget) ? entry : null;
  }
  return (
    Object.values(wasenderPending)
      .filter(
        (entry) =>
          entry.status === "pending" &&
          (!approvalTarget || entry.approvalTarget === approvalTarget),
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null
  );
}

function approvalNotice(entry) {
  const source = entry.isGroup
    ? `Müştəri qrupu: ${entry.sourceName || entry.sender}${entry.participant ? `\nYazan: +${entry.participant}` : ""}`
    : `Şəxsi mesaj: +${entry.sender}`;
  return [
    `📩 ${entry.code} — yeni ${entry.flowName || "AEM"} mesajı`,
    source,
    `\nMesaj:\n${entry.text}`,
    `\nCavadın sizə texniki izahı:\n${entry.analysis}`,
    "\nCavada adi dildə təlimat verə bilərsiniz. Məsələn:",
    '“Task aç və qrupa yaz ki, məsələni araşdırırıq.”',
    '“Müştəriyə de ki, bu gün yoxlayacağıq.”',
    '“Bu texniki problem niyə yaranıb?”',
    `Kodla qısa əmrlər: ${entry.code} CAVAB / TASK / YAZ: ... / KEÇ`,
  ].join("\n");
}

async function processOwnerInstruction(inbound) {
  const command = parseApprovalInstruction(inbound.text);
  if (!command) return;

  // Messages without an approval code or a known short command are ordinary
  // conversations with Cavad. Keep this in a separate owner session so the
  // owner can ask follow-up questions naturally without affecting customer chats.
  if (!command.code && command.action === "instruction") {
    const answer = await runWasenderAgent(
      `owner-${WASENDER_ADMIN_NUMBER}`,
      [
        "Bu mesaj AEM layihəsinin sahibindən birbaşa sənə gəlir.",
        "Cavad AEM biznes analitiki kimi normal söhbət et və suala cavab ver.",
        "Lazım olduqda layihə repolarını araşdır. Qarşı tərəfə mesaj göndərmə; yalnız sahibə cavab yaz.",
        `Sahibin mesajı: ${command.text}`,
      ].join("\n\n"),
    );
    await sendWasenderLongText(WASENDER_ADMIN_NUMBER, answer);
    return;
  }

  const entry = latestPendingApproval(command.code);
  if (!entry) {
    await sendWasenderText(WASENDER_ADMIN_NUMBER, "Gözləyən mesaj tapılmadı. Əmrdə WA-kodunu yoxlayın.");
    return;
  }

  if (command.action === "skip") {
    entry.status = "skipped";
    entry.decidedAt = new Date().toISOString();
    saveWasenderPending();
    await sendWasenderText(WASENDER_ADMIN_NUMBER, `${entry.code} keçildi.`);
    return;
  }

  if (command.action === "task") {
    const taskDraftText = await runWasenderAgent(
      entry.sender,
      [
        "Sahib bu WhatsApp məsələsi üçün task açılmasını istəyir.",
        "Yalnız etibarlı JSON qaytar. Markdown və əlavə mətn yazma.",
        'Format: {"title":"...","description":"...","category":"BUG|DEVELOPMENT|NEW_FEATURE","priority":"LOW|MEDIUM|HIGH|CRITICAL","estimatedMinutes":0}',
        "description daxilində faktiki nəticə, gözlənilən nəticə, təsirlənən hissə və qəbul meyarlarını yaz.",
        `Orijinal mesaj: ${entry.text}`,
        `Əvvəlki analiz: ${entry.analysis}`,
      ].join("\n\n"),
    );

    const taskDraft = parseAgentJson(taskDraftText) || {
      title: `WhatsApp məsələsi: ${entry.text.slice(0, 180)}`,
      description: `${entry.analysis}\n\nOrijinal mesaj:\n${entry.text}`,
      category: "BUG",
      priority: "MEDIUM",
      estimatedMinutes: 0,
    };

    if (ayesTaskConfigured()) {
      const createdTask = await createAyesTask(taskDraft);
      entry.status = "task-created";
      entry.decidedAt = new Date().toISOString();
      entry.task = { id: createdTask.id, number: createdTask.number, title: createdTask.title };
      saveWasenderPending();
      await sendWasenderText(
        WASENDER_ADMIN_NUMBER,
        `${entry.code} üçün ${createdTask.number || "task"} yaradıldı: ${createdTask.title || taskDraft.title}\n${AYES_TASK_URL}`,
      );
      return;
    }

    entry.status = "task-drafted";
    entry.decidedAt = new Date().toISOString();
    entry.taskDraft = taskDraft;
    saveWasenderPending();
    await sendWasenderLongText(
      WASENDER_ADMIN_NUMBER,
      `${entry.code} üçün task mətni hazırdır. İcraçı/yoxlayan/təsdiqləyən seçiləndən sonra avtomatik açılacaq:\n\n${taskDraft.title}\n\n${taskDraft.description}`,
    );
    return;
  }

  let finalReply;
  if (command.action === "custom-reply") {
    finalReply = command.text;
  } else {
    const ownerInstruction =
      command.action === "instruction" ? command.text : "Təklif etdiyin uyğun cavabı göndər.";
    finalReply = await runWasenderAgent(
      entry.sender,
      [
        "Aşağıdakı WhatsApp mesajına cavab vermək sahib tərəfindən təsdiqləndi.",
        "Yalnız qarşı tərəfə göndəriləcək yekun cavab mətnini yaz. Əlavə izah və başlıq yazma.",
        `Orijinal mesaj: ${entry.text}`,
        `Əvvəlki analiz: ${entry.analysis}`,
        `Sahibin göstərişi: ${ownerInstruction}`,
      ].join("\n\n"),
    );
  }

  await sendWasenderLongText(entry.sender, finalReply);
  entry.status = "replied";
  entry.decidedAt = new Date().toISOString();
  entry.finalReply = finalReply;
  saveWasenderPending();
  await sendWasenderText(WASENDER_ADMIN_NUMBER, `${entry.code} cavablandırıldı.`);
}

async function planProjectApproval(entry, instruction) {
  const parsed = parseApprovalInstruction(instruction);
  if (parsed?.action === "skip") return { action: "skip", replyInstruction: "" };
  if (parsed?.action === "task") {
    return {
      action: "task-and-reply",
      replyInstruction: "Məsələnin qeydə alındığını və üzərində işləyəcəyimizi nəzakətlə bildir.",
    };
  }
  if (parsed?.action === "reply") {
    return { action: "reply", replyInstruction: "Təklif etdiyin uyğun cavabı göndər." };
  }
  if (parsed?.action === "custom-reply") {
    return { action: "reply", replyInstruction: parsed.text };
  }

  const planText = await runWasenderAgent(
    entry.sender,
    [
      "Sahibin aşağıdakı təlimatını təhlükəsiz şəkildə icra planına çevir.",
      "Yalnız etibarlı JSON qaytar, markdown və əlavə mətn yazma.",
      'action yalnız bunlardan biri olsun: "discuss", "reply", "task", "task-and-reply", "skip".',
      'Format: {"action":"...","replyInstruction":"..."}',
      'Sahib texniki sual verirsə action="discuss" seç. Müştəriyə yazmağı istəyirsə "reply" seç.',
      'Task açmağı və müştəriyə məlumat verməyi istəyirsə "task-and-reply" seç.',
      `Müştəri mesajı: ${entry.text}`,
      `Texniki analiz: ${entry.analysis}`,
      `Sahibin təlimatı: ${parsed?.text || instruction}`,
    ].join("\n\n"),
    entry.agentId || WASENDER_AGENT_ID,
  );
  const plan = parseAgentJson(planText);
  const allowed = new Set(["discuss", "reply", "task", "task-and-reply", "skip"]);
  if (!allowed.has(plan?.action)) {
    return { action: "discuss", replyInstruction: parsed?.text || instruction };
  }
  return {
    action: plan.action,
    replyInstruction: String(plan.replyInstruction || parsed?.text || instruction).trim(),
  };
}

async function createProjectTask(entry) {
  if (!ayesTaskConfigured()) {
    throw new Error("AYES Task üçün icraçı, yoxlayan və təsdiqləyən təyin edilməyib");
  }
  const taskDraftText = await runWasenderAgent(
    entry.sender,
    [
      "Bu müştəri müraciətindən AYES Task üçün texniki task hazırla.",
      "Yalnız etibarlı JSON qaytar. Markdown və əlavə mətn yazma.",
      'Format: {"title":"...","description":"...","category":"BUG|DEVELOPMENT|NEW_FEATURE","priority":"LOW|MEDIUM|HIGH|CRITICAL","estimatedMinutes":0}',
      "description daxilində faktiki nəticə, gözlənilən nəticə, təsirlənən hissə və qəbul meyarlarını yaz.",
      `Orijinal müştəri mesajı: ${entry.text}`,
      `Cavadın texniki analizi: ${entry.analysis}`,
    ].join("\n\n"),
    entry.agentId || WASENDER_AGENT_ID,
  );
  const taskDraft = parseAgentJson(taskDraftText) || {
    title: `WhatsApp məsələsi: ${entry.text.slice(0, 180)}`,
    description: `${entry.analysis}\n\nOrijinal mesaj:\n${entry.text}`,
    category: "BUG",
    priority: "MEDIUM",
    estimatedMinutes: 0,
  };
  return createAyesTask(taskDraft);
}

async function makeCustomerReply(entry, instruction) {
  return runWasenderAgent(
    entry.sender,
    [
      "Aşağıdakı müştəri WhatsApp mesajına yekun cavab hazırla.",
      "Yalnız müştəriyə göndəriləcək cavabı yaz; başlıq, texniki analiz və daxili məlumat əlavə etmə.",
      "Cavab nəzakətli, müştəri yönümlü, aydın və qısa olsun.",
      "Təsdiqlənməyən vaxt və nəticə vəd etmə. Texniki terminləri yalnız müştəri üçün vacibdirsə işlət.",
      `Müştəri mesajı: ${entry.text}`,
      `Daxili texniki analiz: ${entry.analysis}`,
      `Sahibin göstərişi: ${instruction}`,
    ].join("\n\n"),
    entry.agentId || WASENDER_AGENT_ID,
  );
}

async function processProjectApprovalMessage(inbound, flow) {
  const parsed = parseApprovalInstruction(inbound.text);
  const entry = latestPendingApproval(parsed?.code || "", flow.approvalGroupJid);

  if (!entry) {
    const answer = await runWasenderAgent(
      `approval-${flow.approvalGroupJid}`,
      [
        `Bu mesaj ${flow.name} layihəsinin sahibindən daxili BA qrupunda gəlir.`,
        "Cavad biznes analitiki kimi normal söhbət et. Müştəri qrupuna heç nə göndərmə.",
        `Sahibin mesajı: ${inbound.text}`,
      ].join("\n\n"),
      flow.agentId,
    );
    await sendWasenderLongText(flow.approvalGroupJid, answer);
    return;
  }

  const plan = await planProjectApproval(entry, inbound.text);
  if (plan.action === "discuss") {
    const answer = await runWasenderAgent(
      entry.sender,
      [
        "Sahib müştəriyə cavab göndərmədən məsələ barədə daxili izah istəyir.",
        "Azərbaycan dilində texniki, aydın və praktik cavab ver.",
        `Müştəri mesajı: ${entry.text}`,
        `Əvvəlki analiz: ${entry.analysis}`,
        `Sahibin sualı: ${inbound.text}`,
      ].join("\n\n"),
      entry.agentId || flow.agentId,
    );
    await sendWasenderLongText(flow.approvalGroupJid, answer);
    return;
  }

  if (plan.action === "skip") {
    entry.status = "skipped";
    entry.decidedAt = new Date().toISOString();
    saveWasenderPending();
    await sendWasenderText(flow.approvalGroupJid, `${entry.code} keçildi. Müştəri qrupuna cavab göndərilmədi.`);
    return;
  }

  const results = [];
  if (plan.action === "task" || plan.action === "task-and-reply") {
    const createdTask = await createProjectTask(entry);
    entry.task = { id: createdTask.id, number: createdTask.number, title: createdTask.title };
    entry.status = "task-created";
    entry.decidedAt = new Date().toISOString();
    saveWasenderPending();
    results.push(`${createdTask.number || "Task"} yaradıldı: ${createdTask.title || "Müştəri müraciəti"}`);
  }

  if (plan.action === "reply" || plan.action === "task-and-reply") {
    const replyInstruction =
      plan.replyInstruction ||
      "Məsələnin qeydə alındığını və üzərində işləyəcəyimizi nəzakətlə bildir.";
    const customerReply = await makeCustomerReply(entry, replyInstruction);
    await sendWasenderLongText(entry.sender, customerReply);
    entry.finalReply = customerReply;
    entry.status = entry.task ? "task-created-and-replied" : "replied";
    entry.decidedAt = new Date().toISOString();
    saveWasenderPending();
    results.push("Müştəri qrupuna nəzakətli cavab göndərildi.");
  }

  await sendWasenderLongText(flow.approvalGroupJid, `✅ ${entry.code}\n${results.join("\n")}`);
}

async function processProjectIntakeMessage(inbound, flow) {
  const analysis = await runWasenderAgent(
    inbound.sender,
    [
      `Yeni mesaj ${flow.name} müştəri qrupundan gəlib.`,
      "AEM biznes analitiki kimi problemi anla və lazım olsa layihə repolarını araşdır.",
      "Hələ müştəriyə cavab vermə. Layihə sahibinə Azərbaycan dilində texniki və aydın hesabat hazırla.",
      "Bölmələr: Qısa məzmun, Ehtimal olunan səbəb, Kod/sistem tapıntısı, Tövsiyə, Task lazımdır (Bəli/Xeyr), Müştəriyə təklif olunan cavab.",
      `Yazan: ${inbound.participant ? `+${inbound.participant}` : "qrup iştirakçısı"}`,
      `Mesaj: ${inbound.text}`,
    ].join("\n\n"),
    flow.agentId,
  );
  const code = makeApprovalCode(inbound.id || `${inbound.sender}-${Date.now()}`);
  const entry = {
    code,
    sender: inbound.sender,
    participant: inbound.participant || "",
    isGroup: true,
    sourceName: flow.intakeGroupName || flow.name,
    flowName: flow.name,
    approvalTarget: flow.approvalGroupJid,
    agentId: flow.agentId,
    text: inbound.text,
    analysis,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  wasenderPending[code] = entry;
  saveWasenderPending();
  await sendWasenderLongText(flow.approvalGroupJid, approvalNotice(entry));
}

async function processWasenderMessage(inbound) {
  const agentMessage =
    `Yeni WhatsApp mesajını AEM biznes analitiki kimi araşdır. Lazım olsa kod repolarına bax. ` +
    `Hələ qarşı tərəfə cavab göndərmə. Azərbaycan dilində qısa şəkildə Xülasə, Tapıntı, ` +
    `Tövsiyə olunan cavab və Task lazımdır (Bəli/Xeyr) bölmələri ilə sahibə hesabat hazırla.\n\n` +
    (inbound.isGroup && inbound.participant
      ? `Qrup mesajı, yazan +${inbound.participant}:\n${inbound.text}`
      : `Şəxsi mesaj, yazan +${inbound.sender}:\n${inbound.text}`);
  const answer = await runWasenderAgent(inbound.sender, agentMessage);

  if (WASENDER_ADMIN_NUMBER) {
    const code = makeApprovalCode(inbound.id || `${inbound.sender}-${Date.now()}`);
    const entry = {
      code,
      sender: inbound.sender,
      participant: inbound.participant || "",
      isGroup: inbound.isGroup,
      text: inbound.text,
      analysis: answer,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    wasenderPending[code] = entry;
    saveWasenderPending();
    await sendWasenderLongText(WASENDER_ADMIN_NUMBER, approvalNotice(entry));
  } else {
    await sendWasenderLongText(inbound.sender, answer);
  }
}

async function processDirectGroupMessage(inbound, agentId) {
  const author = inbound.participant ? `+${inbound.participant}` : "qrup iştirakçısı";
  const answer = await runWasenderAgent(
    inbound.sender,
    [
      "Bu mesaj sənə aid xüsusi WhatsApp layihə qrupundan gəlir.",
      "Cavad AEM biznes analitiki kimi normal söhbət et və suala birbaşa cavab ver.",
      "Lazım olduqda AEM layihə repolarını araşdır. Cavabını Azərbaycan dilində, aydın və praktik yaz.",
      `Yazan: ${author}`,
      `Mesaj: ${inbound.text}`,
    ].join("\n\n"),
    agentId,
  );
  await sendWasenderLongText(inbound.sender, answer);
}

// WAsender expects a quick 200 response. Agent work continues in a per-sender
// queue, preserving conversation order and a separate OpenClaw session per user.
app.post("/hooks/wasender", (req, res) => {
  if (!WASENDER_API_KEY || !WASENDER_WEBHOOK_SECRET || WASENDER_ALLOWED_SENDERS.size === 0) {
    return res.status(503).json({ ok: false, error: "WAsender bridge is not configured" });
  }

  const signature = req.get("X-Webhook-Signature") || "";
  if (!safeEqual(signature, WASENDER_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
  }

  const inbound = parseWasenderInbound(req.body);
  if (!inbound) return res.json({ ok: true, ignored: true });
  const directGroupAgentId = inbound.isGroup
    ? WASENDER_GROUP_AGENT_ROUTES.get(inbound.sender) || ""
    : "";
  const approvalFlow = inbound.isGroup
    ? WASENDER_PROJECT_FLOWS.find((flow) => flow.approvalGroupJid === inbound.sender) || null
    : null;
  const isOwnerInstruction =
    Boolean(WASENDER_ADMIN_NUMBER) && !inbound.isGroup && inbound.sender === WASENDER_ADMIN_NUMBER;
  const isProjectOwnerInstruction = Boolean(
    approvalFlow &&
      WASENDER_ADMIN_NUMBER &&
      inbound.participant === WASENDER_ADMIN_NUMBER,
  );
  if (inbound.isGroup && !WASENDER_ALLOW_GROUPS) {
    return res.json({ ok: true, ignored: true, reason: "groups disabled" });
  }
  if (approvalFlow && !isProjectOwnerInstruction) {
    return res.json({ ok: true, ignored: true, reason: "approval sender not allowed" });
  }
  if (!isOwnerInstruction && !wasenderSenderAllowed(inbound.sender)) {
    return res.json({ ok: true, ignored: true, reason: "sender not allowed" });
  }
  if (!rememberWasenderMessage(inbound.id)) {
    return res.json({ ok: true, ignored: true, reason: "duplicate" });
  }

  res.json({ ok: true, accepted: true });

  const queueKey = isOwnerInstruction ? `owner-${WASENDER_ADMIN_NUMBER}` : inbound.sender;
  const previous = wasenderSenderQueues.get(queueKey) || Promise.resolve();
  let activeProjectFlow = approvalFlow;
  const current = previous
    .then(async () => {
      if (inbound.audio) inbound.text = await transcribeWasenderVoice(inbound);
      if (isOwnerInstruction) return processOwnerInstruction(inbound);
      if (approvalFlow) return processProjectApprovalMessage(inbound, approvalFlow);
      if (inbound.isGroup) {
        const intakeFlow = await resolveProjectIntakeFlow(inbound.sender);
        if (intakeFlow) {
          activeProjectFlow = intakeFlow;
          return processProjectIntakeMessage(inbound, intakeFlow);
        }
      }
      if (directGroupAgentId) return processDirectGroupMessage(inbound, directGroupAgentId);
      return processWasenderMessage(inbound);
    })
    .catch(async (err) => {
      console.error(`[wasender] ${inbound.sender}: ${String(err)}`);
      if (activeProjectFlow) {
        try {
          await sendWasenderText(
            activeProjectFlow.approvalGroupJid,
            `Əməliyyatı yerinə yetirmək alınmadı: ${String(err?.message || err).slice(0, 500)}`,
          );
        } catch (notifyError) {
          console.error(`[wasender] project flow error notification failed: ${String(notifyError)}`);
        }
        return;
      }
      if (inbound.audio && (directGroupAgentId || WASENDER_ADMIN_NUMBER)) {
        try {
          await sendWasenderText(
            directGroupAgentId ? inbound.sender : WASENDER_ADMIN_NUMBER,
            "Səsli mesajı mətnə çevirmək alınmadı. Zəhmət olmasa mətni yazılı göndərin.",
          );
        } catch (notifyError) {
          console.error(`[wasender] voice error notification failed: ${String(notifyError)}`);
        }
      }
    })
    .finally(() => {
      if (wasenderSenderQueues.get(queueKey) === current) {
        wasenderSenderQueues.delete(queueKey);
      }
    });
  wasenderSenderQueues.set(queueKey, current);
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Railway runs behind a reverse proxy. Trust loopback as a proxy hop so local client detection
    // remains correct when X-Forwarded-* headers are present.
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"]) ]),
    );

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

        // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
        const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${plug.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${fix.output || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  return respondJson(ok ? 200 : 500, {
    ok,
    output: `${prefix}${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

// --- Gateway token injection ---
// The gateway is only reachable from this container. The Control UI in the browser
// cannot set custom Authorization headers for WebSocket connections, so we inject
// the token into proxied requests at the wrapper level.
function attachGatewayAuthHeader(req) {
  if (!req?.headers?.authorization && OPENCLAW_GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }
}

proxy.on("proxyReqWs", (_proxyReq, req) => {
  attachGatewayAuthHeader(req);
});

// The Control UI uses the Gateway's own token authentication. Applying HTTP
// Basic auth here breaks browser navigation and the new-agent flow because
// those requests do not consistently retain Basic credentials. /setup stays
// protected by requireSetupAuth on its own routes.
app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Sync gateway tokens in config with the current env var on every startup.
  // This prevents "gateway token mismatch" when OPENCLAW_GATEWAY_TOKEN changes
  // (e.g. Railway variable update) but the config file still has the old value.
  if (isConfigured() && OPENCLAW_GATEWAY_TOKEN) {
    console.log("[wrapper] syncing gateway tokens in config...");
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] gateway tokens synced");
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway tokens: ${String(err)}`);
    }
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // Note: browsers cannot attach arbitrary HTTP headers (including Authorization: Basic)
  // in WebSocket handshakes. Do not enforce dashboard Basic auth at the upgrade layer.
  // The gateway authenticates at the protocol layer and we inject the gateway token below.

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }

  // Stop accepting new connections; allow in-flight requests to complete briefly.
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }

  setTimeout(() => process.exit(0), 5_000).unref?.();
});
