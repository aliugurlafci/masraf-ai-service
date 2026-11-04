import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EFFORT_LEVELS, TASK_TEXT_MAX_BYTES } from '@orc/shared';
import type { CreateTaskRequest, Effort } from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { fieldErrorsOf, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView, ProblemMessage } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { Field, PageHeader } from '../../components/ui';
import { formatBytes, utf8Length } from '../../lib/format';
import { IdempotencyKeys } from '../../lib/idempotency';
import { useProjectOptions } from '../useProjectNames';

/** Default TASK_PROMPT_MAX_CHARS (contract §3.3); the API enforces the configured value (422 prompt_too_large). */
export const PROMPT_MAX_CHARS = 32_000;
const TITLE_MAX = 200;
const ACCEPTANCE_MAX = 8000;
const SCOPE_MAX = 4000;

interface Values {
  projectId: string;
  agentId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string;
  scope: string;
  baseRef: string;
  model: string;
  effort: Effort | '';
  timeoutSeconds: string;
  maxBudgetUsd: string;
}

const CODE_FIELDS: Readonly<Record<string, keyof Values>> = {
  prompt_too_large: 'prompt',
  model_not_allowed: 'model',
  project_not_ready: 'projectId',
  agent_inactive: 'agentId',
};

export function NewTaskPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [keys] = useState(() => new IdempotencyKeys());
  const [values, setValues] = useState<Values>(() => ({
    projectId: params.get('projectId') ?? '',
    agentId: '',
    title: '',
    prompt: '',
    acceptanceCriteria: '',
    scope: '',
    baseRef: '',
    model: '',
    effort: '',
    timeoutSeconds: '',
    maxBudgetUsd: '',
  }));
  const [clientErrors, setClientErrors] = useState<Partial<Record<keyof Values, string>>>({});

  const projects = useProjectOptions('ready');
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: false }),
    queryFn: () => api.listAgents(),
  });

  const create = useMutation({
    mutationFn: (body: CreateTaskRequest) => api.createTask(body, keys.keyFor(body)),
    onSettled: (_data, error) => keys.settle(error),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      await navigate(`/tasks/${res.data.id}`);
    },
  });

  if (projects.isPending || agents.isPending) {
    return <Loading label="Loading projects and agents" />;
  }
  if (projects.isError || agents.isError) {
    return (
      <ErrorView
        error={projects.error ?? agents.error}
        onRetry={() => {
          void projects.refetch();
          void agents.refetch();
        }}
      />
    );
  }

  const readyProjects = projects.data.items;
  const activeAgents = agents.data.filter((a) => a.isActive);
  const project = readyProjects.find((p) => p.id === values.projectId);
  const effectiveAgentId = values.agentId || project?.defaultAgentId || '';
  const agent = activeAgents.find((a) => a.id === effectiveAgentId);

  const textBytes =
    utf8Length(values.title) + utf8Length(values.prompt) + utf8Length(values.acceptanceCriteria) + utf8Length(values.scope);

  const serverErrors = fieldErrorsOf(create.error);
  if (isApiError(create.error)) {
    const field = CODE_FIELDS[create.error.code];
    if (field !== undefined && serverErrors[field] === undefined) {
      serverErrors[field] = create.error.detail ?? create.error.title;
    }
  }
  const errorFor = (key: keyof Values): string | undefined => clientErrors[key] ?? serverErrors[key];
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((prev) => ({ ...prev, [key]: value }));

  const validate = (): Partial<Record<keyof Values, string>> => {
    const errors: Partial<Record<keyof Values, string>> = {};
    if (!project) {
      errors.projectId = 'Choose a ready project.';
    }
    if (!agent) {
      errors.agentId = project?.defaultAgentId
        ? 'The project default agent is not active; choose an agent.'
        : 'Choose an agent (the project has no default agent).';
    }
    if (values.title.trim().length === 0) {
      errors.title = 'Title is required.';
    } else if (values.title.trim().length > TITLE_MAX) {
      errors.title = `At most ${TITLE_MAX} characters.`;
    }
    if (!/\S/.test(values.prompt)) {
      errors.prompt = 'The prompt must contain at least one non-whitespace character.';
    } else if (values.prompt.length > PROMPT_MAX_CHARS) {
      errors.prompt = `At most ${PROMPT_MAX_CHARS} characters.`;
    } else if (textBytes > TASK_TEXT_MAX_BYTES) {
      errors.prompt = `Title, prompt, acceptance criteria and scope together exceed ${formatBytes(TASK_TEXT_MAX_BYTES)} (UTF-8).`;
    }
    if (values.acceptanceCriteria.length > ACCEPTANCE_MAX) {
      errors.acceptanceCriteria = `At most ${ACCEPTANCE_MAX} characters.`;
    }
    if (values.scope.length > SCOPE_MAX) {
      errors.scope = `At most ${SCOPE_MAX} characters.`;
    }
    if (values.timeoutSeconds.trim()) {
      const t = Number(values.timeoutSeconds);
      const max = agent ? agent.maxTimeoutSeconds : 86_400;
      if (!Number.isInteger(t) || t < 60 || t > max) {
        errors.timeoutSeconds = `Whole seconds between 60 and ${max}.`;
      }
    }
    if (values.maxBudgetUsd.trim()) {
      const b = Number(values.maxBudgetUsd);
      const max = agent?.maxBudgetUsd ?? 1000;
      if (!Number.isFinite(b) || b < 0.01 || b > max) {
        errors.maxBudgetUsd = `Between 0.01 and ${max} USD.`;
      }
    }
    return errors;
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = validate();
    setClientErrors(errors);
    if (Object.keys(errors).length > 0 || !project || !agent) {
      return;
    }
    const body: CreateTaskRequest = {
      projectId: project.id,
      agentId: agent.id,
      title: values.title.trim(),
      prompt: values.prompt,
    };
    if (values.acceptanceCriteria.trim()) body.acceptanceCriteria = values.acceptanceCriteria;
    if (values.scope.trim()) body.scope = values.scope;
    if (values.baseRef.trim()) body.baseRef = values.baseRef.trim();
    if (values.model.trim()) body.model = values.model.trim();
    if (values.effort) body.effort = values.effort;
    if (values.timeoutSeconds.trim()) body.timeoutSeconds = Number(values.timeoutSeconds);
    if (values.maxBudgetUsd.trim()) body.maxBudgetUsd = Number(values.maxBudgetUsd);
    create.mutate(body);
  };

  const generalProblem =
    isApiError(create.error) &&
    Object.keys(fieldErrorsOf(create.error)).length === 0 &&
    CODE_FIELDS[create.error.code] === undefined
      ? create.error
      : null;

  return (
    <>
      <PageHeader title="New task" subtitle="Describe the change; Claude Code runs it in an isolated worktree." />
      {readyProjects.length === 0 ? (
        <Empty>No project is ready. A project must be validated (status ready) before tasks can be created.</Empty>
      ) : (
        <form className="form card" onSubmit={submit} noValidate>
          {generalProblem ? <ProblemMessage error={generalProblem} /> : null}
          <div className="form-grid">
            <Field label="Project" error={errorFor('projectId')}>
              {(p) => (
                <select {...p} value={values.projectId} required onChange={(e) => set('projectId', e.target.value)}>
                  <option value="">Choose a project…</option>
                  {readyProjects.map((proj) => (
                    <option key={proj.id} value={proj.id}>
                      {proj.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="Agent"
              error={errorFor('agentId')}
              hint={agent ? `${agent.description ?? agent.title} · model ${agent.model}` : undefined}
            >
              {(p) => (
                <select {...p} value={values.agentId} onChange={(e) => set('agentId', e.target.value)}>
                  <option value="">
                    {project?.defaultAgentId ? 'Project default agent' : 'Choose an agent…'}
                  </option>
                  {activeAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} ({a.name})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field label="Title" error={errorFor('title')}>
            {(p) => (
              <input {...p} value={values.title} maxLength={TITLE_MAX} required onChange={(e) => set('title', e.target.value)} />
            )}
          </Field>
          <Field
            label="Prompt"
            error={errorFor('prompt')}
            hint={`${values.prompt.length.toLocaleString()} / ${PROMPT_MAX_CHARS.toLocaleString()} characters · ${formatBytes(textBytes)} of ${formatBytes(TASK_TEXT_MAX_BYTES)} task text`}
          >
            {(p) => (
              <textarea {...p} rows={10} value={values.prompt} required onChange={(e) => set('prompt', e.target.value)} />
            )}
          </Field>
          <Field label="Acceptance criteria" error={errorFor('acceptanceCriteria')}>
            {(p) => (
              <textarea {...p} rows={3} maxLength={ACCEPTANCE_MAX} value={values.acceptanceCriteria} onChange={(e) => set('acceptanceCriteria', e.target.value)} />
            )}
          </Field>
          <Field label="Scope" error={errorFor('scope')} hint="Paths or areas Claude may change.">
            {(p) => (
              <textarea {...p} rows={2} maxLength={SCOPE_MAX} value={values.scope} onChange={(e) => set('scope', e.target.value)} />
            )}
          </Field>
          <details className="advanced">
            <summary>Advanced options</summary>
            <div className="form-grid">
              <Field label="Base ref" error={errorFor('baseRef')} hint={`Branch, tag or commit. Default: ${project?.defaultBranch ?? 'HEAD'}.`}>
                {(p) => <input {...p} value={values.baseRef} maxLength={200} onChange={(e) => set('baseRef', e.target.value)} />}
              </Field>
              <Field label="Model" error={errorFor('model')} hint={agent ? `Default: ${agent.model}` : undefined}>
                {(p) => <input {...p} value={values.model} maxLength={100} placeholder={agent?.model} onChange={(e) => set('model', e.target.value)} />}
              </Field>
              <Field label="Effort" error={errorFor('effort')}>
                {(p) => (
                  <select {...p} value={values.effort} onChange={(e) => set('effort', e.target.value as Effort | '')}>
                    <option value="">Agent default</option>
                    {EFFORT_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label="Timeout (s)"
                error={errorFor('timeoutSeconds')}
                hint={`Default: project setting (${project?.defaultTimeoutSeconds ?? '-'} s), max ${agent?.maxTimeoutSeconds ?? '-'} s.`}
              >
                {(p) => <input {...p} type="number" min={60} value={values.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />}
              </Field>
              <Field label="Budget (USD)" error={errorFor('maxBudgetUsd')} hint={agent?.maxBudgetUsd ? `Agent limit: ${agent.maxBudgetUsd} USD.` : undefined}>
                {(p) => <input {...p} type="number" min={0.01} step={0.01} value={values.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', e.target.value)} />}
              </Field>
            </div>
          </details>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={create.isPending}>
              {create.isPending ? 'Submitting…' : 'Create task'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
