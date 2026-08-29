export const COMPLETION_WITHOUT_FAREWELL_DELAY_MS = 8_000;
export const COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS = 30_000;

export function completionAutoCloseDelayMs(input: {
  interviewComplete: boolean;
  locallyCompleted: boolean;
  hasVisibleFarewell: boolean;
  farewellReadyToClose: boolean;
}): number | null {
  if (
    !input.interviewComplete
    || input.locallyCompleted
    || input.farewellReadyToClose
  ) {
    return null;
  }

  return input.hasVisibleFarewell
    ? COMPLETION_WITH_VISIBLE_FAREWELL_FALLBACK_MS
    : COMPLETION_WITHOUT_FAREWELL_DELAY_MS;
}
