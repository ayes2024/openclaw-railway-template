const STATUS_DETAILS = {
  NEW: { label: "Yeni task", role: "creator", action: "taskı yaratdı" },
  IN_PROGRESS: { label: "İcraya götürüldü", role: "executor", action: "taskı icraya götürdü" },
  CODE_READY: { label: "Kod hazırdır", role: "executor", action: "kodu hazırladı" },
  INITIAL_QA: { label: "İlkin QA yoxlaması", role: "reviewer", action: "ilkin QA yoxlamasına başladı" },
  TEST_DEPLOY_PENDING: {
    label: "Test deploy gözləyir",
    role: "devops",
    action: "test deployunu növbəyə aldı",
  },
  TEST_DEPLOYED: {
    label: "Test mühitinə deploy edildi",
    role: "devops",
    action: "test mühitinə deploy etdi",
  },
  TEST_QA: {
    label: "Test mühitində QA",
    role: "reviewer",
    action: "test mühitində QA yoxlamasını tamamladı",
  },
  PRODUCTION_APPROVAL_PENDING: {
    label: "Production təsdiqi gözləyir",
    role: "approver",
    action: "production təsdiqi mərhələsinə keçirdi",
  },
  PRODUCTION_DEPLOYING: {
    label: "Production deploy edilir",
    role: "devops",
    action: "production deployuna başladı",
  },
  PRODUCTION_SMOKE_TEST: {
    label: "Production smoke test",
    role: "reviewer",
    action: "production smoke testinə başladı",
  },
  DONE: { label: "Bitdi", role: "finalApprover", action: "taskı yekun təsdiqlədi" },
};

function personName(person, fallback) {
  if (!person || typeof person !== "object") return fallback;
  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim();
  return name || person.email || fallback;
}

export function compactTaskTitle(value, maxLength = 100) {
  const title = String(value || "WhatsApp-dan daxil olan məsələ").replace(/\s+/g, " ").trim();
  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function chooseAgentExecutor(draft, agentUserIds) {
  const requested = String(draft?.agentId || "").trim().toLowerCase();
  if (agentUserIds[requested]) return { agentId: requested, userId: agentUserIds[requested] };

  const searchable = `${draft?.title || ""} ${draft?.description || ""}`.toLocaleLowerCase("az-AZ");
  const inferred = /flutter|mobil|android|ios/.test(searchable)
    ? "aem-mobile"
    : /frontend|front-end|angular|react|ui|interfeys|səhifə|sehife/.test(searchable)
      ? "aem-frontend"
      : "aem-backend";
  const agentId = agentUserIds[inferred] ? inferred : Object.keys(agentUserIds)[0];
  return { agentId, userId: agentUserIds[agentId] };
}

export function taskStatusSnapshot(task) {
  return {
    status: String(task?.status || ""),
    cycleNumber: Number(task?.cycleNumber || 0),
    latestRejectionReason: String(task?.latestRejectionReason || ""),
    executionMinutes: Number(task?.executionMinutes || 0),
    updatedAt: String(task?.updatedAt || ""),
  };
}

export function taskSnapshotChanged(previous, current) {
  if (!previous) return false;
  return (
    previous.status !== current.status ||
    previous.cycleNumber !== current.cycleNumber ||
    previous.latestRejectionReason !== current.latestRejectionReason ||
    previous.executionMinutes !== current.executionMinutes
  );
}

export function formatTaskCreatedMessage(task, taskUrl) {
  const number = task?.number || task?.id || "Task";
  const executor = personName(task?.executor, "Developer");
  return [
    "🆕 AGENT TASK AÇILDI",
    `ID: ${number}`,
    `Başlıq: ${compactTaskTitle(task?.title)}`,
    `İcraçı: ${executor}`,
    "Status: Yeni task",
    `🔗 ${taskUrl}`,
  ].join("\n");
}

export function formatTaskUpdateMessage(task, taskUrl) {
  const detail = STATUS_DETAILS[task?.status] || {
    label: String(task?.status || "Yeniləndi"),
    role: "executor",
    action: "taskı yenilədi",
  };
  const actor = personName(task?.[detail.role], "Məsul şəxs");
  const lines = [
    task?.status === "DONE" ? "✅ TASK TAMAMLANDI" : "🔄 TASK YENİLƏNDİ",
    `ID: ${task?.number || task?.id || "Task"}`,
    `Başlıq: ${compactTaskTitle(task?.title)}`,
    `Kim/nə etdi: ${actor} — ${detail.action}.`,
    `Yeni status: ${detail.label}`,
  ];
  if (Number(task?.executionMinutes || 0) > 0) {
    lines.push(`İcra vaxtı: ${task.executionMinutes} dəqiqə`);
  }
  if (task?.latestRejectionReason) {
    lines.push(`Reject səbəbi: ${task.latestRejectionReason}`);
  }
  lines.push(`🔗 ${taskUrl}`);
  return lines.join("\n");
}

