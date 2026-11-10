/**
 * Build Vonage Voice NCCO and outbound TTS call payloads without depending on
 * a public answer webhook or exposing the API token in a URL.
 */
export function buildTalkNcco(text, language, style) {
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

export function buildOutboundTalkCallPayload({
  to,
  from,
  text,
  language,
  style,
  eventUrl,
}) {
  return {
    to: [{ type: "phone", number: to }],
    from: { type: "phone", number: from },
    ncco: buildTalkNcco(text, language, style),
    event_url: [eventUrl],
  };
}
