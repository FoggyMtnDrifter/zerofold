# ADR-0006 — SQLite driver, pragmas, and image base

- **Status:** Accepted (2026-08-22)

## Driver: `better-sqlite3`

Synchronous, mature, and the fastest of the three Drizzle-supported options. The synchronous API
is a genuine advantage here: a command's transaction is truly atomic with no async interleaving
inside it.

`node:sqlite` (Node's built-in) is the eventual destination — zero dependencies, and it ships a
native `backup()` — but it is still flagged experimental on Node 22. `packages/db` exposes a
single `createClient()` so the swap is one file once Node 24 is the baseline.

`libsql` was considered for its wider `ALTER TABLE` support and encryption at rest, but it is a
fork, and for a data-integrity-critical application that is a risk without a matching reward —
plain SQLite 3.35+ already supports `DROP COLUMN` and `RENAME COLUMN`.

## Consequence: the image is glibc, not Alpine

`better-sqlite3` publishes no musl prebuilds, so an Alpine final stage would need a C toolchain
in the shipped image. Final base is `gcr.io/distroless/nodejs22-debian12` — still distroless,
still non-root, comfortably under 300MB. The same constraint applies to `@node-rs/argon2`
(ADR-0001), so both native modules are verified per-architecture in CI.

## Startup pragmas

    journal_mode  = WAL        readers never block the writer
    synchronous   = NORMAL     correct under WAL; FULL costs throughput for durability we
                               do not need between checkpoints
    foreign_keys  = ON         off by default in SQLite, which surprises people
    busy_timeout  = 5000       wait rather than throwing SQLITE_BUSY
    cache_size    = -64000     64 MiB
    wal_autocheckpoint = 1000

`foreign_keys` is bracketed OFF around the 12-step table rebuilds drizzle-kit generates for
column changes, and restored after.

## Type mappings

| logical | SQLite | note |
|---------|--------|------|
| money | `INTEGER` | 64-bit signed; `safeIntegers(true)` or values come back lossy |
| calendar date | `TEXT` | `YYYY-MM-DD`; the ADR-0005 rule becomes storage-enforced |
| timestamp | `TEXT` | ISO-8601 UTC |
| boolean | `INTEGER` | 0/1 |
| json | `TEXT` | never queried into (ADR-0003) |
| id | `TEXT` | **UUIDv7** |

UUIDv7 rather than v4: it is time-ordered, so insert locality improves in every b-tree and the
register's `(plan_id, account_id, date DESC, id DESC)` index gains a meaningful chronological
tiebreak instead of random ordering among same-day rows.
