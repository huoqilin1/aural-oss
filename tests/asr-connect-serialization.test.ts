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

/**
 * 方案B回归(2026-09-03,20 路全答题压测取证):
 * 1) ASR 供应商并发连接配额约 20 路。切题时各会话独立断开/重连,新旧
 *    连接短暂叠加会瞬时冲破配额,被拒会话陷入重连循环(实测一夜 1507 次
 *    quota exceeded)。connectAsr 必须全局串行并带最小间隔。
 * 2) 题目生成的长静默期浏览器 websocket 无流量,中间网络设备掐空闲
 *    连接(实测 15 分钟 10 次 Browser disconnected,回执窗口期发送失败)。
 *    中继必须以协议级 ping 保活(浏览器自动回 pong,前端零改动)。
 */
describe("server/voice-relay.ts route B wiring", () => {
  const src = readVoiceRelaySource();

  it("serializes every connectAsr through one global gate with a minimum interval", () => {
    assert.match(src, /function scheduleAsrConnect\(task: \(\) => Promise<void>\)/);
    assert.match(src, /const ASR_CONNECT_MIN_INTERVAL_MS = 1500;/);
    assert.match(src, /await scheduleAsrConnect\(connectAsrUngated\);/);
    // 闸门必须是模块级(跨会话共享),而不是会话内变量
    assert.match(src, /let asrConnectChain: Promise<void> = Promise\.resolve\(\);/);
  });

  it("keeps the browser websocket alive with protocol-level pings during silent stretches", () => {
    assert.match(src, /const keepBrowserAlive = setInterval\(\(\) => \{/);
    assert.match(src, /browserWs\.ping\(\);/);
    assert.match(src, /, 20000\);/);
    assert.match(src, /browserWs\.on\("close", \(\) => clearInterval\(keepBrowserAlive\)\);/);
  });
});
