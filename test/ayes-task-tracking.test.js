import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseAgentExecutor,
  compactTaskTitle,
  formatTaskCreatedMessage,
  formatTaskUpdateMessage,
  taskSnapshotChanged,
  taskStatusSnapshot,
} from "../src/ayes-task-tracking.js";

test("chooses the requested or inferred AEM developer", () => {
  const users = { "aem-backend": "back", "aem-frontend": "front", "aem-mobile": "mobile" };
  assert.deepEqual(chooseAgentExecutor({ agentId: "aem-frontend" }, users), {
    agentId: "aem-frontend",
    userId: "front",
  });
  assert.equal(chooseAgentExecutor({ title: "Flutter giriş xətası" }, users).userId, "mobile");
  assert.equal(chooseAgentExecutor({ title: "API cavab vermir" }, users).userId, "back");
});

test("keeps task titles short and formats lifecycle messages", () => {
  assert.equal(compactTaskTitle("  Qısa   başlıq  "), "Qısa başlıq");
  assert.equal(compactTaskTitle("x".repeat(120)).length, 100);

  const task = {
    id: "uuid",
    number: "AGT-42",
    title: "Login xətası",
    status: "CODE_READY",
    executor: { firstName: "AEM", lastName: "Backend" },
  };
  assert.match(formatTaskCreatedMessage(task, "https://task.example/agent-tasks"), /AGT-42/);
  assert.match(formatTaskUpdateMessage(task, "https://task.example/agent-tasks"), /AEM Backend — kodu hazırladı/);
});

test("detects meaningful task lifecycle changes", () => {
  const previous = taskStatusSnapshot({ status: "NEW", updatedAt: "1" });
  const timestampOnly = taskStatusSnapshot({ status: "NEW", updatedAt: "2" });
  const progressed = taskStatusSnapshot({ status: "IN_PROGRESS", updatedAt: "2" });
  assert.equal(taskSnapshotChanged(previous, timestampOnly), false);
  assert.equal(taskSnapshotChanged(previous, progressed), true);
});

