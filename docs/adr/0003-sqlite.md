# ADR-0003 — SQLite as the database

- **Status:** Accepted (2026-08-22). Supersedes the plan's original Postgres-primary proposal.

## Context

The original plan named PostgreSQL 16+ as the primary target with SQLite "feasible later".
On review, SQLite serves the project's own stated goals better.

## Decision

**SQLite is the sole v1 target.** The query layer stays within the SQLite∩Postgres intersection
so Postgres can be added in v1.1 for anyone wanting multi-replica, but it is not built now.

## Why

A personal budgeting instance has one to five users. SQLite in WAL mode is comfortably adequate,
and it collapses deployment to a single container with a single file to back up — which is a
stronger form of "your data is yours" than "learn `pg_dump`". Two further wins are not
incidental:

- **Backup is `VACUUM INTO`** — one statement, a consistent snapshot, no downtime, readers never
  blocked. Scheduled backups with retention are therefore on by default.
- **Tests need no Docker.** Each integration test gets a fresh temp-file or `:memory:` database
  in microseconds. Testcontainers is deleted, and CI loses an image pull and a container boot.

**FTS5** is built in, which covers register search better than stock Postgres would.

## Costs, accepted knowingly

1. **Single replica, permanently, in v1.** SQLite across a shared volume from multiple app
   instances is unsafe. This removes the migration-lock-against-racing-replicas requirement and
   replaces it with a startup file lock.
2. **Network filesystems can corrupt SQLite.** This is a live risk for NAS users. Mitigations:
   a loud README warning, a startup probe that logs when the data directory looks like a network
   mount, and default-on backups.
3. **Migrations are clumsier.** SQLite's `ALTER` is limited, so drizzle-kit emits 12-step table
   rebuilds. Forward-only still holds, but each migration gets real review and
   `PRAGMA foreign_keys=OFF` bracketing.

## Portability rules

To keep Postgres reachable later, the following are **banned**:

`DEFERRABLE` constraints · advisory locks (abstracted behind `withPlanLock`) · JSON operators
(JSON is stored and read whole, never queried into) · array columns · `interval` arithmetic
(done in TypeScript) · `gen_random_uuid()` and `now()` in defaults (generated in the app, so the
engine stays deterministic) · `numeric` (money is integer, see [ADR-0004](0004-money.md)).

CTEs, window functions, partial and expression indexes, `ON CONFLICT`, and `RETURNING` all exist
in both and are fine.
