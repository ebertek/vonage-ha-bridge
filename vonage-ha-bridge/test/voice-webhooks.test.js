import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import jwt from "jsonwebtoken";
import { verifyVoiceWebhook } from "../src/voice-webhooks.js";

const signatureSecret = "test-signature-secret-not-for-production";
const apiKey = "test-api-key";
const applicationId = "test-application-id";
const payload = {
  to: "12025550123",
  from: "12025550124",
  uuid: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  status: "failed",
  sip_code: 500,
};

function authorization(body, overrides = {}) {
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
  return `Bearer ${jwt.sign(claims, signatureSecret, {
    algorithm: "HS256",
  })}`;
}

function check(body, auth = authorization(body), extra = {}) {
  return verifyVoiceWebhook({
    authorization: auth,
    payload: body,
    signatureSecret,
    apiKey,
    applicationId,
    ...extra,
  });
}

test("accepts a signed POST Voice event and its payload hash", () => {
  assert.deepEqual(check(payload), { valid: true });
});

test("accepts a signed GET Answer URL query object", () => {
  const query = {
    to: "12025550123",
    from: "12025550124",
    conversation_uuid: "CON-aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
    uuid: payload.uuid,
  };
  assert.deepEqual(check(query), { valid: true });
});

test("rejects an altered POST payload or GET query", () => {
  const auth = authorization(payload);
  assert.equal(check({ ...payload, status: "completed" }, auth).valid, false);
  assert.equal(check({ ...payload, to: "12025550125" }, auth).valid, false);
  assert.equal(
    check(Object.fromEntries(Object.entries(payload).reverse()), auth).valid,
    false,
  );
});

test("rejects missing, malformed, or incorrectly signed authorization", () => {
  assert.deepEqual(check(payload, undefined, { authorization: undefined }), {
    valid: false,
    reason: "missing_authorization",
  });
  assert.equal(check(payload, "Basic test").valid, false);
  assert.equal(check(payload, "Bearer invalid").valid, false);
  assert.equal(
    check(payload, authorization(payload), {
      signatureSecret: "different-signature-secret",
    }).valid,
    false,
  );
  assert.equal(
    check(payload, authorization(payload), { signatureSecret: "" }).valid,
    false,
  );
});

test("rejects JWTs with invalid issuer, API key, or application ID", () => {
  for (const claims of [
    { iss: "SomeoneElse" },
    { api_key: "wrong-key" },
    { application_id: "different-application" },
    { application_id: null },
  ]) {
    // Missing optional application_id is allowed, but an incorrect ID is not.
    if (claims.application_id === null) {
      assert.deepEqual(
        check(payload, authorization(payload, { application_id: undefined })),
        { valid: true },
      );
    } else {
      assert.equal(check(payload, authorization(payload, claims)).valid, false);
    }
  }
});

test("rejects stale, future-dated, or missing issued-at timestamps", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(
    check(payload, authorization(payload, { iat: now - 600 })).valid,
    false,
  );
  assert.equal(
    check(payload, authorization(payload, { iat: now + 120 })).valid,
    false,
  );
  const claims = jwt.decode(authorization(payload).slice(7));
  const withoutIssuedAt = jwt.sign(claims, signatureSecret, {
    algorithm: "HS256",
    noTimestamp: true,
  });
  assert.equal(check(payload, `Bearer ${withoutIssuedAt}`).valid, false);
});

test("rejects JWTs signed using the wrong algorithm", () => {
  const claims = jwt.decode(authorization(payload).slice(7));
  const wrongAlgorithm = jwt.sign(claims, signatureSecret, {
    algorithm: "HS384",
  });
  assert.equal(check(payload, `Bearer ${wrongAlgorithm}`).valid, false);
});

test("rejects malformed or mismatched payload_hash claims", () => {
  for (const badHash of ["abc", "", null, "f".repeat(64)]) {
    assert.equal(
      check(payload, authorization(payload, { payload_hash: badHash })).valid,
      false,
    );
  }
});

test("a valid signed JWT without a payload_hash is accepted over HTTPS", () => {
  assert.deepEqual(
    check(payload, authorization(payload, { payload_hash: undefined })),
    { valid: true },
  );
});

test("rejects missing payload when a signed payload_hash is present", () => {
  assert.equal(check(undefined, authorization(payload)).valid, false);
});
