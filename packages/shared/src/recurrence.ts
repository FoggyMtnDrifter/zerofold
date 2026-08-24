import {
  addDays,
  type CalendarDate,
  compare,
  daysInMonth,
  fromParts,
  parts,
} from './date.ts'

/**
 * Recurrence, as calendar arithmetic.
 *
 * Every period here was measured against a real series (R51). The traps are that the day-delta
 * between the first occurrence and the next one tells you nothing unless exactly one period has
 * elapsed — `daily` reads as +7 after a week's absence — and that `twiceAMonth` is a day-pair
 * rather than a stride.
 */

export type Frequency =
  | 'never'
  | 'daily'
  | 'weekly'
  | 'everyOtherWeek'
  | 'twiceAMonth'
  | 'every4Weeks'
  | 'monthly'
  | 'everyOtherMonth'
  | 'every3Months'
  | 'every4Months'
  | 'twiceAYear'
  | 'yearly'
  | 'everyOtherYear'

const DAY_STRIDE: Partial<Record<Frequency, number>> = {
  daily: 1,
  weekly: 7,
  everyOtherWeek: 14,
  every4Weeks: 28,
}

const MONTH_STRIDE: Partial<Record<Frequency, number>> = {
  monthly: 1,
  everyOtherMonth: 2,
  every3Months: 3,
  every4Months: 4,
  twiceAYear: 6,
  yearly: 12,
  everyOtherYear: 24,
}

/**
 * Add months, keeping the day of the month where the month is long enough.
 *
 * **The short-month rule is provisional.** Whether the oracle clamps the 31st to the 28th of
 * February, skips that month, or drifts is genuinely unknown: the API shows one step at a time
 * and the register projects only the next occurrence. The experiment that settles it is planted
 * and cannot be read before **2026-09-01** — see `docs/behavior/P3-04c-month-end-clamping.md`.
 *
 * Clamping to the last day is what most calendars do and what a person expecting rent on the
 * 31st would least mind, so it is what happens here until the measurement lands. It is marked
 * here, in the doc, and in the open-questions list rather than being quietly assumed, and no
 * golden fixture depends on it.
 */
function addMonthsClamped(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = parts(date)
  const total = year * 12 + (month - 1) + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = (total % 12) + 1
  return fromParts(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)))
}

/**
 * The pair of days a twice-monthly series falls on.
 *
 * Measured from the 16th: the next occurrence is the 1st of the following month, not the 31st —
 * so the series is `{d, d − 15}` for a day past the 15th (R52). The mirror case, a day at or
 * before the 15th, is untested; `{d, d + 15}` is the reading that makes the two halves the same
 * rule, and it is flagged alongside the clamping question.
 */
function twiceAMonthDays(day: number): readonly [number, number] {
  return day > 15 ? [day - 15, day] : [day, day + 15]
}

function nextTwiceAMonth(from: CalendarDate): CalendarDate {
  const { year, month, day } = parts(from)
  const [low, high] = twiceAMonthDays(day)

  if (day < high) {
    // The other day of the pair is still ahead this month, if the month is long enough for it.
    const target = day < low ? low : high
    if (target <= daysInMonth(year, month)) return fromParts(year, month, target)
  }

  const next = addMonthsClamped(fromParts(year, month, 1), 1)
  const { year: y, month: m } = parts(next)
  return fromParts(y, m, Math.min(low, daysInMonth(y, m)))
}

/** The occurrence immediately after `from`. Null for a one-off, which has no next. */
export function nextOccurrence(from: CalendarDate, frequency: Frequency): CalendarDate | null {
  if (frequency === 'never') return null

  const days = DAY_STRIDE[frequency]
  if (days !== undefined) return addDays(from, days)

  if (frequency === 'twiceAMonth') return nextTwiceAMonth(from)

  const months = MONTH_STRIDE[frequency]
  if (months === undefined) return null

  /*
   * Stepping from the *first* occurrence rather than the previous one would be more faithful
   * for a clamped series — 31 Jan, 28 Feb, 31 Mar rather than 28 Feb, 28 Mar — but that needs
   * the anchor day, which the caller has and this function does not. `occurrencesBetween`
   * below carries the anchor for exactly that reason.
   */
  return addMonthsClamped(from, months)
}

/**
 * Every occurrence in `(after, through]`, in order.
 *
 * Anchored on `first` so a clamped series returns to its original day when the month is long
 * enough again: a monthly schedule starting on the 31st should ask for the 31st of March, not
 * the 28th, having been clamped in February. Stepping from each occurrence in turn would let
 * the series drift permanently earlier after a single short month.
 *
 * `limit` is a guard, not a feature: a daily schedule dormant for years would otherwise
 * materialise thousands of rows in one pass.
 */
export function occurrencesBetween(
  first: CalendarDate,
  frequency: Frequency,
  after: CalendarDate | null,
  through: CalendarDate,
  limit = 1_000,
): readonly CalendarDate[] {
  const out: CalendarDate[] = []
  if (frequency === 'never') {
    if (compare(first, through) <= 0 && (after === null || compare(first, after) > 0)) {
      out.push(first)
    }
    return out
  }

  const months = MONTH_STRIDE[frequency]

  for (let step = 0; out.length < limit; step++) {
    const date =
      months === undefined
        ? step === 0
          ? first
          : occurrenceByStride(first, frequency, step)
        : addMonthsClamped(first, months * step)

    if (compare(date, through) > 0) break
    if (after === null || compare(date, after) > 0) out.push(date)

    // A guard against a frequency that fails to advance, which would spin forever.
    if (step > 0 && compare(date, first) <= 0 && months === undefined) break
  }

  return out
}

function occurrenceByStride(first: CalendarDate, frequency: Frequency, step: number): CalendarDate {
  const days = DAY_STRIDE[frequency]
  if (days !== undefined) return addDays(first, days * step)
  if (frequency === 'twiceAMonth') {
    let date = first
    for (let i = 0; i < step; i++) date = nextTwiceAMonth(date)
    return date
  }
  return first
}
