export interface DynamicQuestionLike {
  text: string;
  order: number;
  description?: string | null;
}

export interface QuestionIdLike {
  id?: string | null;
  order: number;
}

/**
 * Stable lookup used by long-lived relay callbacks. A progressive recruitment
 * interview may contain only Q1/Q2 when the relay is connected; updating this
 * object lets that original callback bind later answers to generated Q3-Q8.
 */
export class LiveQuestionIdLookup {
  private ids: Array<string | undefined> = [];

  constructor(questions: readonly QuestionIdLike[]) {
    this.update(questions);
  }

  update(questions: readonly QuestionIdLike[]): void {
    this.ids = [...questions]
      .sort((left, right) => left.order - right.order)
      .map((question) => question.id || undefined);
  }

  idAt(index: number): string | undefined {
    return this.ids[index];
  }
}

const LEGACY_OPRUN_MAIN_DIMENSIONS = new Set([
  "communication",
  "job_duty_primary",
  "job_duty_secondary",
  "core_experience",
  "problem_solving",
  "ai_collaboration",
  "learning",
  "motivation_stability",
]);

const EVIDENCE_OPRUN_MAIN_DIMENSIONS = new Set([
  "core_experience",
  "project_ownership",
  "core_skill_evidence",
  "result_authenticity",
  "job_work_sample",
  "problem_solving",
  "ai_learning_boundary",
  "collaboration_motivation_stability",
]);

const OPRUN_DIMENSION_CONTRACTS = [
  LEGACY_OPRUN_MAIN_DIMENSIONS,
  EVIDENCE_OPRUN_MAIN_DIMENSIONS,
];

export const OPRUN_PLANNED_MAIN_QUESTION_COUNT = 8;

export function isProgressiveQuestionSet(
  questions: readonly DynamicQuestionLike[],
): boolean {
  if (questions.length < 1 || questions.length >= OPRUN_PLANNED_MAIN_QUESTION_COUNT) {
    return false;
  }
  const dimensions = questions.map((question) => {
    const description = String(question.description ?? "");
    const marker = "oprun_dimension:";
    return description.startsWith(marker) ? description.slice(marker.length) : "";
  });
  return OPRUN_DIMENSION_CONTRACTS.some((contract) => (
    contract.has(dimensions[0])
    && dimensions.every((dimension) => contract.has(dimension))
    && new Set(dimensions).size === dimensions.length
  ));
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
