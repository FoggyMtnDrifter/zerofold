# P3-02 — Age of Money

- **Status:** RESOLVED for the core formula. Cash-vs-credit treatment open.
- **Evidence class:** CONSTRUCTED in a **dedicated clean plan** (`zf-exp-aom`, `36f6aa08…`),
  designed so that four candidate formulas predict four different answers.
- **Units:** milliunits; ages in days.

## YNAB's own definition and threshold

From the Age of Money report, verbatim:

> *"Age of Money is how long, on average, money sits in your account(s) between earning and
> spending it."*
> *"YNAB needs a minimum of **10 transactions** to calculate your Age of Money."*

Two things fall out before any experiment: the metric is an **average**, and there is a hard
**10-transaction floor** below which it is not reported at all.

## The experiment

A clean plan, one checking account opened at **zero** so no starting balance pollutes income.

**Income — two distinct dates, creating two FIFO buckets:**

| date | amount |
|------|--------|
| 2026-06-01 | 100000 |
| 2026-07-15 | 200000 |

**Spending — twelve outflows of 25000, on consecutive days 2026-08-10 … 08-21.**

Under FIFO the first four spends (100000) draw the June bucket and the remaining eight draw the
July bucket, giving these ages in days:

    70, 71, 72, 73,   30, 31, 32, 33, 34, 35, 36, 37
    └── from Jun 1 ──┘ └────────── from Jul 15 ──────────┘

| candidate formula | predicted |
|-------------------|-----------|
| **mean of the last 10** | **41** |
| median of the last 10 | 34.5 |
| mean of all 12 | 46 |
| median of all 12 | 35.5 |

## Result

    2026-06-01   age_of_money: 0
    2026-07-01   age_of_money: 0
    2026-08-01   age_of_money: 41      ← mean of the last 10

## R65 — Age of Money is the mean FIFO age of the last ten spending transactions

    ages   = for each spending transaction, (spend date − date of the income that funds it,
             matched FIFO across income in date order)
    AoM(M) = round( mean( ages of the last 10 spending transactions up to and including M ) )

Two independent findings in one number:

1. **It is the mean, not the median.** The project plan §4 asked to *"verify whether YNAB uses a
   median of the last ten spending transactions."* It does not — 41 is the mean; the median is
   34.5. YNAB's own wording ("on average") agrees.
2. **FIFO matching is real.** Had spending been matched against the most recent income instead,
   every age would fall in 30–37 and the answer would be ~34, not 41. Producing 41 requires the
   first four spends to be attributed to the *June* bucket specifically.

Months before any spending report **0**, not null — `null` appears only when the 10-transaction
floor is unmet (as in `zf-exp-p0`, which has ample transactions but no positive income left to
match).

### Not yet discriminated

`413 / 10 = 41.3`, which both floors and rounds to 41. Whether AoM floors or rounds is
**undetermined**; a case landing on `.5` or above is needed. **Follow-up P3-02b.** Low stakes —
a one-day difference in a single display figure.

## Open — cash vs credit

The project plan §4 also asks how AoM treats credit spending. Every spend here was from a cash
account. Whether a credit-card purchase enters the "last 10" window at its purchase date, at
the date the card is paid, or not at all, is untested. **Follow-up P3-02c.**

## Engine consequences

1. AoM needs a **FIFO queue over income**, consumed by spending in date order — this is the
   `aom.fifo` field already reserved in `CarryState` (plan §4). It now has a defined
   consumption rule.
2. The queue must persist across months, since the August figure depends on June income. It
   cannot be computed from a single month's slice, and it must survive the gap-jump
   optimisation — an empty month neither adds to nor consumes the queue, so the transform stays
   idempotent and the optimisation holds.
3. The **10-transaction floor** is part of the contract: below it, emit `null`, not `0`. A plan
   with 9 spends must not report a number.
4. `age_of_money` is per month and monotonically re-derivable, so it belongs in the `month`
   cache alongside `income`/`budgeted`/`activity` — not computed on read.
