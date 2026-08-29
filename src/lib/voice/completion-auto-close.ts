export const COMPLETION_WITHOUT_FAREWELL_DELAY_MS = 8_000;
export const COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS = 30_000;
export const RECRUITMENT_CLOSING_FALLBACK_MS = 30_000;

export function shouldBlockRecruitmentCompletion(input: {
  isRecruitmentInterview: boolean;
  interviewComplete: boolean;
  totalQuestions: number;
  currentQuestionIndex: number;
  answeredCurrentQuestion: boolean;
  plannedMainQuestionCount: number;
}): boolean {
  if (!input.isRecruitmentInterview || input.interviewComplete) return false;

  const hasAllowedQuestionCount =
    input.totalQuestions === input.plannedMainQuestionCount
    || (
      input.totalQuestions === input.plannedMainQuestionCount + 1
      && input.currentQuestionIndex >= input.plannedMainQuestionCount
    );

  return (
    !hasAllowedQuestionCount
    || input.currentQuestionIndex < input.plannedMainQuestionCount - 1
    || !input.answeredCurrentQuestion
  );
}

export function recruitmentClosingAutoCloseDelayMs(input: {
  isRecruitmentInterview: boolean;
  locallyCompleted: boolean;
  isCandidateClosing: boolean;
  answeredCurrentQuestion: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  isTransitioning: boolean;
}): number | null {
  if (
    !input.isRecruitmentInterview
    || input.locallyCompleted
    || !input.isCandidateClosing
    || !input.answeredCurrentQuestion
    || input.isListening
    || input.isSpeaking
    || input.isProcessing
    || input.isTransitioning
  ) {
    return null;
  }

  return RECRUITMENT_CLOSING_FALLBACK_MS;
}

export function completionAutoCloseDelayMs(input: {
  interviewComplete: boolean;
  locallyCompleted: boolean;
  hasVisibleFarewell: boolean;
  farewellReadyToClose: boolean;
}): number | null {
  if (
    !input.interviewComplete
    || input.locallyCompleted
    || input.farewellReadyToClose
  ) {
    return null;
  }

  return input.hasVisibleFarewell
    ? COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS
    : COMPLETION_WITHOUT_FAREWELL_DELAY_MS;
}
