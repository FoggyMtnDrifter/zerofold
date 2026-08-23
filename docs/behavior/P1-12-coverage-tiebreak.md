# P1-12 — the same-date coverage tiebreak is the transaction id, not the account

- **Status:** RESOLVED. **Corrects R7** in [P1-11](P1-11-credit-coverage-ordering.md).
- **Evidence class:** CONSTRUCTED, as a deliberate falsification test, plus a retrodiction
  against the independent [P1-03](P1-03-credit-card-payment-coverage.md) observation.
- **Plan:** `zf-exp-fresh` (`c997a8c9…`), two cards created for this test.
- **Units:** milliunits.

## Why this experiment existed

Implementing coverage against R7 — *same-date ties break by account order* — failed to reproduce
P1-03. That plan has three categories charged on two cards on the same date, and R7 gets all
three wrong in either account order:

| category      | charges (same date)        | observed coverage    | R7 with Visa first | R7 with Amex first |
|---------------|----------------------------|----------------------|--------------------|--------------------|
| Entertainment | Visa 60000, Amex 20000     | Visa 50000, Amex 0   | Visa 50000, Amex 0 | Visa 30000, Amex 20000 |
| Vacation      | Visa 60000, Amex 20000     | Visa 50000, Amex 0   | Visa 50000, Amex 0 | Visa 30000, Amex 20000 |
| Stuff         | Amex 60000, Visa 20000     | **Amex 50000, Visa 0** | Visa 20000, Amex 30000 | Amex 50000, Visa 0 |

No single account order explains all three. The payment categories give the totals away:
observed Visa 120000 / Amex 50000; R7 predicts 140000 / 30000 or 80000 / 90000.

Sorting each contest by **transaction id** matches all three: Amex `03124c6d` < Visa `a576fe9e`
for Stuff, Visa `030aacb8` < Amex `ddbd88a1` for Entertainment, Visa `b84330e6` < Amex
`c65a1fb0` for Vacation.

P1-11 did not test this. Its T2 and T4 eliminated transaction *creation* order, account name and
account *uuid* — but the transaction ids were never recorded, and with two candidates each of
those rounds had an even chance of agreeing with id order regardless.

## The experiment

One category, two cards, **identical date and identical amount**, funded for exactly half the
total, so whichever card ends up covered is the one that went first. Repeated five times,
because which transaction receives the smaller id is a coin flip nobody controls.

| round | smaller id | covered first | id order predicts | account order predicts |
|-------|-----------|---------------|-------------------|------------------------|
| 0 | Card A | Card A | ✓ | ✓ |
| 1 | Card B | Card B | ✓ | ✗ |
| 2 | Card B | Card B | ✓ | ✗ |
| 3 | Card A | Card A | ✓ | ✓ |
| 4 | Card B | Card B | ✓ | ✗ |

**Transaction id ascending: 5/5. Account order: 2/5 — chance.**

With P1-03's three contests, that is 8 of 8 for the transaction id and 2 of 8 for account order.

## R7′ — a same-date tie is broken by transaction id, ascending

Superseding R7. The full coverage order within a category is:

    1. all cash spending first, regardless of date        (R2)
    2. then by transaction date, earliest first            (R6)
    3. then by transaction id, ascending                   (R7′)

R2 and R6 are unaffected; both were established by constructed tests that this does not touch.

## What this means for Zerofold

The *rule* is identical, the *ids* are not. Ours are uuidv7 and therefore time-ordered, so
"smallest id first" reads as "the charge entered first is covered first". The oracle's ids are
random, so the same rule there produces an order with no explanation available to the user.

We keep the rule and inherit the better behaviour from the id generator. It is a total order in
both cases, so the engine's determinism property — shuffling the input never changes the
output — holds either way. Recorded as a divergence in outcome, not in rule; see D11.

## The lesson, again

R7 fitted every observation P1-11 had. It was falsified by data that already existed in another
document, and neither noticed, because the two were never computed against each other. What
caught it was implementing the rule and running an *independent* observation through it.

This is the third time on this project: the auto-assign window (P3-01), R60 (P1-07), and now R7.
The pattern is identical each time — a rule that fits everything seen so far, and no one had yet
constructed the case where it would be wrong.
