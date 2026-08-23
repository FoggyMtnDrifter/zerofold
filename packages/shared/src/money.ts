/**
 * Money is integer milliunits. 1 currency unit = 1000 milliunits, so 10 milliunits = 1 cent.
 *
 * Every value is a bigint. Floats never appear, and formatting to a display string happens
 * only at the UI boundary. See ADR-0004.
 */

declare const MilliunitsBrand: unique symbol

/** An integer number of milliunits. Construct with {@link milli} or {@link fromCents}. */
export type Milliunits = bigint & { readonly [MilliunitsBrand]: true }

export const ZERO = 0n as Milliunits

/** Milliunits per currency unit (dollar, euro, …). */
export const MILLI_PER_UNIT = 1000n
/** Milliunits per cent — the granularity YNAB quantises derived "needed" figures to. */
export const MILLI_PER_CENT = 10n

export function milli(value: bigint | number): Milliunits {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`milli() requires a safe integer, received ${value}`)
    }
    return BigInt(value) as Milliunits
  }
  return value as Milliunits
}

export const fromCents = (cents: bigint | number): Milliunits =>
  milli(BigInt(cents) * MILLI_PER_CENT)

export const add = (a: Milliunits, b: Milliunits): Milliunits => (a + b) as Milliunits
export const sub = (a: Milliunits, b: Milliunits): Milliunits => (a - b) as Milliunits
export const neg = (a: Milliunits): Milliunits => -a as Milliunits
export const sum = (xs: Iterable<Milliunits>): Milliunits => {
  let total = 0n
  for (const x of xs) total += x
  return total as Milliunits
}
export const max = (a: Milliunits, b: Milliunits): Milliunits => (a > b ? a : b)
export const min = (a: Milliunits, b: Milliunits): Milliunits => (a < b ? a : b)
/** Clamp negatives to zero. The carryforward transform for both cash and credit (R10, R61). */
export const clampToZero = (a: Milliunits): Milliunits => (a > 0n ? a : ZERO)

/**
 * Round UP to the nearest cent.
 *
 * This is the rounding YNAB applies to every derived "needed" figure — `goal_under_funded`
 * and friends (R28). Rounding the shortfall up means following a target never leaves a
 * fractional-cent gap at the deadline.
 *
 * Deliberately named for the DIRECTION, not for the field, because the sibling rule
 * {@link floorToPercent} rounds the opposite way and the two are easy to confuse.
 */
export function ceilToCent(value: Milliunits): Milliunits {
  const remainder = value % MILLI_PER_CENT
  if (remainder === 0n) return value
  // BigInt division truncates toward zero, so negatives need no adjustment to round "up".
  return (remainder > 0n ? value + (MILLI_PER_CENT - remainder) : value - remainder) as Milliunits
}

/**
 * Percentage complete, truncated toward zero (R34).
 *
 * Rounds the OPPOSITE way to {@link ceilToCent}: progress rounds down so it never overstates
 * how far along you are, while "needed" rounds up so it never understates what you owe. Both
 * err against the user's optimism. Returns 0 when the target is zero.
 */
export function floorToPercent(funded: Milliunits, target: Milliunits): number {
  if (target === 0n) return 0
  return Number((funded * 100n) / target)
}

/** Ceiling division for a positive divisor. bigint `/` truncates toward zero. */
function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  // a >= 0: truncation is floor, so a positive remainder means we must round up.
  // a <  0: truncation is already the ceiling, and the remainder is <= 0.
  return a % b > 0n ? q + 1n : q
}

/**
 * Divide, rounding the quotient up to the nearest cent. The R27 per-month share.
 *
 * NOTE: this ceilings the EXACT quotient. Dividing first and then calling
 * {@link ceilToCent} is subtly wrong — it discards the sub-milliunit remainder before
 * rounding, so a target of 1 milliunit over 3 months yields 0 instead of the 10 that
 * YNAB reports (P2-03). Hence the single fused operation.
 */
export function divideCeilToCent(total: Milliunits, divisor: number): Milliunits {
  if (!Number.isInteger(divisor) || divisor <= 0) {
    throw new RangeError(`divideCeilToCent requires a positive integer divisor, got ${divisor}`)
  }
  return (ceilDiv(total, BigInt(divisor) * MILLI_PER_CENT) * MILLI_PER_CENT) as Milliunits
}
