# P3-06 / P3-07 — Transfers to tracking accounts, and splits containing transfers

- **Status:** RESOLVED.
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p3-06.json`, `_raw/p3-07.json`.
- **Units:** milliunits.

## P3-06 — Transfer categorisation depends on the *destination's* budget status

Two transfers out of the same on-budget checking account, both submitted **with a category**:

| destination | type | `on_budget` | category submitted | **category stored** | category activity |
|-------------|------|-------------|--------------------|---------------------|-------------------|
| ZFX Tracking | `otherAsset` | **false** | A2 | **A2 — kept** | **−50000** |
| ZFX Visa | `creditCard` | true | A2 | **`null` — stripped** | 0 |

### R44 — On-budget → tracking transfers are categorisable and are real spending

The category survives and the category's `activity` moves by the full amount. Money leaving the
budget for a tracking account is spending, exactly as the plan's §3 assumed.

### R45 — On-budget → on-budget transfers have their category silently stripped

The API returned **201 with `category_id: null`**. No `400`, no warning, no indication that the
submitted category was discarded. A client that posts a categorised transfer between two budget
accounts gets a success response describing something different from what it asked for.

We must reproduce the stripping for compatibility, but should **log it** rather than discard
silently, and our own UI should not offer a category in that case at all.

## P3-07 — Splits containing a transfer leg

One parent of −100000 in Checking with two subtransactions:

| # | amount | category | transfer_account | transfer_transaction_id |
|---|--------|----------|------------------|-------------------------|
| 1 | −60000 | **A2** | null | null |
| 2 | −40000 | null | **ZFX Tracking** | **set** |

- Sum of subs = **−100000** = parent amount ✓
- A2's activity moved by **−60000** — the categorised leg only. The transfer leg contributed
  nothing to any category.
- A real transaction appeared in ZFX Tracking: **+40000**, payee `Transfer : Checking`, carrying
  the *subtransaction's* memo, with `category_name: "Uncategorized"`.

### R46 — A split subtransaction can be a transfer, and it creates a full linked transaction

The far side is an ordinary top-level transaction in the other account, not a subtransaction.
So one split parent can spawn several independent transfer partners, each needing its own pair
consistency check. The plan's §3 anticipated this; it is confirmed.

### R47 — ⚠ A split parent carries a *phantom* category id

    parent.category_id   = "22c4e363-…"
    parent.category_name = "Split"

**That id is not present in `plan.categories`, and not in `month.categories`.** It resolves to
nothing. Any client that joins `transaction.category_id` against the category list gets a
dangling reference for every split parent in the plan.

This **corrects the plan's §3 invariant**, which stated `if is_split then category_id IS NULL`.
It is not null. Our options:

1. Mirror YNAB exactly — emit a stable phantom id with `category_name: "Split"` — for
   compatibility with existing clients that already tolerate it.
2. Emit `null` and diverge.

**Recommendation: mirror (1).** Existing YNAB tooling has been written against this shape for
years; emitting `null` would be a subtle behavioural difference in a field that clients switch
on. Internally the split parent still stores no real category — the phantom is a
presentation-layer constant at the API boundary, not a row in our `category` table.
**Logged as a divergence-avoidance decision, needs an ADR before M2.**

## R48 — The internal category set is smaller than assumed

`category.internal = true` holds for exactly two categories in a fresh plan:

| name | group |
|------|-------|
| **Inflow: Ready to Assign** | Internal Master Category |
| **Uncategorized** | Internal Master Category |

The plan's §3 listed `inflow_rta` and `deferred_income`. **There is no "Deferred Income"
category** in a current plan — but there *is* an `Uncategorized` one, which §3 did not model
and which the far side of every transfer reports as its `category_name`.

`internal_kind` should therefore be: `inflow_rta` | `uncategorized` | `credit_card_payment`,
with `deferred_income` dropped unless it turns up on an older plan.

## Engine consequences

1. The "is this leaf spending?" predicate is **not** `category_id != null`. It is
   `category_id != null AND category is not internal`. The `Uncategorized` internal category is
   a real id that must not be treated as a spending category.
2. Transfer categorisation validity depends on `account.on_budget` of the **destination**, which
   can change when an account is edited. Re-validating existing transfers on an account's
   budget-status change is a migration path the plan did not consider — **flagged for M2**.
3. Split parents must be excluded from category activity aggregation entirely; only leaves
   count. Summing parents *and* leaves would double every split.
