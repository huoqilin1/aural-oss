"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "oprun:recruitment-onboarding:";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

function browserOnboardingStorage(): OnboardingStorage | undefined {
  try {
    // Accessing the property itself can throw, before getItem/setItem runs.
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function hasPersistedRecruitmentStart(
  storage: OnboardingStorage | undefined,
  sessionId: string,
): boolean {
  try {
    return storage?.getItem(`${STORAGE_PREFIX}${sessionId}`) === "started";
  } catch {
    return false;
  }
}

export function persistRecruitmentStart(
  storage: OnboardingStorage | undefined,
  sessionId: string,
): void {
  try {
    storage?.setItem(`${STORAGE_PREFIX}${sessionId}`, "started");
  } catch {
    // A blocked storage API must not prevent the interview from starting.
  }
}

export function useRecruitmentOnboardingGate({
  isRecruitmentInterview,
  sessionId,
  hasServerProgress,
}: {
  isRecruitmentInterview: boolean;
  sessionId?: string | null;
  hasServerProgress: boolean;
}) {
  const identity = isRecruitmentInterview && sessionId ? sessionId : null;
  const [resolvedIdentity, setResolvedIdentity] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!identity) return;
    const persisted = hasPersistedRecruitmentStart(browserOnboardingStorage(), identity);
    setDone(hasServerProgress || persisted);
    setResolvedIdentity(identity);
  }, [hasServerProgress, identity]);

  const complete = useCallback(() => {
    if (identity) {
      persistRecruitmentStart(browserOnboardingStorage(), identity);
      setResolvedIdentity(identity);
    }
    setDone(true);
  }, [identity]);

  return {
    ready: !isRecruitmentInterview || (!!identity && resolvedIdentity === identity),
    done: hasServerProgress || done,
    complete,
  };
}
