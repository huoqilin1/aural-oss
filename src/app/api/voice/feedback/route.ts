import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { handleFeedbackSave, type FeedbackOps } from "./logic";
import {sessionAccessResponse} from '@/server/session-access-http';

const log = createLogger("api/voice/feedback");

const feedbackOps: FeedbackOps = {
  async loadSession(sessionId) {
    const { data } = await supabaseAdmin
      .from("sessions")
      .select(
        "status, interviewId, interview:interviews!inner(publicSlug, isActive)",
      )
      .eq("id", sessionId)
      .maybeSingle();
    if (!data) return null;
    const interview = data.interview as unknown as {
      publicSlug: string | null;
      isActive: boolean;
    } | null;
    return {
      status: data.status,
      interviewId: data.interviewId,
      publicSlug: interview?.publicSlug ?? null,
      isActive: interview?.isActive ?? false,
    };
  },
  async loadLinkedCandidate(inviteToken, interviewId) {
    const { data } = await supabaseAdmin
      .from("candidates")
      .select("sessionId")
      .eq("inviteToken", inviteToken)
      .eq("interviewId", interviewId)
      .maybeSingle();
    return data as { sessionId: string | null } | null;
  },
  async insertFeedback(payload) {
    const { error } = await supabaseAdmin
      .from("session_feedback")
      .insert(payload);
    if (!error) return { conflict: false };
    if (error.code === "23505") return { conflict: true };
    log.error("Feedback insert failed:", error);
    return null;
  },
};

/**
 * POST /api/voice/feedback
 * 完成页匿名反馈。每场会话只写入一条(UNIQUE "sessionId"),
 * 重复提交幂等返回已提交。
 */
export async function POST(req: Request) {
  const rawBody = await req.json().catch(() => null);
  const denied=await sessionAccessResponse(rawBody?.sessionId);
  if(denied)return denied;
  const result = await handleFeedbackSave(rawBody, feedbackOps);
  return NextResponse.json(result.body, { status: result.status });
}
