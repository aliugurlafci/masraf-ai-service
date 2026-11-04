// In-memory registry of the attempts this worker is running (contract §2.11, §13.1, §13.9).
import type { Uuid } from '@orc/shared';
import type {
  AbortReason,
  ActiveAttempt,
  ActiveAttemptRegistry,
  SupersedeKind,
} from './types.js';

export function createActiveAttemptRegistry(): ActiveAttemptRegistry {
  const attempts = new Map<Uuid, ActiveAttempt>();
  const superseded = new Map<Uuid, SupersedeKind>();
  const lost = new Set<Uuid>();

  const abort = (attemptId: Uuid, reason: AbortReason): boolean => {
    const a = attempts.get(attemptId);
    if (a === undefined || a.controller.signal.aborted) return false;
    a.controller.abort(reason);
    return true;
  };

  return {
    register(a) {
      attempts.set(a.attemptId, a);
      superseded.delete(a.attemptId);
      lost.delete(a.attemptId);
    },
    unregister(attemptId) {
      attempts.delete(attemptId);
      superseded.delete(attemptId);
      lost.delete(attemptId);
    },
    abort,
    abortAll(reason) {
      let n = 0;
      for (const id of [...attempts.keys()]) if (abort(id, reason)) n += 1;
      return n;
    },
    list() {
      return [...attempts.values()];
    },
    size() {
      return attempts.size;
    },
    get(attemptId) {
      return attempts.get(attemptId);
    },
    supersede(attemptId, kind) {
      const a = attempts.get(attemptId);
      if (a === undefined) return false;
      if (!superseded.has(attemptId)) superseded.set(attemptId, kind);
      if (!a.controller.signal.aborted) a.controller.abort('worker_shutdown' satisfies AbortReason);
      return true;
    },
    supersededKind(attemptId) {
      return superseded.get(attemptId) ?? null;
    },
    markRunnerLost(attemptId) {
      const a = attempts.get(attemptId);
      if (a === undefined) return false;
      lost.add(attemptId);
      if (!a.controller.signal.aborted) a.controller.abort('worker_shutdown' satisfies AbortReason);
      return true;
    },
    runnerLost(attemptId) {
      return lost.has(attemptId);
    },
  };
}
