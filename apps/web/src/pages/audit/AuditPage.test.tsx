import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, T0, makeMe, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);

function entry(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(n),
    occurredAt: T0,
    action: 'auth.login',
    outcome: 'success',
    actorType: 'user',
    actorUserId: IDS.user,
    actorTokenId: null,
    actorLabel: 'admin',
    entityType: 'user',
    entityId: IDS.user,
    before: null,
    after: null,
    detail: null,
    ip: '10.0.0.7',
    userAgent: null,
    requestId: 'req-abc',
    correlationId: null,
    ...overrides,
  };
}

describe('audit log (contract §20.1 /audit)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('auditor')));
    http.on(
      'GET',
      '/api/v1/audit-logs',
      json(page([entry(2), entry(1, { action: 'auth.logout', outcome: 'denied', detail: { reason: 'expired' } })])),
    );
  });

  it('shows a loading state while the log loads', async () => {
    http.on('GET', '/api/v1/audit-logs', never);
    renderApp('/audit');

    expect(await screen.findByRole('heading', { name: 'Audit log', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Loading audit log…')).toBeInTheDocument();
  });

  it('lists entries with actor, outcome and a JSON detail disclosure', async () => {
    renderApp('/audit');

    const logout = (await screen.findByRole('cell', { name: 'auth.logout' })).closest('tr') as HTMLElement;
    expect(within(logout).getByText('denied')).toHaveAttribute('data-status', 'denied');
    expect(within(logout).getByText('10.0.0.7')).toBeInTheDocument();
    expect(within(logout).getByText('JSON')).toBeInTheDocument();
    expect(within(logout).getByText(/"reason": "expired"/)).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'auth.login' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Outcome' })).toBeInTheDocument();
  });

  it('shows an empty state when no entry matches', async () => {
    http.on('GET', '/api/v1/audit-logs', json(page([])));
    renderApp('/audit');

    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
  });

  it('shows the API error with a retry action', async () => {
    http.on('GET', '/api/v1/audit-logs', problem(500, 'internal_error', 'Audit unavailable'));
    renderApp('/audit');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Audit unavailable')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('applies filters to the query string and the request', async () => {
    const { user } = renderApp('/audit');
    await screen.findByRole('cell', { name: 'auth.logout' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'auth.logout');
    await user.type(screen.getByRole('textbox', { name: 'Entity id' }), 'abc');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByTestId('location')).toHaveTextContent('action=auth.logout');
    expect(screen.getByTestId('location')).toHaveTextContent('entityId=abc');
    const last = http.calls('GET', '/api/v1/audit-logs').at(-1);
    expect(last?.search.get('action')).toBe('auth.logout');
    expect(last?.search.get('entityId')).toBe('abc');
  });

  it('rejects a non-GUID actor id without calling the API again', async () => {
    const { user } = renderApp('/audit');
    await screen.findByRole('cell', { name: 'auth.logout' });
    const before = http.calls('GET', '/api/v1/audit-logs').length;

    await user.type(screen.getByRole('textbox', { name: 'Actor user id' }), 'not-a-guid');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Actor user id must be a GUID.');
    expect(http.calls('GET', '/api/v1/audit-logs')).toHaveLength(before);
  });

  it('loads the next page on demand', async () => {
    http.on(
      'GET',
      '/api/v1/audit-logs',
      (req) =>
        req.search.get('cursor') ? json(page([entry(3, { action: 'auth.lockout' })])) : json(page([entry(2)], 'next-1')),
    );
    const { user } = renderApp('/audit');

    await screen.findByRole('cell', { name: 'auth.login' });
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    expect(await screen.findByRole('cell', { name: 'auth.lockout' })).toBeInTheDocument();
  });

  it('denies access without audit:read', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    renderApp('/audit');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(http.calls('GET', '/api/v1/audit-logs')).toHaveLength(0);
  });
});
