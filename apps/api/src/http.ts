// Response helpers: JSON, ETag / If-None-Match / If-Match, Location (contract §9.2).
import type { Request, Response } from 'express';
import { OrcError } from '@orc/shared';
import { rowVerToEtag } from '@orc/database';
import { API_PREFIX } from './route.js';

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

export function setLocation(res: Response, path: string): void {
  res.setHeader('Location', `${API_PREFIX}${path}`);
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''))
    .some((v) => v === '*' || v === etag);
}

/** Single-resource GET/PATCH: strong ETag of the RowVer; a matching If-None-Match on GET => 304. */
export function sendEntity(req: Request, res: Response, status: number, body: unknown, rowVer: string): void {
  const etag = rowVerToEtag(rowVer);
  res.setHeader('ETag', etag);
  if ((req.method === 'GET' || req.method === 'HEAD') && etagMatches(req.get('if-none-match'), etag)) {
    res.status(304).end();
    return;
  }
  sendJson(res, status, body);
}

/** PATCH: If-Match is required (428 precondition_required); its value is passed to the service (412 on mismatch). */
export function requireIfMatch(req: Request): string {
  const value = req.get('if-match');
  if (value === undefined || value.trim() === '') {
    throw new OrcError('precondition_required', 'If-Match header required');
  }
  return value.trim();
}

export function optionalIfMatch(req: Request): string | undefined {
  const value = req.get('if-match');
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}
