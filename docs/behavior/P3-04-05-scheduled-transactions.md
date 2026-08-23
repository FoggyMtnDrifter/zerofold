# P3-04 / P3-05 — Scheduled transaction date math and auto-entry

- **Status:** RESOLVED for all 13 frequencies and for auto-entry. Month-end clamping still open.
- **Evidence class:** CONSTRUCTED. **Raw:** `_raw/p3-04.json`.
- **Units:** milliunits. Observation date 2026-08-22 local / 2026-08-23 UTC.

## R49 — Scheduled transactions have the mirror-image date window

    POST /scheduled_transactions  { date: '2026-01-31' }
    → 400  "date must not be more than 1 week in the past or over 5 years in the future"

Compare the regular-transaction rule from [ADR-0007](../adr/0007-no-future-dated-transactions.md):

| entity | permitted dates |
|--------|-----------------|
| `transaction` | not in the future; not over 5 years **ago** |
| `scheduled_transaction` | not more than **1 week ago**; not over 5 years **ahead** |

The two windows are near-complements, overlapping by one week. This is strong corroboration of
ADR-0007's model: the past belongs to transactions, the future to schedules, and the one-week
overlap exists so a just-missed occurrence can still be scheduled.

## R50 — `date_next` is stored state, and the creation response is not settled

Every POST returned `date_next == date_first == 2026-08-16`, i.e. **unadvanced**, even though
that date was already six days past. Re-reading the same records shortly afterwards showed
`date_next` advanced correctly for all twelve recurring frequencies, matching the register's
projection exactly.

So `date_next` is **not** computed on read. It is a stored pointer advanced by the entry
process, and **the value in a creation response is provisional**. An importer or client that
trusts the POST response will hold a stale `date_next`.

Our implementation should either advance it synchronously within the creating transaction, or
compute it on read. Returning an unsettled value is a wart worth not copying — but note the
compat API must still *accept* clients that re-read.

## R51 — The twelve recurring periods

First occurrence 2026-08-16 in every case; `date_next` is the earliest occurrence **≥ today**.

| frequency | `date_next` | period |
|-----------|-------------|--------|
| `daily` | 2026-08-23 | +1 day (advanced to today; see note) |
| `weekly` | 2026-08-23 | +7 days |
| `everyOtherWeek` | 2026-08-30 | +14 days |
| `twiceAMonth` | **2026-09-01** | see R52 |
| `every4Weeks` | 2026-09-13 | +28 days |
| `monthly` | 2026-09-16 | +1 calendar month, same day-of-month |
| `everyOtherMonth` | 2026-10-16 | +2 months |
| `every3Months` | 2026-11-16 | +3 months |
| `every4Months` | 2026-12-16 | +4 months |
| `twiceAYear` | 2027-02-16 | +6 months |
| `yearly` | 2027-08-16 | +1 year |
| `everyOtherYear` | 2028-08-16 | +2 years |

> **Note on `daily`:** the raw day-delta from `date_first` is 7, but the period is 1 — the
> pointer simply skipped the six occurrences already past. Deriving a period from
> `date_next − date_first` is only valid when exactly one occurrence has elapsed. This is a
> trap for anyone reverse-engineering the rule from a single observation.

### R52 — `twiceAMonth` is a day-pair 15 days apart

From the 16th, the next occurrence is **the 1st of the following month**, not the 31st. The
series is the pair `{d, d−15}` for `d > 15` — here `{1, 16}` — so after the 16th comes the 1st.

**Open:** the behaviour for `d ≤ 15` (is the pair `{d, d+15}`?) and for `d` where `d+15`
overruns a short month are untested. **Follow-up P3-04b.**

## R53 — Auto-entry back-fills *every* missed occurrence, unapproved

Creating 13 schedules dated six days in the past produced **19 real transactions**:

    13  (one 2026-08-16 occurrence per frequency)
  +  6  (daily, for 08-17 … 08-22)
  = 19

Dates span 2026-08-16 through 2026-08-22 — one per elapsed daily occurrence. All were created
with **`approved: false`** and `cleared: 'uncleared'`, which is what drives the register's
*"20 new transactions to approve or categorize"* banner.

Two consequences:

1. **Auto-enter is the default** for schedules created through the API — there is no
   `auto_enter` field on `SaveScheduledTransaction`, so a client cannot opt out.
2. Back-filling is **not** limited to the most recent occurrence. A schedule that has been
   dormant across many periods will materialise all of them at once. Our scheduler must be
   idempotent across this — running it twice must not double-enter — which is precisely the M6
   acceptance criterion about catching up after downtime.

## R54 — A `never` schedule is consumed by its own entry

The `frequency: 'never'` record is **absent** from `/scheduled_transactions` afterwards — not
soft-deleted with `deleted: true`, simply gone. Its single occurrence was entered as a real
transaction and the scheduled record ceased to exist.

This is the mechanical form of ADR-0007's promotion path: a future-dated entry lives as a
`never` schedule until its date arrives, then becomes an ordinary transaction. It also means
**one-time schedules are not durable records** — anything wanting an audit trail of them must
capture it elsewhere.

> Note the inconsistency with [R24](P0-C-scheduled-accounts-deletion.md): deleted *accounts*
> remain queryable as tombstones through delta requests, but a consumed `never` schedule does
> not. A syncing client is told nothing about its disappearance beyond its absence. We should
> emit a proper tombstone here. **Divergence candidate — flagged, pending a delta-request check
> on scheduled transactions.**

## Open

- **Month-end clamping is untested.** A monthly schedule on the 31st must resolve February;
  whether YNAB clamps to the last day, skips, or drifts is unknown. The API cannot show it —
  `date_next` gives one step, and the register projects only the next occurrence. Requires
  either a schedule dated 2026-08-31 observed after 31 August, or the UI's own multi-occurrence
  projection if one exists. **P3-04c — the highest-value remaining scheduling question.**
- `auto_enter` vs approve-first cannot be set through the API; the UI toggle is untested.
- Editing a single occurrence vs the whole series is untested.
