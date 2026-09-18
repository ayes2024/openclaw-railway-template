import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkText,
  extractAgentResult,
  extractAgentText,
  makeApprovalCode,
  normalizeWasenderSender,
  parseApprovalInstruction,
  parseDirectTaskRequest,
  parseWasenderInbound,
  safeEqual,
} from "../src/wasender-bridge.js";

test("parses an incoming WAsenderAPI text message", () => {
  const message = parseWasenderInbound({
    event: "messages.received",
    data: {
      messages: {
        key: {
          id: "abc123",
          fromMe: false,
          remoteJid: "994501234567@s.whatsapp.net",
        },
        messageBody: "AEM-də bu funksiya niyə belədir?",
      },
    },
  });
  assert.deepEqual(message, {
    id: "abc123",
    sender: "994501234567",
    text: "AEM-də bu funksiya niyə belədir?",
    isGroup: false,
  });
});

test("ignores outbound and non-message events", () => {
  assert.equal(parseWasenderInbound({ event: "message.sent", data: {} }), null);
  assert.equal(
    parseWasenderInbound({
      event: "messages.received",
      data: { messages: { key: { fromMe: true }, messageBody: "loop" } },
    }),
    null,
  );
});

test("parses a WAsenderAPI group message and keeps participant identity", () => {
  const message = parseWasenderInbound({
    event: "messages-group.received",
    data: {
      messages: {
        key: {
          id: "group-456",
          fromMe: false,
          remoteJid: "120363012345678@g.us",
          cleanedParticipantPn: "994501234567",
        },
        messageBody: "Bu funksiya niyə belə işləyir?",
      },
    },
  });
  assert.deepEqual(message, {
    id: "group-456",
    sender: "120363012345678@g.us",
    text: "Bu funksiya niyə belə işləyir?",
    isGroup: true,
    participant: "994501234567",
  });
});

test("parses an incoming voice message without a text body", () => {
  const audio = {
    url: "https://example.com/encrypted-audio",
    mediaKey: "base64-media-key",
    mimetype: "audio/ogg; codecs=opus",
  };
  const message = parseWasenderInbound({
    event: "messages.received",
    data: {
      messages: {
        key: { id: "voice-1", fromMe: false, cleanedSenderPn: "994501234567" },
        message: { audioMessage: audio },
      },
    },
  });
  assert.deepEqual(message, {
    id: "voice-1",
    sender: "994501234567",
    text: "[Səsli mesaj]",
    isGroup: false,
    audio,
  });
});

test("extracts agent reply text from CLI JSON", () => {
  const output = JSON.stringify({
    result: { payloads: [{ text: "Birinci" }, { text: "İkinci" }] },
  });
  assert.equal(extractAgentText(output), "Birinci\n\nİkinci");
});

test("extracts task token usage from gateway agent JSON", () => {
  const output = JSON.stringify({
    result: {
      payloads: [{ text: "Hazırdır" }],
      meta: {
        agentMeta: {
          usage: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 10, total: 2010 },
          costUsd: 0.0123,
        },
      },
    },
  });
  assert.deepEqual(extractAgentResult(output), {
    text: "Hazırdır",
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 10,
      totalTokens: 2010,
      tokenCostUsd: 0.0123,
    },
  });
});

test("normalizes senders, compares secrets, and chunks replies", () => {
  assert.equal(normalizeWasenderSender("+994 50 123 45 67"), "994501234567");
  assert.equal(normalizeWasenderSender("*"), "*");
  assert.equal(normalizeWasenderSender("1203630@g.us"), "1203630@g.us");
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "wrong"), false);
  assert.deepEqual(chunkText("12345 67890", 7), ["12345", "67890"]);
});

test("creates stable approval codes and parses owner commands", () => {
  assert.equal(makeApprovalCode("message-1"), makeApprovalCode("message-1"));
  assert.match(makeApprovalCode("message-1"), /^WA-[A-F0-9]{6}$/);
  assert.deepEqual(parseApprovalInstruction("WA-A1B2C3 CAVAB"), {
    code: "WA-A1B2C3",
    action: "reply",
    text: "",
  });
  assert.deepEqual(parseApprovalInstruction("yaz: Sabah yoxlayacağıq"), {
    code: "",
    action: "custom-reply",
    text: "Sabah yoxlayacağıq",
  });
  assert.deepEqual(parseApprovalInstruction("task aç"), {
    code: "",
    action: "task",
    text: "",
  });
});

test("parses a direct task request with its description", () => {
  assert.equal(
    parseDirectTaskRequest("Task aç: Mobil tətbiqdə giriş düyməsi işləmir"),
    "Mobil tətbiqdə giriş düyməsi işləmir",
  );
  assert.equal(parseDirectTaskRequest("Task aç"), "");
  assert.equal(parseDirectTaskRequest("Task yarat CRM ad problemi"), "CRM ad problemi");
  assert.equal(parseDirectTaskRequest("Bu problemi araşdır"), "");
});
