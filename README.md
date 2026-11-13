# vonage-ha-bridge

A Node.js bridge between [Vonage](https://www.vonage.com/) (formerly **Nexmo**) and [Home Assistant](https://www.home-assistant.io/) for SMS, phone calls, and notifications.

- Send SMS and text-to-speech (TTS) calls from Home Assistant.
- Route incoming SMS to HA Assist and reply by SMS.
- Forward incoming calls to a phone number or SIP URI.
- Forward Voice events and SMS delivery statuses to HA webhooks.

## Quick start

1. Create a Vonage Application with **Messages (v1)** enabled, and **Voice** if you need calls. Link your virtual number and download the application RSA private key.
2. Configure the application webhooks using your public HTTPS hostname:

   | Capability | Webhook      | URL path                  |
   | ---------- | ------------ | ------------------------- |
   | Messages   | Inbound      | `/vonage/inbound-message` |
   | Messages   | Status       | `/vonage/message-status`  |
   | Voice      | Answer (GET) | `/vonage/answer`          |
   | Voice      | Event (POST) | `/vonage/event`           |

3. Copy `.env.example` to `.env`, set the required variables, and save the private key as `private.key`.
4. Run the container:

   ```bash
   docker run -d --name vonage-ha-bridge \
     --env-file .env \
     -v "$(pwd)/private.key:/run/secrets/private.key:ro" \
     -p 3000:3000 \
     ghcr.io/ebertek/vonage-ha-bridge:latest
   ```

Vonage must reach the webhook endpoints over HTTPS. Keep `/api/*` private (LAN or authenticated reverse proxy). To run without Docker, use Node.js 26: from the `vonage-ha-bridge/` subdirectory, run `npm install` and `node --env-file=../.env src/server.js`, with a valid local private-key path.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) for a ready-to-copy template. Numbers use international format **without** a leading `+`.

### Required

| Variable                  | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `VONAGE_API_KEY`          | Account API key                                                      |
| `VONAGE_APPLICATION_ID`   | Messages-enabled application ID (also used for Voice)                |
| `VONAGE_PRIVATE_KEY_PATH` | Application RSA private key (default: `/run/secrets/private.key`)    |
| `VONAGE_SIGNATURE_SECRET` | Account signature secret for Messages webhook verification           |
| `VONAGE_FROM_NUMBER`      | Vonage virtual number used for outbound SMS and calls                |
| `INTERNAL_API_TOKEN`      | Token required in the `x-api-token` header for internal API requests |

### Voice

| Variable                          | Default | Purpose                                                            |
| --------------------------------- | ------- | ------------------------------------------------------------------ |
| `BASE_URL`                        | —       | Public HTTPS base URL used by Voice callbacks                      |
| `FORWARD_PHONE_NUMBER`            | —       | Destination for inbound call forwarding                            |
| `FORWARD_SIP_URI`                 | —       | SIP forwarding destination; takes precedence over the phone number |
| `DEFAULT_VOICE_LANGUAGE`          | `en-US` | TTS language                                                       |
| `DEFAULT_VOICE_STYLE`             | `0`     | TTS voice style                                                    |
| `VOICE_TTS_LEAD_IN_MS`            | `0`     | Pause before outbound TTS, in ms                                   |
| `VOICE_TTS_LEAD_OUT_MS`           | `0`     | Pause after outbound TTS, in ms                                    |
| `VOICE_WAIT_FOR_RESULT`           | `false` | Wait for a final call outcome before responding to `/api/call`     |
| `VOICE_WAIT_FOR_RESULT_TIMEOUT_S` | `30`    | Maximum wait, 1–120 seconds                                        |

Nonzero TTS pauses must be between 100 and 7,200,000 ms. See [Vonage TTS languages](https://developer.vonage.com/en/voice/voice-api/concepts/text-to-speech#supported-languages).

### Home Assistant

Set `HA_BASE_URL` and `HA_LONG_LIVED_TOKEN` together to enable HA Assist and event forwarding.

| Variable                   | Default             | Purpose                                 |
| -------------------------- | ------------------- | --------------------------------------- |
| `HA_BASE_URL`              | —                   | Home Assistant URL                      |
| `HA_LONG_LIVED_TOKEN`      | —                   | HA long-lived access token              |
| `HA_CALL_EVENT_WEBHOOK_ID` | `vonage_call_event` | Voice event webhook                     |
| `HA_SMS_DLR_WEBHOOK_ID`    | `vonage_sms_dlr`    | SMS delivery status webhook             |
| `HA_ASSIST_AGENT_ID`       | —                   | Assist agent ID; empty uses the default |
| `HA_LANGUAGE`              | `en`                | Assist language                         |
| `ASSIST_TIMEOUT_S`         | `30`                | Assist request timeout, seconds         |

### SMS and server

| Variable                                | Default | Purpose                                            |
| --------------------------------------- | ------- | -------------------------------------------------- |
| `ALLOWED_SMS_SENDERS`                   | all     | Comma-separated sender allowlist                   |
| `SMS_MAX_LENGTH`                        | `1600`  | Maximum SMS text length                            |
| `VALIDATE_VONAGE_WEBHOOK_SIGNATURE`     | `true`  | Verify signed Messages webhooks                    |
| `OUTBOUND_SMS_RATE_LIMIT_MAX_REQUESTS`  | `5`     | SMS requests per destination per window            |
| `OUTBOUND_SMS_RATE_LIMIT_WINDOW_S`      | `15`    | SMS rate-limit window, seconds                     |
| `OUTBOUND_CALL_RATE_LIMIT_MAX_REQUESTS` | `3`     | Call requests per destination per window           |
| `OUTBOUND_CALL_RATE_LIMIT_WINDOW_S`     | `300`   | Call rate-limit window, seconds                    |
| `OUTBOUND_TIMEOUT_S`                    | `10`    | Outbound HTTP timeout, seconds                     |
| `PORT`                                  | `3000`  | HTTP listener port                                 |
| `LOG_LEVEL`                             | `info`  | `debug`, `info`, `warning`, or `error`             |
| `REDACT_LOGS`                           | `true`  | Hide phone numbers and message text in diagnostics |
| `APP_VERSION`                           | `dev`   | Version label (normally supplied by the image)     |

When `REDACT_LOGS=false`, diagnostic logs may include phone numbers and TTS text; URL authentication parameters remain masked. Messages webhooks should use signature verification in production.

## API

Internal endpoints require `x-api-token: <INTERNAL_API_TOKEN>`.

| Method | Path            | Description                                                      |
| ------ | --------------- | ---------------------------------------------------------------- |
| `POST` | `/api/send-sms` | Send an SMS (body: `to`, `text`, optional `clientRef`)           |
| `POST` | `/api/call`     | Place a TTS call (body: `to`, `text`, and optional fields below) |
| `GET`  | `/health`       | Health check                                                     |
| `GET`  | `/version`      | Version information (token required)                             |

Example call:

```json
{
  "to": "12025550123",
  "text": "Water leak detected!",
  "mode": "talk",
  "waitForResult": true,
  "timeoutSeconds": 30
}
```

`mode` defaults to `talk` (inline TTS NCCO); `connect` also supports `dtmfAnswer` / `dtmf_answer`. Optional `language` and `style` override the TTS defaults. `waitForResult` and `timeoutSeconds` override the Voice environment settings per call.

### Call results

Without waiting, HTTP 200 means **Vonage accepted the request**, not that the call succeeded. With waiting enabled:

| HTTP status | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `200`       | Call completed successfully                                             |
| `502`       | Call failed, was rejected, or was not answered                          |
| `504`       | Final result not confirmed before timeout; the call may still be active |

The bridge does not retry or hang up calls automatically. Every Voice event is also forwarded to the HA webhook with the original `payload` and a normalized `call_result`, so automations can handle failures asynchronously.

**Home Assistant:** set your `rest_command` timeout higher than the Voice wait (for example, 45 seconds for a 30-second wait). HA does not automatically fail an automation for HTTP 502/504; inspect `response_variable.status`. See [Home Assistant examples](docs/home-assistant.md) for REST commands, failure handling, and notifications.

## Security

- Keep `INTERNAL_API_TOKEN` private and restrict `/api/*` to trusted clients.
- Messages callbacks are verified using the account signature secret and payload hash by default.
- Voice callback signature validation is not currently implemented; restrict and monitor public Voice webhook access as appropriate.
- Logs are JSON on stdout. The image runs as a non-root user and includes a `/health` check.

The source and container image are available at [GitHub](https://github.com/ebertek/vonage-ha-bridge) and [GHCR](https://github.com/ebertek/vonage-ha-bridge/pkgs/container/vonage-ha-bridge).

## Alternatives

- [attilaszasz/vonage-homeassistant](https://github.com/attilaszasz/vonage-homeassistant) — Home Assistant Notify integration.
- [codefoster/core Vonage integration](https://github.com/codefoster/core/tree/codefoster/vonage/homeassistant/components/vonage) — another Home Assistant integration ([demo](https://www.youtube.com/watch?v=GPKvOXJXX3I)).
