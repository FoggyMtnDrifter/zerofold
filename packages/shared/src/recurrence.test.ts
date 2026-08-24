import { describe, expect, it } from 'vitest'
import { calendarDate } from './date.ts'
import { type Frequency, nextOccurrence, occurrencesBetween } from './recurrence.ts'

/**
 * Recurrence, against the measured series in P3-04.
 *
 * Every first occurrence is 2026-08-16 and every expected `date_next` is the earliest
 * occurrence at or after 2026-08-23, which is how the oracle was read.
 */

const FIRST = calendarDate('2026-08-16')
const TODAY = calendarDate('2026-08-23')

/** The first occurrence at or after `today`, which is what `date_next` holds. */
const dateNext = (frequency: Frequency) =>
  occurrencesBetween(FIRST, frequency, calendarDate('2026-08-22'), calendarDate('2030-01-01'))[0]

describe('R51 — the twelve recurring periods', () => {
  it.each([
    ['daily', '2026-08-23'],
    ['weekly', '2026-08-23'],
    ['everyOtherWeek', '2026-08-30'],
    ['twiceAMonth', '2026-09-01'],
    ['every4Weeks', '2026-09-13'],
    ['monthly', '2026-09-16'],
    ['everyOtherMonth', '2026-10-16'],
    ['every3Months', '2026-11-16'],
    ['every4Months', '2026-12-16'],
    ['twiceAYear', '2027-02-16'],
    ['yearly', '2027-08-16'],
    ['everyOtherYear', '2028-08-16'],
  ] as const)('%s advances to %s', (frequency, expected) => {
    expect(dateNext(frequency)).toBe(calendarDate(expected))
  })

  it('does not let a day-delta stand in for a period', () => {
    // `daily` reads as +7 from the first occurrence after a week's absence. Deriving the period
    // from `next − first` is only valid when exactly one occurrence has elapsed.
    const daily = occurrencesBetween(FIRST, 'daily', null, TODAY)
    expect(daily).toHaveLength(8)
    expect(daily.at(-1)).toBe(TODAY)
  })
})

describe('R52 — twiceAMonth is a day pair fifteen days apart', () => {
  it('goes from the 16th to the 1st of the next month, not the 31st', () => {
    expect(nextOccurrence(calendarDate('2026-08-16'), 'twiceAMonth')).toBe(
      calendarDate('2026-09-01'),
    )
  })

  it('completes the pair within the month before moving on', () => {
    expect(nextOccurrence(calendarDate('2026-09-01'), 'twiceAMonth')).toBe(
      calendarDate('2026-09-16'),
    )
  })

  it('runs a whole series in order', () => {
    const series = occurrencesBetween(
      calendarDate('2026-08-16'),
      'twiceAMonth',
      null,
      calendarDate('2026-10-20'),
    )
    expect(series).toEqual(
      ['2026-08-16', '2026-09-01', '2026-09-16', '2026-10-01', '2026-10-16'].map(calendarDate),
    )
  })
})

describe('R54 — a one-off has exactly one occurrence', () => {
  it('yields its own date and nothing after it', () => {
    expect(nextOccurrence(FIRST, 'never')).toBeNull()
    expect(occurrencesBetween(FIRST, 'never', null, calendarDate('2030-01-01'))).toEqual([FIRST])
  })

  it('yields nothing once it has been entered', () => {
    expect(occurrencesBetween(FIRST, 'never', FIRST, calendarDate('2030-01-01'))).toEqual([])
  })
})

describe('back-filling', () => {
  it('returns every missed occurrence, not just the most recent (R53)', () => {
    const missed = occurrencesBetween(FIRST, 'daily', null, calendarDate('2026-08-22'))
    expect(missed).toHaveLength(7)
    expect(missed[0]).toBe(FIRST)
    expect(missed.at(-1)).toBe(calendarDate('2026-08-22'))
  })

  it('returns nothing when everything up to today has been entered', () => {
    const already = calendarDate('2026-08-22')
    expect(occurrencesBetween(FIRST, 'daily', already, already)).toEqual([])
  })

  it('caps a long-dormant series rather than materialising it all at once', () => {
    const capped = occurrencesBetween(FIRST, 'daily', null, calendarDate('2030-01-01'), 10)
    expect(capped).toHaveLength(10)
  })
})

describe('month-end — PROVISIONAL, pending P3-04c', () => {
  /*
   * These pin the *current* behaviour so a change is visible, not the *correct* behaviour,
   * which is not yet known. The experiment that settles it is planted and readable on or after
   * 2026-09-01. If it turns out the oracle skips short months or drifts, these change.
   */
  it('clamps a 31st to the last day of a shorter month', () => {
    expect(nextOccurrence(calendarDate('2027-01-31'), 'monthly')).toBe(calendarDate('2027-02-28'))
  })

  it('returns to the anchor day once the month is long enough again', () => {
    // Stepping from each occurrence in turn would leave the series stuck on the 28th forever.
    const series = occurrencesBetween(
      calendarDate('2027-01-31'),
      'monthly',
      null,
      calendarDate('2027-04-01'),
    )
    expect(series).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'].map(calendarDate))
  })

  it('handles a leap year', () => {
    expect(nextOccurrence(calendarDate('2028-01-31'), 'monthly')).toBe(calendarDate('2028-02-29'))
  })
})
