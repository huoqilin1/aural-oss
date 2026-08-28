import {
  isOpenAiFallbackConfigured,
  probeTcpPort,
  releaseRevision,
} from "@/lib/release-status";

export const dynamic = "force-dynamic";

export async function GET() {
  const primaryPort = Number(process.env.VOICE_RELAY_PORT) || 8766;
  const fallbackPort = Number(process.env.OPENAI_VOICE_RELAY_PORT) || 8767;
  const fallbackConfigured = isOpenAiFallbackConfigured();
  const [primaryVoice, fallbackVoice] = await Promise.all([
    probeTcpPort(primaryPort),
    fallbackConfigured ? probeTcpPort(fallbackPort) : Promise.resolve(null),
  ]);
  const ready = primaryVoice && (!fallbackConfigured || fallbackVoice === true);
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      service: "aural",
      revision: releaseRevision(),
      voice_mode: fallbackConfigured ? "primary_with_fallback" : "primary_only",
      checks: {
        primary_voice_relay: primaryVoice,
        fallback_voice_relay: fallbackVoice,
        fallback_voice_relay_configured: fallbackConfigured,
      },
    },
    { status: ready ? 200 : 503 },
  );
}
