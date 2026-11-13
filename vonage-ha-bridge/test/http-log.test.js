import assert from "node:assert/strict";
import test from "node:test";
import { formatLoggedUrl } from "../src/http-log.js";

const url =
  "/vonage/answer?msisdn=12025550123&sig=test-signature&api-key=test-key&x-api-token=test-token";

test("default HTTP logging redacts phone numbers and credentials", () => {
  const logged = formatLoggedUrl(url);
  assert.equal(logged.includes("12025550123"), false);
  assert.equal(logged.includes("test-signature"), false);
  assert.equal(logged.includes("test-key"), false);
  assert.equal(logged.includes("test-token"), false);
  assert.equal(logged.includes("msisdn=[redacted]"), true);
});

test("REDACT_LOGS=false keeps phone numbers but never secrets", () => {
  const logged = formatLoggedUrl(url, { redactLogs: false });
  assert.equal(logged.includes("msisdn=12025550123"), true);
  assert.equal(logged.includes("test-signature"), false);
  assert.equal(logged.includes("test-key"), false);
  assert.equal(logged.includes("test-token"), false);
});

test("HTTP log formatter redacts credentials regardless of query parameter case", () => {
  const logged = formatLoggedUrl(
    "/api/call?API_SECRET=demo&Authorization=BearerSecret&NONCE=nonce",
    { redactLogs: false },
  );
  assert.equal(logged.includes("demo"), false);
  assert.equal(logged.includes("BearerSecret"), false);
  assert.equal(logged.includes("nonce=nonce"), false);
});

test("malformed URL cannot leak an unprocessed query string", () => {
  assert.equal(
    formatLoggedUrl("http://[bad?x-api-token=test-token", {
      redactLogs: false,
    }),
    "[invalid-url]",
  );
});
