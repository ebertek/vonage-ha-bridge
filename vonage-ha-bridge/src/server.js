import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "node:fs";
import crypto from "node:crypto";
import axios from "axios";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();

app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  haAssistAgentId: process.env.HA_ASSIST_AGENT_ID ?? "",
  haLanguage: process.env.HA_LANGUAGE ?? "en",
  vonageApiKey: process.env.VONAGE_API_KEY ?? "",
  vonageApiSecret: process.env.VONAGE_API_SECRET ?? "",
  vonageSignatureSecret: process.env.VONAGE_SIGNATURE_SECRET ?? "",
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

if (!config.baseUrl) {
  console.warn("[config] BASE_URL not set — voice features will not work");
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
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortObjectKeys(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function isValidVonageSmsSignature(request) {
  if (!config.validateVonageSmsSignature) {
    return true;
  }

  if (!config.vonageSignatureSecret) {
    console.error(
      "Vonage SMS signature validation enabled, but VONAGE_SIGNATURE_SECRET is missing.",
    );
    return false;
  }

  const providedSignature =
    request.body.sig ??
    request.query.sig ??
    request.header("x-nexmo-signature") ??
    "";

  if (!providedSignature) {
    return false;
  }

  const sourcePayload = request.method === "GET" ? request.query : request.body;
  const payload = { ...sourcePayload };
  delete payload.sig;

  const serialized = Object.entries(sortObjectKeys(payload))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const expectedSignature = crypto
    .createHash("md5")
    .update(serialized + config.vonageSignatureSecret, "utf8")
    .digest("hex");

  return (
    expectedSignature.toLowerCase() === String(providedSignature).toLowerCase()
  );
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

async function sendSms({ to, text }) {
  const payload = new URLSearchParams({
    api_key: config.vonageApiKey,
    api_secret: config.vonageApiSecret,
    to: normalizePhoneNumber(to),
    from: config.vonageFromNumber,
    text: sanitizeSmsText(text),
  });

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

  console.log("[SMS] sent", result.data);
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

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

async function handleInboundSms(request, response) {
  try {
    if (!isValidVonageSmsSignature(request)) {
      console.warn("Rejected inbound SMS due to invalid Vonage signature.");
      response.status(403).json({ error: "Invalid signature" });
      return;
    }

    const payload = request.method === "GET" ? request.query : request.body;

    const from = normalizePhoneNumber(payload.msisdn ?? payload.from ?? "");
    const text = sanitizeSmsText(payload.text);
    console.log("[SMS] inbound", { from, text });

    if (!from || !text) {
      response.status(200).json({ ok: true });
      return;
    }

    if (!isAuthorizedSender(from)) {
      await sendSms({
        to: from,
        text: "Unauthorized sender.",
      });

      response.status(200).json({ ok: true });
      return;
    }

    let replyText;

    try {
      const assistResponse = await callHaConversation({ from, text });
      replyText = extractAssistReply(assistResponse);
    } catch (error) {
      console.error(
        "Home Assistant Assist request failed:",
        error.response?.data ?? error.message,
      );
      replyText = "Error communicating with Home Assistant.";
    }

    console.log("[SMS] replying", { to: from, replyText });
    await sendSms({
      to: from,
      text: replyText,
    });

    response.status(200).json({ ok: true });
  } catch (error) {
    console.error("[SMS] reply failed", error.response?.data ?? error);
    response.status(500).json({
      error: "Inbound SMS handling failed",
    });
  }
}

app.get("/vonage/sms", handleInboundSms);
app.post("/vonage/sms", handleInboundSms);

app.get("/vonage/answer", (_request, response) => {
  try {
    response.json(buildInboundCallNcco());
  } catch (error) {
    console.error("Answer URL failed:", error);
    response.status(500).json(buildTalkNcco("An internal error occurred."));
  }
});

app.post("/vonage/answer", (_request, response) => {
  try {
    response.json(buildInboundCallNcco());
  } catch (error) {
    console.error("Answer URL failed:", error);
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
    console.error(
      "Voice event GET handler failed:",
      error.response?.data ?? error,
    );
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
    console.error(
      "Voice event POST handler failed:",
      error.response?.data ?? error,
    );
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
      const { to, text } = request.body;

      if (!to || !text) {
        response
          .status(400)
          .json({ error: 'Fields "to" and "text" are required' });
        return;
      }

      const result = await sendSms({ to, text });
      response.json(result);
    } catch (error) {
      console.error(
        "Outbound SMS failed:",
        error.response?.data ?? error.message,
      );
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
      console.error(
        "Outbound call failed:",
        error.response?.data ?? error.message,
      );
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
  console.log(`Vonage HA bridge listening on port ${config.port}`);
});
