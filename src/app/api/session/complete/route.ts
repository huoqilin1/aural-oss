import {
  computeMessageBasedDuration,
  computeSegmentDuration,
  effectiveNowForSession,
  requireVoiceStorageResult,
  VoiceStorageError,
  type ActivitySegment,
} from "@/app/api/voice/save/logic";
import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import {sessionAccessResponse} from '@/server/session-access-http';

const log = createLogger("api/session/complete");

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const sessionId = body?.sessionId;
    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const denied=await sessionAccessResponse(sessionId);
    if(denied)return denied;
    const sessionResult = await supabaseAdmin
      .from("sessions")
      .select("id, status, startedAt, lastActivityAt, interviewId, activitySegments, voiceRevision")
      .eq("id", sessionId)
      .single();
    const session = requireVoiceStorageResult('load safety-net completion version', sessionResult);

    if (!session) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (session.status === "COMPLETED") {
      return NextResponse.json({ ok: true, alreadyCompleted: true });
    }

    const now = new Date();
    const cappedNowMs = effectiveNowForSession(session.lastActivityAt as string | null, now.getTime());
    const cappedNowIso = new Date(cappedNowMs).toISOString();
    const segments = ((session.activitySegments ?? []) as ActivitySegment[]);
    const closed = segments.map((s) =>
      s.leftAt === null ? { ...s, leftAt: cappedNowIso } : s,
    );

    let duration: number;
    if (closed.length > 0) {
      duration = computeSegmentDuration(closed, cappedNowMs);
    } else {
      const messageResult = await supabaseAdmin
        .from("messages")
        .select("timestamp")
        .eq("sessionId", sessionId)
        .order("timestamp", { ascending: true });
      const msgRows = requireVoiceStorageResult('load completion timestamps', messageResult);
      const msgTimesMs = (msgRows ?? []).map((r) => new Date(r.timestamp as string).getTime());
      duration = computeMessageBasedDuration(
        new Date(session.startedAt as string).getTime(),
        msgTimesMs,
        cappedNowMs,
      );
    }

    const completionResult = await supabaseAdmin
      .from("sessions")
      .update({
        status: "COMPLETED" as const,
        completedVoiceRevision: session.voiceRevision,
        completedAt: now.toISOString(),
        activitySegments: closed,
        totalDurationSeconds: duration,
      })
      .eq("id", sessionId).select('id').maybeSingle();
    requireVoiceStorageResult('persist safety-net completion', completionResult);
    if (!completionResult.data) return NextResponse.json({error:'Interview session no longer exists'}, {status:404});

    log.info(`Session ${sessionId} completed via safety-net (${duration}s)`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof VoiceStorageError && ['PVR01','PVR02','PVR03'].includes(error.code)) {
      return NextResponse.json({error:'回答尚未完整确认，请返回面试页面重试保存。'}, {status:409});
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
