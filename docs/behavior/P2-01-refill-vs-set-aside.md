# P2-01 — Refill vs. set-aside, and the NEED "needed" formula

- **Status:** RESOLVED. Complete formula for NEED targets in both modes.
- **Evidence class:** CONSTRUCTED. Two categories identical in every respect except
  `goal_needs_whole_amount`, driven through three states.
- **Raw:** `_raw/p2-probe.json`, `_raw/p2-01.json`. **Units:** milliunits.

## The mapping

    goal_needs_whole_amount: true   →  SET-ASIDE
    goal_needs_whole_amount: false  →  REFILL

The project brief flagged this distinction as one of the two most commonly gotten wrong, and
the plan's §3 schema marked the field **⚠ SEMANTICS TO VERIFY**. It is now verified.

**Note the default: an unspecified `goal_needs_whole_amount` becomes `true` (set-aside).**

## Observations

Two categories, NEED monthly, target 100000, differing only in the flag.

### Step 1 — funded 100000 in August, nothing spent

| month | mode | budgeted | balance | under_funded | pct | overall_funded |
|-------|------|----------|---------|--------------|-----|----------------|
| AUG | set-aside | 100000 | 100000 | 0 | 100 | 100000 |
| AUG | refill | 100000 | 100000 | 0 | 100 | 100000 |
| SEP | **set-aside** | 0 | **100000** | **100000** | **0** | **0** |
| SEP | **refill** | 0 | **100000** | **0** | **100** | **100000** |

**This already discriminates, before any spending.** Both categories carry 100000 into
September. Set-aside declares it needs the full 100000 *again*; refill declares itself
satisfied. The carried balance is invisible to one and decisive for the other.

### Step 2 — spent 60000 from each, leaving 40000

| month | mode | budgeted | activity | balance | under_funded | pct | overall_funded | overall_left |
|-------|------|----------|----------|---------|--------------|-----|----------------|--------------|
| AUG | set-aside | 100000 | -60000 | 40000 | **0** | 100 | 100000 | 0 |
| AUG | refill | 100000 | -60000 | 40000 | **0** | 100 | 100000 | 0 |
| SEP | **set-aside** | 0 | 0 | 40000 | **100000** | 0 | 0 | 100000 |
| SEP | **refill** | 0 | 0 | 40000 | **60000** | 40 | 40000 | 60000 |

## R25 — The NEED "needed" formula

Define **funded(M)**, the amount considered to satisfy the target in month M:

    set-aside:  funded(M) = budgeted(M)
    refill:     funded(M) = carried_forward(M) + budgeted(M)

`carried_forward(M)` is the balance entering the month — i.e. **available before this month's
activity**. Then, in both modes:

    goal_under_funded(M)        = max(0, target − funded(M))
    goal_overall_funded(M)      = funded(M)
    goal_overall_left(M)        = target − funded(M)
    goal_percentage_complete(M) = round(100 × funded(M) / target)

Verified against all eight observations:

| cell | carried | budgeted | funded | target − funded | observed under_funded |
|------|---------|----------|--------|-----------------|-----------------------|
| AUG set-aside | 0 | 100000 | 100000 | 0 | 0 ✓ |
| AUG refill | 0 | 100000 | 100000 | 0 | 0 ✓ |
| SEP set-aside | 100000 | 0 | **0** | 100000 | 100000 ✓ |
| SEP refill | 100000 | 0 | **100000** | 0 | 0 ✓ |
| SEP set-aside (after spend) | 40000 | 0 | **0** | 100000 | 100000 ✓ |
| SEP refill (after spend) | 40000 | 0 | **40000** | 60000 | 60000 ✓ |

And `percentage_complete`: 40000/100000 → **40** ✓, 0/100000 → **0** ✓, 100000/100000 → **100** ✓.

### The subtlety worth stating explicitly

**Spending in the current month does not create under-funding in that month.** In August both
categories dropped to a 40000 balance after spending 60000, yet both report
`under_funded: 0` and `pct: 100`. The target measures *what you put in*, not *what remains*.
Only the following month re-evaluates.

An implementation that computed `under_funded = target − balance` would be right for refill in
September and wrong in all five other cells.

## What the API can and cannot construct

`POST /categories` accepts only `goal_target`, `goal_target_date`, and
`goal_needs_whole_amount` (per `NewCategory`), and `PATCH` accepts neither
(`SaveCategory` is name and note only).

Every target created this way comes back as:

    goal_type: 'NEED',  goal_cadence: 1,  goal_cadence_frequency: 1

**The API cannot create TB, TBD, MF, or DEBT targets, nor set a cadence, day, or snooze.**
Remaining P2 experiments must build targets through the web UI and read results back through
the API. This split — construct in the UI, observe via the API — is the working method for
the rest of P2.

## Incidental — by-date targets divide evenly across remaining months

A target of 120000 with `goal_target_date: '2026-12-01'`, created in August, returned
`goal_months_to_budget: 5` (Aug…Dec inclusive) and `goal_under_funded: 24000` = 120000 ÷ 5.

Even division across the inclusive month span, no rounding artefact at this magnitude.
Full treatment — including recalculation after a skipped or partially funded month, and
rounding when the division is inexact — is **P2-03**.

## Fixtures

- `p2-01-set-aside.json`, `p2-01-refill.json` — the three-step sequence for each mode.
- Property test: for a refill target, `funded(M)` must equal available-before-activity, which
  is a value the engine already computes for the carryforward transform. Set-aside must ignore
  it entirely.
