import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCallResult,
  VoiceCallResultTracker,
} from "../src/call-results.js";

const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const anotherUuid = "bbbbbbbb-cccc-4ddd-8eee-bbbbbbbbbbbb";
const base = {
  uuid,
  direction: "outbound",
  from: "12025550123",
  to: "12025550124",
  timestamp: "2026-11-01T12:00:01.000Z",
};

test("asynchronous failure classification exposes a normalized HA outcome", () => {
  const result = classifyCallResult({
    ...base,
    status: "failed",
    sip_code: 500,
    detail: "internal_error",
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.sip_code, 500);
  assert.equal(result.uuid, uuid);
  assert.equal("from" in result, false);
  assert.equal("to" in result, false);
});

test("failed and not-answered callbacks settle a synchronous waiter", async () => {
  const tracker = new VoiceCallResultTracker();
  const waiting = tracker.wait(uuid, { timeoutMs: 1000 });
  tracker.observe({
    ...base,
    status: "failed",
    sip_code: 500,
    detail: "internal_error",
  });
  const result = await waiting;
  assert.equal(result.outcome, "failed");
  assert.equal(result.sip_code, 500);

  const second = tracker.wait(anotherUuid, { timeoutMs: 1000 });
  tracker.observe({
    ...base,
    uuid: anotherUuid,
    status: "busy",
    sip_code: 486,
  });
  assert.equal((await second).outcome, "not_answered");
});

test("completed SIP 500 is a failure even without a failed event", async () => {
  const tracker = new VoiceCallResultTracker();
  const waiting = tracker.wait(uuid, { timeoutMs: 1000 });
  tracker.observe({
    ...base,
    status: "completed",
    sip_code: "500",
    detail: "internal_error",
    duration: "0",
  });
  assert.equal((await waiting).outcome, "failed");
});

test("success requires completion, not merely ringing or answered", async () => {
  const tracker = new VoiceCallResultTracker();
  const waiting = tracker.wait(uuid, { timeoutMs: 1000 });
  tracker.observe({ ...base, status: "ringing" });
  tracker.observe({ ...base, status: "answered" });
  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  tracker.observe({
    ...base,
    status: "completed",
    sip_code: 200,
    detail: "ok",
    duration: "2",
  });
  const result = await waiting;
  assert.equal(result.outcome, "completed");
  assert.equal(result.sip_code, 200);
});

test("early callbacks are retained before the create-call response", async () => {
  const tracker = new VoiceCallResultTracker();
  tracker.observe({ ...base, status: "failed", sip_code: 500 });
  tracker.observe({
    ...base,
    status: "completed",
    sip_code: 200,
    detail: "ok",
  });
  const result = await tracker.wait(uuid, { timeoutMs: 100 });
  assert.equal(result.outcome, "failed");
});

test("a successful completed callback can arrive before the waiter", async () => {
  const tracker = new VoiceCallResultTracker();
  tracker.observe({
    ...base,
    status: "completed",
    sip_code: 200,
    detail: "ok",
  });
  assert.equal((await tracker.wait(uuid)).outcome, "completed");
});

test("timeouts mean unknown outcome, not a failed or cancelled call", async () => {
  const tracker = new VoiceCallResultTracker();
  tracker.observe({ ...base, status: "answered" });
  const result = await tracker.wait(uuid, { timeoutMs: 25 });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.status, "result_timeout");

  tracker.observe({
    ...base,
    status: "completed",
    sip_code: 200,
    detail: "ok",
  });
  assert.equal((await tracker.wait(uuid)).outcome, "completed");
});

test("unverified completion without positive signaling is not called success", async () => {
  const tracker = new VoiceCallResultTracker();
  const waiting = tracker.wait(uuid, { timeoutMs: 25 });
  tracker.observe({ ...base, status: "completed", duration: "0" });
  assert.equal((await waiting).outcome, "unknown");
});

test("track distinct call UUIDs and ignore unrelated inbound callbacks", async () => {
  const tracker = new VoiceCallResultTracker();
  const first = tracker.wait(uuid, { timeoutMs: 1000 });
  const second = tracker.wait(anotherUuid, { timeoutMs: 1000 });
  tracker.observe({ ...base, direction: "inbound", status: "failed" });
  tracker.observe({
    ...base,
    uuid: anotherUuid,
    status: "completed",
    sip_code: 200,
  });
  tracker.observe({ ...base, status: "rejected", detail: "restricted" });
  assert.equal((await first).outcome, "failed");
  assert.equal((await second).outcome, "completed");
});

test("missing call UUID and other irrelevant callbacks are ignored", () => {
  const tracker = new VoiceCallResultTracker();
  tracker.observe({ status: "failed", direction: "outbound" });
  tracker.observe({ uuid, status: "failed", direction: "inbound" });
  assert.equal(tracker.entries.size, 0);
  assert.throws(() => tracker.wait(null), /call UUID/u);
});

test("pre-response event tracking remains bounded", () => {
  const tracker = new VoiceCallResultTracker({
    maxEntries: 2,
    retentionMs: 1,
  });
  for (const id of ["a", "b", "c"]) {
    tracker.observe({
      uuid: id,
      direction: "outbound",
      status: "failed",
      sip_code: 500,
    });
  }
  assert.ok(tracker.entries.size <= 2);
});
