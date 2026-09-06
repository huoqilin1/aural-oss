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
    { lease: number; connection: Connection; established: boolean; lastSeen: number }
  >();
  private nextLease = 0;

  claim(sessionId: string, connection: Connection): SessionConnectionLease {
    const lease = ++this.nextLease;
    const previous = this.active.get(sessionId);
    this.active.set(sessionId, { lease, connection, established: false, lastSeen: 0 });

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

  establish(sessionId: string, lease: number, now = Date.now()): void {
    const entry = this.active.get(sessionId);
    if (entry?.lease !== lease) return;
    entry.established = true;
    entry.lastSeen = now;
  }

  touch(sessionId: string, lease: number, now = Date.now()): void {
    const entry = this.active.get(sessionId);
    if (entry?.lease === lease) entry.lastSeen = now;
  }

  onlineSessionIds(now = Date.now(), freshMs = 45_000): string[] {
    return Array.from(this.active).filter(([, entry]) => entry.established
      && entry.lastSeen <= now && now - entry.lastSeen <= freshMs).map(([id]) => id);
  }

  release(sessionId: string, lease: number): boolean {
    if (!this.isCurrent(sessionId, lease)) return false;
    this.active.delete(sessionId);
    return true;
  }
}
