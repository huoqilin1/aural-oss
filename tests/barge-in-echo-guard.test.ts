import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { shouldHoldBargeInInterimForFinal } from "../server/voice-relay-helpers";

const relayPath = path.join(
  fileURLToPath(new URL("../server/voice-relay.ts", import.meta.url)),
);

function readVoiceRelaySource(): string {
  return fs.readFileSync(relayPath, "utf8");
}

/**
 * 真实候选人事故回归(2026-09-03,候选人 #1410):
 * 外放音箱回声让 ASR 产生 1-3 字碎片,抢话逻辑立刻取消 TTS 并把碎片当
 * 回答送进 LLM,AI 回话再被回声打断,每 ~15 秒循环,候选人"被重复打断"
 * 约 5 分钟后离场。防线:1-3 字碎片不再触发抢话保持;无 final 的提升
 * 要求 ≥4 字;与 AI 刚播报内容同源的碎片视为回声丢弃。
 */
describe("barge-in echo/noise guards", () => {
  it("holds barge-in only for fragments with real substance (>=4 chars)", () => {
    const base = { definite: false, ttsSpeaking: true, endingInterview: false };
    assert.equal(shouldHoldBargeInInterimForFinal({ ...base, text: "嗯" }), false);
    assert.equal(shouldHoldBargeInInterimForFinal({ ...base, text: "好的" }), false);
    assert.equal(shouldHoldBargeInInterimForFinal({ ...base, text: "等一下我想说" }), true);
  });

  it("still holds definite finals regardless of length", () => {
    assert.equal(shouldHoldBargeInInterimForFinal({
      definite: true, ttsSpeaking: true, endingInterview: false, text: "好",
    }), false);
  });

  it("relay drops short no-final promotions and assistant-echo fragments", () => {
    const src = readVoiceRelaySource();
    assert.match(src, /reason === "no-final-after-barge-in" && finalText\.length < 4/);
    assert.match(src, /Barge-in fragment too short/);
    assert.match(src, /echoes assistant speech, ignored/);
  });
});
