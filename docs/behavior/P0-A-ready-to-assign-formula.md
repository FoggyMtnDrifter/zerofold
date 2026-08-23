# P0-A — The Ready to Assign formula, carryforward, and cash overspending

- **Status:** RESOLVED for all terms reachable without future-dated income (see P0-04).
- **Evidence class:** CONSTRUCTED, in a clean plan (`zf-exp-p0`, `8aff3ff5…`) created solely for
  this experiment. Single variable changed per step, full state read after each.
- **Covers experiments:** P0-01 (carryforward), P0-03 (future-month assignments),
  P0-05 (cash overspending), P0-06 (over-assignment).
- **Raw:** `_raw/p0-run2.json`, `_raw/p0-run3-r9-retest.json`. **Units:** milliunits.
  (The steps 0–2 capture was not persisted — that script aborted at the P0-04 error before its
  write. The step table below is the record of it, and R9 was independently re-confirmed
  afterwards with different amounts; see "Independent re-confirmation".)

## Setup

One checking account with a starting balance of 1000000 ($1000), dated 2026-08-22, auto
categorized to `Inflow: Ready to Assign`. Three empty categories C1, C2, C3. Nothing else.

## The result

| step | change made | AUG RTA | SEP RTA | OCT RTA | C1 AUG | C1 SEP |
|------|-------------|---------|---------|---------|--------|--------|
| 0 | baseline, nothing assigned      | 1000000 | 1000000 |   *404* |      0 |      0 |
| 1 | assign 300000 to C2 in **SEP**  |  **700000** |  700000 |  700000 |      0 |      0 |
| 2 | revert C2 to 0                  | 1000000 | 1000000 | 1000000 |      0 |      0 |
| 3 | assign 100000 to C1 in **AUG**  |  900000 |  900000 |  900000 | 100000 | **100000** |
| 4 | spend **140000 cash** on C1 AUG |  **900000** |  **860000** |  860000 | **-40000** | **0** |
| 5 | assign 5000000 to C3 in AUG     | -4100000 | -4140000 | -4140000 | -40000 |      0 |

## Rules

### R8 — The Ready to Assign formula

    RTA(M) = Σ income(months ≤ M)
           − Σ budgeted(ALL months — past, current, and future)
           − Σ cash_overspending(months < M)

The three terms have **three different time windows**, and that asymmetry is the whole point:

- income is cumulative **through M**
- assignments are counted across **all time**, including months after M
- cash overspending is counted **strictly before M**

Verification against the table:

| month | income≤M | Σ budgeted (all) | overspend<M | computed | observed |
|-------|----------|------------------|-------------|----------|----------|
| step 1 AUG | 1000000 | 300000 (in SEP) | 0 | 700000 | 700000 ✓ |
| step 3 AUG | 1000000 | 100000 | 0 | 900000 | 900000 ✓ |
| step 4 AUG | 1000000 | 100000 | 0 | 900000 | 900000 ✓ |
| step 4 SEP | 1000000 | 100000 | 40000 | 860000 | 860000 ✓ |
| step 5 AUG | 1000000 | 5100000 | 0 | -4100000 | -4100000 ✓ |
| step 5 SEP | 1000000 | 5100000 | 40000 | -4140000 | -4140000 ✓ |

### R9 — Future-month assignments reduce the *current* month's RTA

Step 1 is decisive: money assigned in **September** dropped **August's** RTA from 1000000 to
700000. RTA is not a per-month bucket that future months draw from independently — every
assignment anywhere reduces it everywhere.

> This was flagged in the project plan §4 as "determine empirically." It is now determined.

### R10 — Cash overspending: zero the category, charge the *next* month's RTA

Step 4 is decisive on both halves:

- The category shows **-40000 in August**, the month the overspending happened, and
  **0 in September** — the negative does **not** roll forward.
- **August's own RTA is unchanged** at 900000. Only **September onward** drops to 860000.

So cash overspending is absorbed by the *following* month, never the month it occurred in.
Contrast with credit overspending (P1-03 / R4), which does not touch RTA at all and instead
carries the negative forward in the category.

### R11 — Carryforward is unconditional for non-negative balances

Step 3: C1 assigned 100000 in August shows `balance: 100000` in September and October with
`budgeted: 0` in those months. Positive available carries forward indefinitely and is not
re-counted against RTA.

### R12 — Negative RTA is permitted and is not clamped

Step 5 assigned 5100000 against 1000000 of income. RTA simply goes to -4100000. There is no
floor, no error, and no automatic correction. The formula holds unchanged through negative
values.

## Independent re-confirmation of R8 + R9

Re-run from a *different* baseline — one where C1 already carried a 40000 August cash overspend
— so the future-assignment term and the overspend term are exercised **simultaneously**, which
the original sequence never did:

| month | observed RTA | income≤M | Σ budgeted (all) | overspend<M | computed |
|-------|--------------|----------|------------------|-------------|----------|
| AUG | 650000 | 1000000 | 350000 (100000 AUG + 250000 SEP) | 0 | 650000 ✓ |
| SEP | 610000 | 1000000 | 350000 | 40000 | 610000 ✓ |
| OCT | 610000 | 1000000 | 350000 | 40000 | 610000 ✓ |

Reverting the September assignment returned every month to its prior value exactly, confirming
the operation is cleanly invertible and leaves no residue.

## Engine consequences

1. `readyToAssign` **cannot** be derived from a left-to-right fold over months alone, because
   the assignment term depends on *future* months. The engine must compute
   `Σ budgeted(all months)` as a plan-wide scalar available to every month's evaluation.
   This is a real constraint on `advance()`: its `CarryState` needs a plan-level term that is
   not a function of the months already folded.
2. The overspending term uses `< M`, not `≤ M`. Off-by-one here would misstate RTA in every
   month following any overspend — a bug that would look correct in the current month and
   wrong everywhere after it.
3. R10 + R11 mean the carryforward transform is `max(available, 0)` for cash-funded
   categories, with the clipped amount accumulated into a separate plan-level overspend
   ledger keyed by month. This is precisely the transform whose idempotence the gap-jumping
   optimization depends on (plan §4) — and it *is* idempotent, since `max(max(x,0),0) = max(x,0)`.

## Structural observations

- **Months materialize lazily.** `GET /months/2026-10-01` returned **404** at baseline, when
  the plan's horizon was August–September. Assigning into September in step 1 caused October
  to spring into existence. Once materialized, a month persists even after the assignment that
  created it is reverted (step 2 shows October still present, at 1000000).
  This validates the plan's §4 "material months" design: YNAB itself does not materialize an
  unbounded future.
- **RTA is reported identically in every month at or after the last event.** SEP and OCT always
  agree. Only months separated by an overspending event differ.

## Fixtures

- `p0-a-rta-formula.json` — the full five-step sequence above as one golden file, asserting
  RTA and category balances for AUG/SEP/OCT after every step.
- Property test: `RTA(M)` computed by the fold must equal the closed form R8 for every M.
