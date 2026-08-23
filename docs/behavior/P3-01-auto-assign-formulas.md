# P3-01 — The auto-assign (quick budget) actions and their windows

- **Status:** RESOLVED for the averaging window. Individual action semantics partly open.
- **Evidence class:** CONSTRUCTED, with **three rounds of escalating history** — see below.
- **Units:** milliunits.

## The action list — eight, not seven

| # | Action | Observed value in the test plan |
|---|--------|-------------------------------|
| 1 | Underfunded | $763.03 |
| 2 | Assigned Last Month | $400.00 |
| 3 | Spent Last Month | $40.00 |
| 4 | Average Assigned | $1,814.29 |
| 5 | Average Spent | $181.43 |
| 6 | **Reduce Overfunding** | $150.00 |
| 7 | Reset Available Amounts | $0.00 |
| 8 | Reset Assigned Amounts | $0.00 |

The project plan §4 listed seven and named the last two "reset to zero / reset to assigned".
**"Reduce Overfunding" was missing entirely**, and the reset actions are *Reset Available
Amounts* and *Reset Assigned Amounts*. Payment categories relabel #3 to **"Paid Last Month"**
(see [P2-07](P2-07-debt-targets-and-opening-debt.md)).

## Why this took three rounds — a cautionary record

The averaging window was measured three times and gave three different answers. Each earlier
answer was an **artefact of how much history existed**, and each looked convincing.

| history available | Σ assigned | observed Average Assigned | reading it appeared to support |
|-------------------|-----------|---------------------------|-------------------------------|
| May–Jul 2026 (3 mo) | 700000 | **233333** | "3-month window" — and ÷3 is exactly that |
| Feb–Jul 2026 (6 mo) | 6300000 | **1050000** | "6-month window" — and ÷6 is exactly that |
| Jan–Jul 2026 (7 mo) | 12700000 | **1814286** | ÷7 — so not a fixed 3- or 6-month window |
| + Jun 2025 (8 mo, one outside a 12-mo window) | 25500000 | **1814286 — unchanged** | **12-month window, ÷ months with data** |

Had I stopped after the first round I would have written down "3-month average" with a clean
verifying calculation behind it. The second round would have "corrected" it to 6-month, equally
cleanly. **Neither was right.** A formula's *window* cannot be measured with less history than
the window itself.

## R42 — The averaging formula (corrected by P3-01b)

    window   = the 12 calendar months preceding the viewed month, [M−12 … M−1]
    first    = the earliest month *within the window* that has data for the category
    n        = inclusive month span from `first` through M−1 — **empty months included**

    averageAssigned(M) = Σ budgeted(window)  / n
    averageSpent(M)    = Σ −activity(window) / n

> ⚠ The divisor is a **span**, not a count. An earlier draft of this rule said "count of months
> with data", which happened to agree on every observation available at the time because none
> of them had a gap. See the correction below.

Verification on the final state (viewed month = 2026-08):

- Window is **2025-08 … 2026-07**.
- June 2025 assigned 12,800,000 — **outside** the window, excluded. This is what rules out
  "average over all history" (which would give ÷8 = 3,187,500).
- Inside the window, only Jan–Jul 2026 carry data → **n = 7**, not 12. This is what rules out
  dividing by the full window length (÷12 = 1,058,333).
- 12,700,000 ÷ 7 = **1,814,286** ✓  and 1,270,000 ÷ 7 = **181,429** ✓

Both averages use the same window and the same divisor.

### The gap case, measured (P3-01b)

A category funded in **January and March only**, read from August 2026. The window is
Aug 2025 … Jul 2026, so the first in-window month with data is January.

| candidate divisor | value | predicted Average Assigned | predicted Average Spent |
|-------------------|-------|---------------------------|------------------------|
| count of months with data | 2 | $400.00 | $40.00 |
| Jan–Mar inclusive | 3 | $266.67 | $26.67 |
| **span Jan → Jul** | **7** | **$114.29** | **$11.43** |

Observed: **Average Assigned $114.29, Average Spent $11.43.**

**The divisor counts the empty months.** February contributed nothing to the numerator and
still lengthened the denominator, which is the behaviour that makes the average mean "what you
have typically assigned per month since you started using this category" rather than "the
average of the months you happened to use it".

Had this been implemented from the earlier reading, a category funded twice in seven months
would have reported an average **3.5× too high** — and the error grows with the size of the
gap, which is to say it is worst exactly for the sporadic categories where the figure is most
likely to be consulted.

## R43 — "Last Month" actions read the immediately preceding month only

`Assigned Last Month` = 400000 and `Spent Last Month` = 40000, both exactly July's figures,
while much larger values sat in earlier months. No averaging, no fallback to the most recent
month *with* data — just M−1.

## Engine consequences

1. The averaging window needs **12 months of history to reach past its own edge**, so the
   golden fixture for this rule must carry at least 14 months of data, including a month
   outside the window and an empty month inside it. A short fixture will pass against a wrong
   implementation.
2. `n` is a count of months *with data*, not the window length. Dividing by 12 is the obvious
   implementation and it is wrong for every category younger than a year — which is every
   category in a new plan, i.e. exactly the case a new self-hoster will see first.
3. These are **read-time** figures over a 12-month span. Computing them per category per month
   on demand is 12 row lookups; they should be derived from the same `month_category` rows the
   engine already materialises rather than a separate aggregate query.

## Open

- The exact semantics of **Reduce Overfunding**, **Reset Available Amounts**, and **Reset
  Assigned Amounts** (what they set, and whether they act on selection or whole plan) are not
  yet exercised — only their displayed amounts observed. **Follow-up P3-01c.**
- Whether `Underfunded` uses the same selection scope as the averages (it reported the same
  $763.03 plan-wide throughout) is untested.
