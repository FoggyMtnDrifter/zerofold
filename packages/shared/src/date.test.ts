import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  budgetMonth,
  calendarDate,
  dayOfWeek,
  daysInMonth,
  lastDayOfMonth,
  monthOf,
  monthsToBudget,
  weekdayOccurrences,
  weekdayOccurrencesRemaining,
} from './date.ts'

const d = calendarDate
const m = budgetMonth

describe('dayOfWeek (0 = Sunday, matching goal_day — R29)', () => {
  it('matches dates verified against the YNAB oracle', () => {
    // August 2026 starts on a Saturday; this is what made Monday-vs-Friday
    // a usable discriminator for R30.
    expect(dayOfWeek(d('2026-08-01'))).toBe(6)
    expect(dayOfWeek(d('2026-08-03'))).toBe(1) // a Monday
    expect(dayOfWeek(d('2026-08-28'))).toBe(5) // the last Friday
    expect(dayOfWeek(d('2026-09-01'))).toBe(2) // September starts Tuesday
    expect(dayOfWeek(d('1970-01-01'))).toBe(4) // epoch was a Thursday
  })
})

describe('weekdayOccurrences', () => {
  it('finds all five Mondays and four Fridays in August 2026', () => {
    expect(weekdayOccurrences(m('2026-08-01'), 1).map(String)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ])
    expect(weekdayOccurrences(m('2026-08-01'), 5)).toHaveLength(4)
  })
})

describe('weekdayOccurrencesRemaining (R30) — reproduces the measured discrimination', () => {
  // Observed on 2026-08-22: a $25/week Monday target reported 50000 (2 occurrences)
  // while the same target on Friday reported 25000 (1). "Weeks remaining in the month"
  // would have given both the same figure, which is how occurrence-counting was proven.
  const today = d('2026-08-22')
  const aug = m('2026-08-01')

  it('counts only occurrences on or after today in the current month', () => {
    expect(weekdayOccurrencesRemaining(aug, 1, today)).toBe(2) // 24th, 31st
    expect(weekdayOccurrencesRemaining(aug, 5, today)).toBe(1) // 28th
  })

  it('counts every occurrence in a future month', () => {
    expect(weekdayOccurrencesRemaining(m('2026-09-01'), 5, today)).toBe(4)
  })

  it('counts none in a past month', () => {
    expect(weekdayOccurrencesRemaining(m('2026-07-01'), 1, today)).toBe(0)
  })

  it('includes today itself when today is the target weekday', () => {
    // 2026-08-24 is a Monday; standing on it, it still needs funding.
    expect(weekdayOccurrencesRemaining(aug, 1, d('2026-08-24'))).toBe(2)
    expect(weekdayOccurrencesRemaining(aug, 1, d('2026-08-25'))).toBe(1)
  })
})

describe('monthsToBudget (R27 / R36)', () => {
  it('counts inclusively, as goal_months_to_budget does', () => {
    expect(monthsToBudget(m('2026-08-01'), m('2026-09-01'))).toBe(2)
    expect(monthsToBudget(m('2026-09-01'), m('2026-09-01'))).toBe(1)
    expect(monthsToBudget(m('2026-08-01'), m('2026-12-01'))).toBe(5)
  })

  it('returns 0 past the target month — the no-demand sentinel, not a negative span', () => {
    // A non-repeating target read after its date reports months_to_budget 0 (R35).
    // Returning -1 here would make the R27 division produce nonsense.
    expect(monthsToBudget(m('2026-10-01'), m('2026-09-01'))).toBe(0)
  })
})

describe('month and day arithmetic', () => {
  it('addMonths crosses year boundaries in both directions', () => {
    expect(addMonths(m('2026-12-01'), 1)).toBe('2027-01-01')
    expect(addMonths(m('2026-01-01'), -1)).toBe('2025-12-01')
    expect(addMonths(m('2026-08-01'), 12)).toBe('2027-08-01')
  })

  it('addDays crosses months, years and leap days', () => {
    expect(addDays(d('2026-08-31'), 1)).toBe('2026-09-01')
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01')
    expect(addDays(d('2028-02-28'), 1)).toBe('2028-02-29') // 2028 is a leap year
    expect(addDays(d('2026-02-28'), 1)).toBe('2026-03-01')
  })

  it('round-trips through epoch days across a wide range', () => {
    for (const iso of ['1900-01-01', '1970-01-01', '2026-08-22', '2099-12-31', '2400-02-29']) {
      expect(addDays(d(iso), 0)).toBe(iso)
    }
  })

  it('knows month lengths including leap Februaries', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28) // centurial non-leap
    expect(daysInMonth(2400, 2)).toBe(29)
    expect(lastDayOfMonth(m('2026-08-01'))).toBe('2026-08-31')
    expect(lastDayOfMonth(m('2026-02-01'))).toBe('2026-02-28')
  })

  it('monthOf extracts the budget month', () => {
    expect(monthOf(d('2026-08-22'))).toBe('2026-08-01')
  })
})

describe('validation', () => {
  it('rejects impossible dates rather than silently normalising them', () => {
    // `new Date('2026-02-30')` would roll over to March. Strings must not.
    expect(() => d('2026-02-30')).toThrow(TypeError)
    expect(() => d('2026-13-01')).toThrow(TypeError)
    expect(() => d('2026-8-1')).toThrow(TypeError)
    expect(() => m('2026-08-15')).toThrow(TypeError)
  })
})
