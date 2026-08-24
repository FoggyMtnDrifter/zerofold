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
| M3 | The budget engine and budget view: Ready to Assign, assignment, carryover, the month grid | **done** |
| M4 | Credit cards: payment categories, covered and uncovered debt, cash and credit overspending | **done** |
| M5 | Targets: the full goal set, recalculation, rounding, snooze and rollover | **done** |
| M6 | Scheduled transactions: cadences, auto-entry, approval | **done**, except month-end |
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

## M3 — done

`packages/budget-engine` is pure and implements the measured rules: the Ready to Assign formula
and its three different time windows (R8), future assignments reducing the current month (R9),
cash overspending charged to the following month (R10), credit overspending charged to nothing
(R61), unconditional carryforward of positive balances (R11), and the cash-before-credit
ordering that decides which is which (R2).

The budget view computes from the engine rather than reading the cache, and `budget.verify`
asserts the two agree. Assignment appends to the money-movement ledger and never edits it (R13).

Measured, at five years and 200 categories — 12,000 cells: budget view **16ms** against a 1s
target, assignment **0.9ms** against 16ms, full recompute ~1s and verify 60ms.

Deliberately not in M3: credit-card payment categories have engine support for the *rules* but
no UI and no coverage arithmetic yet — that is M4. Targets are M5, so no category shows what it
needs. Category and group editing (rename, reorder, hide, delete) is not built; the starter set
is what a plan has.

## M4 — done

Coverage is sequential against a running balance, so the engine takes a ledger of transactions
rather than per-category totals: a charge is covered by whatever the category has available when
that charge is applied, and no sum can express "this one was covered and that one was not".
Order is cash first (R2), then date (R6), then transaction id (R7′).

Covered and uncovered debt are tracked per card. A payment settles covered debt first and costs
Ready to Assign only for the uncovered part (R60′) — the rule that was falsified once already
and now has the case that falsified it as a test. Refunds pay down uncovered debt first (R62,
R69); interest and opening balances create it (R63, R37).

The P1-03 plan is reproduced end to end from its real transaction ids, including the
Visa 120000 / Amex 50000 split — which is how R7 was found to be wrong.

Deliberately not in M4: the credit-card payment *target* (R39, an implicit funding requirement
equal to the card balance) belongs with targets in M5.

## M5 — done

Every target formula is measured, and two were measured wrong the first time — so both blind
spots are covered deliberately: every by-date case is tested funded *and* unfunded, and never
only in its final month.

Set aside counts what you put in; fill up to counts what was already there (R25), and they part
company the month after funding, before anything is spent. By-date targets spread what is still
missing over the months still available, subtracting this month's assignment *after* the ceiling
(R27, R28). The two rounding rules point opposite ways on purpose — needed ceils, progress
floors (R28, R34) — so neither ever flatters the user. Weekly targets decay through the month
(R30); repeating ones roll forward past their due month while non-repeating ones go quiet
(R31, R35). Snooze changes one aggregate and no arithmetic (R32, R33). A credit-card payment
category is underfunded by its balance with no target at all (R39).

Targets are stored as revisions keyed by the month they take effect from (divergence D2), so
editing one today cannot rewrite what a past month needed.

Deliberately not in M5: the target *editor* is not built — targets are set through the API, and
the grid shows what they need. `MF` and `DEBT` goal types remain unproduced by the oracle and
are accepted but untested.

## M6 — done, except month-end

All thirteen frequencies match the measured series (R51), including the two traps: a day-delta
between the first occurrence and the next tells you nothing unless exactly one period has
elapsed, and `twiceAMonth` is a day-pair rather than a stride (R52).

Auto-entry back-fills *every* missed occurrence rather than the latest (R53), unapproved and
uncleared so they are offered rather than assumed. Running it again enters nothing:
`last_entered_date` is the watermark and the whole catch-up is one transaction. A one-off is
consumed by its own entry (R54), leaving a tombstone rather than vanishing — divergence D12.

The catch-up runs in the component that reads the data, not in the layout. Next renders those
concurrently, so a catch-up in the layout could commit after the page had already queried, which
showed as a register missing rows it had just created on roughly one load in three.

**Month-end resolution is provisional.** A monthly schedule on the 31st currently clamps to the
last day of a shorter month and returns to the 31st when the month is long enough again. That is
a choice, not a measurement, and it is marked as such in `recurrence.ts`, in its tests, and
below. No fixture depends on it.

## Open behaviour questions

These are measured against the oracle before the code that depends on them is written.

- **P3-04c, month-end clamping.** The experiment is planted and cannot be read before
  **2026-09-01**; `docs/behavior/_pending/p3-04c-read.mjs` reads it. M6 ships a *provisional*
  reading — clamp to the last day, return to the anchor day afterwards — chosen because it is the
  only one of the three candidates whose mistakes are visible if it is wrong, marked as
  provisional everywhere it appears and backed by no fixture. Searching the public record found
  all three behaviours attested elsewhere and nothing authoritative about this application. Read the experiment and either confirm it or
  correct `packages/shared/src/recurrence.ts`.
- **P3-04b, the twiceAMonth mirror case.** A day at or before the 15th is untested; the code
  reads it as `{d, d + 15}`, which is the pairing that makes both halves the same rule.
- **P3-02d, an exhausted FIFO queue in Age of Money.** Open, low priority. Blocks part of M8.
