import assert from "node:assert/strict";
import test from "node:test";
import {
  isProgressiveOpeningOnly,
  mergeExpandedQuestionSet,
} from "../src/lib/voice/dynamic-question-sync";

const opening = {
  text: "固定开场题",
  order: 0,
  description: "oprun_dimension:communication",
};

test("recognizes only the OpRun progressive opening as incomplete", () => {
  assert.equal(isProgressiveOpeningOnly([opening]), true);
  assert.equal(
    isProgressiveOpeningOnly([{ text: "独立单题", order: 0, description: null }]),
    false,
  );
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
