# ADR-0007 — Transactions may not be dated in the future

- **Status:** Accepted (2026-08-22)
- **Context source:** [P0-04](../behavior/P0-04-future-dated-transactions.md)

## Context

YNAB's API rejects any attempt to create a transaction dated in the future:

    POST /plans/{id}/transactions  { "date": "2026-09-15", ... }
    → 400  "date must not be in the future or over 5 years ago"

A future-dated entry in YNAB is not a `transaction` — it is a `scheduled_transaction`. This
is why the two are separate entities rather than one entity with a flag, and why the
register's "upcoming" rows are scheduled occurrences rather than stored rows.

Our §3 schema placed no bound on `transaction.date`, so a decision was required before M2
builds the register.

## Decision

**Mirror YNAB. `transaction.date` may not be in the future, relative to the plan's timezone.**

1. The command layer rejects a future-dated transaction create/update with a typed validation
   error carrying the offending date and the plan's "today".
2. The register's entry flow **auto-promotes** a future-dated entry into a
   `scheduled_transaction` with `frequency: 'never'` and `date_first = date_next = <date>`,
   surfacing this to the user rather than doing it silently.
3. Editing an existing transaction's date into the future is the same promotion: the
   transaction is deleted and a scheduled transaction created, in one atomic command.
4. **We do NOT adopt YNAB's lower bound** ("over 5 years ago"). See divergence below.

## Rationale

Permitting future-dated transactions would put money into account balances that has not
actually moved. Every downstream invariant — account balance, cleared balance, reconciliation,
net worth, and the R8 Ready-to-Assign income term — would need an "as of date" qualifier, and
each of those qualifiers is a place to get it wrong. Reconciliation in particular becomes
incoherent: you cannot reconcile against a statement that includes transactions the bank has
never seen.

The benefit of diverging is nil. The user-facing capability people actually want — "record
this rent payment I know is coming" — is exactly what scheduled transactions provide, and
providing it twice, through two mechanisms with different semantics, is worse than providing
it once.

## Divergence from YNAB

**We accept transaction dates arbitrarily far in the past.** YNAB rejects dates more than
roughly five years old. That is a product-policy validation, not a modelling constraint, and
it is actively harmful for us: importing a decade of history from another tool is a first-class
use case for a self-hosted app, and our importers must not choke on it.

Logged in `docs/behavior/divergences.md`.

## Consequences

- `transaction.date <= plan_today()` is a command-layer invariant, checked in one place.
  It is **not** a database CHECK constraint — "today" is not a stable value, and a row that
  was valid yesterday must not become invalid overnight or on restore from backup.
- Importers must handle a source file containing future-dated rows. They promote them to
  scheduled transactions and record the promotion in the import's loss/transform report so
  the user is told, rather than finding out later.
- The R8 income term `Σ income(months ≤ M)` is unobservably equivalent to `Σ income(all)`
  for stored transactions, since income after M cannot exist. We still implement the `≤ M`
  form, which is correct under both readings and stays correct once scheduled transactions
  auto-enter. Confirming the auto-enter case is follow-up **P0-04b**.
