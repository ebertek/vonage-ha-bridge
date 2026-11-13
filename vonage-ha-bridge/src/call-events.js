import crypto from "node:crypto";

const FAILURE_STATUSES = new Set(["failed", "rejected"]);
const UNANSWERED_STATUSES = new Set(["busy", "unanswered", "timeout"]);
const FAILURE_DETAILS = new Set([
  "internal_error",
  "cannot_route",
  "number_out_of_service",
  "restricted",
  "invalid_number",
  "throttled",
]);

function normalizedSipCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 699
    ? number
    : null;
}

/**
 * Keep Voice call diagnostics useful without writing phone numbers, TTS text,
 * or complete third-party webhook payloads into application logs.
 */
export function summarizeVoiceCallEvent(payload) {
  const uuid = payload?.uuid ?? payload?.callId;
  const conversationUuid =
    payload?.conversation_uuid ?? payload?.conversationId;
  const detail = payload?.detail;

  return {
    uuid: typeof uuid === "string" ? uuid : null,
    conversation_uuid:
      typeof conversationUuid === "string" ? conversationUuid : null,
    status:
      typeof payload?.status === "string" ? payload.status.toLowerCase() : "",
    direction:
      payload?.direction === "outbound" || payload?.direction === "inbound"
        ? payload.direction
        : null,
    sip_code: normalizedSipCode(payload?.sip_code),
    detail:
      typeof detail === "string" && /^[a-z_]{1,64}$/u.test(detail)
        ? detail
        : null,
  };
}

export function classifyVoiceCallEvent(payload) {
  const { status, sip_code: sipCode, detail } =
    summarizeVoiceCallEvent(payload);

  if (
    FAILURE_STATUSES.has(status) ||
    (status === "completed" &&
      ((sipCode !== null && sipCode >= 400) || FAILURE_DETAILS.has(detail)))
  ) {
    return "failed";
  }

  if (UNANSWERED_STATUSES.has(status)) {
    return "not_answered";
  }

  if (typeof payload?.reason === "string") {
    return "webhook_error";
  }

  return "other";
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * Key retries by all event fields (including timestamp) rather than call UUID.
 * Different statuses of the same call must all reach Home Assistant.
 */
export function voiceEventDeliveryKey(method, payload) {
  return crypto
    .createHash("sha256")
    .update(`${method}: ${JSON.stringify(canonicalize(payload))}`)
    .digest("hex");
}
