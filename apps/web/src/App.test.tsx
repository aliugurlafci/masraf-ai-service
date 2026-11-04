import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { installFetch, problem } from './test/http';
import type { FetchMock } from './test/http';

describe('App shell', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    window.history.replaceState(null, '', '/tasks');
  });

  it('boots with the browser router and sends anonymous users to the login page', async () => {
    http.on('GET', '/api/v1/auth/me', problem(401, 'unauthenticated', 'Authentication required'));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Claude Code Orchestrator' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe(`?next=${encodeURIComponent('/tasks')}`);
    const [me] = http.calls('GET', '/api/v1/auth/me');
    expect(me?.url).toBe('/api/v1/auth/me');
  });
});
