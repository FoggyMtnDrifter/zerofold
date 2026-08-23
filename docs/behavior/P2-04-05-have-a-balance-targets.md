# P2-04 / P2-05 — TB and TBD targets, and the modern target taxonomy

- **Status:** RESOLVED for TB and TBD. MF remains unproduced (see Open).
- **Evidence class:** CONSTRUCTED in the web UI, observed via the API.
- **Units:** milliunits.

## The modern target editor is one control, not five types

YNAB's current editor composes a target from three orthogonal choices, not a menu of named
goal types. Understanding this is what makes the API's `goal_type` enum legible.

| Axis | Options |
|------|---------|
| **Cadence** (tabs) | Weekly · Monthly · Yearly · **Custom** |
| **Behavior** ("I want to") | Set aside · Fill up to · Have a balance of |
| **Due date** | `Due by date` toggle → month + year selectors (no day) |
| **Repeat** | toggle (Custom cadence only) |

The behaviors carry YNAB's own descriptions, which independently corroborate
[R25](P2-01-refill-vs-set-aside.md):

- **Set aside** — *"Add $X to this category, regardless of its current balance."*
  Marked **"Most people choose this."** → `goal_needs_whole_amount: true`
- **Fill up to** — *"Use what is already in this category and fill it up to $X."*
  → `goal_needs_whole_amount: false`
- **Have a balance of** — *"Reach this amount by a specific time and refrain from spending
  until you reach it."* → `TB` / `TBD`

On the Monthly tab the same choice is phrased *"Next month I want to → Set aside another $X /
Refill up to $X"*, with the refill description reading *"Whatever you don't spend will get
applied toward next month's $X."* That is R25's refill formula stated in YNAB's own words.

## Mapping the UI onto `goal_type`

| UI selection | `goal_type` | `needs_whole_amount` | `cadence` | `target_month` |
|--------------|-------------|----------------------|-----------|----------------|
| Set aside, any cadence | `NEED` | `true` | 1 (monthly) | null unless dated |
| Fill up to, any cadence | `NEED` | `false` | 1 (monthly) | null unless dated |
| Have a balance of, **no** date | **`TB`** | **null** | **null** | **null** |
| Have a balance of, **with** date | **`TBD`** | **null** | **null** | the chosen month |

`goal_needs_whole_amount`, `goal_cadence`, and `goal_cadence_frequency` are **NEED-only**.
They come back `null` for TB and TBD — the engine must not read them for those types.

## P2-04 — TB (have a balance, no date)

Target 500000, no date, nothing assigned:

| month | under_funded | months_to_budget | overall_funded | overall_left | pct |
|-------|--------------|------------------|----------------|--------------|-----|
| AUG | **0** | **0** | 0 | 500000 | 0 |
| SEP | **0** | **0** | 0 | 500000 | 0 |

### R26 — A TB target never demands funding in any month

`goal_under_funded` is **0**, not 500000, despite nothing being assigned. With no deadline
there is no per-month obligation. Corroborated in two independent places in the UI:

- the grid renders **"$500.00 needed eventually"**
- with only TB categories selected, Auto-Assign → **Underfunded reports $0.00**

So a TB target contributes nothing to the underfunded total and nothing to the "Underfunded"
quick-budget action. The naive expectation — `under_funded = target − funded` — is wrong.

## P2-05 — TBD (have a balance by a date)

Target 600000, due 2026-09-01, created in August, nothing assigned:

| viewed month | under_funded | months_to_budget | overall_left |
|--------------|--------------|------------------|--------------|
| AUG | **300000** | **2** | 600000 |
| SEP | **600000** | **1** | 600000 |

### R27 — TBD spreads the remaining amount evenly over the remaining months

> ⚠ **The formula below is SUPERSEDED.** It was derived from unfunded observations only, where
> several candidate formulas coincide, and it is wrong for any month other than the last.
> See **[P2-03](P2-03-target-recalculation-and-rounding.md)** for the corrected R27 and for the
> ceiling-to-cent rounding rule (R28). The `months_to_budget` and escalation findings below
> stand; only the arithmetic was wrong.

    months_to_budget(M) = inclusive month count from M through goal_target_month
    goal_under_funded(M) = (goal_target − goal_overall_funded) / months_to_budget(M)   ← WRONG

- AUG: 600000 ÷ 2 = **300000** ✓
- SEP: 600000 ÷ 1 = **600000** ✓

The span is measured from the **viewed month**, not the creation month, so the figure
**recalculates every month**. This is the same mechanic the earlier probe showed for a dated
NEED target (120000 due December from August → `months_to_budget: 5`, `under_funded: 24000`).

The demand therefore escalates automatically as the deadline nears and earlier months go
unfunded — which is the substance of the "yearly by date recalculation" question in
**P2-03**, still to be tested with a partially funded history and an inexact division.

## Open

- **MF is not creatable — resolved by exhaustion (P2-06b).** The editor's full matrix has now
  been exercised: four cadences (Weekly, Monthly, Yearly, Custom) × three behaviours (Set
  aside, Fill up to, Have a balance of) × dated and undated. Every combination yields `NEED`,
  `TB` or `TBD`. `MF` — "monthly funding", the older encoding for *set aside £X every month* —
  is now expressed as `NEED` with `goal_cadence: 1` and `goal_needs_whole_amount: true`.
  **Conclusion:** `MF` is legacy, present on older plans only. Our compat API must accept and
  emit it, and the engine must compute it (treating it as monthly set-aside), but nothing in
  our UI creates one. Same treatment for `DEBT`, which is likewise unproduced — see
  [P2-07](P2-07-debt-targets-and-opening-debt.md) R40, where a debt payoff target is stored as
  `TBD`.
- ~~Rounding when the division is inexact.~~ **Resolved in [P2-03](P2-03-target-recalculation-and-rounding.md) (R28):**
  rounded **up to the nearest cent**.
- The due-date picker offers **month and year only**, no day. But `goal_day` exists in the API
  and the Monthly tab has a "By" selector defaulting to "Last Day of Month". `goal_day` is
  presumably driven by that, not by the Custom due date. **Folded into P2-02.**

## Engine consequences

1. `computeTarget` must branch on `goal_type` before reading any other goal field. Reading
   `goal_needs_whole_amount` for a TB target would read `null` and, if coerced, silently
   behave as refill.
2. TB must be excluded from every "underfunded" aggregation — the month total, the filter
   chip, and the Underfunded quick-budget action.
3. TBD's `months_to_budget` is a function of the **viewed** month. Caching it per category
   rather than per (category, month) would freeze the first value computed and quietly
   under-demand for the rest of the target's life.
