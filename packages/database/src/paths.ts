// Locations of the shipped SQL assets. Resolved relative to this module, which is packages/database/src in
// source form and packages/database/dist/orc-db.js when bundled: '../migrations' is correct for both.
import { fileURLToPath } from 'node:url';

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

export function defaultSeedFile(): string {
  return fileURLToPath(new URL('../seed/seed.sql', import.meta.url));
}
