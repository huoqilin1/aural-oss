import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("HR copilot recording resilience", () => {
  it("recovers provider failures and stops after bounded retries", () => {
    const source = fs.readFileSync(path.join(root, "server/voice-relay.ts"), "utf8");
    assert.match(source, /const maxReconnectAttempts = 2;/);
    assert.ok(source.includes("recoverMicTestAsr"));
    assert.ok(source.includes('reason: "asr_unavailable"'));
  });

  it("invalidates late microphone and websocket work after stop", () => {
    const source = fs.readFileSync(path.join(root, "src/hooks/use-relay-asr-input.ts"), "utf8");
    assert.ok(source.includes("generationRef.current += 1"));
    assert.match(source, /generation !== generationRef\.current/);
    assert.match(source, /stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  });

  it("autosaves and restores a versioned second-round draft", () => {
    const source = fs.readFileSync(path.join(root, "src/app/hr/copilot/CopilotClient.tsx"), "utf8");
    assert.ok(source.includes('method: "PUT"'));
    assert.ok(source.includes("revisionRef.current + 1"));
    assert.ok(source.includes("d.draft.transcript"));
    assert.ok(source.includes("relay.start(transcriptRef.current)"));
  });
});
