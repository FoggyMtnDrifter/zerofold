# ADR-0004 — Money is integer milliunits

- **Status:** Accepted (2026-08-22)

## Decision

All money is an integer number of **milliunits** — 1 currency unit = 1000 milliunits, so
10 milliunits = 1 cent. Stored as SQLite `INTEGER` (64-bit signed), carried in TypeScript as
`bigint` behind a branded `Milliunits` type. Formatting to a display string happens only at the
UI boundary.

Not `numeric`: it returns a string in every driver and invites a `parseFloat` somewhere at 2am.
Not `number`: milliunits exceed `Number.MAX_SAFE_INTEGER` past ~9 trillion currency units, and
more importantly a float type in a money position is a latent bug even when the values are small.

## Rounding is not one rule

Two derived figures round in **opposite directions**, and this is deliberate on YNAB's part:

    goal_under_funded        → ceil, to the nearest cent   (R28)
    goal_percentage_complete → floor, to a whole percent   (R34)

"How much you still need" rounds **up** so following a target never leaves a shortfall.
"How far along you are" rounds **down** so progress is never overstated. Both err against the
user's optimism.

Therefore `packages/shared/money.ts` exposes `ceilToCent` and `floorToPercent` named for their
**direction, not their field**. A single shared `round()` applied to every derived goal field
would be wrong on one of them by one unit — invisible in casual testing, permanently wrong in a
golden fixture.

`divideCeilToCent` is a **fused** operation for the same reason: dividing first and then
ceiling discards the sub-milliunit remainder, yielding 0 where the oracle returns 10.

## Consequences

- JSON has no bigint. The compat API emits numbers (as YNAB does) with a safe-range assertion;
  internal transport encodes as strings.
- Arithmetic operators on raw bigints outside `packages/shared/money` are a lint error.
