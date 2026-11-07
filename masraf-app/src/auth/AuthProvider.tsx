import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { ApiError, setSessionToken, setUnauthorizedHandler } from '@/api/client';
import { getBen, login, logout } from '@/api/endpoints';
import { queryKeys, useBen } from '@/api/queries';
import type { BenYaniti, Kullanici } from '@/api/types';

import { clearToken, readToken, saveToken } from './token-store';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'unreachable';

export interface AuthValue {
  readonly status: AuthStatus;
  readonly user: Kullanici | null;
  /** Message for the login screen (e.g. the session expired) or the unreachable screen. */
  readonly notice: string | null;
  /** Throws ApiError with the server's Turkish message on failure. */
  readonly signIn: (eposta: string, sifre: string) => Promise<Kullanici>;
  readonly signOut: () => Promise<void>;
  /** Re-reads the user (GET /api/ben), e.g. after a password change. */
  readonly refreshUser: () => Promise<Kullanici | null>;
  /** Tries the stored session again after the server was unreachable. */
  readonly retry: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

const SESSION_ENDED = 'Oturumunuz sona erdi. Lütfen yeniden giriş yapın.';

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [baseUser, setBaseUser] = useState<Kullanici | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Keeps the user fresh (role, password flag) and feeds the approvals badge.
  const ben = useBen(status === 'signedIn');
  const user = status === 'signedIn' ? (ben.data?.kullanici ?? baseUser) : null;

  const endSession = async (message: string | null): Promise<void> => {
    setSessionToken(null);
    await clearToken();
    queryClient.clear();
    setBaseUser(null);
    setNotice(message);
    setStatus('signedOut');
  };

  // Any authenticated request that gets 401 ends the session and the guard shows the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void endSession(SESSION_ENDED);
    });
    return () => setUnauthorizedHandler(null);
  });

  // On start (and on retry): validate a stored token with GET /api/ben.
  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await readToken();
      if (!alive) return;
      if (token === null) {
        setStatus('signedOut');
        return;
      }
      setSessionToken(token);
      try {
        const me = await queryClient.fetchQuery({ queryKey: queryKeys.ben, queryFn: () => getBen(), staleTime: 0, retry: false });
        if (!alive) return;
        setBaseUser(me.kullanici);
        setNotice(null);
        setStatus('signedIn');
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
          // Keep the token: the server may just be down or adb reverse not set up yet.
          setNotice(err.message);
          setStatus('unreachable');
        } else if (err instanceof ApiError && err.status !== 401) {
          await endSession(err.message);
        } else {
          await endSession(SESSION_ENDED);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const signIn = async (eposta: string, sifre: string): Promise<Kullanici> => {
    // Plain (not Turkish) lower-casing: e-mail addresses are ASCII and "I" must stay "i".
    const res = await login(eposta.trim().toLowerCase(), sifre);
    if (res.token === undefined || res.token === '') {
      throw new ApiError(500, 'token_yok', 'Sunucu oturum anahtarı döndürmedi. Sunucu sürümünü kontrol edin.');
    }
    await saveToken(res.token);
    setSessionToken(res.token);
    queryClient.clear();
    queryClient.setQueryData<BenYaniti>(queryKeys.ben, { kullanici: res.kullanici, bekleyenOnay: 0, okunmamisBildirim: 0 });
    // The badge count is not part of the login answer; fetch it right away.
    void queryClient.invalidateQueries({ queryKey: queryKeys.ben });
    setBaseUser(res.kullanici);
    setNotice(null);
    setStatus('signedIn');
    return res.kullanici;
  };

  const signOut = async (): Promise<void> => {
    // Tell the server without waiting for it (it may be unreachable); the request picks up the token
    // before the local session is cleared below.
    logout().catch(() => undefined);
    await endSession(null);
  };

  const refreshUser = async (): Promise<Kullanici | null> => {
    try {
      const me = await queryClient.fetchQuery({ queryKey: queryKeys.ben, queryFn: () => getBen(), staleTime: 0, retry: false });
      setBaseUser(me.kullanici);
      return me.kullanici;
    } catch {
      return null;
    }
  };

  const retry = (): void => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  };

  const value: AuthValue = { status, user, notice, signIn, signOut, refreshUser, retry };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
