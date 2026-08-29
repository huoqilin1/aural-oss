import assert from "node:assert/strict";
import test from "node:test";
import {
  planSessionFinalization,
  type LiveSessionRecord,
} from "../server/session-finalization";
import {
  COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS,
  RECRUITMENT_CLOSING_FALLBACK_MS,
  completionAutoCloseDelayMs,
  recruitmentClosingAutoCloseDelayMs,
  shouldBlockRecruitmentCompletion,
} from "../src/lib/voice/completion-auto-close";

const GRACE = 10 * 60_000;

test("completed farewell has a bounded save fallback when playback never settles", () => {
  assert.equal(
    completionAutoCloseDelayMs({
      interviewComplete: true,
      locallyCompleted: false,
      hasVisibleFarewell: true,
      farewellReadyToClose: false,
    }),
    COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS,
  );
});

test("naturally finished farewell owns the normal close path", () => {
  assert.equal(
    completionAutoCloseDelayMs({
      interviewComplete: true,
      locallyCompleted: false,
      hasVisibleFarewell: true,
      farewellReadyToClose: true,
    }),
    null,
  );
});

test("authoritative recruitment completion can save after an unscored closing item", () => {
  assert.equal(
    shouldBlockRecruitmentCompletion({
      isRecruitmentInterview: true,
      interviewComplete: true,
      totalQuestions: 9,
      currentQuestionIndex: 8,
      answeredCurrentQuestion: false,
      plannedMainQuestionCount: 8,
    }),
    false,
  );
});

test("recruitment completion remains blocked before all scored questions finish", () => {
  assert.equal(
    shouldBlockRecruitmentCompletion({
      isRecruitmentInterview: true,
      interviewComplete: false,
      totalQuestions: 8,
      currentQuestionIndex: 6,
      answeredCurrentQuestion: true,
      plannedMainQuestionCount: 8,
    }),
    true,
  );
});

test("eight answered scored questions can still use the normal end path", () => {
  assert.equal(
    shouldBlockRecruitmentCompletion({
      isRecruitmentInterview: true,
      interviewComplete: false,
      totalQuestions: 8,
      currentQuestionIndex: 7,
      answeredCurrentQuestion: true,
      plannedMainQuestionCount: 8,
    }),
    false,
  );
});

test("answered unscored closing item can use the normal end path", () => {
  assert.equal(
    shouldBlockRecruitmentCompletion({
      isRecruitmentInterview: true,
      interviewComplete: false,
      totalQuestions: 9,
      currentQuestionIndex: 8,
      answeredCurrentQuestion: true,
      plannedMainQuestionCount: 8,
    }),
    false,
  );
});

test("unexpected extra recruitment items remain blocked", () => {
  assert.equal(
    shouldBlockRecruitmentCompletion({
      isRecruitmentInterview: true,
      interviewComplete: false,
      totalQuestions: 10,
      currentQuestionIndex: 9,
      answeredCurrentQuestion: true,
      plannedMainQuestionCount: 8,
    }),
    true,
  );
});

test("idle answered recruitment closing has a bounded save fallback", () => {
  assert.equal(
    recruitmentClosingAutoCloseDelayMs({
      isRecruitmentInterview: true,
      locallyCompleted: false,
      isCandidateClosing: true,
      answeredCurrentQuestion: true,
      isListening: false,
      isSpeaking: false,
      isProcessing: false,
      isTransitioning: false,
    }),
    RECRUITMENT_CLOSING_FALLBACK_MS,
  );
});

test("recruitment closing fallback waits while the candidate or AI is active", () => {
  assert.equal(
    recruitmentClosingAutoCloseDelayMs({
      isRecruitmentInterview: true,
      locallyCompleted: false,
      isCandidateClosing: true,
      answeredCurrentQuestion: true,
      isListening: false,
      isSpeaking: false,
      isProcessing: true,
      isTransitioning: false,
    }),
    null,
  );
});

function record(overrides: Partial<LiveSessionRecord> = {}): LiveSessionRecord {
  return {
    sessionId: "s1",
    startedAtMs: 0,
    lastActiveAtMs: 0,
    timeLimitMinutes: 32,
    isRecruitmentInterview: false,
    status: "live",
    ...overrides,
  };
}

test("planSessionFinalization keeps a live, active session untouched", () => {
  const now = 5 * 60_000;
  assert.equal(
    planSessionFinalization(record({ lastActiveAtMs: now - 1_000 }), now, GRACE),
    null,
  );
});

test("planSessionFinalization abandons after disconnect grace", () => {
  // 会话整体没超硬限(20 分钟 < 32 分钟),但最后消息已是 20 分钟前
  const now = 20 * 60_000;
  const plan = planSessionFinalization(
    record({ lastActiveAtMs: 0 }),
    now,
    GRACE,
  );
  assert.deepEqual(plan, { status: "ABANDONED", reason: "candidate_disconnected" });
});

test("planSessionFinalization force-completes at hard limit even while active", () => {
  // 后台挂着一直"活跃"也不能超 32 分钟硬限(+60s 缓冲)
  const now = 32 * 60_000 + 61_000;
  const plan = planSessionFinalization(
    record({ lastActiveAtMs: now - 1_000 }),
    now,
    GRACE,
  );
  assert.deepEqual(plan, { status: "COMPLETED", reason: "server_time_limit" });
});

test("active recruitment sessions are never force-completed by a time limit", () => {
  const now = 95 * 60_000;
  const plan = planSessionFinalization(
    record({
      isRecruitmentInterview: true,
      lastActiveAtMs: now - 1_000,
    }),
    now,
    GRACE,
  );
  assert.equal(plan, null);
});

test("planSessionFinalization ignores already-ended records", () => {
  const now = 5 * 60_000;
  assert.equal(
    planSessionFinalization(record({ status: "ended", lastActiveAtMs: 0 }), now, GRACE),
    null,
  );
});

test("planSessionFinalization without a time limit only uses disconnect grace", () => {
  const now = 90 * 60_000;
  assert.equal(
    planSessionFinalization(
      record({ timeLimitMinutes: null, lastActiveAtMs: now - 1_000 }),
      now,
      GRACE,
    ),
    null,
  );
  assert.deepEqual(
    planSessionFinalization(
      record({ timeLimitMinutes: null, lastActiveAtMs: 0 }),
      now,
      GRACE,
    ),
    { status: "ABANDONED", reason: "candidate_disconnected" },
  );
});

test("planSessionFinalization prefers the hard limit over disconnect grace", () => {
  // 同时满足两条时,硬限优先(挂着不说话也按时结束,而不是判放弃)
  const now = 32 * 60_000 + 61_000;
  const plan = planSessionFinalization(record({ lastActiveAtMs: 0 }), now, GRACE);
  assert.deepEqual(plan, { status: "COMPLETED", reason: "server_time_limit" });
});

test("planSessionFinalization keeps a disconnected session live within grace", () => {
  // 关页后 5 分钟(未到 10 分钟宽限):给候选人重连机会,不判定
  const now = 5 * 60_000;
  assert.equal(
    planSessionFinalization(record({ lastActiveAtMs: 0 }), now, GRACE),
    null,
  );
});
