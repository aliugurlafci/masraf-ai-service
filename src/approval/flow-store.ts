import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, iso, p, query, queryOne, transaction, type Db, type Executor } from '../db/sql.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import type { Actor } from '../expenses/rules.ts';
import { lockFlow } from '../users/users.ts';
import { formatMoney, validateFlow, type FlowStep, type OrderedStep, type Strateji } from './flow.ts';

/** A flow by name, as other objects refer to it. */
export interface AkisOzet {
  readonly id: number;
  readonly ad: string;
  readonly varsayilan: boolean;
}

export interface FlowView extends AkisOzet {
  readonly strateji: Strateji;
  readonly paraBirimi: string;
  readonly guncelleme: string | null;
  readonly guncelleyen: { readonly id: number; readonly adSoyad: string } | null;
  /** Active users whose expenses go to this flow now (unassigned users count for the default). */
  readonly kullaniciSayisi: number;
  readonly adimlar: ReadonlyArray<{
    readonly sira: number;
    readonly onayci: { readonly id: number; readonly adSoyad: string; readonly eposta: string; readonly departman: string | null };
    /** Largest amount this approver gives the last approval for; null = no limit (the last approver). */
    readonly limit: number | null;
  }>;
}

/** A flow ready for routing: its name and steps in order. */
export interface RoutingFlow {
  readonly akis: AkisOzet;
  readonly strateji: Strateji;
  readonly adimlar: OrderedStep[];
}

export interface FlowInput {
  readonly ad: string;
  readonly strateji: Strateji;
  readonly adimlar: readonly FlowStep[];
}

interface FlowRow {
  id: number;
  ad: string;
  varsayilan: boolean;
  strateji: Strateji;
  guncelleme: Date;
  guncelleyen_id: number | null;
  guncelleyen_ad: string | null;
  kullanici_sayisi: number;
}

interface StepRow {
  akis_id: number;
  sira: number;
  onayci_id: number;
  onay_limiti: number | null;
  ad_soyad: string;
  eposta: string;
  departman: string | null;
}

const toNumber = (v: number | null): number | null => (v === null ? null : Number(v));

const toOrdered = (r: Pick<StepRow, 'sira' | 'onayci_id' | 'onay_limiti'>): OrderedStep => ({
  sira: r.sira,
  onayciId: r.onayci_id,
  limit: toNumber(r.onay_limiti),
});

async function routingFlow(ex: Executor, flow: (AkisOzet & { strateji: Strateji }) | null): Promise<RoutingFlow | null> {
  if (flow === null) return null;
  const rows = await query<StepRow>(ex, 'SELECT sira, onayci_id, onay_limiti FROM dbo.onay_adimlari WHERE akis_id = @id ORDER BY sira', {
    id: p.int(flow.id),
  });
  return { akis: { id: flow.id, ad: flow.ad, varsayilan: flow.varsayilan }, strateji: flow.strateji, adimlar: rows.map(toOrdered) };
}

/** The flow a user's expenses go to: their assigned flow, otherwise the default. Null only without a default flow. */
export async function loadUserFlow(ex: Executor, userId: number): Promise<RoutingFlow | null> {
  const flow = await queryOne<AkisOzet & { strateji: Strateji }>(
    ex,
    `SELECT TOP (1) a.id, a.ad, a.varsayilan, a.strateji FROM dbo.kullanicilar k
     JOIN dbo.onay_akislari a ON a.id = k.onay_akisi_id OR (k.onay_akisi_id IS NULL AND a.varsayilan = 1)
     WHERE k.id = @u`,
    { u: p.int(userId) },
  );
  return routingFlow(ex, flow);
}

/** A flow by id, for routing (the admin's "try an amount" on a chosen flow). */
export async function loadFlowById(ex: Executor, flowId: number): Promise<RoutingFlow | null> {
  const flow = await queryOne<AkisOzet & { strateji: Strateji }>(ex, 'SELECT id, ad, varsayilan, strateji FROM dbo.onay_akislari WHERE id = @id', {
    id: p.int(flowId),
  });
  return routingFlow(ex, flow);
}

const FLOW_SELECT = `SELECT a.id, a.ad, a.varsayilan, a.strateji, a.guncelleme, a.guncelleyen_id, g.ad_soyad AS guncelleyen_ad,
    (SELECT COUNT(*) FROM dbo.kullanicilar k
     WHERE k.aktif = 1 AND (k.onay_akisi_id = a.id OR (k.onay_akisi_id IS NULL AND a.varsayilan = 1))) AS kullanici_sayisi
  FROM dbo.onay_akislari a LEFT JOIN dbo.kullanicilar g ON g.id = a.guncelleyen_id`;

const STEP_SELECT = `SELECT s.akis_id, s.sira, s.onayci_id, s.onay_limiti, k.ad_soyad, k.eposta, k.departman
  FROM dbo.onay_adimlari s JOIN dbo.kullanicilar k ON k.id = s.onayci_id`;

function toView(f: FlowRow, steps: readonly StepRow[], currency: string): FlowView {
  return {
    id: f.id,
    ad: f.ad,
    varsayilan: f.varsayilan,
    strateji: f.strateji,
    paraBirimi: currency,
    guncelleme: iso(f.guncelleme),
    guncelleyen: f.guncelleyen_id === null ? null : { id: f.guncelleyen_id, adSoyad: f.guncelleyen_ad ?? '' },
    kullaniciSayisi: f.kullanici_sayisi,
    adimlar: steps
      .filter((s) => s.akis_id === f.id)
      .map((s) => ({
        sira: s.sira,
        onayci: { id: s.onayci_id, adSoyad: s.ad_soyad, eposta: s.eposta, departman: s.departman },
        limit: toNumber(s.onay_limiti),
      })),
  };
}

/** Every flow, the default first, then by name. */
export async function listFlows(ex: Executor, currency: string): Promise<FlowView[]> {
  const flows = await query<FlowRow>(ex, `${FLOW_SELECT} ORDER BY a.varsayilan DESC, a.ad, a.id`);
  const steps = await query<StepRow>(ex, `${STEP_SELECT} ORDER BY s.akis_id, s.sira`);
  return flows.map((f) => toView(f, steps, currency));
}

export async function getFlow(ex: Executor, id: number, currency: string): Promise<FlowView> {
  const flow = await queryOne<FlowRow>(ex, `${FLOW_SELECT} WHERE a.id = @id`, { id: p.int(id) });
  if (flow === null) throw notFound('Onay akışı bulunamadı.');
  const steps = await query<StepRow>(ex, `${STEP_SELECT} WHERE s.akis_id = @id ORDER BY s.sira`, { id: p.int(id) });
  return toView(flow, steps, currency);
}

/** Creates a flow after checking every rule; the array order is the approval order. */
export async function createFlow(db: Db, actor: Actor, input: FlowInput, currency: string): Promise<FlowView> {
  const problems = validateFlow(input.adimlar, currency);
  if (problems.length > 0) throw invalidFlow(problems);
  const id = await withNameCheck(() =>
    transaction(db, async (tx) => {
      await lockFlow(tx);
      const names = await checkApprovers(tx, input.adimlar);
      const row = await queryOne<{ id: number }>(
        tx,
        'INSERT INTO dbo.onay_akislari (ad, strateji, guncelleyen_id) OUTPUT inserted.id VALUES (@ad, @st, @u)',
        { ad: p.str(input.ad.trim(), 80), st: p.ascii(input.strateji, 8), u: p.int(actor.id) },
      );
      if (row === null) throw new Error('onay akışı eklenemedi');
      await writeSteps(tx, row.id, input.adimlar);
      await audit(tx, actor.id, 'onay_akisi_olusturuldu', `${input.ad.trim()}: ${describeSteps(input, names, currency)}`);
      return row.id;
    }),
  );
  return getFlow(db, id, currency);
}

/** Replaces the name and every step of a flow. Forms already sent keep their copied steps. */
export async function updateFlow(db: Db, actor: Actor, id: number, input: FlowInput, currency: string): Promise<FlowView> {
  const problems = validateFlow(input.adimlar, currency);
  if (problems.length > 0) throw invalidFlow(problems);
  await withNameCheck(() =>
    transaction(db, async (tx) => {
      await lockFlow(tx);
      const before = await queryOne<{ ad: string }>(tx, 'SELECT ad FROM dbo.onay_akislari WHERE id = @id', { id: p.int(id) });
      if (before === null) throw notFound('Onay akışı bulunamadı.');
      const names = await checkApprovers(tx, input.adimlar);
      const ad = input.ad.trim();
      await execute(tx, 'UPDATE dbo.onay_akislari SET ad = @ad, strateji = @st, guncelleme = SYSUTCDATETIME(), guncelleyen_id = @u WHERE id = @id', {
        ad: p.str(ad, 80),
        st: p.ascii(input.strateji, 8),
        u: p.int(actor.id),
        id: p.int(id),
      });
      await execute(tx, 'DELETE FROM dbo.onay_adimlari WHERE akis_id = @id', { id: p.int(id) });
      await writeSteps(tx, id, input.adimlar);
      const renamed = before.ad === ad ? ad : `${before.ad} → ${ad}`;
      await audit(tx, actor.id, 'onay_akisi_guncellendi', `${renamed}: ${describeSteps(input, names, currency)}`);
    }),
  );
  return getFlow(db, id, currency);
}

/** Makes a flow the default; users without an assignment follow it from now on. */
export async function setDefaultFlow(db: Db, actor: Actor, id: number, currency: string): Promise<FlowView> {
  await transaction(db, async (tx) => {
    await lockFlow(tx);
    const flow = await queryOne<{ ad: string; varsayilan: boolean }>(tx, 'SELECT ad, varsayilan FROM dbo.onay_akislari WHERE id = @id', {
      id: p.int(id),
    });
    if (flow === null) throw notFound('Onay akışı bulunamadı.');
    if (flow.varsayilan) return;
    const old = await queryOne<{ ad: string }>(tx, 'SELECT ad FROM dbo.onay_akislari WHERE varsayilan = 1');
    // One statement, so the "at most one default" index never sees two or none in between.
    await execute(
      tx,
      `UPDATE dbo.onay_akislari SET varsayilan = CASE WHEN id = @id THEN 1 ELSE 0 END,
         guncelleme = CASE WHEN id = @id THEN SYSUTCDATETIME() ELSE guncelleme END,
         guncelleyen_id = CASE WHEN id = @id THEN @u ELSE guncelleyen_id END
       WHERE varsayilan = 1 OR id = @id`,
      { id: p.int(id), u: p.int(actor.id) },
    );
    await audit(tx, actor.id, 'varsayilan_akis_degisti', `${old?.ad ?? '-'} → ${flow.ad}`);
  });
  return getFlow(db, id, currency);
}

/** Deletes a flow that is not the default; users assigned to it fall back to the default flow. */
export async function deleteFlow(db: Db, actor: Actor, id: number): Promise<void> {
  await transaction(db, async (tx) => {
    await lockFlow(tx);
    const flow = await queryOne<{ ad: string; varsayilan: boolean }>(tx, 'SELECT ad, varsayilan FROM dbo.onay_akislari WHERE id = @id', {
      id: p.int(id),
    });
    if (flow === null) throw notFound('Onay akışı bulunamadı.');
    if (flow.varsayilan) {
      throw conflict('varsayilan_akis', `${flow.ad} varsayılan onay akışı olduğu için silinemez. Önce başka bir akışı varsayılan yapın.`);
    }
    const moved = await execute(tx, 'UPDATE dbo.kullanicilar SET onay_akisi_id = NULL, guncelleme = SYSUTCDATETIME() WHERE onay_akisi_id = @id', {
      id: p.int(id),
    });
    await execute(tx, 'DELETE FROM dbo.onay_akislari WHERE id = @id', { id: p.int(id) }); // steps cascade
    await audit(tx, actor.id, 'onay_akisi_silindi', moved > 0 ? `${flow.ad} (${moved} kullanıcı varsayılan akışa geçti)` : flow.ad);
  });
}

/** Every approver must exist and be active. Returns their names for the audit line. */
async function checkApprovers(tx: Executor, steps: readonly FlowStep[]): Promise<Map<number, string>> {
  const ids = [...new Set(steps.map((s) => s.onayciId))];
  const users = await query<{ id: number; ad_soyad: string; aktif: boolean }>(
    tx,
    `SELECT id, ad_soyad, aktif FROM dbo.kullanicilar WHERE id IN (${ids.map((_, i) => `@u${i}`).join(', ')})`,
    Object.fromEntries(ids.map((id, i) => [`u${i}`, p.int(id)])),
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const problems: string[] = [];
  steps.forEach((s, i) => {
    const u = byId.get(s.onayciId);
    if (u === undefined) problems.push(`${i + 1}. onaycı: kullanıcı bulunamadı.`);
    else if (!u.aktif) problems.push(`${i + 1}. onaycı: ${u.ad_soyad} pasif bir kullanıcı.`);
  });
  if (problems.length > 0) throw invalidFlow(problems);
  return new Map(users.map((u) => [u.id, u.ad_soyad]));
}

async function writeSteps(tx: Executor, flowId: number, steps: readonly FlowStep[]): Promise<void> {
  for (const [i, s] of steps.entries()) {
    await execute(tx, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, onay_limiti) VALUES (@f, @s, @o, @l)', {
      f: p.int(flowId),
      s: p.int(i + 1),
      o: p.int(s.onayciId),
      l: p.money(s.limit),
    });
  }
}

const STRATEGY_NAMES: Record<Strateji, string> = { zincir: 'zincirleme onay', tek: 'tek onaycı' };

function describeSteps(input: FlowInput, names: Map<number, string>, currency: string): string {
  const steps = input.adimlar
    .map((s, i) => `${i + 1}) ${names.get(s.onayciId) ?? s.onayciId}: ${s.limit === null ? 'sınırsız' : `${formatMoney(s.limit, currency)}'ye kadar`}`)
    .join('; ');
  return `${STRATEGY_NAMES[input.strateji]}; ${steps}`;
}

async function withNameCheck<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err) && String((err as Error).message).includes('ux_onay_akislari_ad')) {
      throw conflict('akis_adi_kullaniliyor', 'Bu adla bir onay akışı zaten var.');
    }
    throw err;
  }
}

function invalidFlow(problems: string[]): HttpError {
  return new HttpError(400, 'gecersiz_akis', problems[0] ?? 'Onay akışı geçersiz.', { sorunlar: problems });
}
