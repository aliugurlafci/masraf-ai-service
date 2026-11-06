import { createHash, randomBytes } from 'node:crypto';
import { execute, iso, p, queryOne, type Db } from '../db/sql.ts';
import { getUser, type Kullanici } from '../users/users.ts';

export type Istemci = 'panel' | 'mobil' | 'api';

export interface OpenedSession {
  /** Shown once to the client; only its hash is stored. */
  readonly token: string;
  readonly tokenOzeti: string;
  readonly bitis: string;
}

export interface ActiveSession {
  readonly tokenOzeti: string;
  readonly kullanici: Kullanici;
  /** True when this request pushed the expiry forward; the panel's cookie is then renewed too. */
  readonly uzatildi: boolean;
}

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** Sliding expiry is written at most this often per session, not on every request. */
const TOUCH_EVERY_MS = 5 * 60_000;

export async function openSession(db: Db, kullaniciId: number, istemci: Istemci, ttlMs: number): Promise<OpenedSession> {
  const token = randomBytes(32).toString('base64url');
  const tokenOzeti = hashToken(token);
  const bitis = new Date(Date.now() + ttlMs);
  await execute(db, 'DELETE FROM dbo.oturumlar WHERE son_kullanma < SYSUTCDATETIME()');
  await execute(db, 'INSERT INTO dbo.oturumlar (token_ozeti, kullanici_id, istemci, son_kullanma) VALUES (@t, @k, @i, @b)', {
    t: p.ascii(tokenOzeti, 64),
    k: p.int(kullaniciId),
    i: p.ascii(istemci, 16),
    b: p.time(bitis),
  });
  await execute(db, 'UPDATE dbo.kullanicilar SET son_giris = SYSUTCDATETIME() WHERE id = @k', { k: p.int(kullaniciId) });
  return { token, tokenOzeti, bitis: bitis.toISOString() };
}

/**
 * The user behind a token, or null when the token is unknown, expired or the user is inactive.
 * Pushes the expiry forward (at most every few minutes) unless `touch` is false.
 */
export async function findSession(db: Db, token: string, ttlMs: number, { touch = true }: { touch?: boolean } = {}): Promise<ActiveSession | null> {
  if (!TOKEN_FORMAT.test(token)) return null;
  const tokenOzeti = hashToken(token);
  const row = await queryOne<{ kullanici_id: number; son_erisim: Date }>(
    db,
    `SELECT o.kullanici_id, o.son_erisim FROM dbo.oturumlar o
     JOIN dbo.kullanicilar k ON k.id = o.kullanici_id
     WHERE o.token_ozeti = @t AND o.son_kullanma > SYSUTCDATETIME() AND k.aktif = 1`,
    { t: p.ascii(tokenOzeti, 64) },
  );
  if (row === null) return null;
  const kullanici = await getUser(db, row.kullanici_id);
  if (kullanici === null) return null;
  const uzatildi = touch && Date.now() - row.son_erisim.getTime() > TOUCH_EVERY_MS;
  if (uzatildi) {
    await execute(db, 'UPDATE dbo.oturumlar SET son_erisim = SYSUTCDATETIME(), son_kullanma = @b WHERE token_ozeti = @t', {
      t: p.ascii(tokenOzeti, 64),
      b: p.time(new Date(Date.now() + ttlMs)),
    });
  }
  return { tokenOzeti, kullanici, uzatildi };
}

export async function closeSession(db: Db, tokenOzeti: string): Promise<void> {
  await execute(db, 'DELETE FROM dbo.oturumlar WHERE token_ozeti = @t', { t: p.ascii(tokenOzeti, 64) });
}

export async function sessionExpiry(db: Db, tokenOzeti: string): Promise<string | null> {
  const row = await queryOne<{ son_kullanma: Date }>(db, 'SELECT son_kullanma FROM dbo.oturumlar WHERE token_ozeti = @t', {
    t: p.ascii(tokenOzeti, 64),
  });
  return row === null ? null : iso(row.son_kullanma);
}
