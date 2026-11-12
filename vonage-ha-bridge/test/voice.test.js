import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutboundTalkCallPayload,
  buildTalkNcco,
  isValidVoiceTtsWaitMs,
} from "../src/voice.js";

test("outbound talk call embeds an NCCO with no answer URL or secret", () => {
  const payload = buildOutboundTalkCallPayload({
    to: "12025550123",
    from: "12025550124",
    text: "Water leak detected!",
    language: "en-US",
    style: 0,
    eventUrl: "https://bridge.example.com/vonage/event",
  });

  assert.deepEqual(payload, {
    to: [{ type: "phone", number: "12025550123" }],
    from: { type: "phone", number: "12025550124" },
    ncco: [
      {
        action: "talk",
        text: "Water leak detected!",
        language: "en-US",
        style: 0,
      },
    ],
    event_url: ["https://bridge.example.com/vonage/event"],
  });
  assert.equal("answer_url" in payload, false);
  assert.equal(JSON.stringify(payload).includes("x-api-token"), false);
});

test("outbound TTS text is trimmed and limited to 1400 characters", () => {
  const payload = buildTalkNcco(`  ${"a".repeat(1500)}  `, "sv-SE", 2);
  assert.equal(payload[0].text.length, 1400);
  assert.equal(payload[0].style, 2);
  assert.equal(payload[0].language, "sv-SE");
});

test("missing or invalid style is omitted from the NCCO", () => {
  assert.deepEqual(buildTalkNcco("Hello", "", "invalid"), [
    { action: "talk", text: "Hello" },
  ]);
  assert.deepEqual(buildTalkNcco("Hello", "en-US", null), [
    { action: "talk", text: "Hello", language: "en-US" },
  ]);
});

test("configured lead-in and lead-out waits wrap outbound TTS", () => {
  const payload = buildOutboundTalkCallPayload({
    to: "12025550123",
    from: "12025550124",
    text: "Water leak detected!",
    language: "en-US",
    style: 0,
    eventUrl: "https://bridge.example.com/vonage/event",
    leadInMs: 500,
    leadOutMs: 500,
  });

  assert.deepEqual(payload.ncco, [
    { action: "wait", timeout: 0.5 },
    {
      action: "talk",
      text: "Water leak detected!",
      language: "en-US",
      style: 0,
    },
    { action: "wait", timeout: 0.5 },
  ]);
  assert.equal("answer_url" in payload, false);
});

test("one-sided waits are optional, and zero preserves the original NCCO", () => {
  assert.deepEqual(buildTalkNcco("Hello", "en-US", 0, { leadInMs: 100 }), [
    { action: "wait", timeout: 0.1 },
    { action: "talk", text: "Hello", language: "en-US", style: 0 },
  ]);
  assert.deepEqual(buildTalkNcco("Hello", "en-US", 0, { leadOutMs: 250 }), [
    { action: "talk", text: "Hello", language: "en-US", style: 0 },
    { action: "wait", timeout: 0.25 },
  ]);
  assert.deepEqual(
    buildTalkNcco("Hello", "en-US", 0, { leadInMs: 0, leadOutMs: 0 }),
    buildTalkNcco("Hello", "en-US", 0),
  );
});

test("wait values must be zero or whole milliseconds supported by Vonage", () => {
  for (const value of [0, 100, 500, 7_200_000]) {
    assert.equal(isValidVoiceTtsWaitMs(value), true);
  }
  for (const value of [-1, 1, 99, 100.5, 7_200_001, NaN, Infinity, "500"]) {
    assert.equal(isValidVoiceTtsWaitMs(value), false);
  }
  assert.throws(
    () => buildTalkNcco("Hello", "en-US", 0, { leadInMs: 50 }),
    RangeError,
  );
  assert.throws(
    () => buildTalkNcco("Hello", "en-US", 0, { leadOutMs: -100 }),
    RangeError,
  );
});
