// Zod building blocks (contract §3.3 "Zod 4 specifics").
import { z } from 'zod';
import { GUID_REGEX } from '../primitives';

/** GUID: case-insensitive input, normalized lower-case. Never z.uuid() (NEWSEQUENTIALID ids are not RFC compliant). */
export const IdSchema = z.string().trim().toLowerCase().regex(GUID_REGEX, 'Invalid GUID');

/** ISO-8601 UTC timestamp (`Z`). */
export const IsoDateTimeSchema = z.iso.datetime();

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/** BIGINT id as decimal string, 1..9223372036854775807 (larger values would raise SQL error 8114). */
export const BigIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, 'Invalid id')
  .refine((s) => BigInt(s) <= BIGINT_MAX, 'Invalid id');

export const nullableId = IdSchema.nullable();
export const nullableIso = IsoDateTimeSchema.nullable();
export const nonNegInt = z.int().min(0);
export const jsonRecord = z.record(z.string(), z.unknown());

/** Integer from a number or a decimal string (query strings). */
export function queryInt(min: number, max: number) {
  return z
    .union([
      z.int(),
      z
        .string()
        .trim()
        .regex(/^-?\d{1,15}$/, 'Expected an integer')
        .transform(Number),
    ])
    .pipe(z.int().min(min).max(max));
}

/** Requires at least one defined key (PATCH bodies). */
export function hasAtLeastOneKey(value: Record<string, unknown>): boolean {
  return Object.values(value).some((v) => v !== undefined);
}

export const AT_LEAST_ONE_KEY = { message: 'At least one field must be provided' } as const;
