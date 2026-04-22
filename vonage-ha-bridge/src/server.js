import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import crypto from "node:crypto";
import axios from "axios";
import jwt from "jsonwebtoken";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

function normalizePhoneNumber(value) {
  let msisdn = String(value ?? "").trim();

  if (msisdn.startsWith("+")) {
    msisdn = msisdn.slice(1);
  }

  msisdn = msisdn.replace(/[^\d]/gu, "");

  if (msisdn.startsWith("00")) {
    msisdn = msisdn.slice(2);
  }

  if (!msisdn || msisdn.length < 7 || msisdn.length > 15) {
    throw new Error(
      `Invalid phone number length: ${msisdn}. Must be 7-15 digits.`,
    );
  }

  if (msisdn.startsWith("0")) {
    throw new Error(
      `Invalid phone number format: ${msisdn}. Must start with country code 1-9.`,
    );
  }

  return msisdn;
}

const config = {
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  baseUrl: (process.env.BASE_URL ?? "").replace(/\/$/u, ""),
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? "",
  haBaseUrl: (process.env.HA_BASE_URL ?? "").replace(/\/$/u, ""),
  haToken: process.env.HA_LONG_LIVED_TOKEN ?? "",
  haCallEventWebhookId:
    process.env.HA_CALL_EVENT_WEBHOOK_ID ?? "vonage_call_event",
  haSmsDlrWebhookId: process.env.HA_SMS_DLR_WEBHOOK_ID ?? "vonage_sms_dlr",
  haAssistAgentId: process.env.HA_ASSIST_AGENT_ID ?? "",
  haLanguage: process.env.HA_LANGUAGE ?? "en",
  version: process.env.APP_VERSION ?? "dev",
  logLevel: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  vonageApiKey: process.env.VONAGE_API_KEY ?? "",
  vonageApiSecret: process.env.VONAGE_API_SECRET ?? "",
  vonageSignatureSecret: process.env.VONAGE_SIGNATURE_SECRET ?? "",
  vonageSignatureAlgorithm: (
    process.env.VONAGE_SIGNATURE_ALGORITHM ?? "md5hash"
  ).toLowerCase(),
  vonageFromNumber: process.env.VONAGE_FROM_NUMBER?.trim()
    ? normalizePhoneNumber(process.env.VONAGE_FROM_NUMBER)
    : "",
  vonageApplicationId: process.env.VONAGE_APPLICATION_ID ?? "",
  vonagePrivateKeyPath:
    process.env.VONAGE_PRIVATE_KEY_PATH ?? "/run/secrets/private.key",
  forwardPhoneNumber: process.env.FORWARD_PHONE_NUMBER
    ? normalizePhoneNumber(process.env.FORWARD_PHONE_NUMBER)
    : "",
  forwardSipUri: process.env.FORWARD_SIP_URI ?? "",
  allowedSmsSenders: (process.env.ALLOWED_SMS_SENDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizePhoneNumber(value)),
  smsMaxLength: Number.parseInt(process.env.SMS_MAX_LENGTH ?? "1600", 10),
  assistTimeoutMs:
    Number.parseInt(process.env.ASSIST_TIMEOUT_S ?? "30", 10) * 1000,
  outboundTimeoutMs:
    Number.parseInt(process.env.OUTBOUND_TIMEOUT_S ?? "10", 10) * 1000,
  outboundSmsRateLimitWindowMs:
    Number.parseInt(process.env.OUTBOUND_SMS_RATE_LIMIT_WINDOW_S ?? "15", 10) *
    1000,
  outboundSmsRateLimitMaxRequests: Number.parseInt(
    process.env.OUTBOUND_SMS_RATE_LIMIT_MAX_REQUESTS ?? "5",
    10,
  ),
  outboundCallRateLimitWindowMs:
    Number.parseInt(
      process.env.OUTBOUND_CALL_RATE_LIMIT_WINDOW_S ?? "300",
      10,
    ) * 1000,
  outboundCallRateLimitMaxRequests: Number.parseInt(
    process.env.OUTBOUND_CALL_RATE_LIMIT_MAX_REQUESTS ?? "3",
    10,
  ),
  defaultVoiceLanguage: process.env.DEFAULT_VOICE_LANGUAGE ?? "en-US",
  defaultVoiceStyle: Number.parseInt(
    process.env.DEFAULT_VOICE_STYLE ?? "0",
    10,
  ),
  validateVonageSmsSignature:
    (process.env.VALIDATE_VONAGE_SMS_SIGNATURE ?? "false").toLowerCase() ===
    "true",
  redactLogs: (process.env.REDACT_LOGS ?? "true").toLowerCase() !== "false",
};

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

function shouldLog(level) {
  const current = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;
  const incoming = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return incoming >= current;
}

function log(level, message, meta = {}) {
  const normalizedLevel = String(level).toLowerCase();

  if (!shouldLog(normalizedLevel)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel.toUpperCase(),
    logger: "vonage-ha-bridge",
    message,
    ...meta,
  };

  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const logger = {
  debug: (message, meta = {}) => log("debug", message, meta),
  info: (message, meta = {}) => log("info", message, meta),
  warn: (message, meta = {}) => log("warning", message, meta),
  error: (message, meta = {}) => log("error", message, meta),
};

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidLogLevel(value) {
  return ["debug", "info", "warning", "error"].includes(value);
}

function isValidSignatureAlgorithm(value) {
  return ["md5hash", "md5", "sha1", "sha256", "sha512"].includes(value);
}

// ---------------------------------------------------------------------------
// Feature flags — derived from which credential groups are configured.
// These are set during validateConfig() and used at runtime to gate
// functionality gracefully rather than crashing on startup.
// ---------------------------------------------------------------------------
const features = {
  /** Outbound SMS via /api/send-sms and as inbound SMS reply channel */
  sms: false,
  /** Inbound SMS → HA Assist → reply flow */
  inboundSms: false,
  /** Outbound voice calls via /api/call */
  outboundCalls: false,
  /** Forward inbound calls to a SIP/phone destination */
  inboundCallForwarding: false,
  /** Push call events and SMS DLRs to HA webhooks */
  haWebhooks: false,
};

function validateConfig() {
  const errors = [];
  const warnings = [];

  // ── Always-required ───────────────────────────────────────────────────────
  const alwaysRequired = [
    "VONAGE_API_KEY",
    "VONAGE_API_SECRET",
    "VONAGE_FROM_NUMBER",
    "INTERNAL_API_TOKEN",
  ];

  for (const key of alwaysRequired) {
    if (!process.env[key]?.trim()) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // ── HA credentials (optional feature group) ───────────────────────────────
  const hasHaUrl = Boolean(process.env.HA_BASE_URL?.trim());
  const hasHaToken = Boolean(process.env.HA_LONG_LIVED_TOKEN?.trim());

  if (hasHaUrl !== hasHaToken) {
    errors.push(
      "HA_BASE_URL and HA_LONG_LIVED_TOKEN must both be set or both be unset",
    );
  } else if (!hasHaUrl && !hasHaToken) {
    warnings.push(
      "HA_BASE_URL / HA_LONG_LIVED_TOKEN not set — inbound SMS→Assist and HA webhook forwarding are disabled",
    );
  }

  // ── Voice credentials (optional feature group) ────────────────────────────
  const voiceReady = Boolean(config.vonageApplicationId.trim());
  if (!voiceReady) {
    warnings.push(
      "VONAGE_APPLICATION_ID not set — outbound calls and inbound call handling are disabled",
    );
  }

  // ── Validate HA URL format only when provided ─────────────────────────────
  if (hasHaUrl && !isValidUrl(config.haBaseUrl)) {
    errors.push(
      `HA_BASE_URL must be a valid http/https URL: ${config.haBaseUrl}`,
    );
  }

  if (!isPositiveInteger(config.port) || config.port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535: ${config.port}`);
  }

  if (!isValidLogLevel(config.logLevel)) {
    errors.push(
      `LOG_LEVEL must be one of: debug, info, warning, error. Got: ${config.logLevel}`,
    );
  }

  if (config.baseUrl && !isValidUrl(config.baseUrl)) {
    errors.push(`BASE_URL must be a valid http/https URL: ${config.baseUrl}`);
  }

  if (!config.redactLogs) {
    warnings.push(
      "REDACT_LOGS=false — sensitive parameters (sig, api-key, msisdn, nonce) will appear in HTTP logs",
    );
  }

  if (!config.haLanguage.trim()) {
    errors.push("HA_LANGUAGE must not be empty");
  }

  if (!config.defaultVoiceLanguage.trim()) {
    errors.push("DEFAULT_VOICE_LANGUAGE must not be empty");
  }

  if (!isNonNegativeInteger(config.defaultVoiceStyle)) {
    errors.push(
      `DEFAULT_VOICE_STYLE must be a non-negative integer: ${config.defaultVoiceStyle}`,
    );
  }

  if (!isPositiveInteger(config.smsMaxLength)) {
    errors.push(
      `SMS_MAX_LENGTH must be a positive integer: ${config.smsMaxLength}`,
    );
  }

  if (!isPositiveInteger(config.assistTimeoutMs)) {
    errors.push(
      `ASSIST_TIMEOUT_S must be a positive integer: ${config.assistTimeoutMs / 1000}`,
    );
  }

  if (!isPositiveInteger(config.outboundTimeoutMs)) {
    errors.push(
      `OUTBOUND_TIMEOUT_S must be a positive integer: ${config.outboundTimeoutMs / 1000}`,
    );
  }

  if (!isPositiveInteger(config.outboundSmsRateLimitWindowMs)) {
    errors.push("OUTBOUND_SMS_RATE_LIMIT_WINDOW_S must be a positive integer");
  }

  if (!isPositiveInteger(config.outboundSmsRateLimitMaxRequests)) {
    errors.push(
      "OUTBOUND_SMS_RATE_LIMIT_MAX_REQUESTS must be a positive integer",
    );
  }

  if (!isPositiveInteger(config.outboundCallRateLimitWindowMs)) {
    errors.push("OUTBOUND_CALL_RATE_LIMIT_WINDOW_S must be a positive integer");
  }

  if (!isPositiveInteger(config.outboundCallRateLimitMaxRequests)) {
    errors.push(
      "OUTBOUND_CALL_RATE_LIMIT_MAX_REQUESTS must be a positive integer",
    );
  }

  if (!isValidSignatureAlgorithm(config.vonageSignatureAlgorithm)) {
    errors.push(
      `VONAGE_SIGNATURE_ALGORITHM must be one of: md5hash, md5, sha1, sha256, sha512. Got: ${config.vonageSignatureAlgorithm}`,
    );
  }

  if (
    config.validateVonageSmsSignature &&
    !config.vonageSignatureSecret.trim()
  ) {
    errors.push(
      "VONAGE_SIGNATURE_SECRET is required when VALIDATE_VONAGE_SMS_SIGNATURE=true",
    );
  }

  if (config.forwardSipUri && !config.forwardSipUri.startsWith("sip:")) {
    errors.push(
      `FORWARD_SIP_URI must start with "sip:": ${config.forwardSipUri}`,
    );
  }

  // ── Private key validation — only when voice credentials are provided ──────
  if (voiceReady) {
    if (!fs.existsSync(config.vonagePrivateKeyPath)) {
      errors.push(
        `VONAGE_PRIVATE_KEY_PATH does not exist: ${config.vonagePrivateKeyPath}`,
      );
    } else {
      try {
        const privateKey = fs
          .readFileSync(config.vonagePrivateKeyPath, "utf8")
          .trim();
        if (!privateKey.startsWith("-----BEGIN")) {
          errors.push(
            `VONAGE_PRIVATE_KEY_PATH does not contain a PEM private key: ${config.vonagePrivateKeyPath}`,
          );
        }
      } catch (error) {
        errors.push(
          `Failed to read VONAGE_PRIVATE_KEY_PATH (${config.vonagePrivateKeyPath}): ${error.message}`,
        );
      }
    }
  }

  for (const warning of warnings) {
    log("warning", warning, { logger: "startup" });
  }

  if (errors.length > 0) {
    for (const error of errors) {
      log("error", error, { logger: "startup" });
    }

    throw new Error(
      `Configuration validation failed with ${errors.length} error(s)`,
    );
  }

  // ── Derive feature flags from validated config ────────────────────────────
  const haReady = Boolean(config.haBaseUrl && config.haToken);

  features.sms = Boolean(
    config.vonageApiKey && config.vonageApiSecret && config.vonageFromNumber,
  );
  features.inboundSms = features.sms && haReady;
  features.outboundCalls = voiceReady && Boolean(config.baseUrl);
  features.inboundCallForwarding =
    voiceReady && Boolean(config.forwardSipUri || config.forwardPhoneNumber);
  features.haWebhooks = haReady;
}

validateConfig();

const app = express();
app.set("trust proxy", true);

const REDACTED_PARAMS = new Set([
  "sig",
  "api-key",
  "api_key",
  "nonce",
  "msisdn",
  "api_secret",
  "api-secret",
  "x-api-token",
]);

function redactUrlParams(rawUrl) {
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    // URL constructor requires an absolute URL; use a dummy base
    const url = new URL(rawUrl, "http://x");

    for (const key of url.searchParams.keys()) {
      if (REDACTED_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[redacted]");
      }
    }

    // Return only path + search, not the dummy origin; decode %5B%5D back to []
    return (url.pathname + (url.search ?? ""))
      .replaceAll("%5B", "[")
      .replaceAll("%5D", "]");
  } catch {
    return rawUrl;
  }
}

app.use(
  morgan(
    (tokens, request, response) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        logger: "http",
        message: "HTTP request",
        method: tokens.method(request, response),
        url: config.redactLogs
          ? redactUrlParams(tokens.url(request, response))
          : tokens.url(request, response),
        status: Number(tokens.status(request, response)),
        response_time_ms: Number(tokens["response-time"](request, response)),
        remote_addr: tokens["remote-addr"](request, response),
        user_agent: tokens["user-agent"](request, response),
      }),
    {
      skip: (request) => request.path === "/health" || !shouldLog("info"),
    },
  ),
);

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));

if (!config.baseUrl) {
  logger.warn("BASE_URL not set — outbound calls are disabled");
}

logger.info("Feature summary", {
  outbound_sms: features.sms,
  inbound_sms_to_assist: features.inboundSms,
  outbound_calls: features.outboundCalls,
  inbound_call_forwarding: features.inboundCallForwarding,
  ha_webhooks: features.haWebhooks,
});

const http = axios.create({
  timeout: config.outboundTimeoutMs,
  httpAgent: new HttpAgent({ keepAlive: true }),
  httpsAgent: new HttpsAgent({ keepAlive: true }),
});

const rateLimitStore = new Map();

function createRateLimiter({ windowMs, maxRequests, keyGenerator, label }) {
  return (request, response, next) => {
    const now = Date.now();
    const key = keyGenerator(request);
    const storeKey = `${label}:${key}`;

    // Prevent unbounded growth under adversarial input
    if (rateLimitStore.size >= 10_000) {
      logger.warn("Rate limit store full — rejecting request", { label, key });
      response.status(429).json({ error: "Too many requests" });
      return;
    }

    const entry = rateLimitStore.get(storeKey);

    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(storeKey, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);

      logger.warn("Rate limit exceeded", {
        label,
        key,
        retry_after_seconds: retryAfterSeconds,
      });

      response.set("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        error: "Too many requests",
        retry_after_seconds: retryAfterSeconds,
      });
      return;
    }

    entry.count += 1;
    next();
  };
}

function cleanupRateLimitStore() {
  const now = Date.now();

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}

setInterval(cleanupRateLimitStore, 60_000).unref();

const outboundSmsRateLimiter = createRateLimiter({
  windowMs: config.outboundSmsRateLimitWindowMs,
  maxRequests: config.outboundSmsRateLimitMaxRequests,
  keyGenerator: (request) => {
    try {
      return normalizePhoneNumber(request.body?.to ?? "");
    } catch {
      return "invalid";
    }
  },
  label: "outbound-sms",
});

const outboundCallRateLimiter = createRateLimiter({
  windowMs: config.outboundCallRateLimitWindowMs,
  maxRequests: config.outboundCallRateLimitMaxRequests,
  keyGenerator: (request) => {
    try {
      return normalizePhoneNumber(request.body?.to ?? "");
    } catch {
      return "invalid";
    }
  },
  label: "outbound-call",
});

function sanitizeSmsText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, config.smsMaxLength);
}

let _cachedPrivateKey = null;

function loadPrivateKey() {
  if (_cachedPrivateKey) {
    return _cachedPrivateKey;
  }

  const privateKey = fs
    .readFileSync(config.vonagePrivateKeyPath, "utf8")
    .trim();

  if (!privateKey.startsWith("-----BEGIN")) {
    throw new Error(
      "VONAGE_PRIVATE_KEY_PATH does not contain a PEM private key",
    );
  }

  _cachedPrivateKey = privateKey;
  return _cachedPrivateKey;
}

function createVonageJwt() {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = loadPrivateKey();

  return jwt.sign(
    {
      application_id: config.vonageApplicationId,
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
    },
    privateKey,
    {
      algorithm: "RS256",
      header: {
        typ: "JWT",
        alg: "RS256",
      },
    },
  );
}

function isAuthorizedSender(msisdn) {
  if (config.allowedSmsSenders.length === 0) {
    return true;
  }

  const normalizedSender = normalizePhoneNumber(msisdn);
  return config.allowedSmsSenders.includes(normalizedSender);
}

function requireInternalToken(request, response, next) {
  const raw = request.header("x-api-token") ?? request.query["x-api-token"];
  const provided = Array.isArray(raw) ? "" : (raw ?? "");

  let authorized = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(config.internalApiToken);
    authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    authorized = false;
  }

  if (!authorized) {
    logger.warn("Unauthorized internal API access attempt", {
      remote_addr: request.ip,
      path: request.path,
    });
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function sanitizeSignatureValue(value) {
  return String(value ?? "").replace(/[&=]/gu, "_");
}

function buildVonageSignatureBaseString(params) {
  return Object.entries(params)
    .filter(([key]) => key !== "sig")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `&${key}=${sanitizeSignatureValue(value)}`)
    .join("");
}

function verifyVonageMd5HashSignature(sig, params, secret) {
  const base = buildVonageSignatureBaseString(params);
  const expected = crypto
    .createHash("md5")
    .update(`${base}${secret}`, "utf8")
    .digest("hex");

  return expected.toLowerCase() === String(sig).toLowerCase();
}

function verifyVonageHmacSignature(sig, params, secret, algorithm) {
  const algoMap = {
    md5: "md5",
    sha1: "sha1",
    sha256: "sha256",
    sha512: "sha512",
  };

  const nodeAlgorithm = algoMap[algorithm];

  if (!nodeAlgorithm) {
    throw new Error(`Unsupported HMAC algorithm: ${algorithm}`);
  }

  const base = buildVonageSignatureBaseString(params);
  const expected = crypto
    .createHmac(nodeAlgorithm, secret)
    .update(base, "utf8")
    .digest("hex");

  return expected.toLowerCase() === String(sig).toLowerCase();
}

function isValidVonageSmsSignature(request) {
  if (!config.validateVonageSmsSignature) {
    return true;
  }

  if (!config.vonageSignatureSecret) {
    logger.error(
      "Vonage SMS signature validation enabled, but VONAGE_SIGNATURE_SECRET is missing",
    );
    return false;
  }

  const params = {
    ...request.query,
    ...request.body,
  };

  const sig = params.sig ?? request.header("x-nexmo-signature") ?? "";

  if (!sig) {
    logger.warn("Missing Vonage signature");
    return false;
  }

  logger.debug("SMS signature check", {
    algorithm: config.vonageSignatureAlgorithm,
    has_sig: Boolean(sig),
    keys: Object.keys(params).sort(),
  });

  try {
    if (config.vonageSignatureAlgorithm === "md5hash") {
      return verifyVonageMd5HashSignature(
        sig,
        params,
        config.vonageSignatureSecret,
      );
    }

    return verifyVonageHmacSignature(
      sig,
      params,
      config.vonageSignatureSecret,
      config.vonageSignatureAlgorithm,
    );
  } catch (error) {
    logger.error("SMS signature verification threw", {
      error: error?.message ?? String(error),
    });
    return false;
  }
}

function getVonageSmsError(message) {
  switch (message.status) {
    case "0":
      return null;
    case "1":
      return "Rate limit exceeded";
    case "2":
      return "Invalid request parameters";
    case "3":
      return "Invalid sender address";
    case "4":
      return "Invalid Vonage credentials";
    case "5":
      return "Internal Vonage error";
    case "6":
      return "Invalid message";
    case "7":
      return "Number barred";
    case "8":
      return "Partner account barred";
    case "9":
      return "Partner quota exceeded";
    case "11":
      return "Account not enabled for REST";
    case "12":
      return "Message too long";
    case "13":
      return "Communication failed";
    case "14":
      return "Invalid signature";
    case "15":
      return "Invalid sender address";
    default:
      return message["error-text"] ?? "Unknown Vonage error";
  }
}

async function callHaConversation({ from, text }) {
  const payload = {
    text,
    language: config.haLanguage,
    conversation_id: `sms-${normalizePhoneNumber(from)}`,
  };

  if (config.haAssistAgentId) {
    payload.agent_id = config.haAssistAgentId;
  }

  const result = await http.post(
    `${config.haBaseUrl}/api/conversation/process`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${config.haToken}`,
        "Content-Type": "application/json",
      },
      timeout: config.assistTimeoutMs,
    },
  );

  return result.data;
}

function extractAssistReply(conversationResponse) {
  const candidates = [
    conversationResponse?.response?.speech?.plain?.speech,
    conversationResponse?.response?.speech?.speech,
    conversationResponse?.response?.text,
  ];

  for (const candidate of candidates) {
    const cleaned = sanitizeSmsText(candidate);
    if (cleaned) {
      return cleaned;
    }
  }

  return "Done.";
}

async function callHaWebhook(webhookId, payload) {
  const result = await http.post(
    `${config.haBaseUrl}/api/webhook/${webhookId}`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${config.haToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  return result.data;
}

async function sendSms({ to, text, clientRef }) {
  const payload = new URLSearchParams({
    api_key: config.vonageApiKey,
    api_secret: config.vonageApiSecret,
    to: normalizePhoneNumber(to),
    from: config.vonageFromNumber,
    text: sanitizeSmsText(text),
  });

  if (clientRef) {
    payload.append("client-ref", String(clientRef).slice(0, 40));
  }

  const result = await http.post(
    "https://rest.nexmo.com/sms/json",
    payload.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );

  const message = result.data?.messages?.[0];

  if (!message) {
    throw new Error("Vonage SMS API returned no message result");
  }

  const smsError = getVonageSmsError(message);

  if (smsError) {
    throw new Error(
      `Vonage SMS failed with status ${message.status}: ${smsError}`,
    );
  }

  logger.info("SMS sent", {
    to: message.to,
    message_id: message["message-id"],
    status: message.status,
    client_ref: message["client-ref"] ?? clientRef ?? null,
  });

  return result.data;
}

async function createOutboundCall({
  to,
  text,
  language = config.defaultVoiceLanguage,
  style = config.defaultVoiceStyle,
  dtmfAnswer,
  mode = "talk",
}) {
  if (!config.baseUrl) {
    throw new Error(
      "BASE_URL is required for outbound calls (voice features disabled)",
    );
  }

  const token = createVonageJwt();
  const toNumber = normalizePhoneNumber(to);
  const fromNumber = normalizePhoneNumber(config.vonageFromNumber);

  let payload;

  if (mode === "connect") {
    const connectEndpoint = {
      type: "phone",
      number: toNumber,
      ...(dtmfAnswer ? { dtmfAnswer: String(dtmfAnswer) } : {}),
    };

    payload = {
      to: [
        {
          type: "phone",
          number: toNumber,
        },
      ],
      from: {
        type: "phone",
        number: fromNumber,
      },
      ncco: [
        {
          action: "talk",
          text: String(text ?? "Please wait while we connect your call.")
            .trim()
            .slice(0, 1400),
          ...(language ? { language } : {}),
          ...(style !== undefined ? { style } : {}),
        },
        {
          action: "connect",
          endpoint: [connectEndpoint],
        },
      ],
      event_url: [`${config.baseUrl}/vonage/event`],
    };
  } else {
    const talkText = String(text ?? "")
      .trim()
      .slice(0, 1400);

    payload = {
      to: [
        {
          type: "phone",
          number: toNumber,
        },
      ],
      from: {
        type: "phone",
        number: fromNumber,
      },
      answer_url: [
        `${config.baseUrl}/ncco/talk?text=${encodeURIComponent(talkText)}&language=${encodeURIComponent(language)}&style=${encodeURIComponent(style)}&x-api-token=${encodeURIComponent(config.internalApiToken)}`,
      ],
      event_url: [`${config.baseUrl}/vonage/event`],
    };
  }

  const result = await http.post("https://api.nexmo.com/v1/calls", payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return result.data;
}

function buildInboundCallNcco() {
  if (!config.forwardSipUri && !config.forwardPhoneNumber) {
    return [
      {
        action: "talk",
        text: "No call destination is currently configured.",
      },
    ];
  }

  if (config.forwardSipUri) {
    return [
      {
        action: "talk",
        text: "Please wait while we connect your call.",
      },
      {
        action: "connect",
        endpoint: [
          {
            type: "sip",
            uri: config.forwardSipUri,
          },
        ],
      },
    ];
  }

  return [
    {
      action: "talk",
      text: "Please wait while we connect your call.",
    },
    {
      action: "connect",
      endpoint: [
        {
          type: "phone",
          number: config.forwardPhoneNumber,
        },
      ],
    },
  ];
}

function buildTalkNcco(text, language, style) {
  return [
    {
      action: "talk",
      text: String(text ?? "")
        .trim()
        .slice(0, 1400),
      ...(language ? { language } : {}),
      ...(style !== undefined && style !== null && !Number.isNaN(Number(style))
        ? { style: Number(style) }
        : {}),
    },
  ];
}

app.get("/", (_request, response) => {
  response.json({
    service: "vonage-ha-bridge",
    status: "ok",
  });
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/version", requireInternalToken, (_request, response) => {
  response.json({
    version: config.version,
    features: {
      outbound_sms: features.sms,
      inbound_sms_to_assist: features.inboundSms,
      outbound_calls: features.outboundCalls,
      inbound_call_forwarding: features.inboundCallForwarding,
      ha_webhooks: features.haWebhooks,
    },
  });
});

async function handleInboundSms(request, response) {
  try {
    if (!isValidVonageSmsSignature(request)) {
      logger.warn("Rejected inbound SMS due to invalid Vonage signature");
      response.status(403).json({ error: "Invalid signature" });
      return;
    }

    const payload = request.method === "GET" ? request.query : request.body;
    const from = normalizePhoneNumber(payload.msisdn ?? payload.from ?? "");
    const text = sanitizeSmsText(payload.text);

    logger.info("SMS inbound", { from, text });

    if (!from || !text) {
      response.status(200).json({ ok: true });
      return;
    }

    if (!isAuthorizedSender(from)) {
      logger.warn("Unauthorized SMS sender", { from });
      response.status(200).json({ ok: true });
      return;
    }

    let replyText;

    if (!features.inboundSms) {
      logger.warn(
        "Inbound SMS received but HA Assist is not configured — dropping without reply",
      );
      response.status(200).json({ ok: true });
      return;
    }

    try {
      const assistResponse = await callHaConversation({ from, text });
      replyText = extractAssistReply(assistResponse);
    } catch (error) {
      logger.error("Home Assistant Assist request failed", {
        error: error.response?.data ?? error.message,
      });
      replyText = "Error communicating with Home Assistant.";
    }

    logger.info("Replying to inbound SMS", { to: from, reply_text: replyText });

    try {
      await sendSms({
        to: from,
        text: replyText,
        clientRef: `inbound-reply-${Date.now()}`,
      });
    } catch (error) {
      logger.error("Failed to send inbound SMS reply", {
        to: from,
        error: error.response?.data ?? error.message ?? String(error),
      });
    }

    response.status(200).json({ ok: true });
  } catch (error) {
    logger.error("Inbound SMS handler failed", {
      error: error.response?.data ?? error.message ?? String(error),
    });
    response.status(500).json({
      error: "Inbound SMS handling failed",
    });
  }
}

async function handleSmsDlr(request, response) {
  try {
    const payload = request.method === "GET" ? request.query : request.body;

    logger.info("SMS delivery receipt received", {
      status: payload.status,
      message_id: payload.messageId,
      msisdn: payload.msisdn,
      client_ref: payload["client-ref"] ?? null,
      err_code: payload["err-code"] ?? null,
    });

    if (features.haWebhooks) {
      await callHaWebhook(config.haSmsDlrWebhookId, {
        provider: "vonage",
        type: "sms_dlr",
        method: request.method,
        payload,
      });
    } else {
      logger.debug(
        "SMS DLR received but HA webhooks not configured — skipping forwarding",
      );
    }

    response.status(200).json({ ok: true });
  } catch (error) {
    logger.error("SMS DLR handler failed", {
      error: error.response?.data ?? error.message ?? String(error),
    });
    response.status(200).json({ ok: true });
  }
}

app.get("/vonage/sms", handleInboundSms);
app.post("/vonage/sms", handleInboundSms);

app.get("/vonage/dlr", handleSmsDlr);
app.post("/vonage/dlr", handleSmsDlr);

function handleAnswer(_request, response) {
  try {
    response.json(buildInboundCallNcco());
  } catch (error) {
    logger.error("Answer URL failed", {
      error: error.message ?? String(error),
    });
    response.status(500).json(buildTalkNcco("An internal error occurred."));
  }
}

app.get("/vonage/answer", handleAnswer);
app.post("/vonage/answer", handleAnswer);

async function handleCallEvent(request, response) {
  try {
    if (features.haWebhooks) {
      await callHaWebhook(config.haCallEventWebhookId, {
        provider: "vonage",
        method: request.method,
        payload: request.method === "GET" ? request.query : request.body,
      });
    } else {
      logger.debug(
        "Call event received but HA webhooks not configured — skipping forwarding",
      );
    }
  } catch (error) {
    logger.error("Voice event handler failed", {
      error: error.response?.data ?? error.message ?? String(error),
    });
  }

  response.status(200).json({ ok: true });
}

app.get("/vonage/event", handleCallEvent);
app.post("/vonage/event", handleCallEvent);

app.get("/ncco/talk", requireInternalToken, (request, response) => {
  const text =
    request.query.text ?? "This is an automated call from Home Assistant.";
  const language = request.query.language || config.defaultVoiceLanguage;
  const style = request.query.style ?? config.defaultVoiceStyle;
  response.json(buildTalkNcco(text, language, style));
});

app.post(
  "/api/send-sms",
  requireInternalToken,
  outboundSmsRateLimiter,
  async (request, response) => {
    if (!features.sms) {
      response.status(503).json({
        error:
          "Outbound SMS is disabled — set VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_FROM_NUMBER",
      });
      return;
    }

    try {
      const { to, text, clientRef } = request.body;

      if (!to || !text) {
        response
          .status(400)
          .json({ error: 'Fields "to" and "text" are required' });
        return;
      }

      const result = await sendSms({ to, text, clientRef });
      response.json(result);
    } catch (error) {
      // Vonage rejected the request (4xx from their API)
      if (error.response?.status >= 400 && error.response?.status < 500) {
        response.status(400).json({
          error: "Vonage rejected the request",
          details: error.response?.data ?? error.message,
        });
        return;
      }
      // Vonage unreachable or 5xx
      if (error.response || error.code === "ECONNABORTED") {
        response.status(502).json({
          error: "Vonage API request failed",
          details: error.response?.data ?? error.message,
        });
        return;
      }
      // Local fault (e.g. JWT signing, phone normalization)
      response.status(500).json({
        error: "Internal error",
        details: error.message,
      });
    }
  },
);

app.post(
  "/api/call",
  requireInternalToken,
  outboundCallRateLimiter,
  async (request, response) => {
    if (!features.outboundCalls) {
      response.status(503).json({
        error:
          "Outbound calls are disabled — set VONAGE_APPLICATION_ID and BASE_URL, and ensure the private key exists at VONAGE_PRIVATE_KEY_PATH",
      });
      return;
    }

    try {
      const {
        to,
        text,
        language,
        style,
        dtmfAnswer,
        dtmf_answer: dtmfAnswerAlt,
        mode,
      } = request.body;

      if (!to || !text) {
        response
          .status(400)
          .json({ error: 'Fields "to" and "text" are required' });
        return;
      }

      const result = await createOutboundCall({
        to,
        text,
        language,
        style:
          style === undefined || style === null
            ? config.defaultVoiceStyle
            : Number.parseInt(String(style), 10),
        dtmfAnswer: dtmfAnswer ?? dtmfAnswerAlt,
        mode: mode === "connect" ? "connect" : "talk",
      });

      response.json(result);
    } catch (error) {
      // Vonage rejected the request (4xx from their API)
      if (error.response?.status >= 400 && error.response?.status < 500) {
        response.status(400).json({
          error: "Vonage rejected the request",
          details: error.response?.data ?? error.message,
        });
        return;
      }
      // Vonage unreachable or 5xx
      if (error.response || error.code === "ECONNABORTED") {
        response.status(502).json({
          error: "Vonage API request failed",
          details: error.response?.data ?? error.message,
        });
        return;
      }
      // Local fault (e.g. JWT signing, phone normalization)
      response.status(500).json({
        error: "Internal error",
        details: error.message,
      });
    }
  },
);

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

// Global error handler — must be last, and must have exactly 4 parameters
app.use((error, _request, response, _next) => {
  logger.error("Unhandled application error", {
    error: error?.message ?? String(error),
  });
  response.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  logger.info("Server started", {
    version: config.version,
    port: config.port,
    log_level: config.logLevel,
  });
});

function shutdown(signal) {
  logger.info("Shutdown requested", { signal });

  server.close((error) => {
    if (error) {
      logger.error("HTTP server close failed", {
        error: error.message ?? String(error),
      });
      process.exit(1);
      return;
    }

    logger.info("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
