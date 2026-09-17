import crypto from "node:crypto";

export function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalizeWasenderSender(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  if (raw.endsWith("@g.us")) return raw;
  return raw
    .replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, "")
    .replace(/^\+/, "")
    .replace(/[^0-9]/g, "");
}

export function parseWasenderInbound(payload) {
  if (!payload || typeof payload !== "object") return null;
  const event = String(payload.event || "").toLowerCase();
  if (
    ![
      "messages.received",
      "messages-personal.received",
      "messages-group.received",
      "message.received",
      "personal.message.received",
    ].includes(event)
  ) {
    return null;
  }

  const data = payload.data || {};
  const message = data.messages || data.message || data;
  const key = message.key || data.key || {};
  if (key.fromMe === true || message.fromMe === true || data.fromMe === true) return null;

  const rawMessage = message.message || data.message?.message || {};
  const audio = rawMessage.audioMessage || message.audioMessage || data.audioMessage || null;

  const text = String(
    message.messageBody ||
      message.text ||
      message.body ||
      message.message?.conversation ||
      data.messageBody ||
      data.text ||
      data.body ||
      payload.text ||
      payload.body ||
      "",
  ).trim();
  if (!text && !audio) return null;

  const rawSender =
    key.cleanedSenderPn ||
    message.cleanedSenderPn ||
    data.cleanedSenderPn ||
    key.senderPn ||
    message.senderPn ||
    data.senderPn ||
    key.remoteJid ||
    message.from ||
    data.from ||
    payload.from ||
    "";
  const sender = normalizeWasenderSender(rawSender);
  if (!sender) return null;

  const participant = normalizeWasenderSender(
    key.cleanedParticipantPn ||
      message.cleanedParticipantPn ||
      data.cleanedParticipantPn ||
      key.participantPn ||
      message.participantPn ||
      data.participantPn ||
      key.participant ||
      message.participant ||
      data.participant ||
      "",
  );

  const id = String(key.id || message.id || data.id || payload.id || "").trim();
  const inbound = {
    id,
    sender,
    text: text || "[Səsli mesaj]",
    isGroup: sender.endsWith("@g.us"),
  };
  if (participant) inbound.participant = participant;
  if (audio) inbound.audio = audio;
  return inbound;
}

export function extractAgentText(output) {
  if (typeof output !== "string" || !output.trim()) return "";
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) return "";
    try {
      parsed = JSON.parse(output.slice(start, end + 1));
    } catch {
      return "";
    }
  }

  const payloads = parsed?.result?.payloads;
  if (!Array.isArray(payloads)) return "";
  return payloads
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function chunkText(text, maxLength = 3800) {
  const chunks = [];
  let remaining = String(text || "").trim();
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function makeApprovalCode(messageId) {
  const value = String(messageId || crypto.randomUUID());
  const suffix = crypto.createHash("sha256").update(value).digest("hex").slice(0, 6).toUpperCase();
  return `WA-${suffix}`;
}

export function parseApprovalInstruction(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  const codeMatch = input.match(/\bWA-[A-F0-9]{6}\b/i);
  const code = codeMatch ? codeMatch[0].toUpperCase() : "";
  const instruction = (codeMatch ? input.replace(codeMatch[0], "") : input).trim();
  const normalized = instruction.toLocaleLowerCase("az-AZ");

  const customMatch = instruction.match(/^(?:yaz|de|cavab)\s*:\s*([\s\S]+)$/i);
  if (customMatch?.[1]?.trim()) {
    return { code, action: "custom-reply", text: customMatch[1].trim() };
  }
  if (/^(?:cavab|cavabla|cavab yaz|göndər|gonder|reply|send)$/.test(normalized)) {
    return { code, action: "reply", text: "" };
  }
  if (/^(?:task|task aç|task ac|tapşırıq aç|tapsiriq ac)$/.test(normalized)) {
    return { code, action: "task", text: "" };
  }
  if (/^(?:keç|kec|ötür|otur|ignore|sil)$/.test(normalized)) {
    return { code, action: "skip", text: "" };
  }
  return { code, action: "instruction", text: instruction };
}
