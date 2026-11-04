// Role x permission matrix (contract §15.1).
import { PERMISSIONS, type Permission, type Role } from './constants';

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  admin: Object.freeze([...PERMISSIONS]),
  operator: Object.freeze([
    'task:create',
    'task:read:own',
    'task:cancel:own',
    'task:retry:own',
    'project:read',
    'agent:read',
    'team:read',
    'token:manage:own',
    'system:read',
  ] as const),
  auditor: Object.freeze([
    'task:read:own',
    'task:read:any',
    'project:read',
    'agent:read',
    'team:read',
    'token:manage:own',
    'system:read',
    'audit:read',
  ] as const),
});

export function hasPermission(role: Role, p: Permission): boolean {
  const granted: readonly Permission[] | undefined = ROLE_PERMISSIONS[role];
  return granted !== undefined && granted.includes(p);
}
