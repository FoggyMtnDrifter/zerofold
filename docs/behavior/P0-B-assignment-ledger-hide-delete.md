# P0-B — The assignment ledger, hiding, and deleting categories

- **Status:** RESOLVED (P0-07, P0-08, P0-09).
- **Evidence class:** CONSTRUCTED, in `zf-exp-p0` (`8aff3ff5…`).
- **Raw:** `_raw/p0-money-movements.json`, `_raw/p0-09-hide.json`, `_raw/p0-08-delete.json`.
- **Units:** milliunits.

## P0-07 — Assignments are a money-movement ledger

`PATCH /months/{m}/categories/{id}` with `{budgeted}` **automatically writes a
`money_movement` record.** The ledger is not limited to the UI's explicit "move money" flow —
every assignment change produces one.

An assignment from nothing is recorded as a movement **from Ready to Assign**, encoded as
`from_category_id: null`:

| month | from | to | amount |
|-------|------|----|--------|
| 2026-09-01 | «Ready to Assign» | C2 | 300000 |
| 2026-09-01 | C2 | «Ready to Assign» | 300000 |
| 2026-08-01 | «Ready to Assign» | C1 | 100000 |
| 2026-08-01 | «Ready to Assign» | C3 | 5000000 |
| 2026-08-01 | C3 | «Ready to Assign» | 5000000 |

### R13 — The ledger is append-only and reconciles exactly to `budgeted`

Setting a category back to zero does **not** edit or delete the original movement. It appends a
**compensating movement in the opposite direction**. Reconciling
`Σ(into) − Σ(out of)` per `(month, category)` against the stored `budgeted`:

| month | category | Σ movements | budgeted | |
|-------|----------|-------------|----------|-|
| 2026-08-01 | C1 | 100000 | 100000 | ✓ |
| 2026-08-01 | C2 | 0 | 0 | ✓ |
| 2026-08-01 | C3 | 0 | 0 | ✓ |
| 2026-09-01 | C1 | 0 | 0 | ✓ |
| 2026-09-01 | C2 | 0 | 0 | ✓ |
| 2026-09-01 | C3 | 0 | 0 | ✓ |

Six of six exact. **This confirms the design proposed in plan §3** — `budgeted` as the scalar
truth with an append-only movement ledger written in the same transaction — rather than
leaving it as an assumption. The reconciliation above becomes an engine invariant test.

`money_movement_group_id` was `null` for every single-category API PATCH. Groups are presumably
formed by batch UI operations (auto-assign, multi-select). **Open:** confirm in P3-01.

## P0-09 — Hiding a category holding money

Hid C2 while it held 200000.

| property | before | after |
|----------|--------|-------|
| `hidden` | false | **true** |
| `deleted` | false | false |
| `category_group_id` | P0 | **P0 (unchanged)** |
| `original_category_group_id` | null | **null** |
| `budgeted` / `balance` | 200000 | **200000** |
| AUG RTA | 700000 | **700000** |
| SEP / OCT RTA | 660000 | **660000** |

### R14 — Hiding is a pure display flag

It releases no money, does not change RTA in any month, and does not interrupt carryforward —
C2 still shows `balance: 200000` in September and October.

**Schema correction.** Plan §3 assumed hiding relocates the category to a "Hidden Categories"
group, with `original_category_group_id` as the restore point. **It does not.** The category
stays in its own group and `original_category_group_id` remains null. The field exists in the
API and the "Hidden Categories" group exists in the default plan, but neither is used by this
operation — likely legacy. We should keep the column for compat-API fidelity but must not
depend on it.

### R15 — Group subtotals exclude hidden categories; month totals include them

With C2 (200000, hidden) and C3 (200000, visible) and C1 (100000, visible):

- P0 group header showed **assigned $300** — C1 + C3 only.
- "Assigned in August" summary showed **$500** — all three.

Two different aggregations over the same data. Both must be reproduced.

## P0-08 — Deleting a category holding money

Deleted C3 while it held 200000. YNAB's confirmation dialog states the rule outright:

> There is money currently assigned to C3. When you delete this category, all assigned amounts
> will be moved to Ready to Assign.

Observed:

| | before | after |
|-|--------|-------|
| C3 `deleted` | false | **true** |
| C3 `budgeted` / `balance` | 200000 | **0** |
| C3 in month `categories[]` | present | **absent** |
| AUG RTA | 500000 | **700000** |
| AUG month `budgeted` | 500000 | **300000** |

### R16 — Deletion returns assigned money to Ready to Assign, as a ledger movement

The delete appended `C3 → «Ready to Assign» 200000`. Deletion is not a special case in the
data model — it is an ordinary movement plus a `deleted` flag. The ledger remains the complete
record of where every dollar went.

### R17 — Soft delete, with different visibility in two places

A deleted category **remains** in `plan.categories[]` with `deleted: true` (required so delta
requests can report the deletion), but is **omitted entirely** from `month.categories[]`.
Our compat API must reproduce this asymmetry exactly.

> Note: plan §5 lists "delete with reassignment". Reassignment applies to the deleted
> category's **transactions**, not to its assigned money — that always returns to Ready to
> Assign. C3 had no transactions, so the transaction-reassignment path is still untested.
> **Follow-up: P0-08b** — delete a category that has transactions.

## Engine consequences

1. Implement assignment as `applyMovement(month, from, to, amount)` with `null` meaning Ready
   to Assign, and derive `budgeted` from it. Category deletion, "move money", and quick-budget
   actions all become the same primitive. This is simpler than the alternative and it is what
   YNAB actually does.
2. R13's reconciliation is a cheap, high-value invariant to assert continuously, not just in
   tests — it would catch an entire class of cache-drift bugs.
3. R14 means hidden categories participate fully in the fold; only presentation filters them.
   A `WHERE hidden = false` in the wrong query would silently corrupt RTA.
4. R15 means the budget view needs two distinct aggregations. Reusing one for both is a bug
   that would only show up on plans that actually have hidden categories.
