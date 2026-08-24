import { calendarDate } from '@zerofold/shared/date'
import { milli } from '@zerofold/shared/money'
import { describe, expect, it } from 'vitest'
import {
  type AgeOfMoneyEvent,
  advanceAgeOfMoney,
  ageOfMoney,
  emptyAgeOfMoney,
} from './age-of-money.ts'

/**
 * Age of Money, against the measured experiments.
 *
 * Every number here came off the oracle. The two that would be easy to get wrong and hard to
 * notice are the FIFO matching — most-recent-first gives ~34 where the truth is 41 — and what
 * an exhausted queue does, which was open until P3-02d and is the difference between 110 and
 * 217 on the same data.
 */

const on = (date: string, amount: number): AgeOfMoneyEvent => ({
  date: calendarDate(date),
  amount: milli(amount),
})

const run = (events: readonly AgeOfMoneyEvent[]) =>
  ageOfMoney(advanceAgeOfMoney(emptyAgeOfMoney(), events))

describe('R65 — the mean FIFO age of the last ten spends', () => {
  /** The P3-02 experiment: two income buckets, twelve spends on consecutive days. */
  const EVENTS: AgeOfMoneyEvent[] = [
    on('2026-06-01', 100_000),
    on('2026-07-15', 200_000),
    ...Array.from({ length: 12 }, (_, i) =>
      on(`2026-08-${String(10 + i).padStart(2, '0')}`, -25_000),
    ),
  ]

  it('reproduces the measured 41', () => {
    expect(run(EVENTS)).toBe(41)
  })

  it('is the mean rather than the median', () => {
    // The median of that window is 34.5. Only the mean gives 41.
    expect(run(EVENTS)).not.toBe(35)
  })

  it('matches oldest income first, not most recent', () => {
    // Matching against the most recent income would put every age in 30–37 and give about 34.
    expect(run(EVENTS)).toBeGreaterThan(38)
  })
})

describe('R67 — rounding half up', () => {
  it('takes a mean of exactly 36.5 to 37', () => {
    // Constructed so the window's ages are 73 30 31 32 33 34 35 36 37 24, summing to 365.
    const ages = [73, 30, 31, 32, 33, 34, 35, 36, 37, 24]
    const state = { queue: [], recentAges: ages, spendCount: 13 }
    expect(ageOfMoney(state)).toBe(37)
  })

  it('is not floor, which the other two rounding rules might tempt you into', () => {
    const state = { queue: [], recentAges: [1, 2], spendCount: 10 }
    // Mean 1.5 → 2, not 1.
    expect(ageOfMoney(state)).toBe(2)
  })
})

describe('R70 — an exhausted queue', () => {
  /** P3-02d: ten funded spends aged 212…221, then five with nothing left to match. */
  const EVENTS: AgeOfMoneyEvent[] = [
    on('2026-01-01', 100_000),
    ...Array.from({ length: 15 }, (_, i) =>
      on(`2026-08-${String(i + 1).padStart(2, '0')}`, -10_000),
    ),
  ]

  it('gives unmatched spending age zero and keeps it in the window', () => {
    // Measured: 110. Skipping the unmatched rows would give 217.
    expect(run(EVENTS)).toBe(110)
  })

  it('collapses to zero once the whole window is unfunded', () => {
    const more: AgeOfMoneyEvent[] = [
      ...EVENTS,
      ...Array.from({ length: 5 }, (_, i) => on(`2026-08-${16 + i}`, -10_000)),
    ]
    // Measured: 0. This is the confirmation that predicted 0 and observed 0.
    expect(run(more)).toBe(0)
  })

  it('does not report a healthier age the more a plan overspends', () => {
    const funded = run(EVENTS) ?? 0
    const overspent =
      run([...EVENTS, ...Array.from({ length: 3 }, (_, i) => on(`2026-08-${16 + i}`, -10_000))]) ??
      0
    expect(overspent).toBeLessThan(funded)
  })
})

describe('the ten-transaction floor', () => {
  it('reports nothing at all below it', () => {
    const nine = [
      on('2026-01-01', 100_000),
      ...Array.from({ length: 9 }, (_, i) => on(`2026-08-0${i + 1}`, -1_000)),
    ]
    expect(run(nine)).toBeNull()
  })

  it('reports a number at exactly ten', () => {
    const ten = [
      on('2026-01-01', 100_000),
      ...Array.from({ length: 10 }, (_, i) =>
        on(`2026-08-${String(i + 1).padStart(2, '0')}`, -1_000),
      ),
    ]
    expect(run(ten)).not.toBeNull()
  })

  it('reports nothing rather than zero, which would mean something else entirely', () => {
    expect(run([on('2026-01-01', 100_000), on('2026-08-01', -1_000)])).toBeNull()
  })
})

describe('a spend spanning two income buckets', () => {
  it('weights the age by how much came from each', () => {
    // 50000 from a bucket 100 days old and 50000 from one 50 days old averages to 75.
    const state = advanceAgeOfMoney(emptyAgeOfMoney(), [
      on('2026-05-03', 50_000),
      on('2026-06-22', 50_000),
      on('2026-08-11', -100_000),
    ])
    expect(state.recentAges.at(-1)).toBe(75)
  })

  it('does not round a per-spend age, only the mean', () => {
    // Two thirds from a 90-day bucket and one third from a 60-day one is 80 exactly; making it
    // 30/70 gives a fraction, and truncating each age before averaging would lose it.
    const state = advanceAgeOfMoney(emptyAgeOfMoney(), [
      on('2026-05-13', 100_000),
      on('2026-06-12', 100_000),
      on('2026-08-11', -150_000),
    ])
    expect(state.recentAges.at(-1)).toBeCloseTo(80, 5)
  })
})

describe('the queue persists across months', () => {
  it('gives the same answer fed month by month as all at once', () => {
    const june = [on('2026-06-01', 100_000)]
    const july = [on('2026-07-15', 200_000)]
    const august = Array.from({ length: 12 }, (_, i) =>
      on(`2026-08-${String(10 + i).padStart(2, '0')}`, -25_000),
    )

    let state = emptyAgeOfMoney()
    for (const month of [june, july, august]) state = advanceAgeOfMoney(state, month)

    expect(ageOfMoney(state)).toBe(run([...june, ...july, ...august]))
  })

  it('is unchanged by a month with nothing in it', () => {
    const events = [on('2026-06-01', 100_000)]
    const withGap = advanceAgeOfMoney(advanceAgeOfMoney(emptyAgeOfMoney(), events), [])
    expect(withGap).toEqual(advanceAgeOfMoney(emptyAgeOfMoney(), events))
  })
})
