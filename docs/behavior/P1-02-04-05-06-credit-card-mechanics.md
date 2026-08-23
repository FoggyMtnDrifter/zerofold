# P1-02 / P1-04 / P1-05 / P1-06 — Credit overspending, refunds, interest, cash back

- **Status:** RESOLVED. **Corrects the project plan's §4 assumption about credit overspending.**
- **Evidence class:** CONSTRUCTED on a clean card with no opening debt.
- **Raw:** `_raw/p1-m4.json`. **Units:** milliunits.

## Setup

`ZFX M4`, credit card, opening balance **0**. Category `M4 spend` assigned 50000. Then four
operations in sequence, reading August and September after each.

## P1-02 — Credit overspending does **not** carry forward

Charged 80000 against 50000 of funding:

| month | X budgeted | X activity | **X balance** | payment cat | RTA |
|-------|-----------|------------|---------------|-------------|-----|
| AUG | 50000 | −80000 | **−30000** | 50000 | unchanged |
| SEP | 0 | 0 | **0** | 50000 | **unchanged** |

### R61 — Credit overspending zeroes the category next month, and does *not* charge RTA

The −30000 is **clamped to 0** in September, exactly as cash overspending is
([R10](P0-A-ready-to-assign-formula.md)). But unlike cash overspending, **September's Ready to
Assign is untouched**.

> **This corrects the project plan.** §4 stated: *"Credit overspending … the negative typically
> carries forward in the category."* It does not. Both kinds of overspending clamp to zero; they
> differ **only** in whether the shortfall is billed to the next month's Ready to Assign.

| | category next month | next month's RTA |
|--|--------------------|------------------|
| **cash** overspending (R10) | 0 | **reduced** by the overspend |
| **credit** overspending (R61) | 0 | **unchanged** |

The asymmetry is right: cash overspending means money left the budget that was never assigned,
so the budget must absorb it. Credit overspending means *debt increased* — nothing left the
budget yet — so it is carried on the account as uncovered debt (see
[R60′](P1-07-paying-a-credit-card.md)) and only costs Ready to Assign when it is eventually paid.

**The two rules meet:** credit overspending creates uncovered debt; R60′ says paying uncovered
debt draws from RTA. The cost is deferred to settlement, not waived.

## P1-04 — A refund credits the category and leaves the payment category alone

Refunded 20000 to the same category on the card:

| | X activity | X balance | payment cat |
|--|-----------|-----------|-------------|
| before | −80000 | −30000 | 50000 |
| after | **−60000** | **−10000** | **50000 — unchanged** |

### R62 — A refund reduces uncovered debt first

Card debt fell 80000 → 60000; coverage stayed at 50000; uncovered debt fell 30000 → 10000,
matching the category balance exactly at both points. The refund was applied wholly to the
uncovered portion.

**Untested boundary:** a refund large enough to push the category *positive*. Whether coverage
then increases, or the surplus simply sits as category balance, is unknown. **Follow-up P1-04b.**

## P1-05 — Uncategorised interest touches no category

A −5000 uncategorised charge changed **nothing**: X unchanged at −10000, payment category
unchanged at 50000, income unchanged.

### R63 — Interest creates uncovered debt attributable to no category

Card debt rose to 65000 while coverage stayed 50000, so uncovered debt is now **15000** while
the category balance is only **−10000**. The two had matched until this point.

**Consequence:** uncovered debt is **not** derivable from summing negative category balances.
It must be tracked per account as `card_balance − Σ coverage`. An engine that reconstructed it
from category balances would understate it by exactly the accumulated interest and fees — and
would then under-charge Ready to Assign when the card is paid.

## P1-06 — Cash back on a card does not create income

A +3000 inflow **categorised to Inflow: Ready to Assign** on the credit card left
`month.income` unchanged at 1039000.

### R64 — Amounts categorised to Inflow on a *credit account* never affect income, either sign

This resolves the ambiguity flagged in [R37](P2-07-debt-targets-and-opening-debt.md), which
observed a **negative** opening balance being excluded and asked whether the rule was about
credit accounts or about negative amounts.

    negative (opening debt −300000) on a credit account  → excluded from income  (R37)
    positive (cash back +3000)      on a credit account  → excluded from income  (R64)

**It is about the account type, not the sign.** The income term in
[R8](P0-A-ready-to-assign-formula.md) must be restricted to Inflow-categorised transactions on
**non-credit** accounts.

## Engine consequences

1. `uncoveredDebt` is per credit account and must be carried in `CarryState`, computed as
   `|card balance| − coverage`, **not** inferred from category balances (R63).
2. The carryforward transform is `max(available, 0)` for *both* funding kinds (R61). What
   differs is only whether the clipped amount is added to the next month's overspend ledger —
   cash yes, credit no. This preserves the gap-jump idempotence the far-future optimisation
   relies on, since both branches are still idempotent.
3. `income` filters on account type. A single `WHERE category_id = <inflow>` without an account
   join would silently include cash back and opening debt, and R8 would drift.
