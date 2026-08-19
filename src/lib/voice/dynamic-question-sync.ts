export interface DynamicQuestionLike {
  text: string;
  order: number;
  description?: string | null;
}

const OPRUN_MAIN_DIMENSIONS = new Set([
  "communication",
  "job_duty_primary",
  "job_duty_secondary",
  "core_experience",
  "problem_solving",
  "ai_collaboration",
  "learning",
  "motivation_stability",
]);

export const OPRUN_PLANNED_MAIN_QUESTION_COUNT = OPRUN_MAIN_DIMENSIONS.size;

export function isProgressiveQuestionSet(
  questions: readonly DynamicQuestionLike[],
): boolean {
  if (questions.length < 1 || questions.length >= OPRUN_MAIN_DIMENSIONS.size) {
    return false;
  }
  const dimensions = questions.map((question) => {
    const description = String(question.description ?? "");
    const marker = "oprun_dimension:";
    return description.startsWith(marker) ? description.slice(marker.length) : "";
  });
  return dimensions[0] === "communication"
    && dimensions.every((dimension) => OPRUN_MAIN_DIMENSIONS.has(dimension))
    && new Set(dimensions).size === dimensions.length;
}

export function isProgressiveOpeningOnly(
  questions: readonly DynamicQuestionLike[],
): boolean {
  return isProgressiveQuestionSet(questions);
}

export function candidateFacingQuestionCount(
  questions: readonly DynamicQuestionLike[],
): number {
  return isProgressiveQuestionSet(questions)
    ? OPRUN_PLANNED_MAIN_QUESTION_COUNT
    : questions.length;
}

export function isInternalQuestionDescription(
  description: string | null | undefined,
): boolean {
  const value = String(description ?? "").trim();
  return value.startsWith("oprun_dimension:")
    || /(?:固定|过渡|兜底)题/.test(value);
}

export function shouldWaitForQuestionExpansion(
  questions: readonly DynamicQuestionLike[],
  activeQuestionIndex: number,
): boolean {
  return isProgressiveQuestionSet(questions)
    && activeQuestionIndex >= questions.length - 1;
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
