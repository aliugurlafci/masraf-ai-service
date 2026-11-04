import { AGENT_INSTRUCTIONS_MAX_BYTES, AGENT_INSTRUCTIONS_MAX_CHARS, EFFORT_LEVELS } from '@orc/shared';
import type { Agent, CreateAgentRequest, Effort, Team, UpdateAgentRequest } from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { fieldErrorsOf, isApiError } from '../../api/errors';
import { ProblemMessage } from '../../components/ErrorView';
import { Field } from '../../components/ui';
import { utf8Length } from '../../lib/format';

const MAX_RULES = 64;

interface Values {
  teamId: string;
  parentAgentId: string;
  name: string;
  title: string;
  description: string;
  isManager: boolean;
  model: string;
  effort: Effort | '';
  allowedTools: string[];
  disallowedTools: string[];
  instructions: string;
  maxTimeoutSeconds: string;
  maxBudgetUsd: string;
  isActive: boolean;
}

function initial(agent: Agent | undefined, teams: readonly Team[]): Values {
  return {
    teamId: agent?.teamId ?? teams[0]?.id ?? '',
    parentAgentId: agent?.parentAgentId ?? '',
    name: agent?.name ?? '',
    title: agent?.title ?? '',
    description: agent?.description ?? '',
    isManager: agent?.isManager ?? false,
    model: agent?.model ?? '',
    effort: agent?.effort ?? '',
    allowedTools: agent ? [...agent.allowedTools] : [],
    disallowedTools: agent ? [...agent.disallowedTools] : [],
    instructions: agent?.instructions ?? '',
    maxTimeoutSeconds: String(agent?.maxTimeoutSeconds ?? 3600),
    maxBudgetUsd: agent?.maxBudgetUsd === null || agent?.maxBudgetUsd === undefined ? '' : String(agent.maxBudgetUsd),
    isActive: agent?.isActive ?? true,
  };
}

/**
 * Index of the rule a 422 tool_not_allowed refers to: field issue `body.<list>.<n>` when present,
 * otherwise the first rule whose text appears in the Problem detail.
 */
function offendingRules(error: unknown, values: Values): { allowed: Set<number>; disallowed: Set<number> } {
  const allowed = new Set<number>();
  const disallowed = new Set<number>();
  if (!isApiError(error) || error.code !== 'tool_not_allowed') {
    return { allowed, disallowed };
  }
  for (const key of Object.keys(fieldErrorsOf(error))) {
    const match = /^(allowedTools|disallowedTools)\.(\d+)$/.exec(key);
    if (match) {
      (match[1] === 'allowedTools' ? allowed : disallowed).add(Number(match[2]));
    }
  }
  if (allowed.size === 0 && disallowed.size === 0 && error.detail) {
    const detail = error.detail;
    values.allowedTools.forEach((rule, i) => {
      if (rule.trim() && detail.includes(rule.trim())) allowed.add(i);
    });
    values.disallowedTools.forEach((rule, i) => {
      if (rule.trim() && detail.includes(rule.trim())) disallowed.add(i);
    });
  }
  return { allowed, disallowed };
}

function RuleList({
  label,
  rules,
  invalid,
  onChange,
}: {
  label: string;
  rules: string[];
  invalid: ReadonlySet<number>;
  onChange: (rules: string[]) => void;
}) {
  return (
    <fieldset className="rule-list">
      <legend>{label}</legend>
      {rules.length === 0 ? <p className="muted small">No rules.</p> : null}
      {rules.map((rule, i) => (
        <div key={i} className={invalid.has(i) ? 'rule-row rule-invalid' : 'rule-row'}>
          <input
            aria-label={`${label} rule ${i + 1}`}
            aria-invalid={invalid.has(i) || undefined}
            className="mono"
            value={rule}
            maxLength={512}
            onChange={(e) => onChange(rules.map((r, j) => (j === i ? e.target.value : r)))}
          />
          <button
            type="button"
            className="btn btn-ghost btn-small"
            aria-label={`Remove ${label} rule ${i + 1}`}
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
          >
            Remove
          </button>
          {invalid.has(i) ? (
            <small className="field-error" role="alert">
              This tool rule is not allowed.
            </small>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="btn btn-small"
        disabled={rules.length >= MAX_RULES}
        onClick={() => onChange([...rules, ''])}
      >
        Add rule
      </button>
    </fieldset>
  );
}

export type AgentFormSubmit =
  | { mode: 'create'; body: CreateAgentRequest }
  | { mode: 'edit'; body: UpdateAgentRequest };

export function AgentForm({
  agent,
  teams,
  agents,
  submitting,
  error,
  notice,
  onSubmit,
  onCancel,
}: {
  agent?: Agent;
  teams: readonly Team[];
  agents: readonly Agent[];
  submitting: boolean;
  error: unknown;
  notice?: string | null;
  onSubmit: (submit: AgentFormSubmit) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Values>(() => initial(agent, teams));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((prev) => ({ ...prev, [key]: value }));
  const serverErrors = fieldErrorsOf(error);
  if (isApiError(error) && error.code === 'model_not_allowed' && serverErrors.model === undefined) {
    serverErrors.model = error.detail ?? error.title;
  }
  const errorFor = (key: string) => clientErrors[key] ?? serverErrors[key];
  const invalidRules = offendingRules(error, values);
  const instructionBytes = utf8Length(values.instructions);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!values.teamId) errors.teamId = 'Choose a team.';
    if (!values.name.trim()) errors.name = 'Name is required.';
    if (!values.title.trim()) errors.title = 'Title is required.';
    if (!values.model.trim()) errors.model = 'Model is required.';
    const timeout = Number(values.maxTimeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86_400) errors.maxTimeoutSeconds = 'Between 60 and 86400 seconds.';
    let budget: number | null = null;
    if (values.maxBudgetUsd.trim()) {
      budget = Number(values.maxBudgetUsd);
      if (!Number.isFinite(budget) || budget < 0.01 || budget > 1000) errors.maxBudgetUsd = 'Between 0.01 and 1000 USD.';
    }
    if (values.instructions.length > AGENT_INSTRUCTIONS_MAX_CHARS || instructionBytes > AGENT_INSTRUCTIONS_MAX_BYTES) {
      errors.instructions = `At most ${AGENT_INSTRUCTIONS_MAX_CHARS} characters and ${AGENT_INSTRUCTIONS_MAX_BYTES} bytes.`;
    }
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const full: CreateAgentRequest = {
      teamId: values.teamId,
      parentAgentId: values.parentAgentId || null,
      name: values.name.trim(),
      title: values.title.trim(),
      description: values.description.trim() || null,
      isManager: values.isManager,
      model: values.model.trim(),
      effort: values.effort || null,
      allowedTools: values.allowedTools.map((r) => r.trim()).filter(Boolean),
      disallowedTools: values.disallowedTools.map((r) => r.trim()).filter(Boolean),
      instructions: values.instructions.length > 0 ? values.instructions : null,
      maxTimeoutSeconds: timeout,
      maxBudgetUsd: budget,
      isActive: values.isActive,
    };
    if (!agent) {
      onSubmit({ mode: 'create', body: full });
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(full)) {
      const before: unknown = agent[key as keyof Agent];
      if (JSON.stringify(value) !== JSON.stringify(before ?? null)) {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length === 0) {
      setClientErrors({ form: 'Nothing changed.' });
      return;
    }
    onSubmit({ mode: 'edit', body: patch });
  };

  const showProblem =
    isApiError(error) &&
    Object.keys(serverErrors).length === 0 &&
    error.code !== 'tool_not_allowed' &&
    error.code !== 'precondition_failed';

  return (
    <form className="form" onSubmit={submit} noValidate>
      {notice ? (
        <div className="banner banner-warning" role="alert">
          {notice}
        </div>
      ) : null}
      {showProblem ? <ProblemMessage error={error} /> : null}
      {isApiError(error) && error.code === 'tool_not_allowed' ? (
        <div className="banner banner-danger" role="alert">
          <strong className="banner-title">{error.title}</strong>
          {error.detail ? <div className="banner-body">{error.detail}</div> : null}
        </div>
      ) : null}
      {clientErrors.form ? <p className="field-error">{clientErrors.form}</p> : null}
      <div className="form-grid">
        <Field label="Team" error={errorFor('teamId')}>
          {(p) => (
            <select {...p} value={values.teamId} onChange={(e) => set('teamId', e.target.value)}>
              <option value="">Choose a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Parent agent" error={errorFor('parentAgentId')}>
          {(p) => (
            <select {...p} value={values.parentAgentId} onChange={(e) => set('parentAgentId', e.target.value)}>
              <option value="">None</option>
              {agents
                .filter((a) => a.id !== agent?.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title} ({a.name})
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Name" error={errorFor('name')}>
          {(p) => <input {...p} value={values.name} maxLength={100} onChange={(e) => set('name', e.target.value)} />}
        </Field>
        <Field label="Title" error={errorFor('title')}>
          {(p) => <input {...p} value={values.title} maxLength={100} onChange={(e) => set('title', e.target.value)} />}
        </Field>
        <Field label="Model" error={errorFor('model')}>
          {(p) => <input {...p} className="mono" value={values.model} maxLength={100} onChange={(e) => set('model', e.target.value)} />}
        </Field>
        <Field label="Effort" error={errorFor('effort')}>
          {(p) => (
            <select {...p} value={values.effort} onChange={(e) => set('effort', e.target.value as Effort | '')}>
              <option value="">Default</option>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Max timeout (s)" error={errorFor('maxTimeoutSeconds')}>
          {(p) => (
            <input {...p} type="number" min={60} max={86400} value={values.maxTimeoutSeconds} onChange={(e) => set('maxTimeoutSeconds', e.target.value)} />
          )}
        </Field>
        <Field label="Max budget (USD)" error={errorFor('maxBudgetUsd')} hint="Empty = no agent limit.">
          {(p) => (
            <input {...p} type="number" min={0.01} step={0.01} value={values.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', e.target.value)} />
          )}
        </Field>
      </div>
      <Field label="Description" error={errorFor('description')}>
        {(p) => <textarea {...p} rows={2} maxLength={2000} value={values.description} onChange={(e) => set('description', e.target.value)} />}
      </Field>
      <div className="form-grid">
        <RuleList
          label="Allowed tools"
          rules={values.allowedTools}
          invalid={invalidRules.allowed}
          onChange={(rules) => set('allowedTools', rules)}
        />
        <RuleList
          label="Disallowed tools"
          rules={values.disallowedTools}
          invalid={invalidRules.disallowed}
          onChange={(rules) => set('disallowedTools', rules)}
        />
      </div>
      <Field
        label="Instructions"
        error={errorFor('instructions')}
        hint={`${values.instructions.length} / ${AGENT_INSTRUCTIONS_MAX_CHARS} characters · ${instructionBytes} / ${AGENT_INSTRUCTIONS_MAX_BYTES} bytes`}
      >
        {(p) => <textarea {...p} rows={6} value={values.instructions} onChange={(e) => set('instructions', e.target.value)} />}
      </Field>
      <fieldset className="checkbox-row">
        <legend>Flags</legend>
        <label>
          <input type="checkbox" checked={values.isManager} onChange={(e) => set('isManager', e.target.checked)} /> Manager agent
        </label>
        <label>
          <input type="checkbox" checked={values.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
        </label>
      </fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}
        </button>
      </div>
    </form>
  );
}
