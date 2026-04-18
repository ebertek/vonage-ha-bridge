import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "node:fs";
import crypto from "node:crypto";
import axios from "axios";
import jwt from "jsonwebtoken";

dotenv.config();

function normalizePhoneNumber(value) {
  return String(value ?? "").replace(/[^\d]/gu, "");
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
  vonageFromNumber: normalizePhoneNumber(process.env.VONAGE_FROM_NUMBER ?? ""),
  vonageApplicationId: process.env.VONAGE_APPLICATION_ID ?? "",
  vonagePrivateKeyPath: process.env.VONAGE_PRIVATE_KEY_PATH ?? "",
  forwardPhoneNumber: normalizePhoneNumber(
    process.env.FORWARD_PHONE_NUMBER ?? "",
  ),
  forwardSipUri: process.env.FORWARD_SIP_URI ?? "",
  allowedSmsSenders: (process.env.ALLOWED_SMS_SENDERS ?? "")
    .split(",")
    .map((value) => normalizePhoneNumber(value.trim()))
    .filter(Boolean),
  smsMaxLength: Number.parseInt(process.env.SMS_MAX_LENGTH ?? "1600", 10),
  assistTimeoutMs: Number.parseInt(
    process.env.ASSIST_TIMEOUT_MS ?? "30000",
    10,
  ),
  outboundTimeoutMs: Number.parseInt(
    process.env.OUTBOUND_TIMEOUT_MS ?? "10000",
    10,
  ),
  outboundSmsRateLimitWindowMs: Number.parseInt(
    process.env.OUTBOUND_SMS_RATE_LIMIT_WINDOW_MS ?? "15000",
    10,
  ),
  outboundSmsRateLimitMaxRequests: Number.parseInt(
    process.env.OUTBOUND_SMS_RATE_LIMIT_MAX_REQUESTS ?? "5",
    10,
  ),
  outboundCallRateLimitWindowMs: Number.parseInt(
    process.env.OUTBOUND_CALL_RATE_LIMIT_WINDOW_MS ?? "300000",
    10,
  ),
  outboundCallRateLimitMaxRequests: Number.parseInt(
    process.env.OUTBOUND_CALL_RATE_LIMIT_MAX_REQUESTS ?? "3",
    10,
  ),
  validateVonageSmsSignature:
    (process.env.VALIDATE_VONAGE_SMS_SIGNATURE ?? "false").toLowerCase() ===
    "true",
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

const app = express();

app.use(
  morgan(
    (tokens, request, response) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        logger: "http",
        message: "HTTP request",
        method: tokens.method(request, response),
        url: tokens.url(request, response),
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!config.baseUrl) {
  logger.warn("BASE_URL not set — voice features will not work");
}

const http = axios.create({
  timeout: config.outboundTimeoutMs,
});

const rateLimitStore = new Map();

function createRateLimiter({ windowMs, maxRequests, keyGenerator, label }) {
  return (request, response, next) => {
    const now = Date.now();
    const key = keyGenerator(request);
    const storeKey = `${label}:${key}`;
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

function assertRequiredConfig() {
  const required = [
    "HA_BASE_URL",
    "HA_LONG_LIVED_TOKEN",
    "VONAGE_API_KEY",
    "VONAGE_API_SECRET",
    "VONAGE_FROM_NUMBER",
    "VONAGE_APPLICATION_ID",
    "VONAGE_PRIVATE_KEY_PATH",
    "INTERNAL_API_TOKEN",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}

assertRequiredConfig();

const outboundSmsRateLimiter = createRateLimiter({
  windowMs: config.outboundSmsRateLimitWindowMs,
  maxRequests: config.outboundSmsRateLimitMaxRequests,
  keyGenerator: (request) =>
    normalizePhoneNumber(request.body?.to ?? "unknown"),
  label: "outbound-sms",
});

const outboundCallRateLimiter = createRateLimiter({
  windowMs: config.outboundCallRateLimitWindowMs,
  maxRequests: config.outboundCallRateLimitMaxRequests,
  keyGenerator: (request) =>
    normalizePhoneNumber(request.body?.to ?? "unknown"),
  label: "outbound-call",
});

function sanitizeSmsText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, config.smsMaxLength);
}

function loadPrivateKey() {
  return fs.readFileSync(config.vonagePrivateKeyPath, "utf8");
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
  const provided = request.header("x-api-token");

  if (provided !== config.internalApiToken) {
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

  if (message.status !== "0") {
    throw new Error(
      `Vonage SMS failed with status ${message.status}: ${message["error-text"] ?? "unknown error"}`,
    );
  }

  logger.info("SMS sent", { result: result.data });
  return result.data;
}

async function createOutboundCall({ to, text }) {
  if (!config.baseUrl) {
    throw new Error(
      "BASE_URL is required for outbound calls (voice features disabled)",
    );
  }

  const token = createVonageJwt();
  const answerUrl = `${config.baseUrl}/ncco/talk?text=${encodeURIComponent(
    String(text ?? "")
      .trim()
      .slice(0, 1400),
  )}`;

  const result = await http.post(
    "https://api.nexmo.com/v1/calls",
    {
      to: [
        {
          type: "phone",
          number: normalizePhoneNumber(to),
        },
      ],
      from: {
        type: "phone",
        number: config.vonageFromNumber,
      },
      answer_url: [answerUrl],
      event_url: [`${config.baseUrl}/vonage/event`],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );

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

function buildTalkNcco(text) {
  return [
    {
      action: "talk",
      text: String(text ?? "")
        .trim()
        .slice(0, 1400),
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

app.get("/version", (_request, response) => {
  response.json({
    version: config.version,
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

    await sendSms({
      to: from,
      text: replyText,
      clientRef: `inbound-reply-${Date.now()}`,
    });

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

    logger.info("SMS delivery receipt received", { payload });

    await callHaWebhook(config.haSmsDlrWebhookId, {
      provider: "vonage",
      type: "sms_dlr",
      method: request.method,
      payload,
    });

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

app.get("/vonage/answer", (_request, response) => {
  try {
    response.json(buildInboundCallNcco());
  } catch (error) {
    logger.error("Answer URL failed", {
      error: error.message ?? String(error),
    });
    response.status(500).json(buildTalkNcco("An internal error occurred."));
  }
});

app.post("/vonage/answer", (_request, response) => {
  try {
    response.json(buildInboundCallNcco());
  } catch (error) {
    logger.error("Answer URL failed", {
      error: error.message ?? String(error),
    });
    response.status(500).json(buildTalkNcco("An internal error occurred."));
  }
});

app.get("/vonage/event", async (request, response) => {
  try {
    await callHaWebhook(config.haCallEventWebhookId, {
      provider: "vonage",
      method: "GET",
      payload: request.query,
    });
  } catch (error) {
    logger.error("Voice event GET handler failed", {
      error: error.response?.data ?? error.message ?? String(error),
    });
  }

  response.status(200).json({ ok: true });
});

app.post("/vonage/event", async (request, response) => {
  try {
    await callHaWebhook(config.haCallEventWebhookId, {
      provider: "vonage",
      method: "POST",
      payload: request.body,
    });
  } catch (error) {
    logger.error("Voice event POST handler failed", {
      error: error.response?.data ?? error.message ?? String(error),
    });
  }

  response.status(200).json({ ok: true });
});

app.get("/ncco/talk", (request, response) => {
  const text =
    request.query.text ?? "This is an automated call from Home Assistant.";
  response.json(buildTalkNcco(text));
});

app.post(
  "/api/send-sms",
  outboundSmsRateLimiter,
  requireInternalToken,
  async (request, response) => {
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
      logger.error("Outbound SMS failed", {
        error: error.response?.data ?? error.message ?? String(error),
      });
      response.status(500).json({
        error: "Outbound SMS failed",
        details: error.response?.data ?? error.message,
      });
    }
  },
);

app.post(
  "/api/call",
  outboundCallRateLimiter,
  requireInternalToken,
  async (request, response) => {
    try {
      const { to, text } = request.body;

      if (!to || !text) {
        response
          .status(400)
          .json({ error: 'Fields "to" and "text" are required' });
        return;
      }

      const result = await createOutboundCall({ to, text });
      response.json(result);
    } catch (error) {
      logger.error("Outbound call failed", {
        error: error.response?.data ?? error.message ?? String(error),
      });
      response.status(500).json({
        error: "Outbound call failed",
        details: error.response?.data ?? error.message,
      });
    }
  },
);

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(config.port, () => {
  logger.info("Server started", {
    version: config.version,
    port: config.port,
    log_level: config.logLevel,
  });
});
