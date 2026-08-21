import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const relayPath = path.join(
  fileURLToPath(new URL("../server/voice-relay.ts", import.meta.url)),
);

function readVoiceRelaySource(): string {
  return fs.readFileSync(relayPath, "utf8");
}

describe("server/voice-relay.ts reconnect & lifecycle (source checks)", () => {
  it("defines ASR reconnect tuning constants", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /const MAX_RECONNECT_ATTEMPTS = 3;/);
    assert.match(src, /const RECONNECT_DELAY_MS = 1000;/);
  });

  it("implements autoReconnectAsr and session reconnect events", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /async function autoReconnectAsr\(\)/);
    assert.ok(src.includes('"session_reconnecting"'));
    assert.ok(src.includes('"session_reconnected"'));
  });

  it("uses 5000ms keep-alive intervals for silence audio", () => {
    const src = readVoiceRelaySource();
    const keepAliveIntervals = src.match(
      /keepAliveInterval = setInterval\([\s\S]*?, 5000\);/g,
    );
    assert.equal(
      keepAliveIntervals?.length,
      4,
      "mic test, response-cycle reopen, post-reconnect, and main interview keep-alive intervals",
    );
  });

  it("marks interviews done and detaches ASR listeners when the browser closes", () => {
    const src = readVoiceRelaySource();
    assert.match(
      src,
      /browserWs\.on\("close", \(\) => \{\r?\n\s+log\.info\("Browser disconnected"\);\r?\n\s+(?:const wasFarewellDone = farewellCompleted;\r?\n\s+)?interviewDone = true;/,
    );
    assert.ok(src.includes("asrWs?.removeAllListeners();"));
    // 断线收尾:告别已完成要落库;没完成交给宽限+硬限定时器(王总 2026-08-21)
    assert.ok(src.includes('persistSessionStatus(ctxSessionId, "COMPLETED", "closed_after_farewell")'));
    assert.ok(src.includes("planSessionFinalization"));
  });

  it("installs a 10s safety timeout after farewell audio is queued", () => {
    const src = readVoiceRelaySource();
    assert.ok(
      src.includes(
        "Farewell TTS timed out after 10s — forcing interview end",
      ),
    );
    assert.match(
      src,
      /setTimeout\(\(\) => \{[\s\S]*?endInterview\(\);[\s\S]*?\}, 10_000\);/,
    );
  });
});

describe("server/voice-relay.ts silence ask-confirm flow (source checks)", () => {
  it("asks before advancing instead of silently skipping questions", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /SPOKEN\.silenceAsk\(\)/);
    assert.match(src, /armSilenceConfirm\(\)/);
    assert.match(src, /MAX_SILENT_ASKS_PER_QUESTION = 2/);
    assert.match(src, /silenceConfirmPending = false;\r?\n\s+unansweredQuestionsStreak = 0;/);
  });

  it("abandons honestly when the candidate is away (AFK guard)", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /MAX_UNANSWERED_QUESTIONS_STREAK = 2/);
    assert.match(src, /persistSessionStatus\(ctxSessionId, "ABANDONED", "candidate_inactive"\)/);
    assert.match(src, /Interview abandoned for inactivity/);
  });
});
