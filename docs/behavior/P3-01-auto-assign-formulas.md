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

## R42 — The averaging formula

    window            = the 12 calendar months preceding the viewed month, [M−12 … M−1]
    n                 = count of months *within that window* that have data for the category
    averageAssigned(M) = Σ budgeted(window)  / n
    averageSpent(M)    = Σ −activity(window) / n

Verification on the final state (viewed month = 2026-08):

- Window is **2025-08 … 2026-07**.
- June 2025 assigned 12,800,000 — **outside** the window, excluded. This is what rules out
  "average over all history" (which would give ÷8 = 3,187,500).
- Inside the window, only Jan–Jul 2026 carry data → **n = 7**, not 12. This is what rules out
  dividing by the full window length (÷12 = 1,058,333).
- 12,700,000 ÷ 7 = **1,814,286** ✓  and 1,270,000 ÷ 7 = **181,429** ✓

Both averages use the same window and the same divisor.

### Residual ambiguity

"Months with data inside the window" and "months from the category's first in-window month
through M−1" both yield 7 here. They diverge only for a category with a **gap** in its history
— funded in January, nothing in February, funded again in March. **Follow-up P3-01b:** leave a
deliberate hole and see whether the divisor counts it.

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
