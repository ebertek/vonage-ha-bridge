/**
 * Build Vonage Voice NCCO and outbound TTS call payloads without depending on
 * a public answer webhook or exposing the API token in a URL.
 */
// Vonage wait actions accept 0.1–7200 seconds. Zero disables the wait.
export function isValidVoiceTtsWaitMs(value) {
  return (
    Number.isInteger(value) &&
    (value === 0 || (value >= 100 && value <= 7_200_000))
  );
}

function optionalWaitNcco(milliseconds) {
  if (!isValidVoiceTtsWaitMs(milliseconds)) {
    throw new RangeError(
      "Voice TTS wait must be 0 or 100–7200000 milliseconds",
    );
  }

  return milliseconds === 0
    ? []
    : [{ action: "wait", timeout: milliseconds / 1000 }];
}

export function buildTalkNcco(
  text,
  language,
  style,
  { leadInMs = 0, leadOutMs = 0 } = {},
) {
  return [
    ...optionalWaitNcco(leadInMs),
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
    ...optionalWaitNcco(leadOutMs),
  ];
}

export function buildOutboundTalkCallPayload({
  to,
  from,
  text,
  language,
  style,
  eventUrl,
  leadInMs = 0,
  leadOutMs = 0,
}) {
  return {
    to: [{ type: "phone", number: to }],
    from: { type: "phone", number: from },
    ncco: buildTalkNcco(text, language, style, { leadInMs, leadOutMs }),
    event_url: [eventUrl],
  };
}
