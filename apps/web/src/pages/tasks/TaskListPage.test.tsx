import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, id, makeMe, makeProject, makeTask, page } from '../../test/fixtures';
import { installFetch, json } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

describe('task list (contract §20.1 /tasks)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/projects', json(page([makeProject()])));
    http.on('GET', '/api/v1/tasks', (req) => {
      if (req.search.get('cursor') === 'next-1') {
        return json(page([makeTask({ id: id(102), title: 'Third task' })]));
      }
      if (req.search.get('status') === 'failed') {
        return json(page([makeTask({ id: id(103), title: 'Failed task', status: 'failed', finishedAt: '2026-11-02T11:00:00.000Z' })]));
      }
      return json(page([makeTask(), makeTask({ id: id(101), title: 'Second task', status: 'queued' })], 'next-1'));
    });
  });

  it('pages with a cursor through "Load more"', async () => {
    const { user } = renderApp('/tasks');

    expect(await screen.findByRole('link', { name: 'Fix invoice rounding' })).toHaveAttribute('href', `/tasks/${IDS.task}`);
    expect(screen.getByRole('link', { name: 'Second task' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Third task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    const calls = http.calls('GET', '/api/v1/tasks');
    expect(calls.map((c) => c.search.get('cursor'))).toEqual([null, 'next-1']);
    expect(calls[0]?.search.get('limit')).toBe('25');
  });

  it('applies the status and project filters from the URL and never sends createdBy without task:read:any', async () => {
    renderApp(`/tasks?status=failed&projectId=${IDS.project}&mine=1`);

    expect(await screen.findByRole('link', { name: 'Failed task' })).toBeInTheDocument();
    const [req] = http.calls('GET', '/api/v1/tasks');
    expect(req?.search.get('status')).toBe('failed');
    expect(req?.search.get('projectId')).toBe(IDS.project);
    expect(req?.search.has('createdBy')).toBe(false);
    expect(screen.queryByLabelText('Only my tasks')).not.toBeInTheDocument();
  });

  it('filters by status from the toolbar and offers "Only my tasks" with task:read:any', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    const { user } = renderApp('/tasks');

    await screen.findByRole('link', { name: 'Fix invoice rounding' });
    await user.click(screen.getByText('Status', { selector: 'summary' }));
    await user.click(screen.getByRole('checkbox', { name: 'failed' }));

    expect(await screen.findByRole('link', { name: 'Failed task' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks?status=failed');

    await user.click(screen.getByRole('checkbox', { name: 'Only my tasks' }));
    await waitFor(() => expect(http.calls('GET', '/api/v1/tasks').at(-1)?.search.get('createdBy')).toBe(IDS.user));

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Second task' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/tasks$/);
  });
});
