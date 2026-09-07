import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RELAY_LLM_ROUTE,
  parseRelayLlmRoute,
  relayLlmRouteOrder,
} from "../src/lib/relay-llm-route";
import { relayLlmRouteFromInterview } from "../server/interview-llm-route";

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
