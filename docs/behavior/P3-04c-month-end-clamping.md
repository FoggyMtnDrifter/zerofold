# P3-04c — Month-end clamping for scheduled transactions

- **Status:** ⏳ **PLANTED, NOT YET READABLE.** The experiment exists in the oracle and can be
  read on or after **2026-09-01**.
- **Blocks:** M6. Not M2–M5.

## The question

A monthly schedule on the **31st** has to resolve September, which has 30 days. Three plausible
behaviours:

| behaviour | September occurrence |
|-----------|---------------------|
| clamp to the last day | 2026-09-30 |
| overflow into the next month | 2026-10-01 |
| skip the month entirely | none; next is 2026-10-31 |

They differ for roughly a third of all months, and picking wrong misplaces a recurring bill by
a day or a month, every year, silently.

## What the public record says: nothing usable (searched 2026-08-24)

Before shipping M6 I looked for a documented answer rather than waiting.

- **YNAB's own documentation does not cover it.** Neither the scheduled-transactions guide nor
  the editing guide mentions short months at all.
- **One relevant community thread exists**, "Recurring payments — Last day of month" (2018). It
  could not be fetched directly (the host refused the connection), and two independent search
  summaries of the same page contradicted each other — one describing a permanent drift to the
  28th, the other saying a series that *starts* on a 31-day month "works". A pair of
  contradictory second-hand summaries of one inaccessible page is not evidence, and the actual
  complaint in that thread appears to be a different feature request: there is no way to express
  "the last day of the month", as distinct from a fixed day number.
- **The relevant standard does something different again.** RFC 5545 says recurrence instances
  falling on invalid dates "are ignored" — so `FREQ=MONTHLY;BYMONTHDAY=31` produces *no*
  February occurrence at all. Compliant calendar libraries skip.

So all three candidate behaviours are attested somewhere in the wild, and none of it is evidence
about *this* application. The measurement still has to be taken.

## The provisional choice, and why

M6 ships **clamp to the last day, anchored on the original day** — 31 Jan, 28 Feb, 31 Mar. Not
because it is most likely, but because it fails safest while the question is open:

| if we do this | and the oracle actually … | the user sees |
|---------------|---------------------------|---------------|
| **clamp + anchor** | skips | an extra unapproved February row — visible, one click to remove |
| skip | clamps | a missing rent payment — invisible, and the budget understates spending |
| clamp + drift | anchors | the bill silently walks earlier every short month — invisible and compounding |

Only the first leaves a mistake the user can see. It also matches what the *domain* means:
rent does not skip February.

When P3-04c is read, if it confirms clamp-and-anchor the provisional markings come out. If it
shows drift or skip, the choice gets weighed then with the measurement in hand — matching the
oracle is the default, and a divergence recorded if the measured behaviour would silently
misplace someone's rent.

## Why it cannot be read today

`date_next` reports **only the next occurrence** ([R50](P3-04-05-scheduled-transactions.md)),
and it is stored state advanced by auto-entry rather than a projection. The register's upcoming
section likewise shows one row per schedule. So observing a *second* occurrence requires the
first one to actually elapse — there is no query that projects forward.

Nor can the question be dodged by starting in the past: scheduled transactions reject a date
more than **one week** before today (R49), and no 29th, 30th or 31st falls inside that window
from 2026-08-23.

## What has been planted

Five schedules were created in `zf-exp-p0` on 2026-08-23, all dated in the near future so that
auto-entry advances each pointer once its date passes:

| `date_first` | frequency | what its `date_next` will reveal |
|--------------|-----------|----------------------------------|
| 2026-08-31 | `monthly` | **the answer** — 09-30 clamps, 10-01 overflows, 10-31 skips |
| 2026-08-30 | `monthly` | control: September *has* a 30th, so this must be 2026-09-30 |
| 2026-08-31 | `everyOtherMonth` | October has a 31st, so a clamp must not persist as a 30th |
| 2026-08-31 | `yearly` | August 2027 has a 31st — same question across a year |
| 2026-08-29 | `monthly` | the case that will matter for February |

The control row is the important one: if the 30th-monthly schedule *also* lands somewhere
unexpected, the reading is measuring something other than clamping.

## How to read it

    node docs/behavior/_pending/p3-04c-read.mjs

on or after 2026-09-01, against the same plan. Both the planting and reading scripts are kept
in `_pending/` so the experiment is reproducible rather than a note saying "check this later".

## Interim position

**No interpretation has been adopted, and none should be.** Clamp-to-last-day is the common
convention and the likeliest answer, but M6 is far enough out that guessing buys nothing —
and this is precisely the kind of rule that looks right in a demo and is wrong for February.

If the oracle lapses before this is read, the fallback is to implement clamp-to-last-day and
record it as an **unverified assumption** in `divergences.md`, flagged for correction if it is
ever contradicted.
