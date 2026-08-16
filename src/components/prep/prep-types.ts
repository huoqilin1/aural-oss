export type PrepVoiceDeliveryFeedback = {
  confidence: number;
  clarity: number;
  tone: number;
  tips: string[];
};

export type PrepFeedback = {
  score: number;
  verdict: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  missingSignals: string[];
  resumeLeverage: string[];
  structureSuggestion: string;
  followUpQuestion: string;
  sampleAnswer: string;
  needsUserVerification: string[];
  voiceDelivery?: PrepVoiceDeliveryFeedback;
};

export type PrepFollowUpTurn = {
  prompt: string;
  answer: string;
  refinement: {
    verdict: string;
    stillStrong: string[];
    stillMissing: string[];
  };
  shouldContinue: boolean;
  nextPrompt: string;
};

export type PrepQuestion = {
  id: string;
  interviewId: string;
  order: number;
  text: string;
  description: string | null;
  type: string;
  options?: unknown;
};

export type PrepQuestionOption = {
  label: string;
  value?: string;
};

export type PrepAttempt = {
  id: string;
  sessionId: string;
  interviewId: string;
  questionId: string;
  userId: string;
  answerText: string;
  inputMode: string;
  durationSeconds: number | null;
  feedback: PrepFeedback;
  followUp: PrepFollowUpTurn[];
  score: number | null;
  attemptNumber: number;
  createdAt: string;
  audioUrl?: string | null;
  audioDurationSeconds?: number | null;
};

export const EMPTY_FEEDBACK: PrepFeedback = {
  score: 0,
  verdict: "",
  summary: "",
  strengths: [],
  improvements: [],
  missingSignals: [],
  resumeLeverage: [],
  structureSuggestion: "",
  followUpQuestion: "",
  sampleAnswer: "",
  needsUserVerification: [],
  voiceDelivery: undefined,
};

export function scoreTone(score?: number | null): string {
  if (!score) return "text-muted-foreground";
  if (score >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 6) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function scoreBadgeClasses(score?: number | null): string {
  if (typeof score !== "number") {
    return "border-border bg-muted text-muted-foreground";
  }
  if (score >= 8) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (score >= 6) {
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300";
}

export function normalizePrepQuestionOptions(value: unknown): PrepQuestionOption[] {
  const rawOptions =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { options?: unknown }).options
      : value;
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions.flatMap((raw): PrepQuestionOption[] => {
    if (typeof raw === "string") {
      const label = raw.trim();
      return label ? [{ label, value: label }] : [];
    }
    if (!raw || typeof raw !== "object") return [];
    const candidate = raw as { label?: unknown; value?: unknown };
    const label = String(candidate.label ?? candidate.value ?? "").trim();
    if (!label) return [];
    const optionValue = String(candidate.value ?? label).trim();
    return [{ label, value: optionValue || label }];
  });
}

export function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function normalizeAttempt(raw: unknown): PrepAttempt {
  const a = raw as Partial<PrepAttempt> & { feedback?: unknown; followUp?: unknown };
  const feedback = (a.feedback ?? {}) as Partial<PrepFeedback>;
  return {
    id: a.id ?? "",
    sessionId: a.sessionId ?? "",
    interviewId: a.interviewId ?? "",
    questionId: a.questionId ?? "",
    userId: a.userId ?? "",
    answerText: a.answerText ?? "",
    inputMode: a.inputMode ?? "TEXT",
    durationSeconds: a.durationSeconds ?? null,
    feedback: {
      ...EMPTY_FEEDBACK,
      ...feedback,
      strengths: safeStringArray(feedback.strengths),
      improvements: safeStringArray(feedback.improvements),
      missingSignals: safeStringArray(feedback.missingSignals),
      resumeLeverage: safeStringArray(feedback.resumeLeverage),
      needsUserVerification: safeStringArray(feedback.needsUserVerification),
    },
    followUp: Array.isArray(a.followUp)
      ? (a.followUp as PrepFollowUpTurn[])
      : [],
    score: typeof a.score === "number" ? a.score : null,
    attemptNumber: a.attemptNumber ?? 1,
    createdAt: a.createdAt ?? "",
    audioUrl: typeof a.audioUrl === "string" ? a.audioUrl : null,
    audioDurationSeconds:
      typeof a.audioDurationSeconds === "number"
        ? a.audioDurationSeconds
        : null,
  };
}

export const FOLLOW_UP_DEPTH_TURNS: Record<string, number> = {
  LIGHT: 0,
  MODERATE: 1,
  DEEP: 3,
};
