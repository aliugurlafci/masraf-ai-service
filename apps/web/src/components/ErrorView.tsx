import { Link, useLocation } from 'react-router';
import { isApiError } from '../api/errors';
import type { ApiError } from '../api/errors';
import { useCountdown } from '../lib/useNow';
import { ForbiddenView, NotFoundView } from '../pages/errors/ErrorPages';
import { CopyButton } from './CopyButton';

function RetryButton({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const remaining = useCountdown(error.receivedAt, error.retryAfterSeconds);
  return (
    <button type="button" className="btn" onClick={onRetry} disabled={remaining > 0}>
      {remaining > 0 ? `Retry in ${remaining} s` : 'Retry'}
    </button>
  );
}

/** Problem block: title, detail and requestId with copy button (contract §20.2). */
export function ProblemMessage({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <strong className="problem-title">{error.title}</strong>
      {error.detail ? <p className="problem-detail">{error.detail}</p> : null}
      {error.requestId ? (
        <p className="problem-meta">
          Request id <code>{error.requestId}</code> <CopyButton value={error.requestId} />
        </p>
      ) : null}
      {onRetry ? <RetryButton error={error} onRetry={onRetry} /> : null}
    </div>
  );
}

/**
 * Error state of a data view: 401 => login link, 403 => inline forbidden, 404 => not found,
 * 429/503/network => retry honouring Retry-After, otherwise the Problem details.
 */
export function ErrorView({
  error,
  onRetry,
  notFoundWhat,
}: {
  error: unknown;
  onRetry?: () => void;
  notFoundWhat?: string;
}) {
  const location = useLocation();
  if (!isApiError(error)) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return (
      <div className="problem" role="alert">
        <strong className="problem-title">Something went wrong</strong>
        <p className="problem-detail">{message}</p>
        {onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (error.status === 401) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return (
      <div className="problem" role="alert">
        <strong className="problem-title">Your session has ended</strong>
        <p className="problem-detail">
          <Link to={`/login?next=${next}`}>Sign in again</Link> to continue.
        </p>
      </div>
    );
  }
  if (error.status === 403 && error.code !== 'csrf_failed') {
    return <ForbiddenView inline />;
  }
  if (error.status === 404) {
    return <NotFoundView inline what={notFoundWhat} />;
  }
  return <ProblemMessage error={error} onRetry={onRetry} />;
}
