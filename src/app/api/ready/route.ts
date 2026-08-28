import { probeTcpPort, releaseRevision } from "@/lib/release-status";

export const dynamic = "force-dynamic";

export async function GET() {
  const primaryPort = Number(process.env.VOICE_RELAY_PORT) || 8766;
  const fallbackPort = Number(process.env.OPENAI_VOICE_RELAY_PORT) || 8767;
  const [primaryVoice, fallbackVoice] = await Promise.all([
    probeTcpPort(primaryPort),
    probeTcpPort(fallbackPort),
  ]);
  const ready = primaryVoice && fallbackVoice;
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      service: "aural",
      revision: releaseRevision(),
      checks: {
        primary_voice_relay: primaryVoice,
        fallback_voice_relay: fallbackVoice,
      },
    },
    { status: ready ? 200 : 503 },
  );
}
