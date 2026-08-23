# P2-03 — By-date recalculation with partial funding, and rounding

- **Status:** RESOLVED. **Supersedes the R27 formula** first stated in
  [P2-04/05](P2-04-05-have-a-balance-targets.md).
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p2-03a.json`, `_raw/p2-03b.json`.
- **Units:** milliunits (1000 = $1.00, so **10 milliunits = 1 cent**).

## Why R27 needed correcting

P2-05 observed a TBD target only in the **unfunded** state, where several candidate formulas
coincide. It concluded:

    under_funded(M) = (target − overall_funded) / months_to_budget(M)     ← WRONG

Partial funding separates them. TBD target 600000 due 2026-09-01, funded 200000 in August:

| month | budgeted | carried | months | overall_funded | **observed** | old R27 predicts |
|-------|----------|---------|--------|----------------|--------------|------------------|
| AUG | 200000 | 0 | 2 | 200000 | **100000** | 200000 ✗ |
| SEP | 0 | 200000 | 1 | 200000 | **400000** | 400000 ✓ |

The old formula happens to be right in the final month (where `months_to_budget = 1`) and
wrong everywhere else. Testing only the last month, or only the unfunded state, would have
shipped this.

## R27 (corrected) — the by-date "needed" formula

    share(M)        = ceil_to_cent( (goal_target − carried_forward(M)) / months_to_budget(M) )
    under_funded(M) = max(0, share(M) − budgeted(M))

where `carried_forward(M)` is the balance entering month M, and `months_to_budget(M)` is the
inclusive month count from M through `goal_target_month`.

The shape is: **spread what is still missing over the months still available, then subtract
what this month already holds.**

Verified against all six observations:

| cell | target − carried | ÷ months | share | − budgeted | computed | observed |
|------|------------------|----------|-------|------------|----------|----------|
| AUG unfunded | 600000 | ÷2 | 300000 | −0 | 300000 | 300000 ✓ |
| SEP unfunded | 600000 | ÷1 | 600000 | −0 | 600000 | 600000 ✓ |
| AUG funded 200000 | 600000 | ÷2 | 300000 | −200000 | 100000 | 100000 ✓ |
| SEP after that | 400000 | ÷1 | 400000 | −0 | 400000 | 400000 ✓ |
| AUG funded 450000 | 600000 | ÷2 | 300000 | −450000 | **0** (clamped) | 0 ✓ |
| SEP after that | 150000 | ÷1 | 150000 | −0 | 150000 | 150000 ✓ |

Also consistent with the earlier NEED-dated probe: 120000 due December, viewed from August →
`months_to_budget: 5`, `under_funded: 24000` = 120000 ÷ 5.

### Supporting values

    overall_funded(M) = carried_forward(M) + budgeted(M)
    overall_left(M)   = goal_target − overall_funded(M)
    percentage_complete(M) = 100 × overall_funded(M) / goal_target

Observed: 200000/600000 → **33**, 450000/600000 → **75**. Both are consistent with floor and
with round-half-up; **not yet discriminated.** A case landing on exactly x.5 is needed.
**Open — folded into P2-09.**

## R28 — `goal_under_funded` is rounded UP to the nearest cent

Four dated targets created in August with deliberately inexact divisions:

| target | months | exact quotient | **observed** |
|--------|--------|----------------|--------------|
| 100000 | 3 | 33333.3333 | **33340** |
| 100000 | 6 | 16666.6667 | **16670** |
| 10 | 3 | 3.3333 | **10** |
| 1 | 3 | 0.3333 | **10** |

Not floor, not round-half — **ceiling to a multiple of 10 milliunits**:

    ceil_to_cent(x) = ceil(x / 10) × 10

- 33333.3333 → 3333.33 cents → ceil 3334 cents → **33340** ✓
- 16666.6667 → 1666.67 cents → ceil 1667 cents → **16670** ✓
- 3.3333 → 0.33 cents → ceil 1 cent → **10** ✓
- 0.3333 → 0.03 cents → ceil 1 cent → **10** ✓

Amounts are *stored* in milliunits, but the derived "needed" figure is quantised to cents and
always rounded up, so following the target never leaves a fractional-cent shortfall at the
deadline.

### Edge case — needed can exceed the target

For `target: 1` over 3 months, `under_funded` is **10** — ten times the entire target. The
ceiling is applied to the per-month share with no clamp against the remaining amount. Sub-cent
targets are pathological and not worth special-casing, but the engine must not assume
`under_funded ≤ overall_left`; an assertion to that effect would fire on legitimate data.

## Engine consequences

1. `ceil_to_cent` belongs in `packages/shared/money` and must be used for **every** derived
   "needed" figure. Exact milliunit division would under-report by up to 9 milliunits per
   category per month, and the Underfunded quick-budget total would drift by the sum of those
   errors across every category — a visible, compounding discrepancy.
2. The subtraction of `budgeted(M)` happens **after** the ceiling, not before. Reversing the
   order changes the result whenever the division is inexact.
3. `carried_forward(M)` is the same value the carryforward transform already produces, so both
   R25 (NEED refill) and R27 (by-date) read one existing term rather than needing new state.
4. Do not test a target formula only in its final month or only unfunded — that is exactly
   the blind spot that produced the wrong R27.
