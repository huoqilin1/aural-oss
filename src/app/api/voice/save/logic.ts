export type VoiceSavePayload = {
  sessionId?: string;
  messages?: Array<{
    role: string;
    content: string;
    questionId?: string;
    source?: string;
    timestamp?: string;
    messageId?: string;
  }>;
  complete?: boolean;
  currentQuestionIndex?: number;
};

export type ActivitySegment = { enteredAt: string; leftAt: string | null };

type StorageResult<T> = {
  data: T;
  error: { code?: string | null } | null;
};

export class VoiceStorageError extends Error {
  constructor(operation: string, public readonly code: string) {
    super(`${operation} failed (${code})`);
  }
}

export function requireVoiceStorageResult<T>(
  operation: string,
  result: StorageResult<T>,
): T {
  if (result.error) {
    throw new VoiceStorageError(operation, result.error.code || "unknown");
  }
  return result.data;
}

const ACTIVITY_GAP_CAP_MS = 5 * 60 * 1000;
const STALE_SESSION_GRACE_MS = 10 * 60 * 1000;

/** Preserve transcript order when a progress batch is inserted in one query. */
export function orderedVoiceMessageTimestamp(
  batchStartedAtMs: number,
  messageIndex: number,
): string {
  const safeIndex = Number.isInteger(messageIndex) && messageIndex > 0
    ? messageIndex
    : 0;
  return new Date(batchStartedAtMs + safeIndex).toISOString();
}

/**
 * For IN_PROGRESS sessions, caps the effective "now" so that abandoned
 * sessions don't accumulate unbounded duration. If the session's last
 * activity was more than STALE_SESSION_GRACE_MS ago, we treat the session
 * as having ended shortly after that last activity.
 */
export function effectiveNowForSession(
  lastActivityAt: string | null | undefined,
  nowMs: number,
): number {
  if (!lastActivityAt) return nowMs;
  const lastMs = new Date(lastActivityAt).getTime();
  if (Number.isNaN(lastMs)) return nowMs;
  return Math.min(nowMs, lastMs + STALE_SESSION_GRACE_MS);
}

export function computeSegmentDuration(
  segments: ActivitySegment[],
  nowMs: number,
): number {
  let totalMs = 0;
  for (const seg of segments) {
    const start = new Date(seg.enteredAt).getTime();
    const end = seg.leftAt ? new Date(seg.leftAt).getTime() : nowMs;
    if (end > start) totalMs += end - start;
  }
  return Math.round(totalMs / 1000);
}

/**
 * Fallback for pre-migration sessions without activity segments.
 * Sums gaps between consecutive message timestamps, capping each gap
 * at 5 minutes to exclude idle periods.
 */
export function computeMessageBasedDuration(
  sessionStartMs: number,
  messageTimestamps: number[],
  endMs: number,
): number {
  const points = [sessionStartMs, ...messageTimestamps, endMs].sort(
    (a, b) => a - b,
  );
  let totalMs = 0;
  for (let i = 1; i < points.length; i++) {
    totalMs += Math.min(points[i] - points[i - 1], ACTIVITY_GAP_CAP_MS);
  }
  return Math.round(totalMs / 1000);
}

export type CompletionSession = {
  status: string;
  voiceRevision?: number;
  startedAt: string;
  lastActivityAt?: string | null;
  activitySegments: unknown;
  interview: {
    title: string;
    objective: string | null;
    language: string;
    userId: string;
    projectId: string;
    assessmentCriteria: { name: string; description: string }[] | null;
    questions: {
      id?: string;
      text: string;
      order: number;
      type?: string;
      description?: string | null;
    }[];
  };
};

export type ProgressSession = {
  interview: {
    questions: { id: string }[];
  };
};

export type VoiceSaveOps = {
  insertMessages: (
    sessionId: string,
    messages: NonNullable<VoiceSavePayload["messages"]>,
  ) => Promise<void>;
  loadSessionForCompletion: (
    sessionId: string,
  ) => Promise<CompletionSession | null>;
  loadActivitySegments: (sessionId: string) => Promise<ActivitySegment[]>;
  closeOpenSegments: (
    sessionId: string,
    now: string,
  ) => Promise<ActivitySegment[]>;
  loadMessageTimestamps: (sessionId: string) => Promise<string[]>;
  loadAnsweredQuestionIds: (sessionId: string) => Promise<string[]>;
  loadSessionForProgress: (sessionId: string) => Promise<ProgressSession | null>;
  updateSession: (
    sessionId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  generateSummary: (
    sessionId: string,
    interviewTitle: string,
    objective?: string | null,
    language?: string | null,
    questions?: { text: string; order: number; type?: string }[] | null,
    assessmentCriteria?: { name: string; description: string }[] | null,
    ownerUserId?: string,
    projectId?: string,
  ) => Promise<void>;
  log: {
    info: (message: string) => void;
    error: (...args: unknown[]) => void;
  };
  now: () => Date;
};

export async function handleVoiceSave(
  payload: VoiceSavePayload,
  ops: VoiceSaveOps,
): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {status: 400, body: {error: 'Invalid voice save payload'}};
  }
  const { sessionId, messages, complete, currentQuestionIndex } = payload;

  if (!sessionId) {
    return { status: 400, body: { error: "Missing sessionId" } };
  }
  if (typeof sessionId !== 'string' ||
      (complete !== undefined && typeof complete !== 'boolean') ||
      (currentQuestionIndex !== undefined && (!Number.isInteger(currentQuestionIndex) || currentQuestionIndex < 0)) ||
      (messages !== undefined && (!Array.isArray(messages) || messages.some(message =>
        !message || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim())))) {
    return {status: 400, body: {error: 'Invalid voice save payload'}};
  }

  try {
    if (messages && Array.isArray(messages) && messages.length > 0) {
      if (messages.some(message => message.messageId !== undefined && (
        typeof message.messageId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.messageId)
      ))) {
        return {status: 400, body: {error: 'Invalid message identity'}};
      }
      if (messages.some(message => message.timestamp !== undefined && (
        typeof message.timestamp !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(message.timestamp) ||
        !Number.isFinite(Date.parse(message.timestamp))
      ))) {
        return {status: 400, body: {error: 'Invalid message timestamp; an explicit timezone is required'}};
      }
      await ops.insertMessages(sessionId, messages);
    }

    if (complete) {
      const session = await ops.loadSessionForCompletion(sessionId);
      if (!session) {
        return { status: 404, body: { error: "Interview session not found" } };
      }

      if (session) {
        const isRecruitment = /^数君招聘\s*·\s*/.test(session.interview.title);
        // Recruitment completion is fail-closed even when another process has
        // already written COMPLETED.  The relay cannot authoritatively know
        // whether all question-bound USER messages reached storage, so an
        // early relay status must never bypass the eight-answer contract.
        if (isRecruitment) {
          const requiredQuestionIds = session.interview.questions
            .filter((question) =>
              /^oprun_dimension:(?!candidate_closing)/.test(
                String(question.description || ""),
              ),
            )
            .map((question) => question.id)
            .filter((questionId): questionId is string => Boolean(questionId));
          if (requiredQuestionIds.length !== 8 || new Set(requiredQuestionIds).size !== 8) {
            return {
              status: 409,
              body: { error: "八道正式题尚未完整准备，暂不能结束面试，请稍后重试" },
            };
          }
          if (requiredQuestionIds.length === 8) {
            const answered = new Set(await ops.loadAnsweredQuestionIds(sessionId));
            const missingCount = requiredQuestionIds.filter(
              (questionId) => !answered.has(questionId),
            ).length;
            if (missingCount > 0) {
              return {
                status: 409,
                body: {
                  error: `还有 ${missingCount} 道正式题的回答未完成同步，请稍后重试`,
                },
              };
            }
          }
        }
        if (session.status === "COMPLETED") {
          return { status: 200, body: { ok: true } };
        }
        const now = ops.now();
        const cappedNowMs = effectiveNowForSession(session.lastActivityAt, now.getTime());
        const cappedNow = new Date(cappedNowMs).toISOString();
        const segments = await ops.closeOpenSegments(sessionId, cappedNow);
        let duration: number;
        if (segments.length > 0) {
          duration = computeSegmentDuration(segments, cappedNowMs);
        } else {
          const timestamps = await ops.loadMessageTimestamps(sessionId);
          const msgTimesMs = timestamps.map((t) => new Date(t).getTime());
          duration = computeMessageBasedDuration(
            new Date(session.startedAt).getTime(),
            msgTimesMs,
            cappedNowMs,
          );
        }

        await ops.updateSession(sessionId, {
          status: "COMPLETED" as const,
          ...(isRecruitment ? {completedVoiceRevision: session.voiceRevision ?? null} : {}),
          completedAt: now.toISOString(),
          totalDurationSeconds: duration,
        });

        ops.log.info(`Session ${sessionId} marked COMPLETED (${duration}s)`);

        const interview = session.interview;
        ops
          .generateSummary(
            sessionId,
            interview.title,
            interview.objective,
            interview.language,
            interview.questions,
            interview.assessmentCriteria,
            interview.userId,
            interview.projectId,
          )
          .catch((err) => {
            ops.log.error("Background summary generation failed:", err);
          });
      }
    } else if (typeof currentQuestionIndex === "number") {
      const session = await ops.loadSessionForProgress(sessionId);

      if (session) {
        const questions = session.interview?.questions ?? [];
        const question = questions[currentQuestionIndex];
        await ops.updateSession(sessionId, {
          ...(question ? { currentQuestionId: question.id } : {}),
          lastActivityAt: ops.now().toISOString(),
        });

        ops.log.info(
          `Progress saved for session ${sessionId} at question ${currentQuestionIndex + 1}`,
        );
      }
    } else {
      await ops.updateSession(sessionId, {
        lastActivityAt: ops.now().toISOString(),
      });

      ops.log.info(`Heartbeat saved for session ${sessionId}`);
    }

    return { status: 200, body: { ok: true } };
  } catch (error) {
    ops.log.error("Voice save error:", error);
    if (error instanceof VoiceStorageError && ['PVR01', 'PVR02', 'PVR03', 'PVR04'].includes(error.code)) {
      return {status: 409, body: {error: error.code === 'PVR04'
        ? '回答题目与当前面试不一致，尚未保存。请保留页面并联系招聘负责人核实。'
        : error.code === 'PVR02'
        ? '面试记录已结束，本次补充尚未纳入报告。请保留页面并联系招聘负责人核实。'
        : '回答记录仍在更新或尚未完整保存，请稍后重试结束面试。'}};
    }
    return { status: 500, body: { error: "Failed to save voice data" } };
  }
}
