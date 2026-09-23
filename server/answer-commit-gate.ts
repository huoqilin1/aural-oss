import { randomUUID } from 'node:crypto';

/** One connection-bound write acknowledgement. Never advance on a timeout. */
export function createAnswerCommitGate(send: (event: Record<string, unknown>) => void, timeoutMs = 10_000) {
  const pending = new Map<string, { index: number; settle: (ok: boolean) => void }>();
  return {
    request(index: number): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => finish(false), timeoutMs);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(ok);
        };
        pending.set(requestId, { index, settle: finish });
        try { send({ type: 'answer_commit_required', requestId, questionIndex: index }); }
        catch { finish(false); }
      });
    },
    acknowledge(event: Record<string, unknown>) {
      const entry = typeof event.requestId === 'string' ? pending.get(event.requestId) : undefined;
      if (entry && event.questionIndex === entry.index) entry.settle(event.ok === true);
    },
    close() { for (const entry of Array.from(pending.values())) entry.settle(false); },
  };
}
