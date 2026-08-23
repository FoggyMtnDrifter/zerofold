# Deliberate divergences from YNAB

Silent divergence is a bug. Every intentional difference is recorded here with its rationale.

| # | Area | YNAB | Zerofold | Rationale | Source |
|---|------|------|----------|-----------|--------|
| D1 | Transaction date lower bound | Rejects dates more than ~5 years old | No lower bound | Importing a decade of history from another tool is a first-class use case for a self-hosted app; our importers must not choke on it | [ADR-0007](../adr/0007-no-future-dated-transactions.md) |
| D2 | Target storage | One mutable goal per category | Revisions with `effective_from_month` | Makes a past month's "needed" reproducible, which the golden-file tests depend on. The compat API projects the revision effective at the requested month, so clients see no difference | plan §3 |
| D3 | Scheduled transactions | No end conditions or per-occurrence edits in the API | `end_date`, `end_after_occurrences`, and `scheduled_transaction_exception` exposed as documented extensions | The capabilities exist in YNAB's UI but not its API; hiding them from our own API would be an arbitrary limitation | plan §3 |
| D4 | Transfer pairing | Two rows linked by mutual `transfer_transaction_id` | Same, plus a `transfer_pair_id` identical on both legs | Avoids a circular FK (and the Postgres-only `DEFERRABLE` needed to express it) and makes "fetch the other leg" a single indexed lookup | plan §3 |
