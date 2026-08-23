# P3-03 — Reconciliation, and an unexpected income interaction

- **Status:** Reconciliation RESOLVED. The income interaction (R60) was **falsified** by
  [P1-07](P1-07-paying-a-credit-card.md); see R60′ there.
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p3-03.json`. **Units:** milliunits.

## Setup

`ZFX Recon`, a savings account: opening balance 100000 (cleared), plus one **uncleared**
−12000 transaction. Cleared balance 100000, working balance 88000. Reconciled against a
statement balance of **85000**.

## The flow

1. *"Is your current balance **$100.00**?"* — YNAB proposes the **cleared** balance, not the
   working balance of $88.00.
2. Answering No prompts for the actual balance.
3. *"−$15.00 Difference"* — computed as cleared − statement.
4. A banner offers **Create Adjustment & Finish**.

Keyboard shortcut: **shift+E**.

## R55 — Reconciliation operates on the cleared balance only

The uncleared −12000 transaction was neither included in the comparison nor altered. After
finishing: `cleared_balance: 85000`, `uncleared_balance: −12000`, `balance: 73000`.

## R56 — Every cleared transaction becomes `reconciled`

The pre-existing starting balance flipped from `cleared` to **`reconciled`**. The uncleared one
stayed `uncleared`. So `reconciled` is a state applied in bulk at reconciliation time, not a
property set per transaction as it is entered.

## R57 — The adjustment transaction, exactly

| field | value |
|-------|-------|
| `date` | **2026-08-22** (see R59) |
| `amount` | **−15000** — statement − cleared |
| `payee_name` | **"Reconciliation Balance Adjustment"** |
| `payee` record | a **real, non-internal payee** with `deleted: false` |
| `category_name` | **"Inflow: Ready to Assign"** |
| `cleared` | **`reconciled`** |
| `approved` | `true` |
| `memo` | **"Entered automatically by YNAB"** |
| `import_id` / `flag_color` | null |

The adjustment is categorised to **Inflow: Ready to Assign**, so a negative adjustment reduces
income and therefore Ready to Assign. It is not booked to a spending category.

## R58 — `account.last_reconciled_at` is set

`null` → `2026-08-23T03:44:08Z`.

## R59 — UI-created and API-created transactions use *different* date bases

The adjustment, created through the browser, is dated **2026-08-22** — the user's local date.
The starting balances created through the API in the same plan are dated **2026-08-23** — the
server's UTC date. Both exist in the same plan, hours apart.

This sharpens divergence **D5**. It is not merely that YNAB uses UTC; it is that **the date
basis depends on which client created the row**, so a plan can contain two transactions
"today" bearing different dates. We resolve "today" through the plan's IANA timezone in one
place, for every entry path.

---

## R60 — ⚠ SUPERSEDED — see [P1-07](P1-07-paying-a-credit-card.md)

> **This rule was FALSIFIED by the designed test it called for.** Income is unaffected when a
> payment overshoots a *fully covered* card, even though the payment category goes negative.
> The real rule (**R60′**) is that payments draw from Ready to Assign only to the extent they
> pay **uncovered** debt — principally a card's opening balance. The analysis below is kept
> because the reasoning that produced it, and the way it failed, are both instructive.

### The original (incorrect) rule: a card payment beyond the payment category's balance reduces income

Discovered while reconciling the income figure, which did not match the sum of Inflow
transactions. Two-point confirmation:

| action | `month.income` | payment category |
|--------|----------------|------------------|
| baseline | 1055000 | activity −30000 |
| pay the card a further **7000** | **1048000 (−7000)** | activity −37000 |

Exactly the payment amount, both times.

### The mechanism, and why it is *not* "payments reduce income"

Cross-checking against the other test plan rules out the simple reading. In `Michael's Plan` a
**100000 card payment did not change income at all** — because there the payment category held
220000 of coverage and merely dropped to +120000, never going negative.

Here the payment category had nothing set aside and went straight to −37000.

    Σ Inflow transactions (excluding credit-account opening balances)   1085000
    + payment-category activity                                          −37000
    = month.income                                                      1048000  ✓

**Reading:** the *negative portion* of a credit-card payment category is drawn from Ready to
Assign, exactly as cash overspending is ([R10](P0-A-ready-to-assign-formula.md)). Paying a card
with nothing set aside is economically the same act as overspending a cash category, and YNAB
accounts for it the same way.

### Caveat — stated plainly

This formula fits **both** plans at every observed point, but it was derived from an
unplanned reconciliation rather than a designed experiment, and the two plans differ in several
respects. It is the strongest available reading, not a measured rule.

**Follow-up P1-07 (already scheduled) now has a specific hypothesis to falsify:** pay a card
*less* than the payment category holds (expect no income change), then *exactly* the balance
(expect none), then *more* (expect income to fall by the overshoot only, not the whole
payment). Until that runs, R60 is provisional and must not be encoded in a fixture.

## Engine consequences

1. Reconciliation is a bulk state transition over cleared rows plus at most one generated
   transaction — it belongs in the command layer as a single atomic operation, and the
   `reconciliation` table in §3 should record `prior_cleared_balance` so the adjustment is
   reproducible after the fact.
2. R56 means `reconciled` cannot be set at entry time. The register's cleared toggle is
   tri-state for display but only the reconcile flow may write `reconciled`.
3. R57's payee is a **real payee row**, so our `payee.internal_kind = 'reconciliation_adjustment'`
   must still be a normal, listable payee — not hidden from the payee list.
