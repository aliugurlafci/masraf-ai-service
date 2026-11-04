import { Link } from 'react-router';

/** 403 view; rendered in place by RequirePermission and for inline 403 answers. */
export function ForbiddenView({ inline = false }: { inline?: boolean }) {
  const Heading = inline ? 'h2' : 'h1';
  return (
    <section className="error-screen" aria-labelledby="forbidden-title">
      <p className="error-code" aria-hidden="true">
        403
      </p>
      <Heading id="forbidden-title">Access denied</Heading>
      <p>Your role does not include the permission required for this page or action.</p>
      {inline ? null : (
        <p>
          <Link to="/">Back to dashboard</Link>
        </p>
      )}
    </section>
  );
}

export function NotFoundView({
  inline = false,
  what = 'page',
}: {
  inline?: boolean;
  what?: string;
}) {
  const Heading = inline ? 'h2' : 'h1';
  return (
    <section className="error-screen" aria-labelledby="not-found-title">
      <p className="error-code" aria-hidden="true">
        404
      </p>
      <Heading id="not-found-title">Not found</Heading>
      <p>The {what} you are looking for does not exist or is not visible to you.</p>
      <p>
        <Link to="/">Back to dashboard</Link>
      </p>
    </section>
  );
}

export function ForbiddenPage() {
  return (
    <main className="standalone">
      <ForbiddenView />
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="standalone">
      <NotFoundView />
    </main>
  );
}
