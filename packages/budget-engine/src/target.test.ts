import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { type Milliunits, milli, ZERO } from '@zerofold/shared/money'
import { describe, expect, it } from 'vitest'
import { computeTarget, type Target, type TargetContext } from './target.ts'

/**
 * Targets, against the measured tables.
 *
 * Two of these formulas were stated wrong the first time — R27 from a target observed only
 * unfunded, and the rounding direction from assuming one helper would do for every derived
 * field. Both blind spots are covered here deliberately: every by-date case is tested funded
 * *and* unfunded, and never only in its final month.
 */

const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')
const OCT = budgetMonth('2026-10-01')
const TODAY = calendarDate('2026-08-22')

const need = (over: Partial<Target> = {}): Target => ({
  goalType: 'NEED',
  goalTarget: milli(100_000),
  goalTargetMonth: null,
  goalDay: null,
  goalCadence: 1,
  goalNeedsWholeAmount: true,
  repeats: true,
  ...over,
})

const at = (over: Partial<TargetContext> = {}): TargetContext => ({
  month: AUG,
  carriedForward: ZERO,
  budgeted: ZERO,
  today: TODAY,
  ...over,
})

describe('R25 — set aside versus fill up to', () => {
  const setAside = need({ goalNeedsWholeAmount: true })
  const refill = need({ goalNeedsWholeAmount: false })

  it('agrees in the month the money went in', () => {
    const context = at({ budgeted: milli(100_000) })
    expect(computeTarget(setAside, context)?.underFunded).toBe(ZERO)
    expect(computeTarget(refill, context)?.underFunded).toBe(ZERO)
    expect(computeTarget(refill, context)?.percentageComplete).toBe(100)
  })

  it('parts company the very next month, before anything is spent', () => {
    // Both carry 100000 forward. Set aside wants the whole amount again; refill is satisfied.
    const context = at({ month: SEP, carriedForward: milli(100_000) })
    expect(computeTarget(setAside, context)?.underFunded).toBe(milli(100_000))
    expect(computeTarget(setAside, context)?.percentageComplete).toBe(0)
    expect(computeTarget(refill, context)?.underFunded).toBe(ZERO)
    expect(computeTarget(refill, context)?.percentageComplete).toBe(100)
  })

  it('counts what was carried, not what remains, after spending', () => {
    // 100000 assigned, 60000 spent, 40000 carried into September.
    const context = at({ month: SEP, carriedForward: milli(40_000) })
    expect(computeTarget(setAside, context)?.underFunded).toBe(milli(100_000))
    expect(computeTarget(refill, context)?.underFunded).toBe(milli(60_000))
    expect(computeTarget(refill, context)?.percentageComplete).toBe(40)
  })

  it('does not treat spending in the current month as under-funding', () => {
    // The target measures what you put in. An implementation using `target − balance` would
    // be right for refill in September and wrong in all five other cells.
    const context = at({ budgeted: milli(100_000) })
    expect(computeTarget(setAside, context)?.underFunded).toBe(ZERO)
    expect(computeTarget(setAside, context)?.percentageComplete).toBe(100)
  })

  it('treats an unset flag as set aside, matching the oracle default', () => {
    const context = at({ month: SEP, carriedForward: milli(100_000) })
    expect(computeTarget(need({ goalNeedsWholeAmount: null }), context)?.underFunded).toBe(
      milli(100_000),
    )
  })
})

describe('R27 — the by-date formula, funded and unfunded', () => {
  const tbd = (target: number, due = SEP): Target => ({
    goalType: 'TBD',
    goalTarget: milli(target),
    goalTargetMonth: due,
    goalDay: null,
    goalCadence: null,
    goalNeedsWholeAmount: null,
    repeats: false,
  })

  it('spreads the shortfall over the months still available', () => {
    expect(computeTarget(tbd(600_000), at())?.underFunded).toBe(milli(300_000))
    expect(computeTarget(tbd(600_000), at({ month: SEP }))?.underFunded).toBe(milli(600_000))
  })

  it('subtracts this month’s assignment after dividing, not before', () => {
    // The case that falsified the first R27: partial funding separates the candidates.
    expect(computeTarget(tbd(600_000), at({ budgeted: milli(200_000) }))?.underFunded).toBe(
      milli(100_000),
    )
    expect(
      computeTarget(tbd(600_000), at({ month: SEP, carriedForward: milli(200_000) }))?.underFunded,
    ).toBe(milli(400_000))
  })

  it('clamps at zero when this month is already over-funded', () => {
    expect(computeTarget(tbd(600_000), at({ budgeted: milli(450_000) }))?.underFunded).toBe(ZERO)
    expect(
      computeTarget(tbd(600_000), at({ month: SEP, carriedForward: milli(450_000) }))?.underFunded,
    ).toBe(milli(150_000))
  })

  it('divides evenly across the inclusive span', () => {
    const december = budgetMonth('2026-12-01')
    const result = computeTarget(tbd(120_000, december), at())
    expect(result?.monthsToBudget).toBe(5)
    expect(result?.underFunded).toBe(milli(24_000))
  })
})

describe('R28 — needed rounds up to the cent', () => {
  const dated = (target: number, due: string): Target => ({
    goalType: 'TBD',
    goalTarget: milli(target),
    goalTargetMonth: budgetMonth(due),
    goalDay: null,
    goalCadence: null,
    goalNeedsWholeAmount: null,
    repeats: false,
  })

  it.each([
    [100_000, '2026-10-01', 3, 33_340],
    [100_000, '2027-01-01', 6, 16_670],
    [10, '2026-10-01', 3, 10],
    [1, '2026-10-01', 3, 10],
  ])('target %i over %s is %i months and needs %i', (target, due, months, expected) => {
    const result = computeTarget(dated(target, due), at())
    expect(result?.monthsToBudget).toBe(months)
    expect(result?.underFunded).toBe(milli(expected))
  })

  it('can ask for more than the target itself, and that is not a bug', () => {
    // Sub-cent targets are pathological; the point is that no assertion may assume
    // `underFunded <= overallLeft`, because legitimate data violates it.
    const result = computeTarget(dated(1, '2026-10-01'), at())
    expect(result?.underFunded).toBe(milli(10))
    expect(result?.overallLeft).toBe(milli(1))
  })
})

describe('R34 — progress rounds down', () => {
  it('truncates rather than rounding', () => {
    const target = need({ goalTarget: milli(600_000), goalNeedsWholeAmount: false })
    expect(computeTarget(target, at({ budgeted: milli(200_000) }))?.percentageComplete).toBe(33)
    expect(computeTarget(target, at({ budgeted: milli(450_000) }))?.percentageComplete).toBe(75)
  })

  it('rounds the opposite way to underFunded, from the same target', () => {
    // Both conservative, in opposite directions: never understate what is still needed, never
    // overstate how far along you are.
    const target: Target = {
      goalType: 'TBD',
      goalTarget: milli(100_000),
      goalTargetMonth: budgetMonth('2026-10-01'),
      goalDay: null,
      goalCadence: null,
      goalNeedsWholeAmount: null,
      repeats: false,
    }
    const result = computeTarget(target, at({ budgeted: milli(50_000) }))
    expect(result?.underFunded).toBe(milli(33_340 - 50_000 < 0 ? 0 : 33_340 - 50_000))
    expect(result?.percentageComplete).toBe(50)
  })
})

describe('R26, R35, R36 — the quiet cases', () => {
  it('a have-a-balance target never demands funding', () => {
    const tb: Target = {
      goalType: 'TB',
      goalTarget: milli(500_000),
      goalTargetMonth: null,
      goalDay: null,
      goalCadence: null,
      goalNeedsWholeAmount: null,
      repeats: false,
    }
    for (const month of [AUG, SEP]) {
      const result = computeTarget(tb, at({ month }))
      expect(result?.underFunded).toBe(ZERO)
      expect(result?.monthsToBudget).toBe(0)
      expect(result?.overallLeft).toBe(milli(500_000))
    }
  })

  it('a non-repeating target goes silent past its due month rather than overdue', () => {
    const tbd: Target = {
      goalType: 'TBD',
      goalTarget: milli(150_000),
      goalTargetMonth: AUG,
      goalDay: null,
      goalCadence: null,
      goalNeedsWholeAmount: null,
      repeats: false,
    }
    const result = computeTarget(tbd, at({ month: OCT }))
    expect(result?.monthsToBudget).toBe(0)
    expect(result?.underFunded).toBe(ZERO)
    // What was never funded is still reported.
    expect(result?.overallLeft).toBe(milli(150_000))
  })
})

describe('R31 — a repeating target rolls forward', () => {
  const yearly = need({
    goalTarget: milli(25_000),
    goalTargetMonth: SEP,
    goalCadence: 13,
    goalNeedsWholeAmount: false,
    repeats: true,
  })

  it('is R27 and nothing new before the due month', () => {
    expect(computeTarget(yearly, at())?.monthsToBudget).toBe(2)
    expect(computeTarget(yearly, at())?.underFunded).toBe(milli(12_500))
    expect(computeTarget(yearly, at({ month: SEP }))?.underFunded).toBe(milli(25_000))
  })

  it('resets to the full period once the due month has passed', () => {
    const result = computeTarget(yearly, at({ month: OCT }))
    expect(result?.monthsToBudget).toBe(12)
    // 25000 / 12 = 2083.3333 -> 208.33 cents -> ceil 209 cents -> 2090.
    expect(result?.underFunded).toBe(milli(2_090))
  })
})

describe('R29, R30 — weekly targets decay as the month elapses', () => {
  const weekly = need({ goalTarget: milli(25_000), goalCadence: 2, goalDay: 1 })

  it('counts only the occurrences still ahead in the current month', () => {
    // Mondays in August 2026 are the 3rd, 10th, 17th, 24th and 31st. On the 22nd, two remain.
    expect(computeTarget(weekly, at())?.underFunded).toBe(milli(50_000))
  })

  it('counts every occurrence of a month entirely in the future', () => {
    // September 2026 has four Mondays.
    expect(computeTarget(weekly, at({ month: SEP }))?.underFunded).toBe(milli(100_000))
  })

  it('asks for the whole month when today is the first', () => {
    const result = computeTarget(weekly, at({ today: calendarDate('2026-08-01') }))
    expect(result?.underFunded).toBe(milli(125_000))
  })

  it('is a function of today, which is why fixtures must pin it', () => {
    const early = computeTarget(weekly, at({ today: calendarDate('2026-08-04') }))
    const late = computeTarget(weekly, at({ today: calendarDate('2026-08-25') }))
    expect(early?.underFunded).toBe(milli(100_000))
    expect(late?.underFunded).toBe(milli(25_000))
  })
})

describe('R39 — a payment category is underfunded by its balance, with no target at all', () => {
  it('asks for the outstanding debt when nothing is set aside', () => {
    const result = computeTarget(null, at({ cardDebt: milli(300_000) }))
    expect(result?.underFunded).toBe(milli(300_000))
    expect(result?.targetSnapshot).toBe(milli(300_000))
  })

  it('counts what the payment category already holds', () => {
    const result = computeTarget(
      null,
      at({ cardDebt: milli(300_000), carriedForward: milli(120_000) }),
    )
    expect(result?.underFunded).toBe(milli(180_000))
  })

  it('goes quiet on a card that owes nothing', () => {
    const result = computeTarget(null, at({ cardDebt: ZERO }))
    expect(result?.underFunded).toBe(ZERO)
    expect(result?.monthsToBudget).toBe(0)
  })

  it('tracks the balance rather than any stored amount (R41)', () => {
    const before = computeTarget(null, at({ cardDebt: milli(300_000) }))
    const after = computeTarget(null, at({ cardDebt: milli(340_000) }))
    expect(after?.underFunded).toBe(((before?.underFunded ?? ZERO) + milli(40_000)) as Milliunits)
  })
})

describe('no target', () => {
  it('reports nothing rather than zero', () => {
    // A category with no target is not a category with a target of zero, and the grid needs to
    // tell them apart to know whether to show anything at all.
    expect(computeTarget(null, at())).toBeNull()
  })
})
