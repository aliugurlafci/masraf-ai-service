# ADR-0026: SQL Server connections use TLS verified against a private CA

- Status: Accepted (2026-11-02, contract v2.0.0)
- Deciders: Solution Architecture Manager; GPM approval with contract v2.0.0
- Contract: `docs/architecture/contract.md` §2.5 (`DatabaseConfig.caCert`), §16.1, §19
- Review findings: F18, T-m10

## Context
The defaults `DB_ENCRYPT=true` and `DB_TRUST_SERVER_CERTIFICATE=false` fail against the self-signed certificate of the `mssql/server:2022` image, and v1.0.0 specified neither certificate provisioning nor compose values. Setting `trustServerCertificate=true` would encrypt but not authenticate the server.

## Decision
`scripts/generate-secrets.mjs` creates a private CA (`db_ca_cert`) and a server certificate with SAN `mssql` (`mssql_tls_cert`, `mssql_tls_key`). mssql loads them via `mssql.conf` (`tlscert`, `tlskey`, `forceencryption = 1`, `tlsprotocols = 1.2`). api, worker, db-bootstrap and migrator verify the server with `DB_CA_CERT_FILE` (tedious `cryptoCredentialsDetails.ca`). Config validation: with `NODE_ENV=production`, `DB_ENCRYPT` must be true and `DB_TRUST_SERVER_CERTIFICATE` must be false; development and test (separate test container) may trust the server certificate.

## Consequences
Encrypted and authenticated DB traffic on the internal network; certificate rotation = regenerate the three files and restart mssql and its clients. The mssql key file must be readable by uid 10001 (Platform documents permissions per host OS).

## Alternatives considered
`DB_TRUST_SERVER_CERTIFICATE=true` on the internal network with an ADR (simpler, but no server authentication); disabling encryption (rejected).

## Rollback path
Set `NODE_ENV=development`-style relaxed settings only outside production; in production revert by re-issuing certificates, never by trusting unverified certificates.
