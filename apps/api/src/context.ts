// Request state, request/correlation ids (contract §9.2, §17.3).
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { OrcError } from '@orc/shared';
import { runWithLogContext } from '@orc/logger';
import type { RequestContext, RequestState } from './types.js';

const STATE_KEY = 'orc';
export const ID_HEADER_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

export function state(res: Response): RequestState {
  const s = res.locals[STATE_KEY] as RequestState | undefined;
  if (s === undefined) throw new OrcError('internal_error', 'Request state missing');
  return s;
}

export function maybeState(res: Response): RequestState | undefined {
  return res.locals[STATE_KEY] as RequestState | undefined;
}

function headerId(req: Request, name: string): string | null {
  const raw = req.get(name);
  return raw !== undefined && ID_HEADER_REGEX.test(raw) ? raw : null;
}

/** X-Request-Id / X-Correlation-Id (accepted when they match §9.2, else generated); echoed on every response. */
export function requestIds() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = headerId(req, 'x-request-id') ?? randomUUID();
    const correlationId = headerId(req, 'x-correlation-id') ?? requestId;
    const s: RequestState = {
      requestId,
      correlationId,
      cookies: {},
      auth: { kind: 'anonymous', failure: null },
      eventStream: false,
    };
    res.locals[STATE_KEY] = s;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ requestId, correlationId }, next);
  };
}

export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress;
  return ip === undefined || ip === '' ? null : ip;
}

export function requestContext(req: Request, res: Response): RequestContext {
  const s = state(res);
  const ua = req.get('user-agent');
  return {
    requestId: s.requestId,
    correlationId: s.correlationId,
    ip: clientIp(req),
    userAgent: ua === undefined ? null : ua.slice(0, 512),
  };
}
