# P2-07 / P1-08 — Debt payoff targets, and starting a card already in debt

- **Status:** RESOLVED for credit cards. Loan-account debt metadata untested (see Open).
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p2-07.json`, `_raw/p2-07-setup.json`.
- **Units:** milliunits.

## P1-08 — Opening a credit card with an existing balance

Created `ZFX Visa`, type `creditCard`, opening balance **−300000**.

| observation | value |
|-------------|-------|
| starting transaction | amount −300000, payee **"Starting Balance"**, category **"Inflow: Ready to Assign"**, `cleared` |
| month `income` | **1000000 → 1000000 (unchanged)** |
| month `to_be_budgeted` | **−225000 → −225000 (unchanged)** |
| payment category `balance` | **0** |

### R37 — A negative opening balance is categorised to Inflow: RTA but does not enter income

The transaction carries the Inflow category, exactly like the checking account's positive
opening balance in [R22](P0-C-scheduled-accounts-deletion.md) — yet income and Ready to Assign
are **both unchanged**. A positive opening balance adds to income; a negative one does not
subtract from it.

> **Not fully discriminated:** this may be a rule about credit-account opening balances
> specifically, or a general rule that negative amounts categorised to Inflow are excluded from
> `income`. Distinguishing them needs a negative opening balance on a *cash* account.
> **Follow-up P1-08b.**

### R38 — Opening debt creates no payment obligation in the payment category

The payment category sits at `budgeted 0, activity 0, balance 0`. The debt exists on the
account but nothing is set aside for it. Contrast [R1](P1-03-credit-card-payment-coverage.md),
where a *categorised purchase* moves funds into the payment category — an opening balance is
not a purchase and moves nothing.

### R39 — Payment categories carry an implicit funding requirement equal to the card balance

Even with **no target at all**, the plan-wide Auto-Assign → Underfunded total rose from
$238.03 to $913.03 when this card and three test categories were added:

    375.00  (three test categories)  +  300.00  (the card)  =  675.00  ✓

The payment-category inspector states it directly: *"You need to assign $300.00 more to pay off
your current balance"*, with **Total Underfunded $300.00**.

So a credit card payment category is underfunded by its outstanding balance by default. This is
an implicit target that exists without any `goal_*` fields being set, and it **must be included
in the underfunded aggregate**.

## P2-07 — The debt payoff target

The payment-category inspector is a distinct surface from a normal category: a Payment section
with an underfunded warning, Current Balance, Available for Payment, a *"Why is my payment
underfunded?"* link, and a **"Create a Debt Payoff Target"** action. Its Auto-Assign list is
relabelled too — **"Paid Last Month"** rather than "Spent Last Month".

Two modes are offered: **Pay Off Balance by Date** and **Pay Specific Amount Monthly**.

### R40 — "Pay Off Balance by Date" is stored as `TBD` with `goal_target: 0`

Created for September 2026 against a −300000 balance:

| month | goal_type | **goal_target** | target_month | under_funded | months_to_budget | **overall_left** |
|-------|-----------|-----------------|--------------|--------------|------------------|------------------|
| AUG | **`TBD`** | **0** | 2026-09-01 | **150000** | 2 | **300000** |
| SEP | **`TBD`** | **0** | 2026-09-01 | **300000** | 1 | **300000** |
| OCT | **`TBD`** | **0** | 2026-09-01 | **0** | 0 | 300000 |

Two things to notice.

**`goal_type` is `TBD`, not `DEBT`.** The enum value `DEBT` exists in the API but was not
produced by this path.

**`goal_target` is 0.** The target amount is *not* stored. The real figure is the account's
current balance, surfaced through `goal_overall_left`.

    under_funded(M) = ceil_to_cent( goal_overall_left / months_to_budget(M) )

- AUG: 300000 ÷ 2 = **150000** ✓
- SEP: 300000 ÷ 1 = **300000** ✓
- OCT: `months_to_budget = 0` → **0** ✓ (R35 — non-repeating, goes quiet past its date)

An engine applying the ordinary [R27](P2-03-target-recalculation-and-rounding.md) formula
`(goal_target − carried) / months` would compute `(0 − 0) / 2 = 0` and report a debt payoff
target that never asks for anything. **This is the single most dangerous target case**: it
looks like a TBD, it validates like a TBD, and using the TBD formula silently produces zero.

### R41 — The debt target amount is dynamic

Because the amount derives from the live account balance rather than a stored constant, the
target's demand changes whenever a charge or payment hits the card — with no edit to the target
and no change to any `goal_*` field. Like [R30](P2-02-weekly-cadence.md)'s date dependence, this
is a cache-invalidation input the plan's §4 strategy did not account for: **a transaction on a
credit account must dirty its payment category's derived target values.**

## Engine consequences

1. `computeTarget` must branch on *whether the category is a credit-card payment category*
   before branching on `goal_type`, because the amount source differs (account balance vs
   `goal_target`) even though the type reads `TBD`.
2. The implicit requirement (R39) applies with **no** target present, so payment categories
   need a default path, not just a target path.
3. Dirty propagation must run **account → payment category → month totals**, an edge the
   current invalidation graph does not have.

## Open

- **`DEBT` and `MF` remain unproduced** by any path in the current UI. Both are in the API enum.
  Working hypothesis: `DEBT` appears for *loan* account types (mortgage, autoLoan, studentLoan)
  rather than credit cards, and `MF` is legacy. Our compat API should accept and emit both.
  **Follow-up P2-06b/P2-07b.**
- **Account `debt_*` fields are all empty** for a credit card (`debt_original_balance: null`,
  `debt_interest_rates: {}`, `debt_minimum_payments: {}`, `debt_escrow_amounts: {}`). They are
  presumably populated only for loan account types — which is also where the loan planner and
  amortisation in §5 will get their inputs. **Untested; needed before M8.**
- **"Pay Specific Amount Monthly"** mode not yet exercised.
