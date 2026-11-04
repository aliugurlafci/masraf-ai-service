// `orc-db create-admin --username <u> [--display-name <d>]` (contract §4.4). The password comes from
// ORC_ADMIN_PASSWORD[_FILE] or stdin, never from argv; it is validated, hashed (scrypt) and never logged.
import { ConflictError, CreateUserRequestSchema, ValidationError } from '@orc/shared';
import { DEFAULT_SCRYPT_PARAMS, hashPassword, validatePasswordPolicy } from '@orc/security';
import type { ScryptParams } from '@orc/security';
import type { Database, UserRecord } from '../types.js';

export interface CreateAdminInput {
  username: string;
  displayName?: string | null;
  password: string;
  scrypt?: ScryptParams;
}

/** Creates an active `admin` user plus a `user.created` audit row in one transaction. Existing username => ConflictError. */
export async function createAdminUser(db: Database, input: CreateAdminInput): Promise<UserRecord> {
  const parsed = CreateUserRequestSchema.safeParse({
    username: input.username,
    displayName: input.displayName ?? input.username,
    email: null,
    role: 'admin',
    password: input.password,
  });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'body');
  const req = parsed.data;
  validatePasswordPolicy(req.password, req.username);
  const passwordHash = await hashPassword(req.password, input.scrypt ?? DEFAULT_SCRYPT_PARAMS);

  return db.transaction(
    async ({ repos }) => {
      if (await repos.users.findByUsername(req.username)) {
        throw new ConflictError(`User ${req.username} already exists`);
      }
      const user = await repos.users.insert({
        username: req.username,
        displayName: req.displayName,
        email: null,
        role: 'admin',
        passwordHash,
      });
      await repos.audit.insert({
        action: 'user.created',
        actor: { type: 'system', label: 'orc-db create-admin' },
        entityType: 'user',
        entityId: user.id,
        outcome: 'success',
        after: { username: user.username, displayName: user.displayName, role: user.role, isActive: user.isActive },
      });
      return user;
    },
    { name: 'cli.createAdmin' },
  );
}
