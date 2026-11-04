# ADR-0018: Custom SQL migration runner and raw mssql repositories

- Status: Accepted (2026-11-02); amended by ADR-0029 (transaction-owned applock per file)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Least-privilege grants, filtered indexes, persisted computed columns and ISJSON checks must be exact T-SQL; ORMs with SQL Server support add heavy abstractions and their own migration semantics.

## Decision
Numbered `.sql` files split on `GO`, each applied in a transaction, `sp_getapplock` for exclusivity, SHA-256 checksums in `orc.SchemaMigrations`; repositories use parameterized `mssql` requests only.

## Consequences
Full control of SQL Server features; developers write T-SQL; no runtime model generation.

## Alternatives considered
Prisma/TypeORM/Knex migrations (limited SQL Server feature coverage or extra CLI tooling); Flyway (JVM dependency).

## Rollback path
Migration files are plain T-SQL and can be replayed by any runner.
