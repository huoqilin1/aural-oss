import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { acquireGlmSlot, withGlmSlot } from "../server/glm-capacity";

test("GLM admission signs requests, releases after provider failure and never retries provider", async () => {
  const keys = ["GLM_SHARED_CAPACITY_ENABLED", "HR_MODEL_CONTROL_URL", "HR_MODEL_CONTROL_SECRET"];
  const saved = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  process.env.GLM_SHARED_CAPACITY_ENABLED = "1";
  process.env.HR_MODEL_CONTROL_URL = "https://hr.example/v1/recruit/internal/aural/model-policy";
  process.env.HR_MODEL_CONTROL_SECRET = "synthetic-secret";
  const calls: {action: string; request_id: string}[] = [];
  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/recruit/internal/aural/model-capacity");
    const headers = new Headers(options?.headers);
    const raw = String(options?.body);
    const expected = createHmac("sha256", "synthetic-secret").update(`${headers.get("X-HR-Model-Timestamp")}\nPOST\n${url.pathname}\n${raw}`).digest("hex");
    assert.equal(headers.get("X-HR-Model-Signature"), expected);
    calls.push(JSON.parse(raw));
    return Response.json({ success: true, granted: true });
  }) as typeof fetch;
  try {
    let providers = 0;
    await assert.rejects(withGlmSlot(async () => { providers++; throw new Error("synthetic_failure"); }), /synthetic_failure/);
    assert.equal(providers, 1);
    assert.deepEqual(calls.map(c => c.action), ["acquire", "release"]);
    assert.equal(calls[0].request_id, calls[1].request_id);
    calls.length = 0;
    const lease = await acquireGlmSlot();
    assert.equal(lease.signal.aborted, false);
    await lease.release();
    await lease.release();
    assert.equal(lease.signal.aborted, true);
    assert.deepEqual(calls.map(c => c.action), ["acquire", "release"]);
    globalThis.fetch = (async () => Response.json({ success: false })) as typeof fetch;
    await assert.rejects(withGlmSlot(async () => { providers++; }), /control_invalid/);
    assert.equal(providers, 1);
    process.env.GLM_SHARED_CAPACITY_ENABLED = "0";
    assert.equal(await withGlmSlot(async () => "disabled"), "disabled");
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});

test("losing the shared lease aborts the provider signal and releases only once", async (t) => {
  const keys = ["GLM_SHARED_CAPACITY_ENABLED", "HR_MODEL_CONTROL_URL", "HR_MODEL_CONTROL_SECRET"];
  const saved = keys.map(key => process.env[key]);
  const request = globalThis.fetch;
  Object.assign(process.env, { GLM_SHARED_CAPACITY_ENABLED: "1", HR_MODEL_CONTROL_URL: "https://hr.example/model-policy", HR_MODEL_CONTROL_SECRET: "synthetic" });
  const actions: string[] = [];
  globalThis.fetch = (async (_url, options) => {
    const { action } = JSON.parse(String(options?.body));
    actions.push(action);
    return Response.json({ success: true, granted: action === "acquire" });
  }) as typeof fetch;
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const lease = await acquireGlmSlot();
    const aborted = new Promise<void>(resolve => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
    t.mock.timers.tick(20_000);
    await aborted;
    assert.match(String(lease.signal.reason), /lease_lost/);
    await lease.release();
    t.mock.timers.tick(60_000);
    assert.deepEqual(actions, ["acquire", "renew", "release"]);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = request;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});
