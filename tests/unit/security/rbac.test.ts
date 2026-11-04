import { describe, expect, it } from 'vitest';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@orc/shared';
import type { Permission, Role } from '@orc/shared';

// Contract §15.1 role x permission matrix, restated independently as the security sign-off.
const MATRIX: Readonly<Record<Permission, readonly Role[]>> = {
  'task:create': ['admin', 'operator'],
  'task:read:own': ['admin', 'operator', 'auditor'],
  'task:read:any': ['admin', 'auditor'],
  'task:cancel:own': ['admin', 'operator'],
  'task:cancel:any': ['admin'],
  'task:retry:own': ['admin', 'operator'],
  'task:retry:any': ['admin'],
  'project:read': ['admin', 'operator', 'auditor'],
  'project:create': ['admin'],
  'project:update': ['admin'],
  'project:index': ['admin'],
  'agent:read': ['admin', 'operator', 'auditor'],
  'agent:manage': ['admin'],
  'team:read': ['admin', 'operator', 'auditor'],
  'team:manage': ['admin'],
  'user:read': ['admin'],
  'user:manage': ['admin'],
  'token:manage:own': ['admin', 'operator', 'auditor'],
  'system:read': ['admin', 'operator', 'auditor'],
  'system:manage': ['admin'],
  'audit:read': ['admin', 'auditor'],
};

const CASES: [Role, Permission][] = ROLES.flatMap((role) =>
  PERMISSIONS.map((permission): [Role, Permission] => [role, permission]),
);

describe('RBAC matrix (§15.1)', () => {
  it('covers every permission', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(CASES)('%s / %s matches the contract', (role, permission) => {
    const expected = MATRIX[permission].includes(role);
    expect(hasPermission(role, permission)).toBe(expected);
    expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(expected);
  });

  it('auditor is read-only and operator never gets cross-user or admin powers', () => {
    const mutating = PERMISSIONS.filter((p) => !/:read(?::|$)/.test(p) && p !== 'token:manage:own');
    for (const p of mutating) expect(hasPermission('auditor', p)).toBe(false);
    for (const p of [
      'task:read:any',
      'task:cancel:any',
      'task:retry:any',
      'user:manage',
      'system:manage',
      'audit:read',
    ] as const) {
      expect(hasPermission('operator', p)).toBe(false);
    }
  });

  it('denies unknown roles', () => {
    expect(hasPermission('root' as Role, 'task:create')).toBe(false);
  });
});
