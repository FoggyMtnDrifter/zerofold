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

### R67 — AoM rounds half-up (P3-02b)

A third income bucket and a thirteenth spend were added so the last-ten mean lands on exactly
**36.5**, which floors to 36 and rounds-half-up to 37.

    FIFO ages: 70 71 72 73 30 31 32 33 34 35 36 37 24
    last ten : 73 30 31 32 33 34 35 36 37 24  → sum 365 → mean 36.5
    observed : 37

**Round-half-up.** Note this is a *third* rounding rule, distinct from both of the target ones:

    goal_under_funded        → ceil to the cent      (R28)
    goal_percentage_complete → floor to a percent    (R34)
    age_of_money             → round half up to a day (R67)

There is no single rounding helper that satisfies all three, and reaching for one would be
wrong on two of them.

## R68 — Credit *purchases* do not count; card *payments* do (P3-02c)

Three categorised purchases were added on a credit card, then three payments to that card.

| action | `age_of_money` |
|--------|----------------|
| baseline | 37 |
| + 3 credit-card **purchases** | **37 — unchanged** |
| + 3 **payments** to that card | **23** |

A credit purchase does not move money, so it is not spending; it creates debt. The money leaves
when the card is paid, and that is the event Age of Money counts.

This is coherent with the metric's own definition — *"how long money sits in your account(s)
between earning and spending it"* — and with [R60′](P1-07-paying-a-credit-card.md), where paying
uncovered debt is what draws on Ready to Assign. Both rules treat the payment, not the purchase,
as the moment money actually leaves.

### Open — an exhausted FIFO queue

At the point the payments were made, cumulative spending already equalled cumulative income, so
the three payments had no income left to match against, and the resulting figure implies they
were assigned an age near **zero**. Whether unmatched spending takes age 0, is skipped, or
consumes some other bucket is **not determined** — the experiment was not built to separate
those. **Follow-up P3-02d**, and it matters: a plan that has spent more than it has earned is
not an unusual state.

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
