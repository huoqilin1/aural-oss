/** Bound new ASR handshakes without serializing unrelated first-time callers. */
export function createAsrInitialConnectQueue(concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid ASR handshake concurrency");
  let active = 0;
  const waiting: Array<() => void> = [];
  return function schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active--;
          waiting.shift()?.();
        });
      };
      if (active < concurrency) start();
      else waiting.push(start);
    });
  };
}
