import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installEventSource } from '../../test/eventSource';
import { CSRF_TOKEN, IDS, id, makeAgent, makeMe, makeProject, makeTask, makeTaskDetail, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,255}$/;

describe('new task form (contract §20.1 /tasks/new)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    installEventSource();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/projects', json(page([makeProject()])));
    http.on('GET', '/api/v1/agents', json([makeAgent(), makeAgent({ id: id(21), name: 'reviewer', title: 'Reviewer' })]));
    http.on('GET', `/api/v1/tasks/${IDS.task}`, json(makeTaskDetail({ status: 'queued', currentAttemptId: null, startedAt: null })));
    http.on('GET', `/api/v1/tasks/${IDS.task}/attempts`, json([]));
  });

  async function fillForm(user: ReturnType<typeof renderApp>['user']): Promise<void> {
    await user.selectOptions(await screen.findByLabelText('Project'), IDS.project);
    await user.type(screen.getByLabelText('Title'), '  Fix invoice rounding  ');
    await user.type(screen.getByLabelText('Prompt'), 'Fix the rounding bug');
  }

  it('loads ready projects and active agents', async () => {
    renderApp('/tasks/new');

    const project = await screen.findByLabelText('Project');
    expect(http.calls('GET', '/api/v1/projects')[0]?.search.get('status')).toBe('ready');
    expect(within(project).getByRole('option', { name: 'Billing service' })).toBeInTheDocument();
    const agent = screen.getByLabelText('Agent');
    expect(within(agent).getByRole('option', { name: 'Reviewer (reviewer)' })).toBeInTheDocument();
  });

  it('sends Idempotency-Key and X-CSRF-Token, then opens the created task on 202', async () => {
    http.on('POST', '/api/v1/tasks', json(makeTask({ status: 'queued' }), 202, { Location: `/api/v1/tasks/${IDS.task}` }));
    const { user } = renderApp('/tasks/new');

    await fillForm(user);
    await user.selectOptions(screen.getByLabelText('Agent'), id(21));
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(await screen.findByRole('heading', { name: 'Fix invoice rounding' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${IDS.task}`);
    const [req] = http.calls('POST', '/api/v1/tasks');
    expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
    expect(req?.headers.get('Idempotency-Key')).toMatch(IDEMPOTENCY_KEY);
    expect(req?.headers.get('Content-Type')).toBe('application/json');
    expect(req?.body).toEqual({
      projectId: IDS.project,
      agentId: id(21),
      title: 'Fix invoice rounding',
      prompt: 'Fix the rounding bug',
    });
  });

  it('uses the project default agent when none is chosen', async () => {
    http.on('POST', '/api/v1/tasks', json(makeTask({ status: 'queued' }), 202));
    const { user } = renderApp('/tasks/new');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await screen.findByRole('heading', { name: 'Fix invoice rounding' });
    expect(http.calls('POST', '/api/v1/tasks')[0]?.body).toMatchObject({ agentId: IDS.agent });
  });

  it('validates on the client before sending (blank prompt, missing project)', async () => {
    const { user } = renderApp('/tasks/new');

    await user.type(await screen.findByLabelText('Title'), 'Something');
    await user.type(screen.getByLabelText('Prompt'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(screen.getByText('Choose a ready project.')).toBeInTheDocument();
    expect(screen.getByText('The prompt must contain at least one non-whitespace character.')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('aria-invalid', 'true');
    expect(http.calls('POST', '/api/v1/tasks')).toHaveLength(0);
  });

  it('shows 422 prompt_too_large on the prompt field and uses a new key for the next submit', async () => {
    // later registrations take precedence: the one-shot 422 answers first
    http.on('POST', '/api/v1/tasks', json(makeTask({ status: 'queued' }), 202));
    http.once(
      'POST',
      '/api/v1/tasks',
      problem(422, 'prompt_too_large', 'Prompt too large', { detail: 'The prompt exceeds 32000 characters.' }),
    );
    const { user } = renderApp('/tasks/new');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    const error = await screen.findByText('The prompt exceeds 32000 characters.');
    expect(error).toHaveAttribute('id', screen.getByLabelText('Prompt').getAttribute('aria-describedby')?.split(' ').at(-1));

    await user.type(screen.getByLabelText('Prompt'), '!');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await screen.findByRole('heading', { name: 'Fix invoice rounding' });

    const [first, second] = http.calls('POST', '/api/v1/tasks');
    expect(first?.headers.get('Idempotency-Key')).toMatch(IDEMPOTENCY_KEY);
    expect(second?.headers.get('Idempotency-Key')).toMatch(IDEMPOTENCY_KEY);
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'));
  });

  it('reuses the Idempotency-Key when the identical body is re-submitted after a lost response', async () => {
    http.on('POST', '/api/v1/tasks', json(makeTask({ status: 'queued' }), 202));
    http.once('POST', '/api/v1/tasks', problem(503, 'service_unavailable', 'Service unavailable'));
    const { user } = renderApp('/tasks/new');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await screen.findByRole('heading', { name: 'Fix invoice rounding' });

    const [first, second] = http.calls('POST', '/api/v1/tasks');
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
  });

  it('shows the 403 page in place for roles without task:create', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('auditor')));
    renderApp('/tasks/new');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(http.calls('GET', '/api/v1/agents')).toHaveLength(0);
  });
});
