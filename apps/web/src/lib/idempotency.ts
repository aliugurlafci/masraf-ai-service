// Idempotency-Key management for POST /tasks and POST /projects (contract §9.2, §9.3, §20.1).
// A fresh UUID is used for every submit. The previous key is reused only when the identical body is
// re-submitted after the server never answered definitively (network failure, 5xx, or
// idempotency_key_in_use), so a lost response can never create a duplicate resource while a stored
// 4xx answer is never replayed for a deliberate re-submit.
import { cryptoIdGenerator } from '@orc/shared';
import { isApiError } from '../api/errors';

interface Pending {
  key: string;
  body: string;
  reusable: boolean;
}

export class IdempotencyKeys {
  #last: Pending | null = null;

  keyFor(body: unknown): string {
    const json = JSON.stringify(body);
    const last = this.#last;
    if (last !== null && last.reusable && last.body === json) {
      return last.key;
    }
    const key = cryptoIdGenerator.uuid();
    this.#last = { key, body: json, reusable: false };
    return key;
  }

  /** Records the outcome of the submit that used the last key. */
  settle(error: unknown): void {
    if (this.#last === null) {
      return;
    }
    const undetermined =
      isApiError(error) &&
      (error.kind === 'network' ||
        error.status >= 500 ||
        error.code === 'idempotency_key_in_use');
    this.#last = undetermined ? { ...this.#last, reusable: true } : null;
  }
}
