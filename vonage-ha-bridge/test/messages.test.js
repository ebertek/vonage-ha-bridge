import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import jwt from "jsonwebtoken";
import {
  buildMessagesSmsPayload,
  parseInboundSms,
  verifyMessagesWebhook,
} from "../src/messages.js";

const signatureSecret = "a-secure-vonage-signature-secret";
const apiKey = "test-api-key";
const applicationId = "test-application-id";
const payload = {
  channel: "sms",
  message_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab",
  from: "46701111111",
  to: "46702222222",
  text: "Hello from Vonage!",
};

function signedAuthorization(body, overrides = {}) {
  const claims = {
    iss: "Vonage",
    api_key: apiKey,
    application_id: applicationId,
    payload_hash: crypto
      .createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
    ...overrides,
  };
  return `Bearer ${jwt.sign(claims, signatureSecret, { algorithm: "HS256" })}`;
}

function verify(body, authorization) {
  return verifyMessagesWebhook({
    authorization,
    payload: body,
    signatureSecret,
    apiKey,
    applicationId,
  });
}

test("Messages SMS payload uses JSON v1 fields and client_ref", () => {
  assert.deepEqual(
    buildMessagesSmsPayload({
      to: "46701111111",
      from: "46702222222",
      text: "SMS message",
      clientRef: "home-assistant-123",
    }),
    {
      channel: "sms",
      message_type: "text",
      from: "46702222222",
      to: "46701111111",
      text: "SMS message",
      client_ref: "home-assistant-123",
    },
  );
  assert.equal(
    buildMessagesSmsPayload({ from: "a", to: "b", text: "c" }).client_ref,
    undefined,
  );
});

test("Inbound Messages API SMS payload uses from and message_uuid", () => {
  assert.deepEqual(parseInboundSms(payload), {
    from: payload.from,
    to: payload.to,
    text: payload.text,
    messageUuid: payload.message_uuid,
  });
  assert.equal(parseInboundSms({ ...payload, channel: "whatsapp" }), null);
  assert.equal(parseInboundSms({ ...payload, message_uuid: null }), null);
});

test("valid Vonage HS256 webhook JWT and payload hash are accepted", () => {
  assert.equal(verify(payload, signedAuthorization(payload)), true);
});

test("webhook authentication rejects missing or invalid bearer token", () => {
  assert.equal(verify(payload, undefined), false);
  assert.equal(verify(payload, "Bearer invalid"), false);
  assert.equal(verify(payload, "Basic abc"), false);
});

test("webhook authentication detects modified message bodies", () => {
  assert.equal(
    verify({ ...payload, text: "Changed" }, signedAuthorization(payload)),
    false,
  );
});

test("webhook authentication checks API key and application ID", () => {
  assert.equal(
    verify(payload, signedAuthorization(payload, { api_key: "other" })),
    false,
  );
  assert.equal(
    verify(payload, signedAuthorization(payload, { application_id: "other" })),
    false,
  );
  assert.equal(
    verify(payload, signedAuthorization(payload, { application_id: undefined })),
    true,
  );
});

test("webhook authentication rejects stale and malformed claims", () => {
  assert.equal(
    verify(
      payload,
      signedAuthorization(payload, { iat: Math.floor(Date.now() / 1000) - 600 }),
    ),
    false,
  );
  assert.equal(
    verify(payload, signedAuthorization(payload, { payload_hash: "invalid" })),
    false,
  );
  assert.equal(
    verify(payload, signedAuthorization(payload, { iss: "not-vonage" })),
    false,
  );
});
