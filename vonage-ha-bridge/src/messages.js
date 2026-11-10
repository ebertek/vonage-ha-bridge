import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export function buildMessagesSmsPayload({ from, to, text, clientRef }) {
  return {
    channel: "sms",
    message_type: "text",
    from,
    to,
    text,
    ...(clientRef ? { client_ref: String(clientRef).slice(0, 100) } : {}),
  };
}

export function parseInboundSms(payload) {
  if (
    payload?.channel !== "sms" ||
    typeof payload.message_uuid !== "string" ||
    typeof payload.from !== "string" ||
    typeof payload.to !== "string" ||
    typeof payload.text !== "string"
  ) {
    return null;
  }

  return {
    messageUuid: payload.message_uuid,
    from: payload.from,
    to: payload.to,
    text: payload.text,
  };
}

/**
 * Messages webhooks use HS256 with the Vonage account signature secret.
 * This is distinct from the RS256 application JWT used to call the API.
 */
export function verifyMessagesWebhook({
  authorization,
  payload,
  signatureSecret,
  apiKey,
  applicationId,
}) {
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "");
  if (!match || !signatureSecret) {
    return false;
  }

  let claims;
  try {
    claims = jwt.verify(match[1], signatureSecret, {
      algorithms: ["HS256"],
      issuer: "Vonage",
      maxAge: "5m",
    });
  } catch {
    return false;
  }

  if (
    !claims ||
    typeof claims !== "object" ||
    claims.api_key !== apiKey ||
    (claims.application_id && claims.application_id !== applicationId) ||
    typeof claims.payload_hash !== "string" ||
    !/^[a-f\d]{64}$/iu.test(claims.payload_hash)
  ) {
    return false;
  }

  // Vonage hashes the compact JSON body, preserving property order.
  const actualHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest();
  const expectedHash = Buffer.from(claims.payload_hash, "hex");
  return crypto.timingSafeEqual(actualHash, expectedHash);
}
