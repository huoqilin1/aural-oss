import assert from "node:assert/strict";
import test from "node:test";

import { SessionConnectionRegistry } from "../server/session-connection-registry";

function connection() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    closes,
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  };
}

test("a refreshed browser supersedes the previous relay connection", () => {
  const registry = new SessionConnectionRegistry<ReturnType<typeof connection>>();
  const first = connection();
  const second = connection();

  const firstClaim = registry.claim("session-a", first);
  const secondClaim = registry.claim("session-a", second);

  assert.equal(firstClaim.superseded, false);
  assert.equal(secondClaim.superseded, true);
  assert.deepEqual(first.closes, [{ code: 4001, reason: "session_reconnected" }]);
  assert.equal(registry.isCurrent("session-a", firstClaim.lease), false);
  assert.equal(registry.isCurrent("session-a", secondClaim.lease), true);
});

test("a stale close cannot release the refreshed browser ownership", () => {
  const registry = new SessionConnectionRegistry<ReturnType<typeof connection>>();
  const firstClaim = registry.claim("session-a", connection());
  const secondClaim = registry.claim("session-a", connection());

  assert.equal(registry.release("session-a", firstClaim.lease), false);
  assert.equal(registry.isCurrent("session-a", secondClaim.lease), true);
  assert.equal(registry.release("session-a", secondClaim.lease), true);
  assert.equal(registry.isCurrent("session-a", secondClaim.lease), false);
});

test("different interview sessions retain independent owners", () => {
  const registry = new SessionConnectionRegistry<ReturnType<typeof connection>>();
  const first = registry.claim("session-a", connection());
  const second = registry.claim("session-b", connection());

  assert.equal(registry.isCurrent("session-a", first.lease), true);
  assert.equal(registry.isCurrent("session-b", second.lease), true);
});
