import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generationRoute = readFileSync(
  "src/app/api/v1/interviews/[id]/generate-questions/route.ts",
  "utf8",
);
const relay = readFileSync("server/voice-relay.ts", "utf8");
const relayPrompts = readFileSync("server/voice-relay-prompts.ts", "utf8");
const openAiRelay = readFileSync("server/openai-voice-relay.ts", "utf8");
const candidateSession = readFileSync("src/app/i/[slug]/session/page.tsx", "utf8");
const invitedCandidateSession = readFileSync(
  "src/app/i/invite/[token]/session/page.tsx",
  "utf8",
);
const candidateRouter = readFileSync(
  "src/server/routers/candidate.ts",
  "utf8",
);
const voiceInterface = readFileSync(
  "src/components/session/voice-interface.tsx",
  "utf8",
);
const intervieweeOnboarding = readFileSync(
  "src/components/session/interviewee-onboarding.tsx",
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

test("progressive generation preserves Q1 and optional fallback Q2 safely", () => {
  assert.match(generationRoute, /const preserveOpening = body\.preserveOpening === true/);
  assert.match(generationRoute, /const preserveDimensions = Array\.isArray/);
  assert.match(generationRoute, /preserveDimensions\.includes\(item\.key\)/);
  assert.match(generationRoute, /const GENERATION_BUDGET_MS = 150_000/);
  assert.match(generationRoute, /withGenerationBudget\(/);
  assert.match(generationRoute, /generated = \{ questions: \[\] \}/);
  assert.match(generationRoute, /missingPreservedDimensions/);
});

test("both voice relays refresh questions during an active candidate session", () => {
  assert.match(candidateSession, /interviewId: interview\.data\.id/);
  assert.match(candidateSession, /refetchInterview\(\)/);
  assert.match(invitedCandidateSession, /interviewId: interview\.id/);
  assert.match(invitedCandidateSession, /refetchCandidate\(\)/);
  for (const source of [relay, openAiRelay]) {
    assert.match(source, /async function refreshDynamicQuestions/);
    assert.match(source, /type: "question_count_update"/);
    assert.match(source, /type === "question_set_update"/);
    assert.match(source, /isProgressiveOpeningOnly\(sortedQuestions\)/);
    assert.match(source, /2_000/);
    assert.match(source, /Dynamic questions refreshed from/);
  }
  assert.match(relay, /await refreshDynamicQuestions\(\)/);
  assert.match(relay, /const waitUntil = Date\.now\(\) \+ 10_000/);
  assert.match(relay, /shouldWaitForQuestionExpansion\(sortedQuestions, currentQuestionIndex\)/);
  assert.match(relay, /while \(isProgressiveOpeningOnly\(sortedQuestions\)/);
  assert.match(openAiRelay, /do not end the interview/);
  assert.match(openAiRelay, /pendingProgressiveTransition/);
  assert.match(
    openAiRelay,
    /!isProgressiveOpeningOnly\(sortedQuestions\) &&\s*currentQuestionIndex/,
  );
});

test("the browser pushes generated questions into an already-open relay", () => {
  const voiceHook = readFileSync("src/hooks/use-voice.ts", "utf8");
  assert.match(voiceHook, /type: "question_set_update"/);
  assert.match(voiceHook, /questions,/);
  assert.match(voiceHook, /Math\.max\(current\.totalQuestions, questions\.length\)/);
});

test("invited candidates resume the persisted question and transcript", () => {
  assert.match(candidateRouter, /session:sessions\(\*, messages\(\*\)\)/);
  assert.match(invitedCandidateSession, /session\.currentQuestionId/);
  assert.match(invitedCandidateSession, /buildInviteResumeState/);
  assert.match(invitedCandidateSession, /startQuestionIndex: resumeState\.questionIndex/);
  assert.match(invitedCandidateSession, /initialMessages=\{resumeState\.isResuming \? resumeTextMessages/);
  assert.match(invitedCandidateSession, /initialDrawings=\{resumeState\.isResuming && resumeDrawings\.length/);

  const voiceHook = readFileSync("src/hooks/use-voice.ts", "utf8");
  assert.match(voiceHook, /keepalive: true/);
  assert.match(voiceHook, /Progress save failed with HTTP/);
});

test("OpRun recruitment relay caps follow-ups across the entire interview", () => {
  assert.match(relay, /GLOBAL_FOLLOW_UP_LIMIT = 15/);
  assert.match(relay, /GLOBAL_FOLLOW_UP_LIMIT - totalFollowUpsUsed/);
});

test("candidate interface keeps the full question and hybrid timing visible", () => {
  assert.match(voiceInterface, /本题已用/);
  assert.match(voiceInterface, /剩余时间/);
  assert.match(voiceInterface, /formatTime\(remainingSeconds\)/);
  assert.match(voiceInterface, /targetDurationMinutes.*分钟目标/);
  assert.match(voiceInterface, /durationMinutes.*分钟硬截止/);
  assert.match(voiceInterface, /按你的节奏来/);
  assert.match(voiceInterface, /当前题目 · 始终显示/);
  assert.match(voiceInterface, /md:text-6xl/);
  assert.match(
    voiceInterface,
    /mobileTranscriptCollapsed, setMobileTranscriptCollapsed\] = useState\(true\)/,
  );
  assert.doesNotMatch(
    voiceInterface,
    /currentQuestionText[\s\S]{0,200}line-clamp-1/,
  );
});

test("invited recruitment candidates see the interview notice before entering", () => {
  // 招聘面试同样先看「面试须知」(怎么进下一题/时长/环境要求),读须知的时间
  // 正好掩盖后台定制题生成;确认后才自动连接开始 (王总 2026-08-20)
  assert.match(
    invitedCandidateSession,
    /!onboardingDone\) \{/,
  );
  assert.doesNotMatch(
    invitedCandidateSession,
    /!onboardingDone && !isOprunRecruitmentInterview/,
  );
  assert.match(
    invitedCandidateSession,
    /autoStart=\{isOprunRecruitmentInterview\}/,
  );
  assert.match(voiceInterface, /void voice\.connect\(\)/);
  assert.match(voiceInterface, /OPRUN_PLANNED_MAIN_QUESTION_COUNT/);
  assert.match(voiceInterface, /isInternalQuestionDescription/);
  assert.match(voiceInterface, /允许麦克风并开始面试/);
  assert.match(intervieweeOnboarding, /面试须知/);
  assert.match(intervieweeOnboarding, /如何进入下一题/);
  assert.match(intervieweeOnboarding, /isRecruitmentInterview/);
});

test("answered questions surface a prominent next-question control", () => {
  // 答完本题后屏幕中央出现大按钮「下一题」,口说「我答完了」同样生效 (王总 2026-08-20)
  assert.match(voiceInterface, /answeredCurrentQuestion/);
  assert.match(voiceInterface, /setAnsweredCurrentQuestion\(true\)/);
  assert.match(voiceInterface, /本(?:题)?答完了就点这里，或直接说「我答完了」/);
  assert.match(relay, /答完了\|我答完了/);
});

test("questions stay tactful about employment status", () => {
  // 生成题与追问都不得以「你目前离职正在找工作」这类求职状态为提问前提
  assert.match(generationRoute, /严禁把候选人的离职状态/);
  assert.match(
    generationRoute,
    /直接问职业选择、岗位理解和未来规划本身/,
  );
  assert.match(relayPrompts, /绝不提候选人的离职状态/);
});
