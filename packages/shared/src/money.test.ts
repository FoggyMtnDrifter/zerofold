import { describe, expect, it } from 'vitest'
import { ceilToCent, clampToZero, divideCeilToCent, floorToPercent, milli, sum } from './money.ts'

describe('ceilToCent (R28)', () => {
  it('leaves exact cents alone', () => {
    expect(ceilToCent(milli(33340))).toBe(33340n)
    expect(ceilToCent(milli(0))).toBe(0n)
  })
  it('rounds up to the next cent', () => {
    expect(ceilToCent(milli(33331))).toBe(33340n)
    expect(ceilToCent(milli(1))).toBe(10n)
  })
  it('rounds negatives toward zero', () => {
    expect(ceilToCent(milli(-33331))).toBe(-33330n)
  })
})

describe('divideCeilToCent (R27 + R28) — values observed from YNAB', () => {
  // Every case here is a figure YNAB actually returned; see docs/behavior/P2-03.
  it.each([
    { total: 100000, months: 3, expected: 33340n, note: '33333.33 -> 3334 cents' },
    { total: 100000, months: 6, expected: 16670n, note: '16666.67 -> 1667 cents' },
    { total: 10, months: 3, expected: 10n, note: '3.33 -> 1 cent' },
    { total: 1, months: 3, expected: 10n, note: 'sub-cent still owes a whole cent' },
    { total: 600000, months: 2, expected: 300000n, note: 'exact division, TBD in August' },
    { total: 600000, months: 1, expected: 600000n, note: 'final month' },
    { total: 25000, months: 12, expected: 2090n, note: 'yearly rolled over (R31)' },
    { total: 120000, months: 5, expected: 24000n, note: 'dated NEED probe' },
  ])('$total over $months months -> $expected ($note)', ({ total, months, expected }) => {
    expect(divideCeilToCent(milli(total), months)).toBe(expected)
  })

  it('rejects a zero divisor — months_to_budget 0 means no demand, not a division (R36)', () => {
    expect(() => divideCeilToCent(milli(100), 0)).toThrow(RangeError)
  })
})

describe('floorToPercent (R34) — rounds the opposite way to ceilToCent', () => {
  it.each([
    { funded: 25000, target: 200000, expected: 12 },
    { funded: 75000, target: 200000, expected: 37 },
    { funded: 125000, target: 200000, expected: 62 },
    { funded: 200000, target: 600000, expected: 33 },
    { funded: 450000, target: 600000, expected: 75 },
  ])('$funded of $target -> $expected%', ({ funded, target, expected }) => {
    expect(floorToPercent(milli(funded), milli(target))).toBe(expected)
  })

  it('truncates rather than rounding half up', () => {
    // 12.5% must floor to 12. Rounding would give 13 and disagree with YNAB.
    expect(floorToPercent(milli(25000), milli(200000))).toBe(12)
  })

  it('returns 0 for a zero target rather than dividing', () => {
    expect(floorToPercent(milli(500), milli(0))).toBe(0)
  })
})

describe('clampToZero (R10, R61)', () => {
  it('is the carryforward transform and is idempotent', () => {
    const overspent = milli(-40000)
    expect(clampToZero(overspent)).toBe(0n)
    // Idempotence is what makes the far-future gap-jump optimisation sound (plan §4).
    expect(clampToZero(clampToZero(overspent))).toBe(clampToZero(overspent))
  })
  it('leaves positive balances to carry forward untouched (R11)', () => {
    expect(clampToZero(milli(100000))).toBe(100000n)
  })
})

describe('sum', () => {
  it('adds milliunits without float error', () => {
    expect(sum([milli(100000), milli(50000), milli(-140000)])).toBe(10000n)
  })
})
