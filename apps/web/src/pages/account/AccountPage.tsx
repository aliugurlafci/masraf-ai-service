import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatedApiToken } from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useApi } from '../../api/ApiContext';
import { fieldErrorsOf, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { useMe } from '../../auth/session';
import { CopyButton } from '../../components/CopyButton';
import { ErrorView, ProblemMessage } from '../../components/ErrorView';
import { Banner, Empty, Loading } from '../../components/States';
import { DateTime, Field, KeyValues, PageHeader } from '../../components/ui';

function NewTokenResult({ created, onDismiss }: { created: CreatedApiToken; onDismiss: () => void }) {
  return (
    <Banner tone="success" title={`Token "${created.apiToken.name}" created`}>
      <p>Copy the token now. It is shown only once and cannot be retrieved later.</p>
      <p className="token-value">
        <code>{created.token}</code> <CopyButton value={created.token} label="Copy token" />
      </p>
      <button type="button" className="btn btn-small" onClick={onDismiss}>
        I have stored the token
      </button>
    </Banner>
  );
}

function TokensSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [readOnly, setReadOnly] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const tokens = useQuery({ queryKey: queryKeys.tokens, queryFn: () => api.listTokens() });

  const create = useMutation({
    mutationFn: () => api.createToken({ name: name.trim(), expiresInDays: Number(days), readOnly }),
    onSuccess: (res) => {
      setCreated(res);
      setName('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokens });
    },
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.revokeToken(tokenId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tokens }),
  });

  const daysNumber = Number(days);
  const daysInvalid = !Number.isInteger(daysNumber) || daysNumber < 1 || daysNumber > 365;
  const serverErrors = fieldErrorsOf(create.error);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || daysInvalid) return;
    create.mutate();
  };

  return (
    <section className="card" aria-labelledby="tokens-title">
      <h2 id="tokens-title">Personal access tokens</h2>
      {created ? <NewTokenResult created={created} onDismiss={() => setCreated(null)} /> : null}
      <form className="form inline-form-wrap" onSubmit={submit} noValidate>
        {isApiError(create.error) && Object.keys(serverErrors).length === 0 ? <ProblemMessage error={create.error} /> : null}
        <div className="form-grid">
          <Field label="Token name" error={serverErrors.name}>
            {(p) => <input {...p} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Expires in (days)" error={daysInvalid ? 'Between 1 and 365 days.' : serverErrors.expiresInDays}>
            {(p) => <input {...p} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        </div>
        <label>
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only (GET requests only)
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim() || daysInvalid}>
            {create.isPending ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </form>
      {revoke.isError ? <ErrorView error={revoke.error} /> : null}
      {tokens.isPending ? (
        <Loading label="Loading tokens" />
      ) : tokens.isError ? (
        <ErrorView error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.length === 0 ? (
        <Empty>You have no access tokens.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Prefix</th>
                <th scope="col">Access</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="mono">{t.prefix}</td>
                  <td>{t.readOnly ? 'read-only' : 'read/write'}</td>
                  <td>
                    <DateTime value={t.expiresAt} />
                  </td>
                  <td>
                    <DateTime value={t.lastUsedAt} />
                  </td>
                  <td>{t.revokedAt ? 'revoked' : 'active'}</td>
                  <td>
                    {t.revokedAt ? null : (
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={revoke.isPending}
                        onClick={() => {
                          if (window.confirm(`Revoke token "${t.name}"? Clients using it stop working immediately.`)) {
                            revoke.mutate(t.id);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PasswordSection({ username }: { username: string }) {
  const api = useApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (next.length < 12 || next.length > 256) {
      setLocalError('The new password must be 12 to 256 characters long.');
      return;
    }
    if (next.toLowerCase() === username.toLowerCase()) {
      setLocalError('The new password must not equal your username.');
      return;
    }
    if (next !== confirm) {
      setLocalError('The passwords do not match.');
      return;
    }
    setLocalError(null);
    change.mutate();
  };

  const wrongCurrent = isApiError(change.error) && change.error.code === 'invalid_credentials';
  return (
    <section className="card" aria-labelledby="password-title">
      <h2 id="password-title">Change password</h2>
      {change.isSuccess ? <Banner tone="success">Password changed. Your other sessions were signed out.</Banner> : null}
      {isApiError(change.error) && !wrongCurrent ? <ProblemMessage error={change.error} /> : null}
      <form className="form" onSubmit={submit} noValidate>
        <Field label="Current password" error={wrongCurrent ? 'The current password is wrong.' : null}>
          {(p) => (
            <input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          )}
        </Field>
        <Field label="New password" error={localError} hint="12 to 256 characters.">
          {(p) => (
            <input {...p} type="password" autoComplete="new-password" maxLength={256} value={next} onChange={(e) => setNext(e.target.value)} />
          )}
        </Field>
        <Field label="Confirm new password">
          {(p) => (
            <input {...p} type="password" autoComplete="new-password" maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          )}
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={change.isPending || !current || !next}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function AccountPage() {
  const me = useMe().data;
  if (!me) return <Loading label="Loading account" />;
  return (
    <>
      <PageHeader title="Account" />
      <section className="card">
        <KeyValues
          items={[
            ['Username', <code key="u">{me.user.username}</code>],
            ['Display name', me.user.displayName],
            ['Role', me.user.role],
            ['Signed in with', me.authMethod === 'session' ? 'browser session' : `API token${me.tokenReadOnly ? ' (read-only)' : ''}`],
            ['Session expires', <DateTime key="e" value={me.sessionExpiresAt} />],
            ['Last login', <DateTime key="l" value={me.user.lastLoginAt} />],
          ]}
        />
      </section>
      {me.authMethod === 'session' ? (
        <div className="grid-2">
          <TokensSection />
          <PasswordSection username={me.user.username} />
        </div>
      ) : (
        <Banner tone="info">Tokens and passwords can only be managed from a browser session.</Banner>
      )}
    </>
  );
}
