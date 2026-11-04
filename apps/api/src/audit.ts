// Audit helpers (contract §15.6). Audit writes on rejection paths are best-effort: a failed insert is logged and never
// changes the HTTP answer.
import type { Request, Response } from 'express';
import type { AuditAction } from '@orc/shared';
import type { Actor, AuditContext, AuditInsert } from '@orc/database';
import { actorOf, auditOf } from '@orc/task-manager';
import { maybeState, requestContext } from './context.js';
import type { AppDeps } from './types.js';

export function auditContext(req: Request, res: Response): AuditContext {
  return auditOf(requestContext(req, res));
}

/** The authenticated viewer as audit actor, else the anonymous system actor. */
export function requestActor(res: Response): Actor {
  const auth = maybeState(res)?.auth;
  if (auth?.kind === 'authenticated') return actorOf(auth.viewer);
  return { type: 'system', label: 'anonymous' };
}

export async function writeAudit(deps: AppDeps, entry: AuditInsert): Promise<void> {
  try {
    await deps.db.repos.audit.insert(entry);
  } catch (err) {
    deps.logger.error({ err, action: entry.action }, 'audit insert failed');
  }
}

/** System-entity rejection audit (`authz.denied`, `security.path_escape`). */
export async function auditDenied(
  deps: AppDeps,
  req: Request,
  res: Response,
  action: Extract<AuditAction, 'authz.denied' | 'security.path_escape'>,
  detail: Record<string, unknown>,
): Promise<void> {
  if (maybeState(res) === undefined) return;
  await writeAudit(deps, {
    action,
    actor: requestActor(res),
    entityType: 'system',
    entityId: null,
    outcome: action === 'authz.denied' ? 'denied' : 'failure',
    detail: { method: req.method, path: req.path, ...detail },
    ...auditContext(req, res),
  });
}
