/** Share in-flight work, retain success, and permit retry after a failed save. */
export function retryableSingleFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(work).catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
