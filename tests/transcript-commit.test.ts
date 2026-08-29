import assert from "node:assert/strict";
import test from "node:test";

import { shouldCommitTranscript } from "@/lib/voice/transcript-commit";
import { requeueFailedProgressMessages } from "@/lib/voice/progress-save";

test("commits interrupted assistant text when it has not been saved", () => {
  assert.equal(
    shouldCommitTranscript("", "Here is the first question: Tell me about latency."),
    true,
  );
});

test("skips duplicate assistant transcript commits", () => {
  assert.equal(
    shouldCommitTranscript(
      "Here is the first question: Tell me about latency.",
      " Here is the first question:   Tell me about latency. ",
    ),
    false,
  );
});

test("skips empty assistant transcript commits", () => {
  assert.equal(shouldCommitTranscript("previous", "  "), false);
});

test("failed progress messages are requeued before newer messages", () => {
  const failed = [{ questionId: "q1", content: "answer one" }];
  const current = [{ questionId: "q2", content: "answer two" }];

  assert.deepEqual(
    requeueFailedProgressMessages(failed, current),
    [...failed, ...current],
  );
});
