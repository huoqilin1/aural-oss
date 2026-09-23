import assert from "node:assert/strict";
import { test } from "node:test";
import { questionMemory } from "../server/question-memory";

test("recruitment preserves source facts and makes no summary model request", async () => {
  const transcript = [{ role: "assistant", text: "Explain the 2024 result and your part." },
    { role: "user", text: "I owned review, not implementation. The result was 12/40, not 12/20." }];
  const snapshot = JSON.stringify(transcript);
  const result = await questionMemory(transcript, true, async () => {
    assert.fail("Recruitment must not enqueue a redundant summary call");
  });
  assert.equal(result, "Interviewer: Explain the 2024 result and your part.\nParticipant: I owned review, not implementation. The result was 12/40, not 12/20.");
  assert.equal(JSON.stringify(transcript), snapshot);
});

test("non-recruitment retains its configured summarization path", async () => {
  let calls = 0;
  const result = await questionMemory([{ role: "user", text: "Original answer" }], false, async source => {
    calls++;
    assert.equal(source, "Participant: Original answer");
    return "Model summary";
  });
  assert.equal(result, "Model summary");
  assert.equal(calls, 1);
});

test("empty transcript never invokes a model", async () => {
  assert.equal(await questionMemory([], false, async () => assert.fail("unexpected call")), "");
});
