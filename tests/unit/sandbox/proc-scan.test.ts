import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProcfsTable,
  hasCap,
  killUidProcesses,
  parseCapEff,
  parseProcStatus,
  type KillSignal,
} from '@orc/sandbox';
import { fakeProcessTable, manualClock } from '../../helpers/sandbox/fakes';

const status = (uid: number, state = 'S (sleeping)'): string =>
  `Name:\tnode\nState:\t${state}\nTgid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;

describe('procfs parsing', () => {
  it('reads the real uid and zombie state', () => {
    expect(parseProcStatus(status(20001))).toEqual({ realUid: 20001, zombie: false });
    expect(parseProcStatus(status(20001, 'Z (zombie)'))).toEqual({ realUid: 20001, zombie: true });
    expect(parseProcStatus('Name:\tx\n')).toEqual({ realUid: null, zombie: false });
    // real uid differs from the effective one (setuid binary): the real uid decides
    expect(parseProcStatus('Uid:\t20002\t0\t0\t0\n').realUid).toBe(20002);
  });

  it('parses CapEff', () => {
    const mask = parseCapEff('CapInh:\t0\nCapEff:\t00000000000000ed\n');
    expect(mask).not.toBeNull();
    // 0xed = bits 0,2,3,5,6,7 = CHOWN, DAC_READ_SEARCH, FOWNER, KILL, SETGID, SETUID
    for (const bit of [0, 2, 3, 5, 6, 7]) expect(hasCap(mask as bigint, bit)).toBe(true);
    for (const bit of [1, 4, 8, 21]) expect(hasCap(mask as bigint, bit)).toBe(false);
    expect(parseCapEff('Name:\tx\n')).toBeNull();
  });
});

describe('createProcfsTable', () => {
  let proc: string;
  beforeAll(() => {
    proc = mkdtempSync(join(tmpdir(), 'orc-fake-proc-'));
    const entries: [string, string][] = [
      ['100', status(20001)],
      ['101', status(20001, 'Z (zombie)')],
      ['102', status(20002)],
      ['103', status(20001)],
      ['self', status(0)],
    ];
    for (const [name, text] of entries) {
      mkdirSync(join(proc, name));
      writeFileSync(join(proc, name, 'status'), text);
    }
    mkdirSync(join(proc, '104')); // exited while scanning: no status file
  });
  afterAll(() => rmSync(proc, { recursive: true, force: true }));

  it('lists live processes of a uid, excluding zombies and the runner itself', async () => {
    const killed: [number, KillSignal][] = [];
    const t = createProcfsTable({
      procRoot: proc,
      selfPid: 103,
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(await t.listByUid(20001)).toEqual([100]);
    expect(await t.listByUid(20002)).toEqual([102]);
    expect(await t.listByUid(1)).toEqual([]);
    t.signal(100, 'SIGTERM');
    t.signal(103, 'SIGKILL'); // self: never
    t.signal(1, 'SIGKILL'); // init: never
    expect(killed).toEqual([[100, 'SIGTERM']]);
    expect(await createProcfsTable({ procRoot: join(proc, 'nope') }).listByUid(0)).toEqual([]);
  });
});

describe('killUidProcesses', () => {
  const run = (table: ReturnType<typeof fakeProcessTable>, graceMs: number) => {
    const clock = manualClock();
    return killUidProcesses(20001, table, {
      graceMs,
      forceWaitMs: 1000,
      pollMs: 100,
      now: clock.now,
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
    });
  };

  it('nothing to kill', async () => {
    expect(await run(fakeProcessTable(), 1000)).toMatchObject({
      graceful: true,
      forced: false,
      survivors: [],
    });
  });

  it('SIGTERM suffices', async () => {
    const t = fakeProcessTable();
    t.add(1, 20001);
    t.add(2, 20001);
    t.add(3, 20002);
    const r = await run(t, 1000);
    expect(r).toMatchObject({ graceful: true, forced: false, survivors: [] });
    expect(t.procs.has(3)).toBe(true);
    expect(t.signals.every((s) => s.signal === 'SIGTERM' && s.pid !== 3)).toBe(true);
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const t = fakeProcessTable();
    t.add(1, 20001, ['SIGKILL']);
    const r = await run(t, 300);
    expect(r).toMatchObject({ graceful: false, forced: true, survivors: [] });
    expect(t.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('graceMs 0 kills immediately', async () => {
    const t = fakeProcessTable();
    t.add(1, 20001);
    const r = await run(t, 0);
    expect(r.forced).toBe(true);
    expect(t.signals).toEqual([{ pid: 1, signal: 'SIGKILL' }]);
  });

  it('reports survivors', async () => {
    const t = fakeProcessTable();
    t.add(7, 20001, []);
    const r = await run(t, 200);
    expect(r).toMatchObject({ graceful: false, forced: true, survivors: [7] });
  });
});
