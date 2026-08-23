# Milestones

Nine milestones, each ending in something demonstrable with a green build. This file is the
record of where the project actually is — not where it was planned to be.

Status is one of **done**, **in progress**, or **not started**. A milestone is done when it is
demonstrable end to end, its behaviour is covered by tests, and anything it diverges on is
recorded in [`behavior/divergences.md`](behavior/divergences.md).

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Instance, accounts and identity: first-run setup, invite-only registration, plans, all thirteen account types, Docker image | **done** |
| M2 | The register: virtualised at 50,000 rows, entry, editing, bulk actions, reconciliation, undo/redo | **done** |
| M3 | The budget engine and budget view: Ready to Assign, assignment, carryover, the month grid | not started |
| M4 | Credit cards: payment categories, covered and uncovered debt, cash and credit overspending | not started |
| M5 | Targets: the full goal set, recalculation, rounding, snooze and rollover | not started |
| M6 | Scheduled transactions: cadences, auto-entry, approval | not started |
| M7 | Import: CSV, OFX, QIF, and migration from another budgeting app | not started |
| M8 | Reports: spending, income, net worth, age of money | not started |
| M9 | Compatible API, export and re-import, PWA offline | not started |

## M1 — done

First user becomes the admin; later registrations need an invite. Plans, memberships, and all
thirteen account types with the budget classification each implies. Per-plan authorization in a
single choke point. Multi-arch container, migrations applied on start, `/healthz`, backup and
restore.

## M2 — done

The register holds 50,000 rows at 32 DOM nodes and zero dropped frames, opens in well under the
budget, and is fully operable from the keyboard. Entry and editing share one form. Bulk approve
and delete. Reconciliation against the cleared balance, posting an adjustment to Ready to Assign
when the statement disagrees. Undo and redo over an inverse-command log ([ADR-0008](adr/0008-undo.md)).

Deliberately not in M2: splits and transfers have command-layer support and tests but no
dedicated UI yet; they arrive with the budget view in M3, where a category picker exists to
attach them to.

## Open behaviour questions

These are measured against the oracle before the code that depends on them is written.

- **P3-04c, month-end clamping.** The experiment is planted and cannot be read before
  **2026-09-01**; `docs/behavior/_pending/p3-04c-read.mjs` reads it. Blocks part of M6. No interim
  interpretation has been adopted.
- **P3-02d, an exhausted FIFO queue in Age of Money.** Open, low priority. Blocks part of M8.
