import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { shouldSuppressAnsweredAsrFinal } from "../server/voice-relay-helpers";

const relayPath = path.join(
  fileURLToPath(new URL("../server/voice-relay.ts", import.meta.url)),
);

function readVoiceRelaySource(): string {
  return fs.readFileSync(relayPath, "utf8");
}

/**
 * 生产缺陷回归(2026-09-01 真人探针取证,候选人 1432/1434):
 * chat 输入曾被 ASR"滚动重放"抑制启发式吞掉——追问补充与原回答共享长
 * 前缀,90s TTL 内被判为重放,中继记了日志却不再调 LLM,候选人侧表现为
 * 答后无限静默且切题被拒。chat 是候选人一次性主动发送,必须绕过该抑制。
 */
describe("server/voice-relay.ts chat input bypasses ASR replay suppression", () => {
  it("documents the hazard: prefix-sharing texts trip the ASR replay heuristic", () => {
    // 候选人在原回答基础上追加补充(chat 常见) → 整段包含原回答,
    // 被 ASR 滚动重放启发式判为重放。该判定对 ASR 双终稿是正确的,
    // 但对 chat 一次性主动发送是误杀——所以 chat 必须绕过。
    const answered = "我最核心的职责是保障产品交付质量并把重复劳动自动化。以 SenseRemote Layers 为例。";
    const appendedAnswer = answered + "另外补充一点：覆盖率从六成提到九成九。";
    assert.equal(
      shouldSuppressAnsweredAsrFinal(answered, appendedAnswer),
      true,
      "包含原回答的追加文本会被启发式吞掉(这正是生产缺陷的触发形态)",
    );
  });

  it("handleUserUtterance accepts isChatInput and gates both duplicate guards", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /isChatInput\?: boolean/);
    const topGuard = src.match(
      /const retryingPendingUserTurnCandidate[\s\S]{0,220}?isDuplicateUserFinal\(userText\)/,
    );
    assert.ok(topGuard, "top dedup guard must exist");
    assert.match(
      topGuard[0],
      /!options\?\.isChatInput\s*&&/,
      "top ASR-replay dedup guard must be skipped for chat input",
    );
    const generatingGuard = src.match(
      /const duplicateWhileGenerating =[\s\S]{0,200}?isReplayOfPendingUserTurn\(userText\)/,
    );
    assert.ok(generatingGuard, "while-generating dedup guard must exist");
    assert.match(
      generatingGuard[0],
      /!options\?\.isChatInput\s*&&/,
      "while-generating dedup guard must be skipped for chat input",
    );
  });

  it("text_input routes chat source with the bypass flag", () => {
    const src = readVoiceRelaySource();
    assert.match(
      src,
      /handleUserUtterance\(\s*userText,\s*source === "chat" \? \{ isChatInput: true \} : undefined,/,
    );
  });

  it("queued chat utterance replays with the bypass flag and skips the flush dedup", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /let queuedUserUtteranceIsChat = false;/);
    assert.match(
      src,
      /queuedUserUtteranceIsChat = Boolean\(options\?\.isChatInput\);/,
    );
    assert.match(
      src,
      /followUp && \(followUpIsChat \|\| !isDuplicateUserFinal\(followUp\)\)/,
    );
    assert.match(
      src,
      /followUpIsChat \? \{ isChatInput: true \} : undefined/,
    );
  });
});
