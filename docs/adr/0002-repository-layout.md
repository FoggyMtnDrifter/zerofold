# ADR-0002 — Repository layout

- **Status:** Accepted (2026-08-22)

## Decision

A pnpm workspace with Turborepo:

    apps/web                Next.js application
    packages/budget-engine  Pure calculation core
    packages/db             Drizzle schema, migrations, seed
    packages/importers      Transaction-feed parsers and whole-plan migration adapters
    packages/shared         Money, dates, Zod schemas
    docs/behavior           Observed behaviour — the specification of record
    docs/adr                These records
    docker                  Dockerfile, compose, entrypoint

## The rule that matters

**`packages/budget-engine` has no dependencies, no I/O, and no clock.** It takes plain data in
and returns plain data out, and it takes `today` as an argument. This is what makes it
exhaustively testable against golden fixtures, and what makes those fixtures stable — a test
that reads the system clock passes on the day it is written and fails afterwards.

`packages/importers` splits into `feed/` (ongoing per-account transaction files) and `plan/`
(one-time whole-budget migration), unified by a canonical intermediate representation that is
**the same document as our native export format**. Export, backup restore, and migration from
another tool are therefore one code path, exercised constantly rather than only in the rare
case.

## Consequences

- The engine cannot log, cache, or read configuration. Anything it needs is an argument.
- A cycle between `budget-engine` and `db` is a design error, not a build problem; the engine
  never learns what a database is.
