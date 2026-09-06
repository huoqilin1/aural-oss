// Local cross-repository contract test. No server, credentials or network I/O.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleVoiceSave, type VoiceSaveOps, type VoiceSavePayload } from "../src/app/api/voice/save/logic";
import { mergeAsrFinal, mergeClientAsrInterim } from "../src/lib/voice/asr-interim";

type Question = { id: string; text: string; order: number; description: string };
async function main() {
const { questions, answeredCount } = JSON.parse(readFileSync(0, "utf8")) as {
  questions: Question[]; answeredCount: number;
};
assert.equal(questions.length, 8);
assert.ok([6, 8].includes(answeredCount));
const messages: NonNullable<VoiceSavePayload["messages"]> = [];
let status = "IN_PROGRESS";
let recording: string | null = null;
let completionWrites = 0;
let summaries = 0;
const ops: VoiceSaveOps = {
  insertMessages: async (_id, batch) => { messages.push(...batch); },
  loadSessionForCompletion: async () => ({
    status, audioRecordingUrl: recording, startedAt: "2026-09-06T01:00:00Z", activitySegments: [],
    interview: { title: "数君招聘 · 本地验收", questions, objective: null, language: "zh",
      userId: "local-test", projectId: "local-project", assessmentCriteria: null },
  }),
  loadActivitySegments: async () => [], closeOpenSegments: async () => [],
  loadMessageTimestamps: async () => [],
  loadAnsweredQuestionIds: async () => messages.filter(m => m.role === "user").map(m => m.questionId!),
  loadSessionForProgress: async () => ({ interview: { questions } }),
  updateSession: async (_id, patch) => {
    if (patch.status === "COMPLETED") { status = "COMPLETED"; completionWrites++; }
  },
  generateSummary: async () => { summaries++; },
  log: { info: () => {}, error: () => {} }, now: () => new Date("2026-09-06T01:20:00Z"),
};
const expected: Record<string, string> = {};
for (const q of questions.slice(0, answeredCount)) {
  const opening = `我本人负责事项${q.order + 1}的资料核对，不编造历史业绩。`;
  const middle = "我建立复核台账并保留原始凭证。";
  const ending = "特殊事项由负责人审批，结果以签收回执核验。";
  let answer = mergeClientAsrInterim("", opening + middle);
  answer = mergeClientAsrInterim(answer, middle + ending);
  answer = mergeAsrFinal(answer, middle + ending);
  assert.ok(answer.includes(opening));
  assert.equal(answer.split(middle).length - 1, 1);
  expected[q.id] = answer;
  const batch: NonNullable<VoiceSavePayload["messages"]> = [
    { role: "assistant", content: q.text, questionId: q.id },
    { role: "assistant", content: "这道题你答完了吗？答完我就进入下一题；还想补充的话，可以继续说。", questionId: q.id },
    { role: "user", content: answer, questionId: q.id },
  ];
  if (q.order === 1) batch.push(
    { role: "assistant", content: "你通过什么记录确认资料复核完成？", questionId: q.id },
    { role: "user", content: "通过复核签收和审批回执确认。", questionId: q.id },
  );
  assert.equal((await handleVoiceSave({ sessionId: "local-replay", messages: batch, currentQuestionIndex: q.order }, ops)).status, 200);
}
const preflight = await handleVoiceSave({ sessionId: "local-replay", validateOnly: true }, ops);
assert.equal(preflight.status, answeredCount === 8 ? 200 : 409);
assert.equal(completionWrites, 0);
assert.equal((await handleVoiceSave({ sessionId: "local-replay", complete: true }, ops)).status, 409);
assert.equal(completionWrites, 0);
recording = "https://example.test/local-recording.webm";
const completed = await handleVoiceSave({ sessionId: "local-replay", complete: true }, ops);
assert.equal(completed.status, answeredCount === 8 ? 200 : 409);
assert.equal(completionWrites, answeredCount === 8 ? 1 : 0);
assert.equal(summaries, answeredCount === 8 ? 1 : 0);
process.stdout.write(JSON.stringify({ messages, expected, status, completionWrites, summaries }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
