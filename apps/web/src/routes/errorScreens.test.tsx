import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { installEventSource } from '../test/eventSource';
import { CSRF_TOKEN, IDS, makeMe } from '../test/fixtures';
import { installFetch, json, noContent, problem } from '../test/http';
import type { FetchMock } from '../test/http';
import { renderApp } from '../test/render';

describe('error, forbidden and not-found screens (contract §20.1, §20.2)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    installEventSource();
  });

  it('shows the network error screen with a retry when the API cannot be reached', async () => {
    let online = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!online) {
          throw new TypeError('Failed to fetch');
        }
        return http.fetch(input, init);
      }),
    );
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/teams', json([]));
    const { user } = renderApp('/teams');

    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
    online = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Teams' })).toBeInTheDocument();
  });

  it('renders the standalone 403 page', async () => {
    renderApp('/403');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
  });

  it('renders the not-found view when the API answers 404 for a task', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', `/api/v1/tasks/${IDS.task}`, problem(404, 'not_found', 'Not found'));
    renderApp(`/tasks/${IDS.task}`);

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByText('The task you are looking for does not exist or is not visible to you.')).toBeInTheDocument();
  });

  it('renders an inline forbidden view when a data route answers 403', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/teams', problem(403, 'forbidden', 'Forbidden'));
    renderApp('/teams');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });

  it('keeps the shell alive when a view throws while rendering', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Fragile() {
      if (broken) {
        throw new Error('view exploded');
      }
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('view exploded')).toBeInTheDocument();
    broken = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('signs out with the CSRF header and returns to the login page', async () => {
    let loggedIn = true;
    http.on('GET', '/api/v1/auth/me', () =>
      loggedIn ? json(makeMe('operator')) : problem(401, 'unauthenticated', 'Authentication required'),
    );
    http.on('GET', '/api/v1/teams', json([]));
    http.on('POST', '/api/v1/auth/logout', () => {
      loggedIn = false;
      return noContent();
    });
    const { user } = renderApp('/teams');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/login$/);
    expect(http.calls('POST', '/api/v1/auth/logout')[0]?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
  });
});
