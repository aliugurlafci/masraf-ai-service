// Record -> public DTO mapping for the resources the API serves directly (users, API tokens).
import type { ApiToken, User } from '@orc/shared';
import type { ApiTokenRecord, UserRecord } from '@orc/database';

export function toUser(u: UserRecord): User {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    lockedUntil: u.lockedUntil,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function toApiToken(t: ApiTokenRecord): ApiToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    readOnly: t.readOnly,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}
