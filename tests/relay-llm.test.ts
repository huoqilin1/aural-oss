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

test("default chain is deepseek-v4-flash -> glm-5.3 -> kimi when provider keys set", () => {
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
      assert.equal(relayLlm.getRelayLlmModel(), "deepseek-v4-flash");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "glm-5.3");
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
      assert.equal(relayLlm.getRelayLlmModel(), "deepseek-v4-flash");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "kimi-k3");
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

test("402 primary falls back to Kimi K3 without legacy temperature and opens a circuit", async () => {
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
        assert.equal(await relayLlm.callRelayLLM("hello"), "READY");
        assert.deepEqual(calls, [
          { model: "deepseek-v4-flash", temperature: 0 },
          { model: "kimi-k3", temperature: undefined },
        ]);

        calls.length = 0;
        assert.equal(await relayLlm.callRelayLLM("hello again"), "READY");
        assert.deepEqual(calls, [
          { model: "kimi-k3", temperature: undefined },
        ]);
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
