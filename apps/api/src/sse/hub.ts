// Live SSE connection registry of this process (contract §8.1, §14.7): per-process cap, in-memory per-user counts
// (the F8 fallback cap when Redis is unavailable) and shutdown of every open stream.

export interface SseConnection {
  readonly id: string;
  readonly userId: string;
  /** Ends the stream (idempotent). */
  close(): void;
}

export interface SseHub {
  /** Open (or reserved) connections of this process. */
  size(): number;
  countFor(userId: string): number;
  /** Synchronous reservation (check + add without an await in between); false when the process cap is reached. */
  reserve(conn: SseConnection, maxPerProcess: number): boolean;
  release(conn: SseConnection): void;
  /** Ends every open stream (graceful shutdown: clients resume elsewhere with Last-Event-ID). */
  closeAll(): void;
}

export function createSseHub(): SseHub {
  const conns = new Set<SseConnection>();
  const perUser = new Map<string, number>();
  return {
    size: () => conns.size,
    countFor: (userId) => perUser.get(userId) ?? 0,
    reserve(conn, maxPerProcess) {
      if (conns.size >= maxPerProcess) return false;
      conns.add(conn);
      perUser.set(conn.userId, (perUser.get(conn.userId) ?? 0) + 1);
      return true;
    },
    release(conn) {
      if (!conns.delete(conn)) return;
      const n = (perUser.get(conn.userId) ?? 1) - 1;
      if (n <= 0) perUser.delete(conn.userId);
      else perUser.set(conn.userId, n);
    },
    closeAll() {
      for (const conn of [...conns]) conn.close();
    },
  };
}
