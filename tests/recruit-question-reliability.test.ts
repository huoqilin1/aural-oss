import assert from "node:assert/strict";
import test from "node:test";
import {
  deduplicateRecruitQuestions,
  normalizeRecruitQuestion,
  recruitQuestionSimilarity,
} from "../src/lib/recruit-question-reliability";

test("normalizes punctuation and polite prefixes", () => {
  assert.equal(
    normalizeRecruitQuestion("请你介绍一下，负责这个项目时遇到的最大困难？"),
    normalizeRecruitQuestion("介绍一下负责这个项目时遇到的最大困难。"),
  );
});

test("rejects near-duplicate recruiting questions", () => {
  const result = deduplicateRecruitQuestions([
    "请介绍你在订单系统项目中负责的核心工作。",
    "介绍一下你在订单系统项目里负责的核心工作？",
    "线上故障发生后，你如何定位根因并推动恢复？",
  ]);
  assert.equal(result.questions.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0]!.score >= 0.76);
});

test("keeps questions about distinct competency dimensions", () => {
  assert.ok(
    recruitQuestionSimilarity(
      "你如何设计高并发系统的限流策略？",
      "你如何处理跨部门协作中的目标冲突？",
    ) < 0.4,
  );
});
