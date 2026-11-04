import type { ReactNode } from 'react';

/** Skeleton placeholder for a loading data view. */
export function Loading({ label = 'Loading', lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

/** Empty state: a sentence saying what is missing. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Banner({
  tone,
  children,
  title,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success';
  children?: ReactNode;
  title?: string;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <strong className="banner-title">{title}</strong> : null}
      {children ? <div className="banner-body">{children}</div> : null}
    </div>
  );
}
