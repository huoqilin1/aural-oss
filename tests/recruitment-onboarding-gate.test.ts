import assert from "node:assert/strict";
import test from "node:test";
import { readBrowserPreference, writeBrowserPreference } from "../src/lib/browser-storage";

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

test("optional preferences survive denied storage property access", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const deniedWindow = Object.defineProperty({}, "localStorage", {
    get() { throw new Error("Storage access denied"); },
  });
  Object.defineProperty(globalThis, "window", {configurable: true, value: deniedWindow});
  try {
    assert.equal(readBrowserPreference("language"), null);
    assert.doesNotThrow(() => writeBrowserPreference("language", "zh"));
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("optional preferences still persist when storage is available", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: {localStorage: memoryStorage()},
  });
  try {
    assert.equal(readBrowserPreference("language"), null);
    writeBrowserPreference("language", "zh");
    assert.equal(readBrowserPreference("language"), "zh");
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
