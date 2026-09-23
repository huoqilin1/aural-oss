/** Include writes appended while an earlier revision is still being stored. */
export async function waitForRevisionWrites(writes: Promise<void>[]): Promise<void> {
  let awaitedCount=0;
  let failures=0;
  while (awaitedCount < writes.length) {
    const batch=writes.slice(awaitedCount);
    awaitedCount=writes.length;
    const results = await Promise.allSettled(batch);
    failures += results.filter(result => result.status === 'rejected').length;
  }
  if (failures) throw new Error(`Revision persistence failed (${failures})`);
}

type RevisionWrite = {
  persist: () => Promise<void>;
  promise: Promise<void>;
  failed: boolean;
};

/** Retain failed operations for an explicit retry without replaying successful writes. */
export class RevisionWriteBarrier {
  private entries = new Set<RevisionWrite>();
  private flushing: Promise<void> | null = null;

  track(persist: () => Promise<void>): Promise<void> {
    const entry: RevisionWrite = {persist, promise: Promise.resolve(), failed: false};
    this.entries.add(entry);
    this.start(entry);
    return entry.promise;
  }

  private start(entry: RevisionWrite): void {
    entry.failed = false;
    entry.promise = Promise.resolve().then(entry.persist).then(() => {
      this.entries.delete(entry);
    }, error => {
      entry.failed = true;
      throw error;
    });
    // Storage can fail before finalization starts. Keep failure state without
    // creating an unhandled rejection or treating it as durable success.
    void entry.promise.catch(() => {});
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    const visited = new Set<RevisionWrite>();
    while (true) {
      const batch = Array.from(this.entries).filter(entry => !visited.has(entry));
      if (!batch.length) break;
      for (const entry of batch) {
        visited.add(entry);
        if (entry.failed) this.start(entry);
      }
      await Promise.allSettled(batch.map(entry => entry.promise));
    }
    const failed = Array.from(this.entries).filter(entry => entry.failed).length;
    if (failed) throw new Error(`Revision persistence failed (${failed})`);
  }
}
