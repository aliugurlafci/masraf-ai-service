import { describe, expect, it, vi } from 'vitest';
import { CSRF_TOKEN, IDS, makeMe, makeTask } from '../test/fixtures';
import { installFetch, json, problem } from '../test/http';
import { ApiClient, buildApiUrl } from './client';
import { Api } from './endpoints';
import { ApiError, fieldErrorsOf, parseRetryAfter } from './errors';

function setup() {
  const http = installFetch();
  const api = new Api(new ApiClient());
  return { http, api };
}

describe('API client (contract §9.2, §9.6, §20.1)', () => {
  it('uses same-origin credentials, no-store and Accept JSON for every request', async () => {
    const { api } = setup();
    const spy = vi.fn(() => Promise.resolve(json(makeMe('operator'))));
    vi.stubGlobal('fetch', spy);

    await api.me();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/me');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('Accept')).toBe('application/json');
  });

  it('builds query strings without empty values and joins lists', () => {
    expect(buildApiUrl('/tasks', { status: ['failed', 'blocked'], projectId: undefined, cursor: '', limit: 25 })).toBe(
      '/api/v1/tasks?status=failed%2Cblocked&limit=25',
    );
  });

  it('sends X-CSRF-Token from /auth/me on unsafe methods only (never on login)', async () => {
    const { http, api } = setup();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', `/api/v1/tasks/${IDS.task}/attempts`, json([]));
    http.on('POST', `/api/v1/tasks/${IDS.task}/cancel`, json(makeTask({ status: 'cancelled' })));

    await api.me();
    await api.attempts(IDS.task);
    await api.cancelTask(IDS.task, undefined);

    expect(http.calls('GET', `/api/v1/tasks/${IDS.task}/attempts`)[0]?.headers.has('X-CSRF-Token')).toBe(false);
    expect(http.calls('POST', `/api/v1/tasks/${IDS.task}/cancel`)[0]?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
  });

  it('refetches /auth/me once and repeats the request once on 403 csrf_failed', async () => {
    const { http, api } = setup();
    const fresh = makeMe('operator', { csrfToken: 'fresh-token' });
    http.on('GET', '/api/v1/auth/me', json(fresh));
    http.on('POST', `/api/v1/tasks/${IDS.task}/cancel`, (req) =>
      req.headers.get('X-CSRF-Token') === 'fresh-token'
        ? json(makeTask({ status: 'cancelled' }))
        : problem(403, 'csrf_failed', 'CSRF check failed'),
    );
    api.client.setCsrfToken('stale-token');
    const seen: string[] = [];
    api.client.onMe((me) => seen.push(me.csrfToken ?? ''));

    const res = await api.cancelTask(IDS.task, 'stop');

    expect(res.data.status).toBe('cancelled');
    expect(http.calls('POST', `/api/v1/tasks/${IDS.task}/cancel`).map((r) => r.headers.get('X-CSRF-Token'))).toEqual([
      'stale-token',
      'fresh-token',
    ]);
    expect(http.calls('GET', '/api/v1/auth/me')).toHaveLength(1);
    expect(seen).toEqual(['fresh-token']);
  });

  it('gives up after one CSRF recovery', async () => {
    const { http, api } = setup();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('POST', `/api/v1/tasks/${IDS.task}/cancel`, problem(403, 'csrf_failed', 'CSRF check failed'));

    await expect(api.cancelTask(IDS.task, undefined)).rejects.toMatchObject({ code: 'csrf_failed', status: 403 });
    expect(http.calls('POST', `/api/v1/tasks/${IDS.task}/cancel`)).toHaveLength(2);
    expect(http.calls('GET', '/api/v1/auth/me')).toHaveLength(1);
  });

  it('parses Problem Details with field issues and Retry-After', async () => {
    const { http, api } = setup();
    http.on(
      'POST',
      '/api/v1/tasks',
      problem(
        422,
        'validation_failed',
        'Validation failed',
        { detail: 'Some fields are invalid.', errors: [{ path: 'body.prompt', message: 'Too long', code: 'too_big' }] },
        { 'Retry-After': '7' },
      ),
    );

    const error = await api
      .createTask({ projectId: IDS.project, agentId: IDS.agent, title: 't', prompt: 'p' }, 'idem-key-123456')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({
      kind: 'http',
      status: 422,
      code: 'validation_failed',
      title: 'Validation failed',
      detail: 'Some fields are invalid.',
      requestId: 'req-12345678',
      retryAfterSeconds: 7,
    });
    expect(fieldErrorsOf(apiError)).toEqual({ prompt: 'Too long' });
    expect(http.calls('POST', '/api/v1/tasks')[0]?.headers.get('Idempotency-Key')).toBe('idem-key-123456');
  });

  it('maps non-Problem error bodies, invalid success bodies and network failures', async () => {
    const { http, api } = setup();
    http.on('GET', '/api/v1/system/queue', new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    await expect(api.queue()).rejects.toMatchObject({ kind: 'http', status: 502, code: 'internal_error' });

    http.on('GET', '/api/v1/system/workers', json({ unexpected: true }));
    await expect(api.workers()).rejects.toMatchObject({ kind: 'invalid_response', code: 'invalid_response' });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.queue()).rejects.toMatchObject({ kind: 'network', status: 0, code: 'network_error' });
  });

  it('broadcasts 401 from data routes but not from the auth flow', async () => {
    const { http, api } = setup();
    http.on('GET', '/api/v1/auth/me', problem(401, 'unauthenticated', 'Authentication required'));
    http.on('GET', '/api/v1/teams', problem(401, 'unauthenticated', 'Authentication required'));
    const listener = vi.fn();
    api.client.onUnauthenticated(listener);

    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(listener).not.toHaveBeenCalled();
    await expect(api.listTeams()).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('parses Retry-After as seconds or HTTP-date', () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Mon, 02 Nov 2026 10:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});
