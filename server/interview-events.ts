import { createHmac, randomUUID } from "node:crypto";

export interface InterviewEventContext {
  externalCorrelationId?: string | null;
  interviewId?: string;
  sessionId?: string;
  questions?: Array<{ id?: string; text: string; type: string }>;
}

export async function emitInterviewEvent(
  context: InterviewEventContext,
  eventType: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const url = process.env.OPRUN_INTERVIEW_EVENT_URL?.trim();
  const secret = process.env.AURAL_EVENT_WEBHOOK_SECRET?.trim();
  if (!url || !secret || !context.externalCorrelationId) return;

  const body = JSON.stringify({
    event_id: randomUUID(),
    event_type: eventType,
    correlation_id: context.externalCorrelationId,
    interview_id: context.interviewId,
    session_id: context.sessionId,
    occurred_at: new Date().toISOString(),
    aural_version: process.env.AURAL_VERSION || process.env.GIT_COMMIT_SHA || "unknown",
    ...data,
    data,
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-aural-timestamp": timestamp,
          "x-aural-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      if (response.status < 500 && response.status !== 429) return;
    } catch {
      // Retry transient network failures; interview flow must not block on telemetry.
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
}
