# P2-02 — Weekly cadence, `goal_day`, and the current-month decay

- **Status:** RESOLVED. The residual ambiguity was subsequently discriminated — see below.
- **Evidence class:** CONSTRUCTED in the UI, observed via the API. **Raw:** `_raw/p2-02.json`.
- **Units:** milliunits. Observation date: 2026-08-22 (local) / 2026-08-23 (UTC).

## Setup

A weekly target of $25.00 **every Monday**, created in August 2026, nothing assigned.
Monday was chosen deliberately: it occurs **5 times in August 2026** and **4 times in
September**, so any formula based on occurrence counts is distinguishable from one based on a
flat four-week month.

## Result

| month | type | day | cadence | cad_freq | target | under_funded | months_to_budget |
|-------|------|-----|---------|----------|--------|--------------|------------------|
| AUG | `NEED` | **1** | **2** | 1 | **25000** | **50000** | 1 |
| SEP | `NEED` | **1** | **2** | 1 | **25000** | **100000** | 1 |

## R29 — Field encodings

- **`goal_cadence: 2` means weekly.** (Monthly is `1`, established in P2-01.)
- **`goal_day` is 0=Sunday … 6=Saturday.** Monday → `1`. Confirmed independently: the UI's day
  selector carries `value="6"` for Saturday.
- **`goal_target` holds the per-occurrence amount, not the monthly total.** 25000 is the
  weekly $25, and the monthly requirement is derived from it.

## R30 — The current month counts only occurrences *remaining from today*

Mondays in August 2026: **3, 10, 17, 24, 31** — five of them.
Observed August requirement: **50000 = 2 × 25000**, not 125000.

The two Mondays still ahead on the observation date (2026-08-22) are **the 24th and the 31st**.

September, entirely in the future, counted **all four** of its Mondays: 100000 = 4 × 25000 ✓

    current month:  under_funded = remaining_occurrences(today … month_end) × goal_target
    future months:  under_funded = all_occurrences(month) × goal_target

So a weekly target's monthly demand **decays as the month progresses** — on the 1st it asks for
five weeks, by the 22nd only two. This is correct behaviour (you cannot fund a Monday that has
already passed) but it is easy to miss entirely, because it is invisible unless you look at a
partially-elapsed month with a weekday that occurs five times.

### Discriminating the two candidate rules

"Remaining occurrences of the target weekday" and "whole weeks remaining in the month" both
predict 2 for Monday. They were separated without waiting or clock manipulation, by changing
only the **weekday** on the same target, in the same month, on the same observation date:

| `goal_day` | weekday | occurrences remaining after Aug 22 | predicted | **observed** |
|------------|---------|------------------------------------|-----------|--------------|
| 1 | Monday | 24th, 31st → **2** | 50000 | **50000** ✓ |
| 5 | Friday | 28th → **1** | 25000 | **25000** ✓ |

"Weeks remaining in the month" is a property of the month and the date alone — it would yield
the **same** figure for both. It does not. **Occurrence counting is confirmed**, and this is a
measured result rather than a chosen interpretation.

September, wholly in the future, reported 100000 = 4 × 25000 for Friday — all four occurrences
— confirming the future-month branch simultaneously.

## Engine consequence — a cache invalidation this design did not account for

Every other rule so far is a pure function of stored data. **R30 is a function of `today`.**

The engine already takes `today` as an explicit input, so the calculation itself is fine. But
the plan's §4 cache strategy invalidates `month_category` **only on edits**. A weekly target's
`goal_under_funded` changes at **midnight with no edit at all** — and so does every aggregate
built from it: the month's underfunded total, the Underfunded quick-budget amount, and the
budget view's colour states.

Required changes:

1. `month_category` rows for categories with `goal_cadence = 2` must carry a
   **`derived_for_date`** stamp alongside `cache_epoch`, and be treated as dirty when
   `derived_for_date != today(plan_timezone)`.
2. The recompute path must therefore be reachable on **read** for the current month, not only
   after a write. Reads of the current month already take the plan lock when dirty (§4), so
   the hook exists — but the dirty predicate must widen.
3. This is per-plan-timezone, not per-server-date — a plan in Auckland rolls over hours before
   one in Los Angeles. Ties directly to divergence **D5**.
4. Golden fixtures for weekly targets must pin `today` explicitly, or they will pass on the day
   they are recorded and fail every day after.

## Open

- **Yearly cadence** (`goal_cadence` value) is still unobserved — presumably `13`, matching
  YNAB's documented encoding, but unverified. Folded into **P2-03b**.
- Whether the "Every N weeks" custom cadence uses `goal_cadence_frequency > 1` is untested.
