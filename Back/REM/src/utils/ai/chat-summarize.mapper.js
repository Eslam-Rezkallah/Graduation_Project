/**
 * Maps the Python chat summarizer response (snake_case) into the
 * camelCase shape the REST API exposes to the frontend.
 */
export function mapChatSummarizeResponse(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      sinceUtc: null,
      nowUtc: null,
      overallSummary: "",
      channels: [],
      voiceAnalyses: [],
      imageOcr: [],
    };
  }

  return {
    sinceUtc: raw.since_utc ?? null,
    nowUtc: raw.now_utc ?? null,
    overallSummary: raw.overall_summary ?? "",
    channels: (raw.channels ?? []).map((channel) => ({
      channel: channel.channel,
      messageCount: channel.message_count ?? 0,
      summary: channel.summary ?? "",
      voiceAnalyses: channel.voice_analyses ?? [],
      imageOcr: channel.image_ocr ?? [],
    })),
    voiceAnalyses: raw.voice_analyses ?? [],
    imageOcr: raw.image_ocr ?? [],
  };
}
