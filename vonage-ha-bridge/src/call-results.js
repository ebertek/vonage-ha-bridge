import { classifyVoiceCallEvent, summarizeVoiceCallEvent } from "./call-events.js";

const FAILURE_STATUSES = new Set([
  "failed",
  "rejected",
  "busy",
  "unanswered",
  "timeout",
  "cancelled",
]);

/**
 * Normalize an individual Vonage Voice callback for Home Assistant.
 * A completed call with no positive signaling remains "unknown" rather than
 * being misreported as successfully delivered.
 */
export function classifyCallResult(payload, { answered = false } = {}) {
  const event = summarizeVoiceCallEvent(payload);
  const failure = classifyVoiceCallEvent(payload);
  if (failure === "failed" || failure === "webhook_error") {
    return { ...event, outcome: "failed" };
  }
  if (failure === "not_answered" || FAILURE_STATUSES.has(event.status)) {
    return { ...event, outcome: "not_answered" };
  }
  if (event.status === "completed") {
    const success =
      (event.sip_code !== null &&
        event.sip_code >= 200 &&
        event.sip_code < 300) ||
      event.detail === "ok" ||
      answered;
    return { ...event, outcome: success ? "completed" : "unknown" };
  }
  return {
    ...event,
    outcome: event.status === "answered" ? "answered" : "pending",
  };
}

/**
 * Track outbound call events even when they arrive before the API's
 * create-call HTTP response. Entries are bounded and expire after a TTL.
 * No event body or phone number is retained in this tracker.
 */
export class VoiceCallResultTracker {
  constructor({ maxEntries = 2000, retentionMs = 180_000 } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.retentionMs = retentionMs;
  }

  prune(now = Date.now()) {
    for (const [uuid, entry] of this.entries) {
      if (entry.waiters.size === 0 && entry.expiresAt <= now) {
        this.entries.delete(uuid);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value;
      const entry = this.entries.get(first);
      if (entry.waiters.size > 0) {
        break;
      }
      this.entries.delete(first);
    }
  }

  getOrCreate(uuid) {
    let entry = this.entries.get(uuid);
    if (!entry) {
      this.prune();
      entry = {
        answered: false,
        result: null,
        waiters: new Set(),
        expiresAt: Date.now() + this.retentionMs,
      };
      this.entries.set(uuid, entry);
    }
    return entry;
  }

  observe(payload) {
    const event = summarizeVoiceCallEvent(payload);
    const uuid = event.uuid;
    if (!uuid || (event.direction && event.direction !== "outbound")) {
      return;
    }
    // Only record events for known requests or explicitly outbound calls.
    if (event.direction !== "outbound" && !this.entries.has(uuid)) {
      return;
    }

    const entry = this.getOrCreate(uuid);
    entry.expiresAt = Date.now() + this.retentionMs;
    if (entry.result) {
      return;
    }
    if (event.status === "answered") {
      entry.answered = true;
    }
    const result = classifyCallResult(payload, { answered: entry.answered });
    if (
      result.outcome !== "failed" &&
      result.outcome !== "not_answered" &&
      result.outcome !== "completed"
    ) {
      return;
    }

    entry.result = result;
    for (const resolve of entry.waiters) {
      resolve(result);
    }
    entry.waiters.clear();
  }

  wait(uuid, { timeoutMs = 30_000 } = {}) {
    if (!uuid || typeof uuid !== "string") {
      throw new Error("Vonage create-call response is missing a call UUID");
    }
    const entry = this.getOrCreate(uuid);
    if (entry.result) {
      return Promise.resolve(entry.result);
    }

    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        entry.waiters.delete(finish);
        resolve(value);
      };
      entry.waiters.add(finish);
      timer = setTimeout(
        () =>
          finish({
            uuid,
            outcome: "unknown",
            status: "result_timeout",
            sip_code: null,
            detail: null,
          }),
        timeoutMs,
      );
    });
  }
}
