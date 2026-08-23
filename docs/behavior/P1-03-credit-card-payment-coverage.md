# P1-03 — Credit card payment category coverage

- **Status:** RESOLVED. Aggregate rule confirmed to the milliunit; the ordering rule that this
  observation could not determine was settled by the constructed experiment in
  [P1-11](P1-11-credit-coverage-ordering.md).
- **Evidence class:** OBSERVED-NOT-CONSTRUCTED. This state was found in the test plan, not
  built to isolate a variable. Treat as strong evidence, not yet as specification.
  A constructed replication is required before the fixture is promoted to a contract.
- **Source:** YNAB plan `11856695…` ("Michael's Plan"), `server_knowledge: 76`, read
  2026-08-22 via API v1 (`GET /plans/{id}`).
- **Units:** milliunits throughout. 1000 = $1.00.

## Question

When a categorized purchase is charged to a credit card, exactly how much money moves into
that card's payment category, and what remains in the spending category?

## Observed inputs

### Accounts

| account  | type       | on_budget | balance    | cleared    | uncleared |
|----------|------------|-----------|------------|------------|-----------|
| Checking | checking   | true      |    870000  |   1000000  |  -130000  |
| Visa     | creditCard | true      |   -220000  |         0  |  -220000  |
| Amex     | creditCard | true      |   -100000  |         0  |  -100000  |
| Car Loan | autoLoan   | false     | -12000000  | -12000000  |        0  |

### Assignments (all in month 2026-08-01)

| category                    | budgeted |
|-----------------------------|----------|
| Groceries                   |   100000 |
| Dining out                  |    50000 |
| Entertainment               |    50000 |
| Vacation                    |    50000 |
| Stuff I forgot to plan for  |    50000 |
| **total**                   |   300000 |

### Transactions (all dated 2026-08-22 except starting balance 2026-08-21)

| account  | category                   | amount   | note              |
|----------|----------------------------|----------|-------------------|
| Checking | Inflow: Ready to Assign    |  1000000 | starting balance  |
| Visa     | Groceries                  |   -80000 |                   |
| Visa     | Groceries                  |   -60000 |                   |
| Visa     | Entertainment              |   -60000 |                   |
| Visa     | Vacation                   |   -60000 |                   |
| Visa     | Dining out                 |   -40000 |                   |
| Visa     | Stuff I forgot to plan for |   -20000 |                   |
| Amex     | Stuff I forgot to plan for |   -60000 |                   |
| Amex     | Vacation                   |   -20000 |                   |
| Amex     | Entertainment              |   -20000 |                   |
| Checking | Dining out                 |   -30000 | **cash** spending |
| Checking | (transfer → Visa)          |  -100000 | card payment      |
| Visa     | (transfer ← Checking)      |   100000 | card payment      |

## Observed outputs — month 2026-08-01

| field          | value    |
|----------------|----------|
| income         |  1000000 |
| budgeted       |   300000 |
| activity       |  -280000 |
| to_be_budgeted |   700000 |
| age_of_money   |     null |

| category                   | group                | budgeted | activity | balance |
|----------------------------|----------------------|----------|----------|---------|
| Groceries                  | Needs                |   100000 |  -140000 |  -40000 |
| Dining out                 | Wants                |    50000 |   -70000 |  -20000 |
| Entertainment              | Wants                |    50000 |   -80000 |  -30000 |
| Vacation                   | Wants                |    50000 |   -80000 |  -30000 |
| Stuff I forgot to plan for | Wants                |    50000 |   -80000 |  -30000 |
| Visa                       | Credit Card Payments |        0 |   120000 |  120000 |
| Amex                       | Credit Card Payments |        0 |    50000 |   50000 |
| Inflow: Ready to Assign    | Internal Master      |        0 |  1000000 | 1000000 |

## Inferred rules

- **R1 — Coverage.** A categorized charge on a credit card moves funds from the spending
  category into that card's payment category, capped at what the spending category has
  available. Uncovered charge amount stays as negative available in the spending category.
- **R2 — Cash before credit.** Within a category, cash spending consumes available *before*
  credit spending is covered, regardless of date. **Confirmed in isolation by P1-11 / T3.**
- **R3 — Payments reduce the payment category.** A transfer into a credit account decreases
  that card's payment category. Its `activity` is net of coverage and payments.
- **R4 — Credit overspending does not reduce Ready to Assign.** RTA = 1000000 − 300000 =
  700000 = `to_be_budgeted`, with no deduction for the 150000 of credit overspending.
- **R5 — `month.activity` excludes Inflow but includes payment categories.**
  −450000 (spending) + 170000 (payment cats) = −280000 ✓

## Verification arithmetic (exact, to the milliunit)

Per-category coverage, applying R1 + R2:

| category      | assigned | cash spend | credit spend        | covered → card      | remainder |
|---------------|----------|------------|---------------------|---------------------|-----------|
| Groceries     |   100000 |          0 | Visa 140000         | Visa 100000         |   -40000  |
| Entertainment |    50000 |          0 | Visa 60000/Amex 20000 | Visa 50000, Amex 0 |   -30000  |
| Vacation      |    50000 |          0 | Visa 60000/Amex 20000 | Visa 50000, Amex 0 |   -30000  |
| Stuff I forgot|    50000 |          0 | Amex 60000/Visa 20000 | Amex 50000, Visa 0 |   -30000  |
| Dining out    |    50000 |      30000 | Visa 40000          | Visa 20000          |   -20000  |

- Visa covered  = 100000 + 50000 + 50000 + 0 + 20000 = **220000**
- Visa payment category = 220000 − 100000 (payment transfer) = **120000** ✓ matches
- Amex covered = **50000**, no payment made = **50000** ✓ matches

**Conservation identity** (holds when no category retains positive available):

    Σ assigned  =  Σ cash spending  +  Σ credit covered
       300000   =        30000      +      270000        ✓

    Σ credit charges  −  Σ credit covered  =  Σ category overspend
          420000      −       270000       =       150000          ✓

Both identities are candidates for engine property tests.

## Open questions — all resolved

1. ~~Intra-category multi-card ordering.~~ **Resolved by P1-11.** Coverage follows transaction
   *date* order (not amount, not entry order), tiebroken by account order. Re-checking this
   observation against the P1-11 rules reproduces every figure: the ordering that the
   uncontrolled data merely *fit* is now the ordering that was independently *derived*.
2. ~~R2 (cash before credit) inferred from a single category.~~ **Resolved by P1-11 / T3**,
   where the cash charge was 10 days later and entered second yet still consumed first.
3. ~~Per-transaction running balance vs. aggregate per category.~~ **Resolved:** coverage is
   sequential against a running available balance. An aggregate model cannot produce the
   T1 split of 30000/20000.

## Schema corrections this observation forces

- `category_group.internal` is `true` for `Internal Master Category`, `Credit Card Payments`,
  and `Hidden Categories`.
- `category.internal` is `true` **only** for `Inflow: Ready to Assign`. Credit card payment
  categories report `internal: false` despite living in an internal group. Our compat API must
  reproduce this exactly; see the plan's §3 note on `internal_kind`.
- Payment categories carry `goal_target: 0` (not `null`) with every other `goal_*` field null.

## Fixture

`packages/budget-engine/test/fixtures/p1-03-credit-coverage.json` — ready to generate.
Retains value as an *integration* fixture: five categories, two cards, mixed cash/credit and a
card payment in one plan, exercising R1–R7 together rather than one rule at a time.
