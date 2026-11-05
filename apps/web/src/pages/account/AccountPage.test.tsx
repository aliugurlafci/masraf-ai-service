import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_TOKEN, T0, id, makeMe } from '../../test/fixtures';
import { installFetch, json, noContent, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);

function token(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: id(500 + n),
    name: `ci-token-${n}`,
    prefix: `orc_${n}abc`,
    readOnly: false,
    expiresAt: '2027-01-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('account (contract §20.1 /account)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/auth/tokens', json([token(1), token(2, { readOnly: true, revokedAt: T0 })]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows profile details and the token list', async () => {
    renderApp('/account');

    expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument();
    expect(await within(screen.getByRole('main')).findByText('Operator User')).toBeInTheDocument();
    expect(screen.getByText('browser session')).toBeInTheDocument();

    const first = (await screen.findByRole('cell', { name: 'ci-token-1' })).closest('tr') as HTMLElement;
    expect(within(first).getByText('read/write')).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    const second = screen.getByRole('cell', { name: 'ci-token-2' }).closest('tr') as HTMLElement;
    expect(within(second).getByText('revoked')).toBeInTheDocument();
    expect(within(second).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('shows a loading state for the token list', async () => {
    http.on('GET', '/api/v1/auth/tokens', never);
    renderApp('/account');

    expect(await screen.findByText('Loading tokens…')).toBeInTheDocument();
  });

  it('shows the empty token state', async () => {
    http.on('GET', '/api/v1/auth/tokens', json([]));
    renderApp('/account');

    expect(await screen.findByText('You have no access tokens.')).toBeInTheDocument();
  });

  it('shows the API error for the token list', async () => {
    http.on('GET', '/api/v1/auth/tokens', problem(500, 'internal_error', 'Tokens unavailable'));
    renderApp('/account');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Tokens unavailable')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('creates a token, reveals the secret once and sends the CSRF header', async () => {
    http.on(
      'POST',
      '/api/v1/auth/tokens',
      json({ token: 'orc_secret_value_123', apiToken: token(3, { name: 'deploy' }) }, 201),
    );
    const { user } = renderApp('/account');

    const create = await screen.findByRole('button', { name: 'Create token' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Token name'), 'deploy');
    await user.click(create);

    expect(await screen.findByText('orc_secret_value_123')).toBeInTheDocument();
    expect(screen.getByText('Token "deploy" created')).toBeInTheDocument();
    const [req] = http.calls('POST', '/api/v1/auth/tokens');
    expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
    expect(req?.body).toMatchObject({ name: 'deploy', expiresInDays: 90, readOnly: false });

    await user.click(screen.getByRole('button', { name: 'I have stored the token' }));
    expect(screen.queryByText('orc_secret_value_123')).not.toBeInTheDocument();
  });

  it('flags an out-of-range expiry and keeps the form disabled', async () => {
    const { user } = renderApp('/account');

    const days = await screen.findByLabelText('Expires in (days)');
    await user.clear(days);
    await user.type(days, '400');

    expect(screen.getByText('Between 1 and 365 days.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Token name'), 'x');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
  });

  it('revokes a token after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    http.on('DELETE', `/api/v1/auth/tokens/${id(501)}`, noContent());
    const { user } = renderApp('/account');

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ci-token-1'));
    await vi.waitFor(() => expect(http.calls('DELETE', `/api/v1/auth/tokens/${id(501)}`)).toHaveLength(1));
  });

  it('does not revoke when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user } = renderApp('/account');

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(http.calls('DELETE', /\/auth\/tokens\//)).toHaveLength(0);
  });

  it('validates the new password locally before calling the API', async () => {
    const { user } = renderApp('/account');

    await user.type(await screen.findByLabelText('Current password'), 'old-password-1');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The new password must be 12 to 256 characters long.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'long-enough-pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'different-pass-22');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(http.calls('POST', '/api/v1/auth/password')).toHaveLength(0);
  });

  it('changes the password and confirms it', async () => {
    http.on('POST', '/api/v1/auth/password', noContent());
    const { user } = renderApp('/account');

    await user.type(await screen.findByLabelText('Current password'), 'old-password-1');
    await user.type(screen.getByLabelText('New password'), 'long-enough-pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'long-enough-pass-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Password changed. Your other sessions were signed out.')).toBeInTheDocument();
    expect(http.calls('POST', '/api/v1/auth/password')[0]?.body).toEqual({
      currentPassword: 'old-password-1',
      newPassword: 'long-enough-pass-1',
    });
  });

  it('marks a wrong current password on its field', async () => {
    http.on('POST', '/api/v1/auth/password', problem(401, 'invalid_credentials', 'Invalid credentials'));
    const { user } = renderApp('/account');

    await user.type(await screen.findByLabelText('Current password'), 'wrong-password-1');
    await user.type(screen.getByLabelText('New password'), 'long-enough-pass-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'long-enough-pass-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('The current password is wrong.')).toBeInTheDocument();
  });

  it('only shows read-only profile data when signed in with an API token', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator', { authMethod: 'token', tokenReadOnly: true })));
    renderApp('/account');

    expect(await screen.findByText('API token (read-only)')).toBeInTheDocument();
    expect(screen.getByText('Tokens and passwords can only be managed from a browser session.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Personal access tokens' })).not.toBeInTheDocument();
    expect(http.calls('GET', '/api/v1/auth/tokens')).toHaveLength(0);
  });
});
