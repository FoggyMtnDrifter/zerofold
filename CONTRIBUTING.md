# Contributing to Zerofold

## Developer Certificate of Origin

Zerofold uses the [DCO](https://developercertificate.org/) rather than a CLA. Sign your work:

    git commit -s

which appends `Signed-off-by: Your Name <your@email>`. That line certifies you wrote the patch
or otherwise have the right to submit it under the project's licence. There is no copyright
assignment — you keep your copyright.

## Behaviour first

The budgeting rules in `docs/behavior/` are the specification. **No budgeting rule is
implemented from memory or assumption.**

If you are changing engine behaviour:

1. Find the rule in `docs/behavior/`. If it is not there, the rule is not yet known — establish
   it by experiment and write the document first.
2. A change in engine output means a change to a golden fixture. A fixture diff in a pull
   request needs an explanation in the description saying which rule changed and why.
3. When you form a rule, construct the case where it would be **wrong** and run that too. A rule
   that fits every observation you happen to have is not confirmed, only unfalsified — see
   `docs/behavior/P1-07-paying-a-credit-card.md` for a rule that survived five observations and
   was still false.

## Ground rules for the engine

`packages/budget-engine` has no dependencies, no I/O, and no clock. It takes `today` as an
argument. If you need the current date inside it, you have found a design error, not a missing
utility.

Money is integer milliunits as `bigint`. Dates are `YYYY-MM-DD` strings. Neither a float nor a
`Date` object belongs anywhere near a balance.

## Checks

    pnpm typecheck && pnpm lint && pnpm test

all of which run in CI on every pull request.
