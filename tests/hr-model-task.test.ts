import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHrModelTask, HrTaskHalted } from "../server/hr-model-task";

test("durable failure stops repeated calls and a new HR-approved round recovers", async () => {
  const keys = ["AURAL_RUNTIME_STATE_DIR", "HR_MODEL_CONTROL_URL", "HR_MODEL_CONTROL_SECRET"];
  const saved = keys.map(key => process.env[key]);
  const request = globalThis.fetch;
  process.env.AURAL_RUNTIME_STATE_DIR = await mkdtemp(join(tmpdir(), "oprun-task-test-"));
  process.env.HR_MODEL_CONTROL_URL = "http://127.0.0.1/v1/recruit/internal/aural/model-policy";
  process.env.HR_MODEL_CONTROL_SECRET = "synthetic-secret";
  let round = 1;
  let state = "active";
  let networkDown = true;
  let calls = 0;
  const route = { primary: "zhipu", fallbacks: ["kimi", "deepseek", "doubao"] };
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.ok(new Headers(options?.headers).get("X-HR-Model-Signature"));
    if (body.action === "failure") {
      if (networkDown) throw new Error("synthetic_network_down");
      if (body.round === round) state = "halted";
    }
    return Response.json({ success: true, task_key: "aural:1", round, state, route });
  }) as typeof fetch;
  try {
    const identity = { session_id: "synthetic-session", stage: "voice_turn" };
    const failure = Object.assign(new Error("all_models_failed"), { attempts: ["zhipu", "kimi", "deepseek", "doubao"].map(provider => ({ provider, model: "synthetic", state: "failed", error: "TimeoutError" })) });
    await assert.rejects(runHrModelTask(identity, async () => { calls++; throw failure; }));
    for (let index = 0; index < 10; index++) {
      await assert.rejects(runHrModelTask(identity, async () => { calls++; return "must not run"; }), HrTaskHalted);
    }
    assert.equal(calls, 1);
    networkDown = false;
    await assert.rejects(runHrModelTask(identity, async () => "must not run"), HrTaskHalted);
    round = 2;
    state = "active";
    assert.equal(await runHrModelTask(identity, async savedRoute => {
      calls++; assert.deepEqual(savedRoute, route); return "recovered";
    }), "recovered");
    assert.equal(calls, 2);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const summary = runHrModelTask({ ...identity, stage: "q-summary" }, async () => {
      entered(); await held; return "summary";
    });
    await started;
    try {
      assert.equal(await runHrModelTask(identity, async () => "live answer"), "live answer");
      await assert.rejects(runHrModelTask({ ...identity, stage: "q-summary" }, async () => "duplicate"), /busy/);
    } finally { release(); await summary; }
  } finally {
    globalThis.fetch = request;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});
