// Runner capability self-check (contract §10.11 item 1, §14.2 "caps self-check ok").
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunnerCaps } from './protocol';

/** Linux capability bit numbers (include/uapi/linux/capability.h). */
const CAP = { CHOWN: 0, DAC_READ_SEARCH: 2, FOWNER: 3, KILL: 5, SETGID: 6, SETUID: 7 } as const;

/** Parses the `CapEff:` hex mask of `/proc/<pid>/status`; null when absent. */
export function parseCapEff(statusText: string): bigint | null {
  const m = /^CapEff:\s*([0-9a-fA-F]+)\s*$/m.exec(statusText);
  return m?.[1] ? BigInt(`0x${m[1]}`) : null;
}

export function hasCap(mask: bigint, bit: number): boolean {
  return ((mask >> BigInt(bit)) & 1n) === 1n;
}

export const DEFAULT_PRLIMIT_CANDIDATES: readonly string[] = Object.freeze([
  '/usr/bin/prlimit',
  '/bin/prlimit',
]);

export interface DetectCapsOptions {
  procRoot?: string;
  prlimitCandidates?: readonly string[];
}

export interface DetectedCaps {
  caps: RunnerCaps;
  /** Absolute path of an executable prlimit, or null. */
  prlimitPath: string | null;
}

export async function detectRunnerCaps(o: DetectCapsOptions = {}): Promise<DetectedCaps> {
  const procRoot = o.procRoot ?? '/proc';
  let mask: bigint | null = null;
  try {
    mask = parseCapEff(await readFile(path.join(procRoot, 'self', 'status'), 'utf8'));
  } catch {
    mask = null;
  }
  const procfs = mask !== null;
  let prlimitPath: string | null = null;
  for (const candidate of o.prlimitCandidates ?? DEFAULT_PRLIMIT_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      prlimitPath = candidate;
      break;
    } catch {
      // try the next candidate
    }
  }
  const has = (bit: number): boolean => mask !== null && hasCap(mask, bit);
  const caps = {
    uidSwitch: has(CAP.SETUID) && has(CAP.SETGID),
    chown: has(CAP.CHOWN) && has(CAP.FOWNER) && has(CAP.DAC_READ_SEARCH),
    kill: has(CAP.KILL),
    prlimit: prlimitPath !== null,
    procfs,
  };
  return {
    caps: { ok: Object.values(caps).every(Boolean), ...caps },
    prlimitPath,
  };
}
