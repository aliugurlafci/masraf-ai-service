// Internal helper types (not part of the public API).
import type { OrcError } from '@orc/shared';

/** Options accepted by the OrcError constructor (mirrors @orc/shared OrcErrorOptions). */
export type OrcErrorOptions = NonNullable<ConstructorParameters<typeof OrcError>[2]>;
