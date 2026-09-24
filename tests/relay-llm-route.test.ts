import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RELAY_LLM_ROUTE,
  parseRelayLlmRoute,
  relayLlmRouteOrder,
  recruitGlmOnlyEnabled,
  recruitTestModelRoutingEnabled,
  zhipuBaseUrl,
  zhipuModel,
  relayLlmProviderModel,
} from "../src/lib/relay-llm-route";
import { relayLlmRouteFromInterview } from "../server/interview-llm-route";

test("production ignores stale GLM/test-route flags while explicit isolated test locks GLM", () => {
  const keys = ["NODE_ENV", "RECRUIT_MODEL_MODE", "RECRUIT_GLM_ONLY", "RECRUIT_TEST_MODEL_ROUTING"];
  const previous = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.RECRUIT_MODEL_MODE;
    process.env.RECRUIT_GLM_ONLY = "1";
    process.env.RECRUIT_TEST_MODEL_ROUTING = "1";
    assert.equal(recruitGlmOnlyEnabled(), false);
    assert.equal(recruitTestModelRoutingEnabled(), false);
    process.env.RECRUIT_MODEL_MODE = "test";
    assert.equal(recruitGlmOnlyEnabled(), true);
    assert.equal(recruitTestModelRoutingEnabled(), false);
    process.env.RECRUIT_MODEL_MODE = "production";
    assert.equal(recruitGlmOnlyEnabled(), false);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

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

test("any supported single-model route has no implicit fallback", () => {
  assert.deepEqual(parseRelayLlmRoute({primary:"zhipu",fallbacks:[]}),{primary:"zhipu",fallbacks:[]});
  assert.deepEqual(parseRelayLlmRoute({primary:"kimi",fallbacks:[]}),{primary:"kimi",fallbacks:[]});
  assert.deepEqual(parseRelayLlmRoute({primary:"deepseek",fallbacks:[]}),{primary:"deepseek",fallbacks:[]});
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
  assert.equal(parseRelayLlmRoute({ primary: "deepseek" }), null);
  assert.equal(parseRelayLlmRoute({ primary: "openai", fallbacks: ["kimi", "zhipu"] }), null);
});

test("omitted providers stay disabled rather than being restored as fallbacks", () => {
  for (const fallbacks of [[], ["kimi", "doubao"]] as string[][]) {
    const route = parseRelayLlmRoute({primary: "zhipu", fallbacks});
    assert.ok(route);
    assert.deepEqual(relayLlmRouteOrder(route), ["zhipu", ...fallbacks]);
    assert.equal(relayLlmRouteOrder(route).includes("deepseek"), false);
  }
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


test("all 15 ordered HR three-provider selections preserve exactly the selected chain", () => {
  const providers = ["zhipu", "kimi", "deepseek"];
  const orders: string[][] = [];
  const visit = (prefix: string[], rest: string[]) => {
    if (prefix.length) orders.push(prefix);
    for (const provider of rest) visit([...prefix, provider], rest.filter(p => p !== provider));
  };
  visit([], providers);
  assert.equal(orders.length, 15);
  for (const order of orders) {
    const route = parseRelayLlmRoute({primary: order[0], fallbacks: order.slice(1)});
    assert.ok(route);
    assert.deepEqual(relayLlmRouteOrder(route), order);
  }
  for (const invalid of [null, [], {}, {primary: "kimi", fallbacks: "zhipu"},
    {primary: "kimi", fallbacks: ["kimi"]}, {primary: "kimi", fallbacks: ["unknown"]}]) {
    assert.equal(parseRelayLlmRoute(invalid), null);
  }
});


test("explicit isolated gateway preserves actual model identity and fails closed outside test mode", () => {
  const keys = ["RECRUIT_MODEL_MODE", "RECRUIT_TEST_GLM_BASE_URL", "RECRUIT_TEST_GLM_MODEL"];
  const previous = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { RECRUIT_MODEL_MODE: "test",
      RECRUIT_TEST_GLM_BASE_URL: "https://models.example.invalid/v1/", RECRUIT_TEST_GLM_MODEL: "glm-5.3-flash" });
    assert.equal(zhipuBaseUrl(), "https://models.example.invalid/v1");
    assert.equal(zhipuModel(), "glm-5.3-flash");
    assert.equal(relayLlmProviderModel("zhipu"), "glm-5.3-flash");
    assert.equal(recruitGlmOnlyEnabled(), true);
    for (const mode of ["production", ""]) {
      process.env.RECRUIT_MODEL_MODE = mode;
      for (const resolve of [zhipuBaseUrl, zhipuModel, recruitGlmOnlyEnabled]) {
        assert.throws(resolve, /requires RECRUIT_MODEL_MODE=test/);
      }
    }
    process.env.RECRUIT_MODEL_MODE = "test";
    for (const [base, model] of [
      ["https://models.example.invalid/v1", ""], ["", "glm-5.3-flash"],
      ["http://models.example.invalid/v1", "glm-5.3-flash"],
      ["https://user:secret@models.example.invalid/v1", "glm-5.3-flash"],
      ["https://models.example.invalid/v1?key=secret", "glm-5.3-flash"],
      ["https://models.example.invalid/v1#fragment", "glm-5.3-flash"],
      ["https://models.example.invalid/v1", "different-provider"],
    ]) {
      process.env.RECRUIT_TEST_GLM_BASE_URL = base;
      process.env.RECRUIT_TEST_GLM_MODEL = model;
      assert.throws(zhipuBaseUrl, /HTTPS base URL and explicit GLM model/);
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
