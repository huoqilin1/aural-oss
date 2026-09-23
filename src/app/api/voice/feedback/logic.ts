import { feedbackSchema, maskNotePii } from "@/lib/voice/feedback";

export type FeedbackOps = {
  loadSession(
    sessionId: string,
  ): Promise<{
    status: string;
    interviewId: string;
    publicSlug: string | null;
    isActive: boolean;
  } | null>;
  loadLinkedCandidate(
    inviteToken: string,
    interviewId: string,
  ): Promise<{ sessionId: string | null } | null>;
  /** null 表示写入失败(非唯一冲突) */
  insertFeedback(payload: {
    sessionId: string;
    rating: number;
    tags: string[];
    note: string | null;
  }): Promise<{ conflict: boolean } | null>;
};

/**
 * 匿名反馈核心逻辑(与 voice/save 一样采用 DI,便于无 Supabase 单测):
 * - 邀请场次校验 inviteToken 对应候选人绑定的正是该会话;
 * - 公开场次(sid 直达)要求会话 COMPLETED 且面试公开展示;
 * - 备注里出现的邮箱/电话在入库前抹除。
 */
export async function handleFeedbackSave(
  rawBody: unknown,
  ops: FeedbackOps,
): Promise<{ body: Record<string, unknown>; status: number }> {
  const parsed = feedbackSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_payload" } };
  }
  const { sessionId, inviteToken, rating, tags, note } = parsed.data;

  const session = await ops.loadSession(sessionId);
  if (!session || session.status !== "COMPLETED") {
    return { status: 403, body: { error: "forbidden" } };
  }

  if (inviteToken) {
    const candidate = await ops.loadLinkedCandidate(
      inviteToken,
      session.interviewId,
    );
    if (!candidate || candidate.sessionId !== sessionId) {
      return { status: 403, body: { error: "forbidden" } };
    }
  } else if (!session.publicSlug || !session.isActive) {
    return { status: 403, body: { error: "forbidden" } };
  }

  const result = await ops.insertFeedback({
    sessionId,
    rating,
    tags,
    note: note?.trim() ? maskNotePii(note.trim()) : null,
  });
  if (result === null) {
    return { status: 500, body: { error: "save_failed" } };
  }
  if (result.conflict) {
    return { status: 200, body: { submitted: true, duplicate: true } };
  }
  return { status: 200, body: { submitted: true } };
}
