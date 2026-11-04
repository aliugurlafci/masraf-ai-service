import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { safeNext } from '../auth/session';
import { CSRF_TOKEN, makeMe, makeUser } from '../test/fixtures';
import { installFetch, json, problem } from '../test/http';
import type { FetchMock } from '../test/http';
import { renderApp } from '../test/render';

describe('login flow', () => {
  let http: FetchMock;
  let loggedIn: boolean;

  beforeEach(() => {
    http = installFetch();
    loggedIn = false;
    http.on('GET', '/api/v1/auth/me', () =>
      loggedIn ? json(makeMe('operator')) : problem(401, 'unauthenticated', 'Authentication required'),
    );
    http.on('GET', '/api/v1/teams', json([]));
  });

  it('signs in and returns to the `next` path', async () => {
    http.on('POST', '/api/v1/auth/login', () => {
      loggedIn = true;
      return json({
        user: makeUser('operator'),
        csrfToken: CSRF_TOKEN,
        expiresAt: '2026-11-02T22:00:00.000Z',
        permissions: makeMe('operator').permissions,
      });
    });
    const { user } = renderApp(`/login?next=${encodeURIComponent('/teams')}`);

    await user.type(await screen.findByLabelText('Username'), ' Operator ');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Teams' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/teams$/);
    const [login] = http.calls('POST', '/api/v1/auth/login');
    expect(login?.body).toEqual({ username: 'Operator', password: 'correct horse battery' });
    expect(login?.headers.get('Content-Type')).toBe('application/json');
    expect(login?.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('shows the invalid credentials message on 401', async () => {
    http.on('POST', '/api/v1/auth/login', problem(401, 'invalid_credentials', 'Invalid username or password'));
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Username'), 'operator');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('shows a Retry-After countdown and blocks submit on 429 login_throttled', async () => {
    http.on(
      'POST',
      '/api/v1/auth/login',
      problem(429, 'login_throttled', 'Too many login attempts', {}, { 'Retry-After': '30' }),
    );
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Username'), 'operator');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Too many login attempts')).toBeInTheDocument();
    expect(screen.getByText(/Try again in (29|30) s\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('accepts only same-origin relative `next` targets', () => {
    expect(safeNext('/tasks/abc?tab=diff')).toBe('/tasks/abc?tab=diff');
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('//evil.example/x')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
