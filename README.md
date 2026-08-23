# Zerofold

Self-hosted zero-based envelope budgeting. Your data, your hardware, no telemetry.

Zerofold implements the zero-based budgeting method — every unit of currency you have gets
assigned a job before you spend it — with the depth that method actually requires:
credit-card payment categories, reconciliation, targets, scheduled transactions, and reports.

> **Status: pre-alpha.** The container builds and runs, but there is no budgeting in it yet —
> no auth, no accounts, no register. The behavioural specification is complete enough to build
> against; see [docs/behavior](docs/behavior/).

## Quickstart

```
git clone https://github.com/zerofold/zerofold && cd zerofold
docker compose -f docker/compose.yml up -d --build
open http://localhost:3000
```

That is the whole installation. One container, one volume, no database service to configure and
no cloud account. Your data is a single SQLite file inside the volume, and
`docker compose exec zerofold` … `backup` copies it out with `VACUUM INTO` while the app keeps
running.

**Do not put the data directory on an NFS or SMB share.** SQLite's locking is unreliable over
network filesystems and the database can be corrupted. Zerofold warns at startup if it detects
one, but it cannot refuse to start. Use local storage.

## Why another budgeting app

Because the good one is a subscription you cannot self-host, and the self-hostable ones do not
implement the method faithfully. Zerofold aims at behavioural parity — including the unglamorous
parts — while running entirely on your own machine from a single container with a single file
of data you can copy.

## Compatibility

Zerofold exposes a public REST API shaped compatibly with the **YNAB API v1** — same resource
paths, field names, milliunit conventions, and delta requests — so existing importers,
dashboards, and scripts work against a Zerofold instance. Deliberate differences are recorded
in [docs/behavior/divergences.md](docs/behavior/divergences.md).

Zerofold is not affiliated with, endorsed by, or derived from the source code of YNAB. The
behavioural specification in `docs/behavior/` was produced by observing a live account and
recording what it does; no code, copy, or visual design was copied.

## Repository layout

    apps/web                Next.js application
    packages/budget-engine  Pure calculation core — no I/O, no framework, no clock
    packages/db             Drizzle schema, migrations, seed
    packages/importers      CSV/OFX/QIF parsers and whole-plan migration adapters
    packages/shared         Money, dates, Zod schemas
    docs/behavior           Observed behaviour — the specification of record
    docs/adr                Architecture decision records
    docker                  Dockerfile, compose, entrypoint

## Development

    pnpm install
    pnpm test
    pnpm typecheck
    pnpm lint

Requires Node 22+ and pnpm 10+.

## The behavioural specification

`docs/behavior/` is the source of truth for what the budgeting engine must do. Each document
states a question, the experiment that answered it, the observed figures at milliunit
precision, and the rule inferred — with raw API snapshots archived alongside so every claim can
be re-derived.

No budgeting rule is implemented from memory or assumption. Where a rule was later found to be
wrong, the failed reasoning is kept rather than deleted, because how it failed is worth as much
as the correction.

## Licence

[AGPL-3.0-only](LICENSE). Contributions under the [DCO](CONTRIBUTING.md) — sign your commits
off with `git commit -s`.
