import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVoiceCallEvent,
  summarizeVoiceCallEvent,
  voiceEventDeliveryKey,
} from "../src/call-events.js";

const failed = {
  from: "12025550123",
  to: "12025550124",
  uuid: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  conversation_uuid: "CON-aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  status: "failed",
  direction: "outbound",
  sip_code: 500,
  detail: "internal_error",
  timestamp: "2026-11-01T12:00:01.000Z",
};

test("failed and rejected call events are recognized", () => {
  assert.equal(classifyVoiceCallEvent(failed), "failed");
  assert.equal(
    classifyVoiceCallEvent({ ...failed, status: "rejected", sip_code: 403 }),
    "failed",
  );
  assert.equal(
    classifyVoiceCallEvent({ ...failed, status: "completed", sip_code: 500 }),
    "failed",
  );
  assert.equal(
    classifyVoiceCallEvent({
      ...failed,
      status: "completed",
      sip_code: 200,
      detail: "internal_error",
    }),
    "failed",
  );
});

test("answer and completion events do not imply alert delivery failure", () => {
  assert.equal(
    classifyVoiceCallEvent({ ...failed, status: "answered", sip_code: null }),
    "other",
  );
  assert.equal(
    classifyVoiceCallEvent({
      ...failed,
      status: "completed",
      sip_code: 200,
      detail: "ok",
    }),
    "other",
  );
  assert.equal(
    classifyVoiceCallEvent({ ...failed, status: "ringing" }),
    "other",
  );
});

test("busy, unanswered and timeout are distinguished from platform failure", () => {
  for (const status of ["busy", "unanswered", "timeout"]) {
    assert.equal(classifyVoiceCallEvent({ status }), "not_answered");
  }
});

test("Voice webhook errors are recognized even without a call status", () => {
  assert.equal(
    classifyVoiceCallEvent({ reason: "Syntax error in NCCO" }),
    "webhook_error",
  );
});

test("call-event logs omit private phone numbers and message content", () => {
  const info = summarizeVoiceCallEvent({ ...failed, text: "Private message" });
  assert.deepEqual(info, {
    uuid: failed.uuid,
    conversation_uuid: failed.conversation_uuid,
    status: "failed",
    direction: "outbound",
    sip_code: 500,
    detail: "internal_error",
  });
  assert.equal(JSON.stringify(info).includes(failed.to), false);
  assert.equal(JSON.stringify(info).includes(failed.from), false);
  assert.equal(JSON.stringify(info).includes("Private message"), false);
});

test("GET callback legacy fields and SIP string values are normalized", () => {
  assert.deepEqual(
    summarizeVoiceCallEvent({
      callId: failed.uuid,
      conversationId: failed.conversation_uuid,
      status: "COMPLETED",
      sip_code: "500",
      direction: "outbound",
      detail: "internal_error",
    }),
    {
      uuid: failed.uuid,
      conversation_uuid: failed.conversation_uuid,
      status: "completed",
      direction: "outbound",
      sip_code: 500,
      detail: "internal_error",
    },
  );
});

test("dedup fingerprints are stable across object-key order and distinct per event", () => {
  const original = voiceEventDeliveryKey("POST", failed);
  const reordered = voiceEventDeliveryKey(
    "POST",
    Object.fromEntries(Object.entries(failed).reverse()),
  );
  assert.equal(original, reordered);
  assert.match(original, /^[a-f0-9]{64}$/u);
  assert.notEqual(original, voiceEventDeliveryKey("GET", failed));
  assert.notEqual(
    original,
    voiceEventDeliveryKey("POST", { ...failed, status: "completed" }),
  );
  assert.notEqual(
    original,
    voiceEventDeliveryKey("POST", {
      ...failed,
      timestamp: "2026-11-01T12:00:02.000Z",
    }),
  );
});
