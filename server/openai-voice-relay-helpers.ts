export const DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS = 400;
export const DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES = 32_000;

export interface TtsBargeInDecision {
  inEchoCooldown: boolean;
  modelIsSpeaking: boolean;
  responseAudioStarted: boolean;
  ttsAudioStartedAt: number;
  nowMs: number;
  responseTtsBytes: number;
  rms: number;
  thresholdRms: number;
  consecutiveFrames: number;
  thresholdFrames: number;
  minAudioMs?: number;
  minAudioBytes?: number;
}

export function shouldAllowTtsBargeIn({
  inEchoCooldown,
  modelIsSpeaking,
  responseAudioStarted,
  ttsAudioStartedAt,
  nowMs,
  responseTtsBytes,
  rms,
  thresholdRms,
  consecutiveFrames,
  thresholdFrames,
  minAudioMs = DEFAULT_TTS_BARGE_IN_MIN_AUDIO_MS,
  minAudioBytes = DEFAULT_TTS_BARGE_IN_MIN_AUDIO_BYTES,
}: TtsBargeInDecision): boolean {
  if (!inEchoCooldown || !modelIsSpeaking || !responseAudioStarted) return false;
  if (ttsAudioStartedAt <= 0) return false;
  if (nowMs - ttsAudioStartedAt < minAudioMs) return false;
  if (responseTtsBytes < minAudioBytes) return false;
  if (rms < thresholdRms) return false;
  if (consecutiveFrames < thresholdFrames) return false;
  return true;
}

export type ManualQuestionAdvanceRejectionReason =
  | "transition_in_progress"
  | "assistant_busy"
  | "answer_required";

export interface ManualQuestionAdvanceDecision {
  isTransitioning: boolean;
  assistantResponseInFlight: boolean;
  modelIsSpeaking: boolean;
  hasPendingQuestionPrompt: boolean;
  isRecruitmentInterview: boolean;
  questionEnteredAt: number;
  lastAssistantQuestionAt: number;
  lastCommittedUserAnswerAt: number;
  committedWordsThisQuestion: number;
}

export function evaluateManualQuestionAdvance({
  isTransitioning,
  assistantResponseInFlight,
  modelIsSpeaking,
  hasPendingQuestionPrompt,
  isRecruitmentInterview,
  questionEnteredAt,
  lastAssistantQuestionAt,
  lastCommittedUserAnswerAt,
  committedWordsThisQuestion,
}: ManualQuestionAdvanceDecision):
  | { allowed: true }
  | { allowed: false; reason: ManualQuestionAdvanceRejectionReason } {
  if (isTransitioning) {
    return { allowed: false, reason: "transition_in_progress" };
  }
  if (assistantResponseInFlight || modelIsSpeaking || hasPendingQuestionPrompt) {
    return { allowed: false, reason: "assistant_busy" };
  }
  if (
    isRecruitmentInterview
    && (
      committedWordsThisQuestion <= 0
      || lastCommittedUserAnswerAt <= Math.max(questionEnteredAt, lastAssistantQuestionAt)
    )
  ) {
    return { allowed: false, reason: "answer_required" };
  }
  return { allowed: true };
}
