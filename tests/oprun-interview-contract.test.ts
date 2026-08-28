import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isOpenAiFallbackConfigured } from "../src/lib/release-status";

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
const recruitmentContract = readFileSync(
  "docs/OPRUN_RECRUITMENT_INTERVIEW_CONTRACT.md",
  "utf8",
);
const agentsContract = readFileSync("AGENTS.md", "utf8");
const releaseBuilder = readFileSync("deploy/build-release-wsl.sh", "utf8");
const releaseRunner = readFileSync("deploy/release.core.ps1", "utf8");
const releaseApply = readFileSync("deploy/production/apply-release.sh", "utf8");
const versionRoute = readFileSync("src/app/api/version/route.ts", "utf8");
const healthRoute = readFileSync("src/app/api/health/route.ts", "utf8");
const readyRoute = readFileSync("src/app/api/ready/route.ts", "utf8");

test("frozen recruitment contract requires item-specific manual approval", () => {
  assert.match(agentsContract, /Q1 计分自我介绍、确定性的简历与岗位双锚定 Q2 和有效邀请就绪后必须立即开放面试/);
  assert.match(agentsContract, /单独手动批准/);
  assert.match(recruitmentContract, /不等待 Q3-Q8/);
  assert.match(recruitmentContract, /全场最多 3 次/);
  assert.match(recruitmentContract, /不设置候选人活跃回答时的/);
  assert.match(recruitmentContract, /5 -> 10 -> 20/);
});

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

test("evidence v12 generator uses the scored self-intro and seven evidence dimensions", () => {
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
  assert.match(generationRoute, /scored8-inline2-dynamic1-work-sample/);
  assert.match(generationRoute, /questionSetVersion/);
  assert.match(generationRoute, /questionSpecVersion/);
  assert.match(generationRoute, /const contractVersion = questionSpecVersion \|\| questionSetVersion/);
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
  assert.match(generationRoute, /const GENERATION_BUDGET_MS = 150_000/);
  assert.match(generationRoute, /withGenerationBudget\(/);
  assert.match(generationRoute, /generated = \{ questions: \[\] \}/);
  assert.match(generationRoute, /missingPreservedDimensions/);
  assert.match(generationRoute, /finally \{\s*generationInFlight\.delete\(interviewId\)/);
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
  assert.match(openAiRelay, /next_question_not_ready/);
  assert.match(openAiRelay, /This wait is not an additional interview question/);
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
  assert.match(relay, /OPRUN_RECRUITMENT_FOLLOW_UP_LIMIT = 3/);
  assert.match(relay, /RECRUITMENT_INLINE_FOLLOW_UP_LIMIT = 2/);
  assert.match(relay, /RECRUITMENT_FINAL_FOLLOW_UP_LIMIT = 1/);
  assert.match(relay, /currentQuestionIndex >= 1/);
  assert.match(relay, /currentQuestionIndex <= 6/);
  assert.match(relay, /currentQuestionIndex === 7/);
  assert.match(relay, /objective: ctx\.objective/);
  assert.match(openAiRelay, /ctx\.title\.includes\("数君招聘"\)/);
  assert.match(openAiRelay, /Q2-Q7 allow at most one follow-up each and at most two combined/);
  assert.match(openAiRelay, /Q8 allows one final follow-up only/);
  assert.match(openAiRelay, /2次就地核验\+1次最终核验/);
  assert.match(openAiRelay, /recruitmentInlineFollowUpsUsed/);
  assert.match(openAiRelay, /recruitmentFinalFollowUpsUsed/);
  assert.match(openAiRelay, /recruitmentFollowUpsByQuestion/);
  assert.match(openAiRelay, /recruitmentMustAdvanceAfterAnswer/);
  assert.match(openAiRelay, /answer_complete/);
  assert.match(relay, /不是必问的最终动态核验机会/);
  assert.doesNotMatch(relay, /必须执行的最终动态核验/);
  assert.doesNotMatch(relay, /请再补充一个最能体现你能力的具体结果/);
  assert.doesNotMatch(openAiRelay, /needsFinalVerification/);
  assert.doesNotMatch(openAiRelay, /Blocked transition after Q8/);
});

test("greetings and audio clarifications never skip a scored question", () => {
  for (const source of [relay, openAiRelay]) {
    assert.match(source, /isRecruitmentConversationControl/);
    assert.match(source, /recruitment conversation control|不计入追问预算/);
  }
  assert.match(relay, /!isRecruitmentConversationControl\(userText\)/);
  assert.match(openAiRelay, /!isRecruitmentConversationControl\(text\)/);
});

test("session export preserves durable question identity for HR reconciliation", () => {
  const sessionRoute = readFileSync(
    "src/app/api/v1/sessions/[id]/route.ts",
    "utf8",
  );
  const voiceHook = readFileSync("src/hooks/use-voice.ts", "utf8");
  assert.match(sessionRoute, /messages\(id, role, content, timestamp, questionId, transcription\)/);
  assert.match(sessionRoute, /currentQuestionId/);
  assert.match(voiceHook, /questionId: questionIdAt\(currentQuestionIndexRef\.current\)/);
  assert.match(voiceHook, /Voice completion failed with HTTP/);
});

test("all next-question controls share the same transition lock", () => {
  assert.match(voiceInterface, /advancePending/);
  assert.match(voiceInterface, /voice\.isTransitioning/);
  assert.match(voiceInterface, /voice\.isProcessing/);
  assert.match(voiceInterface, /!canAdvanceCurrentQuestion/);
  assert.match(voiceInterface, /latestAssistantRequiresAnswer/);
  assert.match(voiceInterface, /voice\.isSpeaking/);
  assert.doesNotMatch(voiceInterface, /<span onClick=\{handleNextQuestion\}/);
});

test("manual next-question transitions are acknowledged or rejected by the relay", () => {
  const voiceHook = readFileSync("src/hooks/use-voice.ts", "utf8");
  assert.match(openAiRelay, /evaluateManualQuestionAdvance/);
  assert.match(openAiRelay, /type: "transition_rejected"/);
  assert.match(openAiRelay, /lastAssistantQuestionAt/);
  assert.match(relay, /evaluateTranscriptManualAdvance/);
  assert.match(relay, /type: "transition_rejected"/);
  assert.match(voiceHook, /requestId: crypto\.randomUUID\(\)/);
  assert.match(voiceHook, /case "transition_rejected"/);
  assert.match(voiceHook, /transitionRejectionCount/);
});

test("candidate interface keeps the full question and honest human pacing visible", () => {
  assert.match(voiceInterface, /本题已用/);
  assert.match(voiceInterface, /剩余时间/);
  assert.match(voiceInterface, /formatTime\(displayedRemainingSeconds\)/);
  assert.doesNotMatch(voiceInterface, /durationMinutes === 32/);
  assert.match(
    voiceInterface,
    /if \(isOprunRecruitmentInterview\) \{\s*setRemainingSeconds\(null\)/,
  );
  assert.match(
    voiceInterface,
    /isOprunRecruitmentInterview \|\| remainingSeconds !== 0/,
  );
  assert.match(
    voiceInterface,
    /isOprunRecruitmentInterview \? undefined : durationMinutes/,
  );
  assert.match(intervieweeOnboarding, /通常约 30 分钟，共 8 道正式计分题/);
  assert.match(intervieweeOnboarding, /不会因达到目标时间而截断/);
  assert.doesNotMatch(intervieweeOnboarding, /18~22|最长 25 分钟/);
  assert.match(voiceInterface, /全程约 \$\{targetDurationMinutes\} 分钟/);
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
  assert.match(
    invitedCandidateSession,
    /videoMode=\{!!interview\.videoEnabled\}/,
  );
  assert.match(voiceInterface, /void voice\.connect\(\)/);
  assert.match(voiceInterface, /OPRUN_PLANNED_MAIN_QUESTION_COUNT/);
  assert.match(voiceInterface, /isInternalQuestionDescription/);
  assert.match(
    voiceInterface,
    /!voice\.isConnected && !preview && !autoStart &&/,
  );
  assert.doesNotMatch(voiceInterface, /允许麦克风并开始面试/);
  assert.match(intervieweeOnboarding, /面试须知/);
  assert.match(intervieweeOnboarding, /如何进入下一题/);
  assert.match(intervieweeOnboarding, /isRecruitmentInterview/);
  assert.match(intervieweeOnboarding, /允许麦克风和摄像头权限/);
  assert.match(intervieweeOnboarding, /onClick=\{\(\) => handleComplete\(\)\}/);
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

test("immutable release gate covers functional flow and exact public readiness", () => {
  assert.match(releaseBuilder, /npm run test:web/);
  assert.match(releaseBuilder, /npm run test:functional/);
  assert.match(releaseRunner, /--max-redirs 5/);
  assert.match(releaseRunner, /api\/version/);
  assert.match(releaseRunner, /api\/health/);
  assert.match(releaseRunner, /api\/ready/);
  assert.match(releaseRunner, /voice_websocket_handshake/);
  assert.match(releaseRunner, /aural\.service aural-voice\.service && echo "services=ok"/);
  assert.match(releaseRunner, /fallback_service=missing_or_down/);
  assert.match(releaseRunner, /fallback_configured=yes/);
  assert.match(releaseRunner, /PASS\(primary\);fallback=not_configured/);
  assert.match(releaseRunner, /\/root\/aural\/env\/\.env\.local 2>\/dev\/null \|\|/);
  assert.match(releaseRunner, /Remove-Item -LiteralPath \$buildEnvFile -Force/);
  assert.match(releaseApply, /aural-openai-voice\.service/);
  assert.match(releaseApply, /FALLBACK_CONFIGURED=false/);
  assert.match(releaseApply, /REQUIRED_SERVICES=\(aural\.service aural-voice\.service\)/);
  assert.match(releaseApply, /SNAPSHOT\/dropins\/aural\.service\.d/);
  assert.match(releaseApply, /EnvironmentFile=-\$ENV_DIR\/\.env\.local/);
  assert.doesNotMatch(releaseApply, /local readiness endpoint failed" >&2; exit 1/);
  assert.match(releaseApply, /http:\/\/127\.0\.0\.1:3000\/api\/ready/);
  assert.match(versionRoute, /releaseRevision/);
  assert.match(healthRoute, /status: "ok"/);
  assert.match(readyRoute, /primary_voice_relay/);
  assert.match(readyRoute, /fallback_voice_relay/);
  assert.match(readyRoute, /fallback_voice_relay_configured/);
});

test("OpenAI fallback readiness is required only when credentials are configured", () => {
  assert.equal(isOpenAiFallbackConfigured({}), false);
  assert.equal(
    isOpenAiFallbackConfigured({
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    }),
    false,
  );
  assert.equal(
    isOpenAiFallbackConfigured({
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_API_KEY: "configured",
    }),
    true,
  );
});
