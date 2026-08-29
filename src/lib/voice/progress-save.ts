export function requeueFailedProgressMessages<T>(
  failedMessages: readonly T[],
  currentMessages: readonly T[],
): T[] {
  return [...failedMessages, ...currentMessages];
}
