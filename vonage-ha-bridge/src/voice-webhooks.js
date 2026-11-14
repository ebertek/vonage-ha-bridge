import crypto from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * Voice signed webhooks use an HS256 JWT issued by Vonage and the account
 * signature secret. Unlike API request authentication, no RSA key is used.
 *
 * The signed payload hash (when supplied) covers the compact JSON encoding
 * of the POST body or GET query object in its original property order.
 */
export function verifyVoiceWebhook({
  authorization,
  payload,
  signatureSecret,
  apiKey,
  applicationId,
}) {
  if (!authorization) {
    return { valid: false, reason: "missing_authorization" };
  }

  const match = /^Bearer\s+(\S+)$/iu.exec(authorization);
  if (!match || !signatureSecret) {
    return { valid: false, reason: "invalid_authorization" };
  }

  let claims;
  try {
    claims = jwt.verify(match[1], signatureSecret, {
      algorithms: ["HS256"],
      issuer: "Vonage",
      maxAge: "5m",
      clockTolerance: 10,
    });
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }

  if (
    !claims ||
    typeof claims !== "object" ||
    !Number.isInteger(claims.iat) ||
    claims.iat > Math.floor(Date.now() / 1000) + 30 ||
    claims.api_key !== apiKey ||
    (claims.application_id && claims.application_id !== applicationId)
  ) {
    return { valid: false, reason: "invalid_claims" };
  }

  if (claims.payload_hash !== undefined) {
    if (
      typeof claims.payload_hash !== "string" ||
      !/^[a-f\d]{64}$/iu.test(claims.payload_hash) ||
      payload === undefined
    ) {
      return { valid: false, reason: "invalid_payload_hash" };
    }

    const actualHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest();
    const expectedHash = Buffer.from(claims.payload_hash, "hex");
    if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
      return { valid: false, reason: "invalid_payload_hash" };
    }
  }

  return { valid: true };
}
