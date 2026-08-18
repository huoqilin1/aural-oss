export interface DynamicQuestionLike {
  text: string;
  order: number;
  description?: string | null;
}

export function isProgressiveOpeningOnly(
  questions: readonly DynamicQuestionLike[],
): boolean {
  if (questions.length !== 1) return false;
  return String(questions[0]?.description ?? "").includes(
    "oprun_dimension:communication",
  );
}

export function mergeExpandedQuestionSet<T extends DynamicQuestionLike>(
  current: readonly T[],
  incoming: readonly T[],
  activeQuestionIndex: number,
): T[] | null {
  if (incoming.length <= current.length) return null;

  for (let index = 0; index <= activeQuestionIndex; index += 1) {
    const currentQuestion = current[index];
    const incomingQuestion = incoming[index];
    if (
      currentQuestion
      && incomingQuestion
      && currentQuestion.text !== incomingQuestion.text
    ) {
      return null;
    }
  }

  return [...incoming].sort((a, b) => a.order - b.order);
}
