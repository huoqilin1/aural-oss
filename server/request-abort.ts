// Keep source signals strongly reachable for the complete response body read.
// Node 20 can collect timeout sources passed only through AbortSignal.any().
export function requestAbortScope(sources: AbortSignal[]) {
  const controller = new AbortController();
  const listeners: Array<{ source: AbortSignal; listener: () => void }> = [];
  for (const source of sources) {
    const listener = () => controller.abort(source.reason);
    listeners.push({ source, listener });
    if (source.aborted) listener();
    else source.addEventListener("abort", listener, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
      listeners.length = 0;
    },
  };
}
