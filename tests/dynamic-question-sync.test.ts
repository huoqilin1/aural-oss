import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateFacingQuestionCount,
  isInternalQuestionDescription,
  isProgressiveOpeningOnly,
  mergeExpandedQuestionSet,
  shouldWaitForQuestionExpansion,
} from "../src/lib/voice/dynamic-question-sync";
import { buildInviteResumeState } from "../src/lib/voice/invite-resume-state";

const opening = {
  text: "固定开场题",
  order: 0,
  description: "oprun_dimension:communication",
};

const openingWithFallback = [
  opening,
  { text: "条件式岗位过渡题", order: 1, description: "oprun_dimension:job_duty_primary" },
];

const evidenceOpening = {
  text: "计分自我介绍",
  order: 0,
  description: "oprun_dimension:core_experience",
};

const evidenceOpeningWithFallback = [
  evidenceOpening,
  {
    text: "候选人专属项目所有权题",
    order: 1,
    description: "oprun_dimension:project_ownership",
  },
];

test("recognizes Q1 plus the optional fallback Q2 as incomplete", () => {
  assert.equal(isProgressiveOpeningOnly([opening]), true);
  assert.equal(isProgressiveOpeningOnly(openingWithFallback), true);
  assert.equal(isProgressiveOpeningOnly([evidenceOpening]), true);
  assert.equal(isProgressiveOpeningOnly(evidenceOpeningWithFallback), true);
  assert.equal(
    isProgressiveOpeningOnly([{ text: "独立单题", order: 0, description: null }]),
    false,
  );
  assert.equal(
    isProgressiveOpeningOnly([
      ...openingWithFallback,
      { text: "岗位协作", order: 2, description: "oprun_dimension:job_duty_secondary" },
      { text: "核心经历", order: 3, description: "oprun_dimension:core_experience" },
      { text: "问题解决", order: 4, description: "oprun_dimension:problem_solving" },
      { text: "AI 协作", order: 5, description: "oprun_dimension:ai_collaboration" },
      { text: "学习", order: 6, description: "oprun_dimension:learning" },
      { text: "动机", order: 7, description: "oprun_dimension:motivation_stability" },
    ]),
    false,
  );
});

test("advances from Q1 to an available fallback Q2 without waiting", () => {
  assert.equal(shouldWaitForQuestionExpansion([opening], 0), true);
  assert.equal(shouldWaitForQuestionExpansion(openingWithFallback, 0), false);
  assert.equal(shouldWaitForQuestionExpansion(openingWithFallback, 1), true);
  assert.equal(shouldWaitForQuestionExpansion(evidenceOpeningWithFallback, 0), false);
  assert.equal(shouldWaitForQuestionExpansion(evidenceOpeningWithFallback, 1), true);
});

test("never exposes a progressive seed as the candidate-facing total", () => {
  assert.equal(candidateFacingQuestionCount([opening]), 8);
  assert.equal(candidateFacingQuestionCount(openingWithFallback), 8);
  assert.equal(candidateFacingQuestionCount(evidenceOpeningWithFallback), 8);
  assert.equal(
    candidateFacingQuestionCount([
      { text: "普通题一", order: 0, description: null },
      { text: "普通题二", order: 1, description: null },
    ]),
    2,
  );
});

test("recognizes internal question metadata that candidates must not see", () => {
  assert.equal(isInternalQuestionDescription("oprun_dimension:communication"), true);
  assert.equal(isInternalQuestionDescription("条件式岗位过渡题"), true);
  assert.equal(isInternalQuestionDescription("请结合实际案例作答"), false);
});

test("expands a live one-question snapshot without changing the active opening", () => {
  const generated = [
    opening,
    ...Array.from({ length: 8 }, (_, index) => ({
      text: `生成题 ${index + 2}`,
      order: index + 1,
      description: `oprun_dimension:dimension_${index + 2}`,
    })),
  ];

  const merged = mergeExpandedQuestionSet([opening], generated, 0);
  assert.equal(merged?.length, 9);
  assert.equal(merged?.[0].text, opening.text);
  assert.equal(merged?.[1].text, "生成题 2");
});

test("rejects an expansion that mutates an already active question", () => {
  const merged = mergeExpandedQuestionSet(
    [opening],
    [
      { ...opening, text: "被替换的开场题" },
      { text: "生成题 2", order: 1, description: "oprun_dimension:core_experience" },
    ],
    0,
  );
  assert.equal(merged, null);
});

test("expands a conditional fallback snapshot without changing answered questions", () => {
  const generated = [
    ...openingWithFallback,
    { text: "岗位协作", order: 2, description: "oprun_dimension:job_duty_secondary" },
    { text: "核心经历", order: 3, description: "oprun_dimension:core_experience" },
    { text: "问题解决", order: 4, description: "oprun_dimension:problem_solving" },
    { text: "AI 协作", order: 5, description: "oprun_dimension:ai_collaboration" },
    { text: "学习", order: 6, description: "oprun_dimension:learning" },
    { text: "动机", order: 7, description: "oprun_dimension:motivation_stability" },
  ];
  const merged = mergeExpandedQuestionSet(openingWithFallback, generated, 1);
  assert.equal(merged?.length, 8);
  assert.deepEqual(merged?.slice(0, 2), openingWithFallback);
});

test("restores an invited candidate to the persisted question", () => {
  const state = buildInviteResumeState(
    [
      { id: "q-3", order: 2, text: "第三题" },
      { id: "q-1", order: 0, text: "第一题" },
      { id: "q-2", order: 1, text: "第二题" },
    ],
    "q-2",
    [
      { id: "m-2", timestamp: "2026-08-19T08:02:00.000Z", content: "后保存" },
      { id: "m-1", timestamp: "2026-08-19T08:01:00.000Z", content: "先保存" },
    ],
  );

  assert.equal(state.questionIndex, 1);
  assert.equal(state.isResuming, true);
  assert.deepEqual(state.orderedQuestions.map((question) => question.id), ["q-1", "q-2", "q-3"]);
  assert.deepEqual(state.orderedMessages.map((message) => message.id), ["m-1", "m-2"]);
});

test("falls back safely when a persisted question no longer exists", () => {
  const state = buildInviteResumeState(
    [{ id: "q-1", order: 0 }],
    "removed-question",
    [],
  );

  assert.equal(state.questionIndex, 0);
  assert.equal(state.isResuming, false);
});
