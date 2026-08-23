# P3-08 — Fresh Start

- **Status:** RESOLVED.
- **Evidence class:** CONSTRUCTED — run against `zf-exp-aom`, which had 27 transactions, two
  accounts, 14 categories and three months of history.

## What it is

A way to start planning from today without rebuilding a plan by hand: the structure you have
built up is carried forward and the history is left behind.

## R70 — Fresh Start creates a new plan and archives the original

The live plan afterwards has a **new id**. The original keeps its id and is **renamed**:

    zf-exp-aom  →  "zf-exp-aom (Archived on 2026-08-23)"

Nothing is deleted. This is worth stating precisely because the dialog's wording ("a copy of
this plan will be archived") suggests the opposite of what happens: the *original* becomes the
archive, and the *fresh* plan is the new object.

**Consequence for the compatibility API:** any external reference to the plan id — a script, a
dashboard, a saved bookmark — continues to resolve, but now points at the **archive**, not at
the plan the user is actually using. Anything integrating by plan id silently starts reading a
frozen copy. Our own implementation should surface this, and our importer should treat an
archived plan as such rather than as a live one.

## Carried into the fresh plan

Verified against the API:

| | outcome |
|--|---------|
| accounts | **carried**, with **balance 0** |
| category groups and categories | **carried** — all 14 |
| targets | carried (per the dialog; this plan had none to observe) |
| payees, including transfer and system payees | **carried** |
| scheduled transactions | dialog says carried; **untested** — this plan had none |
| transactions | **not carried** — only the two $0 starting balances |
| `first_month` | **reset** to the current month (2026-06-01 → 2026-08-01) |
| income / budgeted / Ready to Assign | **0** |
| `age_of_money` | **null** — back under the 10-transaction floor (R65) |

The dialog distinguishes linked from unlinked accounts: a linked account carries today's
balance and today's transactions, while an **unlinked account starts at $0** for the user to
update. Every account here was unlinked, so only the $0 case was observed. Bank linking is
out of scope for v1, so the unlinked case is the one that matters to us.

## What the archive retains

Transaction histories and category amounts — i.e. everything the fresh plan dropped. The two
together are lossless: nothing is destroyed, it is partitioned.

## Engine consequences

1. Fresh Start is **copy-structure-then-reset**, not a mutation. It belongs in
   `packages/commands` as a command that reads one plan and writes another, and it should be
   expressible through the same canonical intermediate representation as export/import — it is
   the same operation with the ledger filtered out.
2. Because the original is retained intact, this is one of the few genuinely non-destructive
   "destructive" operations, and should be presented that way. Unlike account deletion (D6) it
   does not need a typed-name confirmation.
3. `plan.archivedAt` needs to exist. The oracle encodes archival in the plan *name*, which is
   lossy and unparseable; we should store it as a field and leave the name alone.
