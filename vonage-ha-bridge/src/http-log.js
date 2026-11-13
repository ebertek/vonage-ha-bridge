const SECRET_QUERY_PARAMS = new Set([
  "sig",
  "api-key",
  "api_key",
  "nonce",
  "api_secret",
  "api-secret",
  "x-api-token",
  "access_token",
  "authorization",
]);

const PERSONAL_QUERY_PARAMS = new Set(["msisdn"]);

/**
 * REDACT_LOGS=false permits phone number debugging, but never exposes
 * credentials embedded in a URL query string.
 */
export function formatLoggedUrl(rawUrl, { redactLogs = true } = {}) {
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl, "http://x");
    for (const key of url.searchParams.keys()) {
      const name = key.toLowerCase();
      if (
        SECRET_QUERY_PARAMS.has(name) ||
        (redactLogs && PERSONAL_QUERY_PARAMS.has(name))
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }

    return (url.pathname + url.search)
      .replaceAll("%5B", "[")
      .replaceAll("%5D", "]");
  } catch {
    // Never fall back to the unprocessed URL: it may contain a secret.
    return "[invalid-url]";
  }
}
