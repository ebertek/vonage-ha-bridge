import assert from "node:assert/strict";
import test from "node:test";
import { buildOutboundTalkCallPayload, buildTalkNcco } from "../src/voice.js";

test("outbound talk call embeds an NCCO with no answer URL or secret", () => {
  const payload = buildOutboundTalkCallPayload({
    to: "46735519258",
    from: "46790965420",
    text: "Water leak detected!",
    language: "en-US",
    style: 0,
    eventUrl: "https://bridge.example.com/vonage/event",
  });

  assert.deepEqual(payload, {
    to: [{ type: "phone", number: "46735519258" }],
    from: { type: "phone", number: "46790965420" },
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
