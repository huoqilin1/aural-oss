import { generateVoiceSummary } from "@/lib/ai/voice-summary";
import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import {
  handleVoiceSave,
  orderedVoiceMessageTimestamp,
  requireVoiceStorageResult,
  type ActivitySegment,
  type CompletionSession,
  type ProgressSession,
  type VoiceSaveOps,
  type VoiceSavePayload,
} from "./logic";

const log = createLogger("api/voice/save");
const voiceSaveOps: VoiceSaveOps = {
  async insertMessages(sessionId, messages) {
    const batchStartedAtMs = Date.now();
    const result = await supabaseAdmin.from("messages").insert(
      messages.map((m, messageIndex) => ({
        sessionId,
        role: m.role === "user" ? ("USER" as const) : ("ASSISTANT" as const),
        content: m.content,
        contentType: "TEXT" as const,
        questionId: m.questionId || null,
        wordCount: m.content.split(/\s+/).length,
        transcription: m.source === "chat" ? "chat" : null,
        // PostgreSQL's default now() is identical for an entire INSERT. Give
        // each turn a stable millisecond so reconnect hydration can reproduce
        // USER -> ASSISTANT -> USER ordering exactly.
        timestamp: orderedVoiceMessageTimestamp(batchStartedAtMs, messageIndex),
      })),
    );
    requireVoiceStorageResult("insert voice messages", result);
  },
  async loadSessionForCompletion(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select(
        `*, interview:interviews!inner(title, objective, language, userId, projectId, assessmentCriteria, questions(id, text, order, type, description))`,
      )
      .eq("id", sessionId)
      .order("order", {
        referencedTable: "interviews.questions",
        ascending: true,
      })
      .single();

    const data = requireVoiceStorageResult("load completion session", result);
    return (data as CompletionSession | null) ?? null;
  },
  async loadActivitySegments(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select("activitySegments")
      .eq("id", sessionId)
      .single();
    const data = requireVoiceStorageResult("load activity segments", result);
    return ((data?.activitySegments as ActivitySegment[]) ?? []);
  },
  async closeOpenSegments(sessionId, now) {
    const loadResult = await supabaseAdmin
      .from("sessions")
      .select("activitySegments")
      .eq("id", sessionId)
      .single();
    const data = requireVoiceStorageResult("load open activity segments", loadResult);
    const segments = ((data?.activitySegments as ActivitySegment[]) ?? []);
    const closed = segments.map((s) =>
      s.leftAt === null ? { ...s, leftAt: now } : s,
    );
    const updateResult = await supabaseAdmin
      .from("sessions")
      .update({ activitySegments: closed })
      .eq("id", sessionId);
    requireVoiceStorageResult("close activity segments", updateResult);
    return closed;
  },
  async loadMessageTimestamps(sessionId) {
    const result = await supabaseAdmin
      .from("messages")
      .select("timestamp")
      .eq("sessionId", sessionId)
      .order("timestamp", { ascending: true });

    const data = requireVoiceStorageResult("load message timestamps", result);
    return (data ?? []).map((r) => r.timestamp as string);
  },
  async loadAnsweredQuestionIds(sessionId) {
    const result = await supabaseAdmin
      .from("messages")
      .select("questionId")
      .eq("sessionId", sessionId)
      .eq("role", "USER")
      .not("questionId", "is", null);

    const data = requireVoiceStorageResult("load answered question ids", result);
    return (data ?? [])
      .map((row) => row.questionId as string | null)
      .filter((questionId): questionId is string => Boolean(questionId));
  },
  async loadSessionForProgress(sessionId) {
    const result = await supabaseAdmin
      .from("sessions")
      .select(`*, interview:interviews!inner(questions(*))`)
      .eq("id", sessionId)
      .order("order", {
        referencedTable: "interviews.questions",
        ascending: true,
      })
      .single();

    const data = requireVoiceStorageResult("load progress session", result);
    return (data as ProgressSession | null) ?? null;
  },
  async updateSession(sessionId, payload) {
    const result = await supabaseAdmin
      .from("sessions")
      .update(payload)
      .eq("id", sessionId);
    requireVoiceStorageResult("update voice session", result);
  },
  generateSummary: generateVoiceSummary,
  log,
  now: () => new Date(),
};

/**
 * POST /api/voice/save
 * Save voice interview messages, optionally complete the session,
 * and fire-and-forget an AI summary/analysis so the interviewee isn't blocked.
 */
export async function POST(req: Request) {
  let payload: VoiceSavePayload;
  try {
    payload = (await req.json()) as VoiceSavePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = await handleVoiceSave(payload, voiceSaveOps);
  return NextResponse.json(result.body, { status: result.status });
}
