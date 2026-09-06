import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as relayLlm from "../server/relay-llm";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  relayLlm.resetRelayLlmCacheForTests();
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const v = prev[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    relayLlm.resetRelayLlmCacheForTests();
  }
}

async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  relayLlm.resetRelayLlmCacheForTests();
  try {
    await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const v = prev[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    relayLlm.resetRelayLlmCacheForTests();
  }
}

afterEach(() => {
  relayLlm.resetRelayLlmCacheForTests();
});

test("four-provider request counts empty JSON responses once and includes missing configuration", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    calls.push(JSON.parse(String(init?.body)).model);
    return Response.json({ choices: [{ message: { content: "" } }] });
  }) as typeof fetch;
  try {
    await withEnvAsync({ ZHIPU_API_KEY: "z-test", KIMI_API_KEY: "k-test", DEEPSEEK_API_KEY: "d-test",
      DOUBAO_TEXT_API_KEY: undefined, DOUBAO_TEXT_MODEL: undefined }, async () => {
      await assert.rejects(relayLlm.callRelayLLM("synthetic", undefined, { stage: "test" },
        { primary: "zhipu", fallbacks: ["kimi", "deepseek", "doubao"] }), (error: unknown) => {
          assert.ok(error instanceof relayLlm.AllFourModelsFailed);
          assert.deepEqual(error.attempts.map(row => row.provider), ["zhipu", "kimi", "deepseek", "doubao"]);
          assert.equal(error.message, "all_models_failed");
          return true;
        });
      assert.deepEqual(calls, ["glm-5.3", "kimi-k3", "deepseek-v4-flash"]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default chain starts GLM then Kimi when provider keys set", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: undefined,
      DEEPSEEK_API_KEY: "d-test",
      ZHIPU_API_KEY: "z-test",
      KIMI_API_KEY: "k-test",
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "glm-5.3");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "kimi-k3");
    },
  );
});

test("chain trims to configured providers (deepseek + kimi only)", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: undefined,
      DEEPSEEK_API_KEY: "d-test",
      ZHIPU_API_KEY: undefined,
      GLM_API_KEY: undefined,
      KIMI_API_KEY: "k-test",
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "kimi-k3");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "deepseek-v4-flash");
    },
  );
});

test("retired kimi-latest overrides migrate to kimi-k3", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: undefined,
      DEEPSEEK_API_KEY: undefined,
      ZHIPU_API_KEY: undefined,
      GLM_API_KEY: undefined,
      KIMI_API_KEY: "k-test",
      KIMI_MODEL: "kimi-latest",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "kimi-k3");
    },
  );
});

test("402 HR-selected primary is attempted once per request then falls back without changing the route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ model: string; temperature: unknown }> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      model?: string;
      temperature?: unknown;
    };
    calls.push({ model: body.model || "", temperature: body.temperature });
    if (body.model === "deepseek-v4-flash") {
      return new Response('{"error":{"message":"payment required"}}', { status: 402 });
    }
    return Response.json({
      choices: [{ message: { content: "READY" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  try {
    await withEnvAsync(
      {
        RELAY_LLM_MODEL: undefined,
        DEEPSEEK_API_KEY: "d-test",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
        ZHIPU_API_KEY: undefined,
        GLM_API_KEY: undefined,
        KIMI_API_KEY: "k-test",
        KIMI_BASE_URL: "https://api.moonshot.cn/v1",
        KIMI_MODEL: undefined,
      },
      async () => {
        const route = { primary: "deepseek" as const, fallbacks: ["kimi" as const, "zhipu" as const] };
        assert.equal(await relayLlm.callRelayLLM("hello", undefined, undefined, route), "READY");
        assert.deepEqual(calls, [
          { model: "deepseek-v4-flash", temperature: 0 },
          { model: "kimi-k3", temperature: undefined },
        ]);

        calls.length = 0;
        assert.equal(await relayLlm.callRelayLLM("hello again", undefined, undefined, route), "READY");
        assert.deepEqual(calls, [
          { model: "deepseek-v4-flash", temperature: 0 },
          { model: "kimi-k3", temperature: undefined },
        ]);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an HR-selected route overrides the static provider order without changing secrets", async () => {
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
    models.push(body.model || "");
    return Response.json({
      choices: [{ message: { content: "READY" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  try {
    await withEnvAsync(
      {
        RELAY_LLM_MODEL: "legacy-model-must-not-win",
        DEEPSEEK_API_KEY: "d-test",
        ZHIPU_API_KEY: "z-test",
        KIMI_API_KEY: "k-test",
      },
      async () => {
        const text = await relayLlm.callRelayLLM(
          "hello",
          undefined,
          { stage: "test" },
          { primary: "kimi", fallbacks: ["zhipu", "deepseek"] },
        );
        assert.equal(text, "READY");
        assert.deepEqual(models, ["kimi-k3"]);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an HR-selected route never escapes to a legacy fourth provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: "unexpected" } }] });
  }) as typeof fetch;

  try {
    await withEnvAsync(
      {
        RELAY_LLM_MODEL: "legacy-model-must-not-win",
        RELAY_LLM_API_KEY: "legacy-key-must-not-win",
        DEEPSEEK_API_KEY: undefined,
        ZHIPU_API_KEY: undefined,
        GLM_API_KEY: undefined,
        KIMI_API_KEY: undefined,
      },
      async () => {
        const text = await relayLlm.callRelayLLM(
          "hello",
          undefined,
          { stage: "test" },
          { primary: "deepseek", fallbacks: ["zhipu", "kimi"] },
        );
        assert.equal(text, "");
        assert.equal(calls, 0);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness probe fails closed when every configured provider fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 404 })) as typeof fetch;
  try {
    await withEnvAsync(
      {
        RELAY_LLM_MODEL: undefined,
        DEEPSEEK_API_KEY: "d-test",
        ZHIPU_API_KEY: undefined,
        GLM_API_KEY: undefined,
        KIMI_API_KEY: "k-test",
      },
      async () => {
        await assert.rejects(
          relayLlm.assertRelayLlmReady({ force: true }),
          /LLM API 404/,
        );
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit RELAY_LLM_MODEL keeps the legacy single-endpoint behavior", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: "gemini-3.1-flash-lite",
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: "m-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      DEEPSEEK_API_KEY: undefined,
      KIMI_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "gemini-3.1-flash-lite");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "abab6.5s-chat");
    },
  );
});

test("no fallback when primary is already abab6.5s-chat on MiniMax", () => {
  withEnv(
    {
      RELAY_LLM_MODEL: "abab6.5s-chat",
      RELAY_LLM_API_KEY: "m-test",
      RELAY_LLM_BASE_URL: "https://api.minimaxi.com/v1",
      RELAY_LLM_PROVIDER: "openai",
      MINIMAX_API_KEY: "m-test",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "abab6.5s-chat");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), null);
    },
  );
});

test("no fallback without MINIMAX_API_KEY", () => {
  withEnv(
    {
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      ZHIPU_API_KEY: undefined,
      GLM_API_KEY: undefined,
      KIMI_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmFallbackModel(), null);
    },
  );
});
