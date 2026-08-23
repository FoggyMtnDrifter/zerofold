# P0-C — Scheduled transactions, starting balances, account deletion, and tombstones

- **Status:** RESOLVED (P0-04b, P0-08b, P0-10, P0-11 — with one follow-up).
- **Evidence class:** CONSTRUCTED, in `zf-exp-p0` (`8aff3ff5…`).
- **Raw:** `_raw/p0-04b.json`, `_raw/p0-08b.json`, `_raw/p0-11.json`. **Units:** milliunits.

## P0-04b — Scheduled transactions do not participate in the budget

Created a one-time scheduled **income** of 500000 dated 2026-09-15 (`frequency: 'never'`).

    POST /scheduled_transactions  { date: '2026-09-15', amount: 500000, ... }  → 201

| | AUG | SEP | OCT |
|-|-----|-----|-----|
| RTA delta | **0** | **0** | **0** |
| income delta | **0** | **0** | **0** |

### R20 — A scheduled transaction has zero effect on RTA or income until entered

Scheduled transactions are pure projections. They do not contribute to any budget figure
before their occurrence is materialized into a real transaction.

This **closes the R8 income term**: since future-dated transactions cannot exist
([ADR-0007](../adr/0007-no-future-dated-transactions.md)) and scheduled ones do not count,
`Σ income(months ≤ M)` over stored transactions is complete and unambiguous.

It also **confirms the promotion path in ADR-0007 is what YNAB actually does**: the very date
that `POST /transactions` rejected with a 400 was accepted without complaint by
`POST /scheduled_transactions`.

### Incidental — scheduled transactions reject the Inflow category via API

    { category_id: <Inflow: Ready to Assign> }  → 400 "category is invalid"

Internal categories cannot be attached to a scheduled transaction through the API, even though
scheduled paychecks are a headline YNAB use case (the UI evidently uses another path).
**We should not replicate this restriction** — it appears to be an API validation gap rather
than a modelling rule. Candidate divergence; flagged, not yet logged, pending confirmation of
how the UI does it.

## P0-08b — Deleting a category that has transactions

Contrast with [P0-08](P0-B-assignment-ledger-hide-delete.md) (no transactions → money to Ready
to Assign). With transactions present, YNAB presents a **different, blocking dialog**:

> Before you can delete the category C4, you'll need to reassign your past activity to a new
> category. … All transactions [1] · All assigned amounts · Any remaining available amount

The target selector offers **only real categories** — Ready to Assign is *not* an option, and
hidden categories are excluded. Delete stays disabled until one is chosen.

C4 held `budgeted 50000, activity -30000, balance 20000` and one transaction. Target: Groceries
(previously all zeros).

| | before | after |
|-|--------|-------|
| Groceries `budgeted` / `activity` / `balance` | 0 / 0 / 0 | **50000 / -30000 / 20000** |
| the transaction's category | C4 | **Groceries** |
| AUG RTA | 900000 | **900000 (unchanged)** |
| AUG month `budgeted` | 350000 | **350000 (unchanged)** |

Ledger entry appended: `C4 → 🛒 Groceries  50000`.

### R21 — Two distinct deletion paths

| category has… | money goes to | ledger movement | RTA |
|---------------|---------------|-----------------|-----|
| no transactions | Ready to Assign | `C → «RTA»` | **increases** |
| ≥1 transaction | a required target category | `C → target` | **unchanged** |

Both are ordinary money movements — deletion is never a special case in the ledger. The
target category absorbs the deleted category's state exactly: assigned, activity, and
available all transfer intact.

## P0-10 — Starting balances

An account created with a non-zero balance produces a transaction with payee
**"Starting Balance"**, category **"Inflow: Ready to Assign"**, `cleared`, in the amount of the
opening balance. Creating the 250000 savings account moved AUG `income` from 1000000 → 1250000
and RTA from 700000 → 900000, and R8 continued to reconcile exactly.

### R22 — A starting balance on an on-budget account is income to Ready to Assign

### Timezone note — starting balances are stamped with the **UTC** date

The account was created at 02:50 UTC on 2026-08-23, while the user's local date was
2026-08-22. The Starting Balance transaction was dated **08/23/2026**. YNAB derived "today"
from UTC, not from the user's timezone.

This is a bug from the user's point of view — a transaction dated tomorrow — and it is
precisely the failure mode plan §4's calendar-date rule exists to prevent. **We resolve
"today" through the plan's IANA timezone, never UTC and never the server's locale.**
Candidate divergence; confirm the plan-settings timezone behaviour before logging.

## P0-11 — Deleting an account, and how deletions reach clients

Deleting the 250000 savings account:

| | before | after |
|-|--------|-------|
| AUG `income` | 1250000 | **1000000** |
| AUG RTA | 900000 | **650000** |
| AUG `budgeted` | 350000 | 350000 |
| live transactions | 4 | **3** |

R8 still holds: `1000000 − 350000 − 0 = 650000` ✓

### R23 — Deleting an account retroactively removes its transactions and its income

Including the starting balance. RTA falls accordingly. There is no tombstone transaction and
no adjusting entry — the income simply ceases to have existed.

### R24 — Soft delete, with tombstones visible only through delta requests

| request | result |
|---------|--------|
| `GET /accounts` | **1 account** — the deleted one is absent |
| `GET /accounts?last_knowledge_of_server=1` | **2 accounts** — including `ZFX Close Test` with `deleted: true` |

A full fetch omits deleted rows entirely; a delta fetch includes them as tombstones so a
syncing client can remove its local copy. **This is exactly the mechanism proposed in plan §3**
(soft delete plus `knowledge_at_change`), now confirmed against the real implementation rather
than inferred. Our compat API must reproduce both halves — a full fetch that leaks tombstones
would break every existing YNAB client.

### Open — "close" versus "delete" was not reachable

The Edit Account dialog offered **only "Delete Account"**; no "Close Account" control was
present, despite `account.closed` existing in the API. Most likely YNAB gates closing on a
zero balance. **Follow-up P0-11b:** zero an account's balance, then re-open the dialog and
check whether a Close option appears.

## Product notes (not YNAB rules — decisions for us)

1. **"Delete Account" executed immediately, with no confirmation step**, destroying an account
   and its transactions in one click. We will **not** replicate this: account deletion goes
   behind an `AlertDialog` requiring the account name to be typed, and is recorded in
   `audit_event`. Destroying financial history on a single misclick is indefensible in a tool
   whose whole promise is data ownership.
2. **Working Balance is directly editable** in the account dialog, with the note "An adjustment
   transaction will be created automatically if you change this amount." This is the
   `manual_balance_adjustment` payee from plan §3, confirmed. Worth keeping — it is a genuinely
   good affordance — but it should be visibly distinct from reconciliation.
