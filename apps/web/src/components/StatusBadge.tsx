import { humanize } from '../lib/format';

type Tone = 'neutral' | 'info' | 'active' | 'success' | 'warning' | 'danger' | 'muted';

const TONES: Readonly<Record<string, Tone>> = {
  // tasks / attempts
  created: 'neutral',
  queued: 'info',
  preparing_workspace: 'active',
  indexing: 'active',
  running: 'active',
  testing: 'active',
  reviewing: 'active',
  active: 'active',
  completed: 'success',
  succeeded: 'success',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'muted',
  blocked: 'warning',
  interrupted: 'warning',
  // projects
  validating: 'info',
  ready: 'success',
  invalid: 'danger',
  archived: 'muted',
  // tests
  passed: 'success',
  error: 'danger',
  skipped: 'muted',
  // mcp / merge check / workers
  clean: 'success',
  conflicts: 'danger',
  not_run: 'muted',
  starting: 'info',
  draining: 'warning',
  offline: 'muted',
  killed: 'danger',
  success: 'success',
  failure: 'danger',
  denied: 'warning',
  stale: 'warning',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = TONES[status] ?? 'neutral';
  return (
    <span className={`badge badge-${tone}`} data-status={status}>
      {label ?? humanize(status)}
    </span>
  );
}
