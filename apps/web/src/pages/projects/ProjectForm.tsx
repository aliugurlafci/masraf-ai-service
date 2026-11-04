import { INDEX_MODES } from '@orc/shared';
import type {
  Agent,
  CreateProjectRequest,
  IndexMode,
  Project,
  UpdateProjectRequest,
} from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { fieldErrorsOf, isApiError } from '../../api/errors';
import { ProblemMessage } from '../../components/ErrorView';
import { Field } from '../../components/ui';

const MIB = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,99}$/;

interface FormValues {
  name: string;
  description: string;
  repoPath: string;
  defaultBranch: string;
  testCommand: string;
  testTimeoutSeconds: string;
  junitReportPath: string;
  requireIndex: boolean;
  autoIndex: boolean;
  indexMode: IndexMode;
  defaultAgentId: string;
  defaultTimeoutSeconds: string;
  workspaceMaxMiB: string;
}

function initialValues(project: Project | undefined): FormValues {
  return {
    name: project?.name ?? '',
    description: project?.description ?? '',
    repoPath: project?.repoPath ?? '',
    defaultBranch: project?.defaultBranch ?? '',
    testCommand: project?.testCommand?.join('\n') ?? '',
    testTimeoutSeconds: String(project?.testTimeoutSeconds ?? 900),
    junitReportPath: project?.junitReportPath ?? '',
    requireIndex: project?.requireIndex ?? false,
    autoIndex: project?.autoIndex ?? true,
    indexMode: project?.indexMode ?? 'moderate',
    defaultAgentId: project?.defaultAgentId ?? '',
    defaultTimeoutSeconds: String(project?.defaultTimeoutSeconds ?? 3600),
    workspaceMaxMiB:
      project?.workspaceMaxBytes === null || project?.workspaceMaxBytes === undefined
        ? ''
        : String(Math.round(project.workspaceMaxBytes / MIB)),
  };
}

function parseTestCommand(text: string): string[] | null {
  const args = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);
  return args.length === 0 ? null : args;
}

function toInt(text: string): number {
  return Number.parseInt(text.trim(), 10);
}

type Normalized = Omit<CreateProjectRequest, 'repoPath'> & { repoPath: string };

function normalize(values: FormValues): { body: Normalized; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = values.name.trim();
  if (!NAME_RE.test(name)) {
    errors.name = 'Use 2-100 characters: letters, digits, space, dot, underscore or dash; start with a letter or digit.';
  }
  if (values.repoPath.trim().length === 0) {
    errors.repoPath = 'Repository path is required.';
  }
  const testTimeoutSeconds = toInt(values.testTimeoutSeconds);
  if (!Number.isInteger(testTimeoutSeconds) || testTimeoutSeconds < 30 || testTimeoutSeconds > 7200) {
    errors.testTimeoutSeconds = 'Between 30 and 7200 seconds.';
  }
  const defaultTimeoutSeconds = toInt(values.defaultTimeoutSeconds);
  if (!Number.isInteger(defaultTimeoutSeconds) || defaultTimeoutSeconds < 60 || defaultTimeoutSeconds > 86_400) {
    errors.defaultTimeoutSeconds = 'Between 60 and 86400 seconds.';
  }
  let workspaceMaxBytes: number | null = null;
  if (values.workspaceMaxMiB.trim().length > 0) {
    const mib = toInt(values.workspaceMaxMiB);
    if (!Number.isInteger(mib) || mib < 100) {
      errors.workspaceMaxBytes = 'At least 100 MiB (leave empty for the installation default).';
    } else {
      workspaceMaxBytes = mib * MIB;
    }
  }
  if (values.description.length > 2000) {
    errors.description = 'At most 2000 characters.';
  }
  return {
    errors,
    body: {
      name,
      description: values.description.trim().length > 0 ? values.description.trim() : null,
      repoPath: values.repoPath.trim(),
      defaultBranch: values.defaultBranch.trim().length > 0 ? values.defaultBranch.trim() : null,
      testCommand: parseTestCommand(values.testCommand),
      testTimeoutSeconds,
      junitReportPath: values.junitReportPath.trim().length > 0 ? values.junitReportPath.trim() : null,
      requireIndex: values.requireIndex,
      autoIndex: values.autoIndex,
      indexMode: values.indexMode,
      defaultAgentId: values.defaultAgentId.length > 0 ? values.defaultAgentId : null,
      defaultTimeoutSeconds,
      workspaceMaxBytes,
    },
  };
}

/** Fields that changed compared with the loaded project (PATCH sends only these). */
function diffUpdate(project: Project, body: Normalized): UpdateProjectRequest {
  const patch: Record<string, unknown> = {};
  const compare: [keyof Normalized, unknown][] = [
    ['name', project.name],
    ['description', project.description],
    ['defaultBranch', project.defaultBranch],
    ['testCommand', project.testCommand],
    ['testTimeoutSeconds', project.testTimeoutSeconds],
    ['junitReportPath', project.junitReportPath],
    ['requireIndex', project.requireIndex],
    ['autoIndex', project.autoIndex],
    ['indexMode', project.indexMode],
    ['defaultAgentId', project.defaultAgentId],
    ['defaultTimeoutSeconds', project.defaultTimeoutSeconds],
    ['workspaceMaxBytes', project.workspaceMaxBytes],
  ];
  for (const [key, before] of compare) {
    const after = body[key];
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      patch[key] = after;
    }
  }
  return patch;
}

const CODE_FIELDS: Readonly<Record<string, string>> = {
  project_name_taken: 'name',
  project_repo_taken: 'repoPath',
  not_found: 'defaultAgentId',
};

export type ProjectFormSubmit =
  | { mode: 'create'; body: CreateProjectRequest }
  | { mode: 'edit'; body: UpdateProjectRequest };

export function ProjectForm({
  project,
  agents,
  submitting,
  error,
  notice,
  onSubmit,
  onCancel,
}: {
  /** Present => edit mode (repoPath is immutable). */
  project?: Project;
  agents: readonly Agent[];
  submitting: boolean;
  error: unknown;
  notice?: string | null;
  onSubmit: (submit: ProjectFormSubmit) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(project));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const serverErrors = fieldErrorsOf(error);
  if (isApiError(error)) {
    const field = CODE_FIELDS[error.code];
    if (field !== undefined && serverErrors[field] === undefined) {
      serverErrors[field] = error.title;
    }
  }
  const errorFor = (key: string): string | undefined => clientErrors[key] ?? serverErrors[key];
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { body, errors } = normalize(project ? { ...values, repoPath: project.repoPath } : values);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    if (project) {
      const patch = diffUpdate(project, body);
      if (Object.keys(patch).length === 0) {
        setClientErrors({ form: 'Nothing changed.' });
        return;
      }
      onSubmit({ mode: 'edit', body: patch });
    } else {
      onSubmit({ mode: 'create', body });
    }
  };

  const showProblem =
    isApiError(error) &&
    Object.keys(serverErrors).length === 0 &&
    error.code !== 'precondition_failed';

  return (
    <form className="form" onSubmit={submit} noValidate>
      {notice ? (
        <div className="banner banner-warning" role="alert">
          {notice}
        </div>
      ) : null}
      {showProblem ? <ProblemMessage error={error} /> : null}
      {clientErrors.form ? (
        <p className="field-error" role="alert">
          {clientErrors.form}
        </p>
      ) : null}
      <div className="form-grid">
        <Field label="Name" error={errorFor('name')}>
          {(p) => (
            <input {...p} value={values.name} maxLength={100} required onChange={(e) => set('name', e.target.value)} />
          )}
        </Field>
        <Field
          label="Repository path"
          error={errorFor('repoPath')}
          hint={project ? 'The repository path cannot be changed.' : 'Relative to the projects root, e.g. team/service.'}
        >
          {(p) => (
            <input
              {...p}
              value={project ? project.repoPath : values.repoPath}
              readOnly={project !== undefined}
              maxLength={255}
              required
              onChange={(e) => set('repoPath', e.target.value)}
            />
          )}
        </Field>
        <Field label="Default branch" error={errorFor('defaultBranch')} hint="Empty = repository HEAD.">
          {(p) => (
            <input {...p} value={values.defaultBranch} maxLength={200} onChange={(e) => set('defaultBranch', e.target.value)} />
          )}
        </Field>
        <Field label="Default agent" error={errorFor('defaultAgentId')}>
          {(p) => (
            <select {...p} value={values.defaultAgentId} onChange={(e) => set('defaultAgentId', e.target.value)}>
              <option value="">None (choose per task)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} ({a.name})
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Description" error={errorFor('description')}>
        {(p) => (
          <textarea {...p} rows={2} maxLength={2000} value={values.description} onChange={(e) => set('description', e.target.value)} />
        )}
      </Field>
      <Field
        label="Test command"
        error={errorFor('testCommand')}
        hint="One argument per line (executed without a shell), e.g. npm / test. Empty = no tests."
      >
        {(p) => (
          <textarea {...p} rows={3} className="mono" value={values.testCommand} onChange={(e) => set('testCommand', e.target.value)} />
        )}
      </Field>
      <div className="form-grid">
        <Field label="Test timeout (s)" error={errorFor('testTimeoutSeconds')}>
          {(p) => (
            <input {...p} type="number" min={30} max={7200} value={values.testTimeoutSeconds} onChange={(e) => set('testTimeoutSeconds', e.target.value)} />
          )}
        </Field>
        <Field label="JUnit report path" error={errorFor('junitReportPath')} hint="Relative to the worktree.">
          {(p) => (
            <input {...p} value={values.junitReportPath} maxLength={400} onChange={(e) => set('junitReportPath', e.target.value)} />
          )}
        </Field>
        <Field label="Default task timeout (s)" error={errorFor('defaultTimeoutSeconds')}>
          {(p) => (
            <input {...p} type="number" min={60} max={86400} value={values.defaultTimeoutSeconds} onChange={(e) => set('defaultTimeoutSeconds', e.target.value)} />
          )}
        </Field>
        <Field label="Workspace quota (MiB)" error={errorFor('workspaceMaxBytes')} hint="Empty = installation default.">
          {(p) => (
            <input {...p} type="number" min={100} value={values.workspaceMaxMiB} onChange={(e) => set('workspaceMaxMiB', e.target.value)} />
          )}
        </Field>
        <Field label="Index mode" error={errorFor('indexMode')}>
          {(p) => (
            <select {...p} value={values.indexMode} onChange={(e) => set('indexMode', e.target.value as IndexMode)}>
              {INDEX_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <fieldset className="checkbox-row">
        <legend>Code index</legend>
        <label>
          <input type="checkbox" checked={values.autoIndex} onChange={(e) => set('autoIndex', e.target.checked)} /> Index
          automatically after sync
        </label>
        <label>
          <input type="checkbox" checked={values.requireIndex} onChange={(e) => set('requireIndex', e.target.checked)} />{' '}
          Tasks require a successful index
        </label>
      </fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : project ? 'Save changes' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
