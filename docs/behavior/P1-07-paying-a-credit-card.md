# P1-07 — Paying a credit card, and what a payment draws from

- **Status:** RESOLVED. **Falsifies and replaces the provisional R60** in
  [P3-03](P3-03-reconciliation.md).
- **Evidence class:** CONSTRUCTED, as a deliberate falsification test.
- **Raw:** `_raw/p1-07.json`, `_raw/p1-07b.json`. **Units:** milliunits.

## Why this experiment existed

P3-03 stumbled on card payments reducing `month.income`, and proposed **R60**: *the negative
portion of a payment category is drawn from Ready to Assign, as cash overspending is.* It fitted
every observation in two plans. It was recorded as provisional and explicitly barred from a
fixture pending this test.

**It was wrong.**

## Test A — a card with no opening debt

`ZFX P107`, opening balance **0**. Funded a category 100000, charged 60000 to the card →
payment category holds 60000 of coverage. Then three payments:

| step | payment | payment category | `month.income` | R60 predicted |
|------|---------|------------------|----------------|---------------|
| baseline | — | 60000 | 1048000 | — |
| pay **less** (20000) | 20000 | 40000 | **1048000** | unchanged ✓ |
| pay **exactly** (40000) | 40000 | 0 | **1048000** | unchanged ✓ |
| pay **more** (15000) | 15000 | **−15000** | **1048000** | **1033000** ✗ |

Income did not move — **not even when the overshoot drove the payment category to −15000**,
which is precisely the case R60 said would cost Ready to Assign.

## Test B — a card *with* opening debt

`ZFX Debt2`, opening balance **−50000**, no coverage ever created:

| step | payment category | `month.income` |
|------|------------------|----------------|
| created | 0 | 1048000 |
| pay 9000 | **−9000** | **1039000 (−9000)** |

Same payment-category sign, same magnitude of negative — **opposite income result**.

## R60′ — Payments draw from income only to the extent they pay *uncovered* debt

    covered debt   = debt arising from categorised purchases (matched by payment-category coverage)
    uncovered debt = debt that no category ever funded — principally the opening balance

    A payment applied to covered debt   → draws down the payment category. Income unaffected.
    A payment applied to uncovered debt → drawn from Inflow: Ready to Assign. Income falls
                                          by that amount.

Every observation across three cards fits:

| card | opening debt | coverage | payments | income effect | check |
|------|--------------|----------|----------|---------------|-------|
| ZFX P107 | 0 | 60000 | 75000 | **0** | all payments hit covered debt; the 15000 overshoot pays debt that does not exist | ✓ |
| ZFX Debt2 | 50000 | 0 | 9000 | **−9000** | wholly uncovered | ✓ |
| ZFX Visa | 300000 | 0 | 37000 | **−37000** | wholly uncovered | ✓ |

### Why this is the right behaviour

Debt you carried *before* you started budgeting was never funded by any category. Paying it has
to come from somewhere, and the only source is money not yet assigned — Ready to Assign. Debt
from a budgeted purchase was already funded when the purchase was categorised; paying it just
moves the money you set aside. The two are economically different acts and YNAB books them
differently.

This also explains [R37/R38](P2-07-debt-targets-and-opening-debt.md): a negative opening balance
does not *add* to income when the account is created, but paying it down *subtracts* from
income later. The debt is recognised at the moment it is settled, not when it is recorded.

## What went wrong with R60, and the lesson

R60 fitted **five** observations across two plans and was internally coherent. What it lacked
was a case where its prediction differed from the truth — and there was exactly one:
**overshooting a fully-covered card.** In every case that had been observed, "payment category
went negative" and "payment hit uncovered debt" happened to coincide.

This is the same failure mode as the auto-assign window in
[P3-01](P3-01-auto-assign-formulas.md), where 3-month and 6-month readings each fitted
perfectly until the history outgrew them. **A rule that fits every observation is not confirmed;
it is merely unfalsified.** The discipline that caught both: after forming a rule, construct the
case where it would be *wrong*, and run that.

Marking R60 provisional and refusing to fixture it is what made this cheap to correct.

## Engine consequences

1. The engine must track **covered vs uncovered debt per credit account**, not just the payment
   category balance. `CarryState.creditDebtCovered` (plan §4) already exists for this; it now
   has a defined role — a payment reduces covered debt first, and only the remainder is booked
   against Ready to Assign.
2. A payment category may go negative **without** any Ready-to-Assign consequence (Test A).
   So a negative payment category is *not* by itself a signal of anything requiring correction,
   and must not be surfaced as overspending.
3. The opening balance of a credit account is a distinguished quantity, not an ordinary
   transaction. It seeds `uncoveredDebt` and must survive plan export/import intact.
