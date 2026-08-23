# P1-04b — A refund larger than the overspend

- **Status:** RESOLVED. Completes [R62](P1-02-04-05-06-credit-card-mechanics.md).
- **Evidence class:** CONSTRUCTED. **Units:** milliunits.

## Setup

A clean credit card. Category funded 50000, charged 80000 — so 50000 of the debt is covered
and 30000 is not. Then refunded **60000**, which is more than the 30000 overspend and therefore
pushes the category positive.

| step | category balance | payment category | card balance |
|------|------------------|------------------|--------------|
| assigned 50000 | 50000 | 0 | 0 |
| charged 80000 | **−30000** | **50000** | −80000 |
| refunded 60000 | **+30000** | **20000** | −20000 |

## R69 — A refund pays down uncovered debt first, then covered debt

The refund did two things in order:

1. cleared the **30000 of uncovered debt**, taking the category from −30000 to 0
2. reduced **covered debt** by the remaining 30000, and that money went back to the category,
   taking it from 0 to +30000 while coverage fell 50000 → 20000

The invariant that holds throughout is simply:

    payment category balance == the covered portion of the remaining card debt

Card debt ended at 20000 and coverage at 20000 — the whole remaining balance is now covered,
which is correct, because everything still owed was funded by a category.

## Engine consequence

A refund cannot be modelled as "negative spending applied to the category". Doing so would
leave the category at +30000 **and** coverage at 50000, claiming 50000 set aside against a
20000 debt — money conjured out of a return. The refund has to walk the same
covered/uncovered split that [R60′](P1-07-paying-a-credit-card.md) uses for payments, in the
opposite direction.
