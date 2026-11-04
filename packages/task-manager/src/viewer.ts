// Viewer / request context and the shared service helpers (contract §2.9, §9.4, §15.5).
// Exported for @orc/project-manager so both service packages apply identical authorization and paging rules.
import { OrcError, decodeCursor, encodeCursor, filterHash } from '@orc/shared';
import type { IsoDateTime, Page, Permission, Role, Uuid } from '@orc/shared';
import type { Actor, AuditContext, Keyset } from '@orc/database';

export interface Viewer {
  userId: Uuid;
  role: Role;
  permissions: ReadonlySet<Permission>;
  tokenId: Uuid | null;
  readOnly: boolean;
  /** Optional display label for audit/event actors (username); defaults to the user id. */
  username?: string;
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
}

export function actorOf(v: Viewer): Actor {
  const label = v.username ?? v.userId;
  return v.tokenId !== null
    ? { type: 'token', userId: v.userId, tokenId: v.tokenId, label }
    : { type: 'user', userId: v.userId, label };
}

export function auditOf(ctx: RequestContext): AuditContext {
  return {
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

export function hasPerm(v: Viewer, p: Permission): boolean {
  return v.permissions.has(p);
}

/** Route-level permission (403 forbidden). Mutations additionally reject read-only PATs. */
export function requirePermission(v: Viewer, p: Permission, opts: { write?: boolean } = {}): void {
  if (!v.permissions.has(p)) throw new OrcError('forbidden', `Missing permission ${p}`);
  if (opts.write === true && v.readOnly) throw new OrcError('forbidden', 'Read-only token');
}

/** `task:read:any` viewers see every task; others only their own (§15.5). */
export function taskViewer(v: Viewer): { userId: Uuid; canReadAny: boolean } {
  return { userId: v.userId, canReadAny: v.permissions.has('task:read:any') };
}

export function canReadTasks(v: Viewer): boolean {
  return v.permissions.has('task:read:any') || v.permissions.has('task:read:own');
}

// ---- cursor paging (§9.4) -------------------------------------------------------------------

function invalidCursor(): OrcError {
  return new OrcError('invalid_cursor', 'Invalid pagination cursor');
}

/** Keyset (CreatedAt DESC, Id DESC) cursor of a list filtered by `filters`. */
export function keysetFromCursor(
  cursor: string | undefined,
  filters: Record<string, unknown>,
): Keyset | undefined {
  if (cursor === undefined) return undefined;
  const c = decodeCursor(cursor);
  const [createdAt, id] = c.k;
  if (
    c.f !== filterHash(filters) ||
    c.k.length !== 2 ||
    typeof createdAt !== 'string' ||
    typeof id !== 'string'
  ) {
    throw invalidCursor();
  }
  if (Number.isNaN(Date.parse(createdAt))) throw invalidCursor();
  return { createdAt, id };
}

/** Repos return up to limit+1 rows; the extra row means another page exists. */
export function keysetPage<T extends { createdAt: IsoDateTime; id: string }, R>(
  rows: readonly T[],
  limit: number,
  filters: Record<string, unknown>,
  map: (row: T) => R,
): Page<R> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ k: [last.createdAt, last.id], f: filterHash(filters) })
      : null;
  return { items: page.map(map), nextCursor };
}

/** Ascending BIGINT id cursor (events, diff, test results). */
export function bigIdFromCursor(
  cursor: string | undefined,
  filters: Record<string, unknown>,
): string | undefined {
  if (cursor === undefined) return undefined;
  const c = decodeCursor(cursor);
  const [id] = c.k;
  if (
    c.f !== filterHash(filters) ||
    c.k.length !== 1 ||
    typeof id !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(id)
  ) {
    throw invalidCursor();
  }
  return id;
}

export function bigIdPage<T extends { id: string }, R>(
  rows: readonly T[],
  limit: number,
  filters: Record<string, unknown>,
  map: (row: T) => R,
): Page<R> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ k: [last.id], f: filterHash(filters) }) : null;
  return { items: page.map(map), nextCursor };
}

/** Removes the server-only `rowVer` field from a record. */
export function withoutRowVer<T extends { rowVer: string }>(r: T): Omit<T, 'rowVer'> {
  const { rowVer: _rowVer, ...rest } = r;
  return rest;
}
