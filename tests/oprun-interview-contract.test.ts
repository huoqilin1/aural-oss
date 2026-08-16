import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generationRoute = readFileSync(
  "src/app/api/v1/interviews/[id]/generate-questions/route.ts",
  "utf8",
);
const relay = readFileSync("server/voice-relay.ts", "utf8");
const voiceInterface = readFileSync(
  "src/components/session/voice-interface.tsx",
  "utf8",
);

test("OpRun recruitment generator preserves eight distinct dimensions", () => {
  for (const dimension of [
    "communication",
    "core_experience",
    "job_duty_primary",
    "job_duty_secondary",
    "problem_solving",
    "ai_collaboration",
    "learning",
    "motivation_stability",
  ]) {
    assert.match(generationRoute, new RegExp(`key: "${dimension}"`));
  }
  assert.match(generationRoute, /timeLimitSeconds: question\.seconds/);
  assert.match(generationRoute, /description: `oprun_dimension:/);
  assert.match(generationRoute, /usedQuestionTexts/);
  assert.match(generationRoute, /AI 一面（结构化岗位面试）/);
});

test("OpRun recruitment relay caps follow-ups across the entire interview", () => {
  assert.match(relay, /GLOBAL_FOLLOW_UP_LIMIT = 2/);
  assert.match(relay, /GLOBAL_FOLLOW_UP_LIMIT - totalFollowUpsUsed/);
});

test("candidate interface keeps the full question and hybrid timing visible", () => {
  assert.match(voiceInterface, /本题已用/);
  assert.match(voiceInterface, /剩余 \{formatTime\(remainingSeconds\)\}/);
  assert.match(voiceInterface, /当前题目 · Q/);
  assert.doesNotMatch(
    voiceInterface,
    /currentQuestionText[\s\S]{0,200}line-clamp-1/,
  );
});
