export interface ClosableSessionConnection {
  close(code?: number, reason?: string): void;
}

export interface SessionConnectionLease {
  lease: number;
  superseded: boolean;
}

/**
 * Gives one browser relay connection exclusive ownership of a persisted
 * interview session. A refreshed page supersedes the old socket immediately,
 * so the stale relay cannot fire silence timers or write a terminal status.
 */
export class SessionConnectionRegistry<
  Connection extends ClosableSessionConnection,
> {
  private readonly active = new Map<
    string,
    { lease: number; connection: Connection }
  >();
  private nextLease = 0;

  claim(sessionId: string, connection: Connection): SessionConnectionLease {
    const lease = ++this.nextLease;
    const previous = this.active.get(sessionId);
    this.active.set(sessionId, { lease, connection });

    if (previous && previous.connection !== connection) {
      try {
        previous.connection.close(4001, "session_reconnected");
      } catch {
        // Ownership has already moved even if the stale socket cannot close.
      }
    }

    return { lease, superseded: !!previous && previous.connection !== connection };
  }

  isCurrent(sessionId: string, lease: number): boolean {
    return this.active.get(sessionId)?.lease === lease;
  }

  release(sessionId: string, lease: number): boolean {
    if (!this.isCurrent(sessionId, lease)) return false;
    this.active.delete(sessionId);
    return true;
  }
}
