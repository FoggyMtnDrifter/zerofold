# P0-04 — Future-dated transactions (and future income)

- **Status:** BLOCKED as designed → **converted into a structural finding.** The original
  question is untestable through the API because the entity it assumed does not exist.
- **Evidence class:** CONSTRUCTED (negative result).

## Original question

Does income dated in a future month count toward the current month's Ready to Assign?

## What happened

    POST /plans/{id}/transactions
    { "transaction": { "date": "2026-09-15", "amount": 500000, ... } }

    → 400 Bad Request
      { "error": { "id": "400", "name": "bad_request",
                   "detail": "date must not be in the future or over 5 years ago" } }

**YNAB's API refuses to create a transaction dated in the future, at all.**

## The finding

A future-dated entry is not a `transaction` in YNAB's model — it is a
`scheduled_transaction`. This is why `scheduled_transaction` exists as a separate entity with
its own `date_first` / `date_next` rather than being a flag on `transaction`. The register's
"upcoming" rows are scheduled occurrences, not stored transactions.

It also establishes a **validity window on `transaction.date`**: not in the future, and not
more than roughly five years in the past.

## Consequences for our model

1. **Product decision required — flagged for review.** Our §3 schema places no bound on
   `transaction.date`. We can either (a) mirror YNAB and reject future dates, auto-promoting
   such an entry to a scheduled transaction, or (b) permit them and diverge.
   **Recommendation: mirror YNAB (a).** Permitting future-dated transactions would put money
   into account balances that has not moved yet, and every balance and reconciliation
   invariant would need a "as of date" qualifier. The cost of divergence here is high and the
   benefit is nil.
2. The R8 income term `Σ income(months ≤ M)` is, for regular transactions, equivalent to
   `Σ income(all months)` — because income strictly after M cannot exist as a transaction.
   The distinction only becomes observable via a scheduled transaction that auto-enters. The
   engine should still implement the `≤ M` form, which is correct under both readings.
3. The lower bound ("over 5 years ago") is a YNAB-specific validation, not a modelling
   constraint. **Recommend not replicating it** — a self-hoster importing a decade of history
   is a legitimate case, and our importers must not choke on it. Log as a divergence.

## Follow-up

**P0-04b** — create a scheduled transaction dated in a future month via
`POST /scheduled_transactions`, let it auto-enter, and confirm whether its income counts
toward RTA before the entry date. This is the only remaining route to the original question.
