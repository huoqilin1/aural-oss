export function requeueFailedProgressMessages<T>(
  failedMessages: readonly T[],
  currentMessages: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...failedMessages, ...currentMessages].filter(message => {
    const id = message && typeof message === 'object' && 'messageId' in message
      ? message.messageId : undefined;
    if (typeof id !== 'string') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Include progress saves queued while an earlier save is still in flight. */
export async function waitForProgressSaves(current: () => Promise<void>): Promise<void> {
  let observed: Promise<void>;
  do {
    observed = current();
    await observed;
  } while (observed !== current());
}

/** UI timeouts do not cancel a save: retries must join the same operation. */
export class SingleFlightSave<T> {
  private pending: Promise<T> | null = null;

  run(save: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    const operation = Promise.resolve().then(save);
    this.pending = operation;
    const clear = () => {
      if (this.pending === operation) this.pending = null;
    };
    // Use both handlers so clearing a rejected save cannot create an
    // unhandled rejection. The original rejection still reaches callers.
    void operation.then(clear, clear);
    return operation;
  }
}
