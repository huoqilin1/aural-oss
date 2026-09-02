import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { synthesizeSpeech } from "../server/volcengine-tts";

const relayPath = path.join(
  fileURLToPath(new URL("../server/voice-relay.ts", import.meta.url)),
);

function readVoiceRelaySource(): string {
  return fs.readFileSync(relayPath, "utf8");
}

/**
 * 生产缺陷回归(2026-09-02 真人简历官网投递取证,run 25ca153b):
 * volcengine TTS 返回 HTTP 200 后可能永远不吐首个数据块;原实现 fetch 有
 * 8s 超时但 read() 循环没有任何超时 → 流挂起 → speakAndHandle 永不返回
 * → 题目切换丢失、面试在"播报中"状态永久冻结(自 8/27 起 1962 次 200 OK
 * 中 146 次无完成记录)。读循环必须带看门狗并以 error 事件上抛,由
 * voice-relay 重试并最终以纯文本兜底,保证面试永不冻结。
 */

/** 构造与 fetch signal 耦合的挂起流:真 undici fetch 在 signal abort 时会让
 *  response body 以 AbortError 终止;手工构造的 Response 不具备该行为,必须模拟。 */
function mockFetchWithStream(enqueueFirst?: (c: ReadableStreamDefaultController<Uint8Array>) => void) {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      enqueueFirst?.(controller);
    },
  });
  return {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        streamController?.error(err);
      }, { once: true });
      return new Response(stream, { status: 200, statusText: "OK" });
    }) as typeof fetch,
  };
}

describe("server/volcengine-tts.ts stream watchdog", () => {
  it("aborts a stream that returns HTTP 200 but never yields data, and reports it as an error event", async () => {
    process.env.DOUBAO_TTS_FIRST_CHUNK_TIMEOUT_MS = "1000";
    const originalFetch = globalThis.fetch;
    // 永不 enqueue、永不 close:模拟供应商挂起的 200 响应流。
    const mocked = mockFetchWithStream();
    globalThis.fetch = mocked.fetch;
    try {
      const events: Array<{ type: string; error?: string }> = [];
      const startedAt = Date.now();
      for await (const event of synthesizeSpeech(
        "测试文本",
        { appId: "a", accessToken: "b", resourceId: "seed-tts-2.0" },
        { speaker: "x" },
      )) {
        events.push({ type: event.type, error: event.error });
      }
      const elapsed = Date.now() - startedAt;
      assert.ok(
        events.some((e) => e.type === "error" && /stalled|no data/.test(String(e.error))),
        `expected a stall error event, got ${JSON.stringify(events)}`,
      );
      assert.ok(elapsed < 5000, `watchdog should fire near the 1s timeout, took ${elapsed}ms`);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.DOUBAO_TTS_FIRST_CHUNK_TIMEOUT_MS;
    }
  });

  it("re-arms the watchdog between reads: idle hang after the first chunk also aborts with an error", async () => {
    process.env.DOUBAO_TTS_FIRST_CHUNK_TIMEOUT_MS = "800";
    process.env.DOUBAO_TTS_STREAM_IDLE_TIMEOUT_MS = "800";
    const originalFetch = globalThis.fetch;
    // 先吐一个合法 JSON 块,然后永久挂起:看门狗必须按"空闲读"再次触发。
    const mocked = mockFetchWithStream((c) => {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ event: "TTSSentenceStart", code: 0 })));
    });
    globalThis.fetch = mocked.fetch;
    try {
      const events: Array<{ type: string; error?: string }> = [];
      for await (const event of synthesizeSpeech(
        "测试文本",
        { appId: "a", accessToken: "b", resourceId: "seed-tts-2.0" },
        { speaker: "x" },
      )) {
        events.push({ type: event.type, error: event.error });
      }
      assert.ok(events.some((e) => e.type === "sentence_start"), "first chunk should be delivered");
      assert.ok(
        events.some((e) => e.type === "error" && /stalled|watchdog/.test(String(e.error))),
        `expected an idle-watchdog error, got ${JSON.stringify(events)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.DOUBAO_TTS_FIRST_CHUNK_TIMEOUT_MS;
      delete process.env.DOUBAO_TTS_STREAM_IDLE_TIMEOUT_MS;
    }
  });
});

describe("server/voice-relay.ts TTS failure recovery wiring", () => {
  const src = readVoiceRelaySource();

  it("retries TTS once when the first attempt fails without pushing any audio", () => {
    assert.match(src, /TTS attempt 1 failed without audio — retrying once/);
    assert.match(src, /result\.audioBytes === 0/);
  });

  it("falls back to text-only delivery (tts_text + tts_ended) so the interview never freezes", () => {
    assert.match(src, /delivering text-only fallback/);
    assert.match(src, /const degradedTextOnly = !completed/);
    assert.match(src, /delivered = \(completed \|\| degradedTextOnly\)/);
  });

  it("counts text-only fallback as delivered so queued transitions and farewell still run", () => {
    // speakAndHandle 的后置动作(切题/收尾)以 speakText 返回 true 为前提;
    // 兜底送达也必须放行,否则双重 TTS 失败仍会卡死流程。
    const speakText = src.slice(src.indexOf("async function speakText"));
    const body = speakText.slice(0, speakText.indexOf("\n  }\n"));
    assert.match(body, /return delivered;/);
    assert.doesNotMatch(body, /return completed && !abortController\.signal\.aborted;/);
  });
});
