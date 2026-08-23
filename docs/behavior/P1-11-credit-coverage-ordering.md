# P1-11 — Coverage ordering when a category funds multiple cards

- **Status:** RESOLVED (one residual ambiguity, noted below and judged low-impact).
- **Evidence class:** CONSTRUCTED. Each sub-test makes the candidate rules disagree, so the
  observed result eliminates rather than merely fits.
- **Source:** YNAB plan `11856695…`, constructed 2026-08-22 via API v1.
  Raw results: `_raw/p1-11-results.json`, `_raw/p1-11-t4.json`.
- **Units:** milliunits.

## Question

When one category holds insufficient funds and has charges on more than one credit card
(and possibly cash), in what order is available money consumed, and which card's payment
category receives the coverage?

Candidate rules going in: transaction date order · charge amount (largest first) ·
transaction creation order · account order · cash-before-credit.

## Method

Two fresh credit cards with zero balance ("ZFX Card A", "ZFX Card B") so their payment
categories start at 0 and contain only experimental coverage. Four categories, each assigned
exactly 50000, each deliberately overspent. Payment-category deltas read after each sub-test.

## T1 — date order vs. amount order

Entry order and amount order both point to Card A; date order points to Card B.

| account     | date       | amount  | created | properties            |
|-------------|------------|---------|---------|-----------------------|
| ZFX Card A  | 2026-08-20 | -60000  | first   | later date, larger    |
| ZFX Card B  | 2026-08-10 | -20000  | second  | earlier date, smaller |

| prediction    | ΔpayA | ΔpayB |
|---------------|-------|-------|
| amount order  | 50000 |     0 |
| date order    | 30000 | 20000 |
| **observed**  | **30000** | **20000** |

**→ Date order wins. Amount is not a factor.**

## T2 — creation order vs. account order (date and amount tied)

| account     | date       | amount  | created |
|-------------|------------|---------|---------|
| ZFX Card B  | 2026-08-15 | -40000  | **first**  |
| ZFX Card A  | 2026-08-15 | -40000  | second  |

| prediction              | ΔpayA | ΔpayB |
|-------------------------|-------|-------|
| transaction creation order | 10000 | 40000 |
| account order (A before B) | 40000 | 10000 |
| **observed**            | **40000** | **10000** |

**→ Not transaction creation order.** Card A won despite its transaction being entered second.

## T3 — cash priority vs. date order

The cash charge is 10 days *later* and entered *second*; the card charge is earlier and first.

| account     | date       | amount  | kind   |
|-------------|------------|---------|--------|
| ZFX Card A  | 2026-08-10 | -40000  | credit |
| Checking    | 2026-08-20 | -30000  | cash   |

| prediction        | ΔpayA | category balance |
|-------------------|-------|------------------|
| pure date order   | 40000 | -20000 |
| cash priority     | 20000 | -20000 |
| **observed**      | **20000** | **-20000** |

**→ Cash spending consumes available before credit spending, overriding date order.**
Note both hypotheses leave the category at -20000; only the payment-category delta
discriminates. Reading the category balance alone would have been uninformative.

## T4 — isolating the same-date tiebreak

A third card, "ZFX Card 0", named to sort alphabetically *before* "ZFX Card A" and created
*last*. Its uuid also happens to be lexically smaller (`0e193a91…` < `79feea1d…`).

| account     | date       | amount  | created | name sort | id sort |
|-------------|------------|---------|---------|-----------|---------|
| ZFX Card A  | 2026-08-15 | -40000  | earlier | second    | larger  |
| ZFX Card 0  | 2026-08-15 | -40000  | **last**   | **first**    | **smaller** |

Observed: **ΔpayA = 40000, Δpay0 = 10000** — Card A covered first.

**→ Eliminates account name, account uuid, and transaction creation order.**
The surviving explanation is **account creation / sort order**.

## Rules

- **R6 — Date order.** Within a category, spending consumes available in transaction date
  order, earliest first. Charge amount is irrelevant.
- **R2 — Cash before credit (confirmed in isolation).** All cash spending consumes available
  before any credit spending is covered, regardless of date. Two-tier: cash first (in date
  order among themselves), then credit (in date order, tiebroken by R7).
- **R7 — Same-date tiebreak is account order,** not transaction creation order, not account
  name, not account id.
  > **SUPERSEDED by [R7′](P1-12-coverage-tiebreak.md).** The transaction ids were never recorded
  > here, and with two candidates per round, id order had an even chance of agreeing with
  > account order in both T2 and T4. P1-12 constructed the discriminating case: coverage follows
  > the **transaction id**, ascending. T1 and T3 — date beats amount, and cash before credit —
  > are unaffected.

## Residual ambiguity

Account **creation order** and account **sort_order** are confounded: sort order defaults to
creation order, and the API exposes no way to reorder accounts (`SaveAccount` has no
`sort_order` field), so separating them requires drag-and-drop in the web UI.

**Chosen interpretation:** order by the user-visible `account.sort_order`, falling back to
creation order. This is the more principled reading — it matches what the user sees — and the
two coincide unless someone reorders their sidebar. To manifest a difference at all you would
need a reordered sidebar *and* a category with same-date charges on two cards *and*
insufficient funds. Recorded in `docs/adr/` rather than left implicit; revisit if a UI-based
reorder test is ever run.

## Consequence for the engine

Coverage is **order-dependent**, so `LedgerEntry` streams must be sorted deterministically
before the fold, by: `(isCash desc, date asc, accountSortOrder asc, id asc)`. The final `id asc`
is ours, not YNAB's — a total order guard so the engine is deterministic even when every
prior key ties. This belongs in `advance()` as a precondition, and gets a property test
asserting that shuffling the input never changes the output.

## Fixtures

- `p1-11-t1-date-order.json`
- `p1-11-t2-account-order.json`
- `p1-11-t3-cash-priority.json`
- `p1-11-t4-tiebreak.json`
