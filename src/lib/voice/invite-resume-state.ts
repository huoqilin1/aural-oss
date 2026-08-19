export interface InviteResumeQuestion {
  id: string;
  order?: number | null;
}

export interface InviteResumeMessage {
  id: string;
  timestamp?: string | null;
}

export function buildInviteResumeState<
  Question extends InviteResumeQuestion,
  Message extends InviteResumeMessage,
>(
  questions: readonly Question[],
  currentQuestionId: string | null | undefined,
  messages: readonly Message[],
) {
  const orderedQuestions = [...questions].sort(
    (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
  );
  const matchedIndex = currentQuestionId
    ? orderedQuestions.findIndex((question) => question.id === currentQuestionId)
    : -1;
  const questionIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const orderedMessages = [...messages].sort(
    (a, b) =>
      new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime(),
  );

  return {
    orderedQuestions,
    orderedMessages,
    questionIndex,
    isResuming: questionIndex > 0 || orderedMessages.length > 0,
  };
}
