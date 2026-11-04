// MSSQL replay of task output for SSE (contract §8.2, §8.3 step 4): `stdout|stderr|system` rows -> `log` events,
// `claude` rows reassembled into lines -> `claude` events via summarizeClaudeLine, ids `d-<TaskLogs.Id>` (a claude line
// uses the id of the row holding its final `\n`). The scan always starts at the first row of the task so line
// reassembly and line numbers stay exact; rows before the resume point are consumed silently.
import { parseClaudeLine, summarizeClaudeLine } from '@orc/shared';
import type { TaskLog, TaskStreamEvent, Uuid } from '@orc/shared';
import type { Database } from '@orc/database';

export const DB_REPLAY_PAGE = 1000;

export interface DbReplayFilter {
  /** Emit only rows with Id > afterRowId (a `d-<id>` resume point). */
  afterRowId?: string;
  /** Emit only rows created at or after this epoch-ms (switch from Redis after an `r-` id, minus 1 s). */
  minCreatedMs?: number;
}

export type DbEmit = (rowId: string, event: TaskStreamEvent) => boolean;

interface LineState {
  buffer: string;
  line: number;
}

export class DbReplayer {
  private cursor: string | null = null;
  private readonly lines = new Map<Uuid, LineState>();
  private readonly afterRowId: bigint | null;
  private readonly db: Database;
  private readonly taskId: Uuid;
  private readonly filter: DbReplayFilter;

  constructor(db: Database, taskId: Uuid, filter: DbReplayFilter) {
    this.db = db;
    this.taskId = taskId;
    this.filter = filter;
    this.afterRowId = filter.afterRowId === undefined ? null : BigInt(filter.afterRowId);
  }

  /** Reads every row after the scan cursor; returns false when `emit` asked to stop. */
  async pump(emit: DbEmit, isClosed: () => boolean): Promise<boolean> {
    for (;;) {
      if (isClosed()) return false;
      const rows = await this.db.repos.taskLogs.listByTaskAfterId({
        taskId: this.taskId,
        afterId: this.cursor,
        limit: DB_REPLAY_PAGE,
      });
      for (const row of rows) {
        this.cursor = row.id;
        if (!this.handle(row, emit)) return false;
      }
      if (rows.length < DB_REPLAY_PAGE) return true;
    }
  }

  private visible(row: TaskLog): boolean {
    if (this.afterRowId !== null && BigInt(row.id) <= this.afterRowId) return false;
    if (this.filter.minCreatedMs !== undefined && Date.parse(row.createdAt) < this.filter.minCreatedMs) return false;
    return true;
  }

  private handle(row: TaskLog, emit: DbEmit): boolean {
    const visible = this.visible(row);
    if (row.stream !== 'claude') {
      if (!visible) return true;
      return emit(row.id, {
        v: 1,
        type: 'log',
        taskId: row.taskId,
        attemptId: row.attemptId,
        seq: row.seq,
        stream: row.stream,
        source: row.source,
        content: row.content,
        at: row.createdAt,
      });
    }
    let state = this.lines.get(row.attemptId);
    if (state === undefined) {
      state = { buffer: '', line: 0 };
      this.lines.set(row.attemptId, state);
    }
    state.buffer += row.content;
    let idx = state.buffer.indexOf('\n');
    while (idx >= 0) {
      const raw = state.buffer.slice(0, idx).replace(/\r$/, '');
      state.buffer = state.buffer.slice(idx + 1);
      idx = state.buffer.indexOf('\n');
      if (raw.trim() === '') continue;
      state.line += 1;
      if (!visible) continue;
      const events = summarizeClaudeLine(parseClaudeLine(raw), {
        taskId: row.taskId,
        attemptId: row.attemptId,
        line: state.line,
        at: row.createdAt,
      });
      for (const e of events) {
        if (!emit(row.id, e)) return false;
      }
    }
    return true;
  }
}
