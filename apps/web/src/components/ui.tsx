import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { formatDateTime } from '../lib/format';

export function DateTime({ value }: { value: string | null | undefined }) {
  if (!value) {
    return <span className="muted">-</span>;
  }
  return (
    <time dateTime={value} title={value}>
      {formatDateTime(value)}
    </time>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** "Load more" button for cursor-paged lists (contract §9.4). */
export function LoadMore({
  hasMore,
  loading,
  onLoad,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (!hasMore) {
    return null;
  }
  return (
    <div className="load-more">
      <button type="button" className="btn" onClick={onLoad} disabled={loading}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

export interface FieldControlProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Labelled form field; `children` receives the ids that wire label, hint and error. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: ReactNode;
  children: (props: FieldControlProps) => ReactElement;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
      })}
      {hint ? (
        <small id={hintId} className="field-hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errorId} className="field-error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

export function KeyValues({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="kv">
      {items.map(([key, value]) => (
        <div key={key} className="kv-row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
