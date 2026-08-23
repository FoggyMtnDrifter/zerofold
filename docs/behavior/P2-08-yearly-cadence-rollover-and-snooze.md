# P2-08 — Yearly cadence, target rollover past the due month, and snooze

- **Status:** RESOLVED (P2-03b yearly cadence, R31 rollover, P2-08 snooze).
- **Evidence class:** CONSTRUCTED in the UI, observed via the API. **Raw:** `_raw/p2-08.json`.
- **Units:** milliunits. Observation date 2026-08-22 local / 2026-08-23 UTC.

## Yearly cadence

A yearly target of 25000 due 2026-09-01:

| field | value |
|-------|-------|
| `goal_type` | `NEED` |
| **`goal_cadence`** | **13** |
| `goal_cadence_frequency` | 1 |
| `goal_day` | **null** |
| `goal_target` | 25000 |
| `goal_target_month` | `2026-09-01` |

### R31a — Cadence encoding

    1  = monthly     (P2-01)
    2  = weekly      (P2-02)
    13 = yearly      (here)

The Yearly editor accepts a full date ("By 09/01/2026") but only the **month** survives into
`goal_target_month`; `goal_day` stays null. The day component is discarded for yearly targets.

### The needed math is R27, unchanged

| month | months_to_budget | under_funded | check |
|-------|------------------|--------------|-------|
| AUG | 2 | **12500** | 25000 ÷ 2 ✓ |
| SEP | 1 | **25000** | 25000 ÷ 1 ✓ |

A yearly target is not a special case — it is [R27](P2-03-target-recalculation-and-rounding.md)
with a distant `goal_target_month`.

## R31 — A repeating target rolls forward past its due month

Reading the **same** target in October, i.e. *after* its September due month:

| month | months_to_budget | under_funded | overall_left |
|-------|------------------|--------------|--------------|
| OCT | **12** | **2090** | 25000 |

`months_to_budget` jumps from 1 to **12**: the target has rolled over to its next annual
occurrence (September 2027), which is 12 months from October inclusive-of-neither-end in the
sense R27 uses. The demand resets to the full amount spread across the new period.

Rounding confirms it is R27 + R28 and nothing new:

    25000 ÷ 12 = 2083.3333  →  208.33 cents  →  ceil 209 cents  →  2090  ✓

This is the substance of the "yearly target recalculation" question in the brief: **the target
does not expire or go permanently overdue at its due date — it repeats.** An engine that
computed `months_to_budget` as a plain difference to `goal_target_month` would produce zero or
a negative span for every month after the deadline, and divide by it.

**Open:** whether a *non-repeating* target (Custom cadence with Repeat off) instead goes
overdue or stops demanding. Not tested — **P2-08b**.

## P2-08 — Snooze

Toggling "Snooze target for this month" on the August view:

| month | `goal_snoozed_at` | `goal_under_funded` |
|-------|-------------------|---------------------|
| AUG | **`2026-08-23T03:22:57.841Z`** | **12500 — unchanged** |
| SEP | null | 25000 |
| OCT | null | 2090 |

### R32 — Snooze is a per-month presentation flag, not a change to the target math

Three separate observations pin down its scope:

1. **`goal_under_funded` is unchanged** at 12500. Snoozing does not alter the computed need.
2. **`goal_snoozed_at` appears only in the snoozed month.** It is a timestamp, not a boolean,
   and it is scoped to the month it was set in — September and October read null.
3. The category's own Auto-Assign list **drops the "Underfunded" action entirely** while
   snoozed.

### R33 — Snooze changes one aggregate and not the other

| aggregate | before snooze | after snooze | effect |
|-----------|---------------|--------------|--------|
| Auto-Assign → **Underfunded** | $238.03 | **$238.03** | **excluded** |
| "August's Targets" (Cost to Be Me) | $698.03 | **$710.53** | **included** (+$12.50) |

The snoozed category's 12500 is left out of the Underfunded quick-budget total but counted in
the targets total. This is the same split seen in [R15](P0-B-assignment-ledger-hide-delete.md)
for hidden categories: **two different aggregations over the same rows**, and reusing one for
both is a bug that only appears once a plan contains a snoozed or hidden category.

### UI treatment

The grid row's target status text is suppressed entirely and the Available cell shows a sleep
indicator in place of the underfunded warning. The **inspector still shows the full underlying
need** ("Assign $12.50 this month to stay on track", "To Go $25.00"). Snoozing hides the nag,
not the fact.

## Engine consequences

1. `goal_snoozed_at` is **per (category, month)**, not per category. It belongs on
   `month_category`, not on `category_target`. The plan's §3 schema places it on the target
   record — **this needs correcting** before M5.
2. Compute `goal_under_funded` unconditionally; apply snooze only when building the
   Underfunded aggregate and when rendering the row. Never let snooze reach the target math.
3. `months_to_budget` for a repeating target must be computed against the **next** occurrence
   at or after the viewed month, not against a fixed `goal_target_month`. Guard against a
   non-positive span — it is the natural division-by-zero in this code.
