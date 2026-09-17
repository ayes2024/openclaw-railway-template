import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkText,
  extractAgentText,
  normalizeWasenderSender,
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

test("extracts agent reply text from CLI JSON", () => {
  const output = JSON.stringify({
    result: { payloads: [{ text: "Birinci" }, { text: "İkinci" }] },
  });
  assert.equal(extractAgentText(output), "Birinci\n\nİkinci");
});

test("normalizes senders, compares secrets, and chunks replies", () => {
  assert.equal(normalizeWasenderSender("+994 50 123 45 67"), "994501234567");
  assert.equal(normalizeWasenderSender("*"), "*");
  assert.equal(normalizeWasenderSender("1203630@g.us"), "1203630@g.us");
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "wrong"), false);
  assert.deepEqual(chunkText("12345 67890", 7), ["12345", "67890"]);
});
