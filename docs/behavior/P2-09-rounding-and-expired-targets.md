# P2-09 / P2-08b — Percentage rounding, and what a non-repeating target does past its date

- **Status:** RESOLVED.
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p2-09.json`. **Units:** milliunits.

## P2-09 — `goal_percentage_complete` truncates

Three NEED targets of 200000, funded to land on an exact `.5` percentage:

| funded | exact | **reported** | floor | round-half-up |
|--------|-------|--------------|-------|---------------|
| 25000 | 12.5% | **12** | 12 ✓ | 13 ✗ |
| 75000 | 37.5% | **37** | 37 ✓ | 38 ✗ |
| 125000 | 62.5% | **62** | 62 ✓ | 63 ✗ |

### R34 — `goal_percentage_complete = floor(100 × overall_funded / goal_target)`

Truncation, not rounding. Three independent `.5` cases agree.

### ⚠ The two rounding rules point in opposite directions

    goal_under_funded        →  ceil, to the nearest cent   (R28)
    goal_percentage_complete →  floor, to a whole percent   (R34)

Both are derived from the same target in the same call, and they round *opposite ways*. This
is not arbitrary — each is conservative in the direction that matters. Rounding "how much you
still need" **up** never leaves a shortfall; rounding "how far along you are" **down** never
overstates progress. Both err against the user's optimism.

An implementation that applied one rounding helper to every derived goal field would be wrong
on one of them, and the error is a single unit — invisible in casual testing, permanently
wrong in a golden fixture.

## P2-08b — A non-repeating target goes quiet past its due month

`G-TBD`: have a balance of 600000 by 2026-09-01, funded 450000, **not** repeating.

| month | months_to_budget | under_funded | overall_funded | overall_left | pct |
|-------|------------------|--------------|----------------|--------------|-----|
| SEP (the due month) | 1 | **150000** | 450000 | 150000 | 75 |
| OCT (past due) | **0** | **0** | 450000 | 150000 | 75 |

### R35 — Past its due month, a non-repeating target stops demanding

`months_to_budget` drops to **0** and `under_funded` to **0**. The target does not roll over,
does not go overdue, and does not report a negative span. It simply goes silent, while
`overall_left` continues to report the 150000 that was never funded.

This is the exact counterpart to [R31](P2-08-yearly-cadence-rollover-and-snooze.md):

| target | past its due month |
|--------|--------------------|
| **repeating** (e.g. yearly cadence) | rolls to the next occurrence; `months_to_budget` resets to the full period |
| **non-repeating** (TBD) | `months_to_budget → 0`, `under_funded → 0` |

### R36 — `months_to_budget = 0` is the sentinel for "no active demand"

It holds for all three quiet cases: TB always (R26), a past-due non-repeating target (R35),
and by implication anything else with no schedule. `under_funded` is 0 whenever it is 0.

**This is the division guard.** Any implementation of R27 that computes
`(target − carried) / months_to_budget` must short-circuit on 0 before dividing. It is reached
by ordinary data — a savings goal whose date has passed — not by a pathological edge case.

## Engine consequences

1. `packages/shared/money` needs **two** distinct helpers, `ceilToCent` and
   `floorToPercent`, and the target code must not be able to reach for the wrong one. Naming
   them for the *rounding direction* rather than for the field keeps the call sites honest.
2. `computeTarget` returns early with `underFunded: 0, monthsToBudget: 0` for: TB, snoozed
   (no — snooze does *not* zero it, see R32), and past-due non-repeating targets. Only the
   last two of those three actually zero the value; keeping the list explicit avoids
   conflating snooze with expiry, which is the easy mistake here.
3. Determining "is this target repeating?" is what selects between R31 and R35, so it must be
   an explicit stored property, not inferred from whether `goal_cadence` is set — a yearly
   cadence with Repeat off would otherwise be misclassified.
