import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateManualQuestionAdvance,
  shouldAllowTtsBargeIn,
} from "../server/openai-voice-relay-helpers";

test("does not allow TTS barge-in before assistant audio has actually started", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: false,
      ttsAudioStartedAt: 0,
      nowMs: 1000,
      responseTtsBytes: 0,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    false,
  );
});

test("does not allow TTS barge-in until enough assistant audio has been delivered", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 900,
      nowMs: 1200,
      responseTtsBytes: 20_000,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    false,
  );
});

test("allows TTS barge-in only after sustained strong speech once assistant audio is underway", () => {
  assert.equal(
    shouldAllowTtsBargeIn({
      inEchoCooldown: true,
      modelIsSpeaking: true,
      responseAudioStarted: true,
      ttsAudioStartedAt: 500,
      nowMs: 1100,
      responseTtsBytes: 48_000,
      rms: 3000,
      thresholdRms: 2400,
      consecutiveFrames: 3,
      thresholdFrames: 3,
    }),
    true,
  );
});

const readyAdvance = {
  isTransitioning: false,
  assistantResponseInFlight: false,
  modelIsSpeaking: false,
  hasPendingQuestionPrompt: false,
  isRecruitmentInterview: true,
  questionEnteredAt: 1_000,
  lastAssistantQuestionAt: 2_000,
  lastCommittedUserAnswerAt: 3_000,
  committedWordsThisQuestion: 1,
};

test("rejects manual next-question clicks while the assistant is still responding", () => {
  assert.deepEqual(
    evaluateManualQuestionAdvance({ ...readyAdvance, modelIsSpeaking: true }),
    { allowed: false, reason: "assistant_busy" },
  );
  assert.deepEqual(
    evaluateManualQuestionAdvance({ ...readyAdvance, assistantResponseInFlight: true }),
    { allowed: false, reason: "assistant_busy" },
  );
});

test("recruitment next-question clicks require an answer to the latest assistant question", () => {
  assert.deepEqual(
    evaluateManualQuestionAdvance({
      ...readyAdvance,
      lastAssistantQuestionAt: 3_500,
    }),
    { allowed: false, reason: "answer_required" },
  );
  assert.deepEqual(
    evaluateManualQuestionAdvance({
      ...readyAdvance,
      committedWordsThisQuestion: 0,
    }),
    { allowed: false, reason: "answer_required" },
  );
});

test("allows one recruitment transition after the latest question is answered and the assistant is idle", () => {
  assert.deepEqual(evaluateManualQuestionAdvance(readyAdvance), { allowed: true });
});
