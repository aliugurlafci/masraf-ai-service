import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../api/ApiContext';
import { isApiError } from '../api/errors';
import type { ApiError } from '../api/errors';
import { ME_QUERY_KEY, safeNext, useMe } from '../auth/session';
import { ProblemMessage } from '../components/ErrorView';
import { useCountdown } from '../lib/useNow';

function ThrottleNotice({ error }: { error: ApiError }) {
  const remaining = useCountdown(error.receivedAt, error.retryAfterSeconds);
  return (
    <div className="banner banner-warning" role="alert">
      <strong className="banner-title">Too many login attempts</strong>
      <div className="banner-body">
        {remaining > 0
          ? `Try again in ${remaining} s.`
          : 'You can try again now.'}
      </div>
    </div>
  );
}

function LoginSubmit({ error, pending }: { error: unknown; pending: boolean }) {
  const throttled = isApiError(error) && error.code === 'login_throttled' ? error : null;
  const remaining = useCountdown(throttled?.receivedAt ?? 0, throttled?.retryAfterSeconds ?? null);
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending || remaining > 0}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

export function LoginPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login({ username: username.trim(), password }),
    onSuccess: async () => {
      setPassword('');
      await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.me() });
      await navigate(next, { replace: true });
    },
  });

  if (me.isSuccess) {
    return <Navigate to={next} replace />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (username.trim().length === 0 || password.length === 0) {
      return;
    }
    login.mutate();
  };

  const error = login.error;
  let errorView = null;
  if (isApiError(error)) {
    if (error.code === 'invalid_credentials') {
      errorView = (
        <div className="banner banner-danger" role="alert">
          <strong className="banner-title">Invalid username or password</strong>
        </div>
      );
    } else if (error.code === 'login_throttled') {
      errorView = <ThrottleNotice error={error} />;
    } else {
      errorView = <ProblemMessage error={error} />;
    }
  } else if (error) {
    errorView = (
      <div className="banner banner-danger" role="alert">
        {error.message}
      </div>
    );
  }

  return (
    <main className="standalone login">
      <form className="card login-card" onSubmit={onSubmit} noValidate aria-labelledby="login-title">
        <h1 id="login-title">Claude Code Orchestrator</h1>
        <p className="muted">Sign in to continue.</p>
        {errorView}
        <div className="field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            maxLength={64}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <LoginSubmit error={error} pending={login.isPending} />
      </form>
    </main>
  );
}
