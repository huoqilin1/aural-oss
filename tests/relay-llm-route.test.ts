import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RELAY_LLM_ROUTE,
  parseRelayLlmRoute,
  relayLlmRouteOrder,
  recruitGlmOnlyEnabled,
  recruitTestModelRoutingEnabled,
  zhipuBaseUrl,
} from "../src/lib/relay-llm-route";
import { relayLlmRouteFromInterview } from "../server/interview-llm-route";

test("GLM restriction overrides test routing and rejects standard API defaults", () => {
  const keys = ["RECRUIT_GLM_ONLY", "RECRUIT_TEST_MODEL_ROUTING", "ZHIPU_BASE_URL"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.RECRUIT_GLM_ONLY = "1";
    process.env.RECRUIT_TEST_MODEL_ROUTING = "1";
    assert.equal(recruitGlmOnlyEnabled(), true);
    assert.equal(recruitTestModelRoutingEnabled(), false);
    for (const base of [undefined, "", "https://open.bigmodel.cn/api/paas/v4"]) {
      if (base === undefined) delete process.env.ZHIPU_BASE_URL;
      else process.env.ZHIPU_BASE_URL = base;
      assert.throws(() => zhipuBaseUrl(), /Coding endpoint/);
    }
    process.env.ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4/";
    assert.equal(zhipuBaseUrl(), "https://open.bigmodel.cn/api/coding/paas/v4");
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("new route accepts exactly four unique providers", () => {
  const route = parseRelayLlmRoute({primary: "zhipu", fallbacks: ["kimi", "deepseek", "doubao"]});
  assert.deepEqual(relayLlmRouteOrder(route!), ["zhipu", "kimi", "deepseek", "doubao"]);
  assert.equal(parseRelayLlmRoute({primary: "zhipu", fallbacks: ["kimi", "deepseek", "zhipu"]}), null);
});

test("explicit GLM single-model route has no implicit fallback", () => {
  assert.deepEqual(parseRelayLlmRoute({primary:"zhipu",fallbacks:[]}),{primary:"zhipu",fallbacks:[]});
  assert.equal(parseRelayLlmRoute({primary:"kimi",fallbacks:[]}),null);
  assert.equal(parseRelayLlmRoute({primary:"deepseek",fallbacks:[]}),null);
});

test("accepts one primary plus two unique supported fallbacks", () => {
  const route = parseRelayLlmRoute({
    primary: "zhipu",
    fallbacks: ["kimi", "deepseek"],
  });
  assert.deepEqual(route, {
    primary: "zhipu",
    fallbacks: ["kimi", "deepseek"],
  });
  assert.deepEqual(relayLlmRouteOrder(route!), ["zhipu", "kimi", "deepseek"]);
});

test("rejects duplicate, missing, and unknown providers", () => {
  assert.equal(parseRelayLlmRoute({ primary: "deepseek", fallbacks: ["kimi", "kimi"] }), null);
  assert.equal(parseRelayLlmRoute({ primary: "deepseek", fallbacks: ["kimi"] }), null);
  assert.equal(parseRelayLlmRoute({ primary: "openai", fallbacks: ["kimi", "zhipu"] }), null);
});

test("reads only the namespaced route from interview metadata", () => {
  assert.deepEqual(
    relayLlmRouteFromInterview({
      customBranding: {
        color: "blue",
        oprunRelayLlmRoute: {
          primary: "kimi",
          fallbacks: ["deepseek", "zhipu"],
        },
      },
    }),
    { primary: "kimi", fallbacks: ["deepseek", "zhipu"] },
  );
  assert.equal(relayLlmRouteFromInterview({ customBranding: { color: "blue" } }), undefined);
  assert.deepEqual(DEFAULT_RELAY_LLM_ROUTE, {
    primary: "zhipu",
    fallbacks: ["kimi", "deepseek", "doubao"],
  });
});
