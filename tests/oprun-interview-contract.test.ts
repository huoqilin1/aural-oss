import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generationRoute = readFileSync(
  "src/app/api/v1/interviews/[id]/generate-questions/route.ts",
  "utf8",
);
const relay = readFileSync("server/voice-relay.ts", "utf8");
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

test("evidence v11 generator uses the scored self-intro and seven evidence dimensions", () => {
  for (const dimension of [
    "core_experience",
    "project_ownership",
    "core_skill_evidence",
    "result_authenticity",
    "job_work_sample",
    "problem_solving",
    "ai_learning_boundary",
    "collaboration_motivation_stability",
  ]) {
    assert.match(generationRoute, new RegExp(`key: "${dimension}"`));
  }
  assert.match(generationRoute, /scored8-inline3-dynamic1-work-sample/);
  assert.match(generationRoute, /questionSetVersion/);
  assert.match(generationRoute, /第2至第8题每题都必须明确引用简历/);
  assert.match(generationRoute, /第5题必须是工作样例/);
  assert.match(generationRoute, /技术岗位允许并要求核验必要的代码、接口、数据流/);
  assert.match(generationRoute, /selectRecruitAnchor\(resumeText/);
  assert.match(generationRoute, /questionReferencesRecruitAnchor\(generatedText, selectedAnchors\.resume\)/);
  assert.match(generationRoute, /questionReferencesRecruitAnchor\(generatedText, selectedAnchors\.job\)/);
  assert.match(generationRoute, /const isTechnicalRole = roleType === "technical"/);
  assert.match(generationRoute, /必要的伪代码、SQL或配置/);
  assert.match(generationRoute, /一页可执行交付方案/);
  assert.match(generationRoute, /seconds: 150/);
});

test("progressive generation preserves Q1 and optional fallback Q2 safely", () => {
  assert.match(generationRoute, /const preserveOpening = body\.preserveOpening === true/);
  assert.match(generationRoute, /const preserveDimensions = Array\.isArray/);
  assert.match(generationRoute, /preserveDimensions\.includes\(item\.key\)/);
  assert.match(generationRoute, /const GENERATION_BUDGET_MS = 8_000/);
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
  assert.match(relay, /GLOBAL_FOLLOW_UP_LIMIT = 2/);
  assert.match(relay, /OPRUN_RECRUITMENT_FOLLOW_UP_LIMIT = 4/);
  assert.match(relay, /RECRUITMENT_INLINE_FOLLOW_UP_LIMIT = 3/);
  assert.match(relay, /RECRUITMENT_FINAL_FOLLOW_UP_LIMIT = 1/);
  assert.match(relay, /currentQuestionIndex >= 1/);
  assert.match(relay, /currentQuestionIndex <= 6/);
  assert.match(relay, /currentQuestionIndex === 7/);
  assert.match(relay, /objective: ctx\.objective/);
  assert.match(openAiRelay, /ctx\.title\.includes\("数君招聘"\)/);
  assert.match(openAiRelay, /Q2-Q7 allow at most one follow-up each and at most three combined/);
  assert.match(openAiRelay, /Q8 allows one final follow-up only/);
  assert.match(openAiRelay, /3次就地核验\+1次最终核验/);
});

test("candidate interface keeps the full question and hybrid timing visible", () => {
  assert.match(voiceInterface, /本题已用/);
  assert.match(voiceInterface, /剩余时间/);
  assert.match(voiceInterface, /formatTime\(remainingSeconds\)/);
  assert.match(voiceInterface, /targetDurationMinutes.*分钟目标/);
  assert.match(voiceInterface, /durationMinutes.*分钟硬截止/);
  assert.match(voiceInterface, /剩余 5 分钟时转为黄色提醒/);
  assert.match(voiceInterface, /剩余 1 分钟时转为红色强提醒/);
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

test("invited recruitment candidates enter directly without exposing seed metadata", () => {
  assert.match(
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
});
