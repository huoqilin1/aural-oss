import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPersistedRecruitmentStart,
  persistRecruitmentStart,
} from "../src/hooks/use-recruitment-onboarding-gate";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("recruitment start survives a page reload for the same session only", () => {
  const storage = memoryStorage();

  assert.equal(hasPersistedRecruitmentStart(storage, "session-a"), false);
  persistRecruitmentStart(storage, "session-a");
  assert.equal(hasPersistedRecruitmentStart(storage, "session-a"), true);
  assert.equal(hasPersistedRecruitmentStart(storage, "session-b"), false);
});

test("blocked browser storage fails closed without blocking interview entry", () => {
  const blockedStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };

  assert.equal(hasPersistedRecruitmentStart(blockedStorage, "session-a"), false);
  assert.doesNotThrow(() => persistRecruitmentStart(blockedStorage, "session-a"));
});
