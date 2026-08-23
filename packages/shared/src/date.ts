/**
 * Calendar dates, not instants.
 *
 * A transaction date is a date on a calendar. It has no time, no offset, and no timezone.
 * Everything here is integer arithmetic over `YYYY-MM-DD` strings — no `Date` object is ever
 * constructed, so there is no code path by which a value can shift across a midnight boundary.
 * See ADR-0005.
 *
 * This matters concretely: YNAB stamps API-created rows with the server's UTC date and
 * UI-created rows with the browser's local date, so one plan can hold two rows created hours
 * apart bearing different "today"s (R59). We resolve "today" once, from the plan's timezone,
 * and never re-derive it.
 */

declare const CalendarDateBrand: unique symbol
declare const BudgetMonthBrand: unique symbol

/** A date on a calendar, `YYYY-MM-DD`. */
export type CalendarDate = string & { readonly [CalendarDateBrand]: true }
/** The first of a month, `YYYY-MM-01`. Budget months are always day 01. */
export type BudgetMonth = CalendarDate & { readonly [BudgetMonthBrand]: true }

/** 0 = Sunday … 6 = Saturday, matching YNAB's `goal_day` encoding (R29). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Days in a 1-indexed month. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new RangeError(`month out of range: ${month}`)
  if (month === 2 && isLeap(year)) return 29
  return MONTH_LENGTHS[month - 1] as number
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))
const pad4 = (n: number): string => String(n).padStart(4, '0')

export interface DateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

export function parts(date: CalendarDate): DateParts {
  const m = DATE_RE.exec(date)
  if (!m) throw new TypeError(`not a calendar date: ${date}`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export function isCalendarDate(value: string): value is CalendarDate {
  const m = DATE_RE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** Build a calendar date, rejecting anything that is not a real date. */
export function calendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) throw new TypeError(`not a calendar date: ${value}`)
  return value
}

export function fromParts(year: number, month: number, day: number): CalendarDate {
  return calendarDate(`${pad4(year)}-${pad2(month)}-${pad2(day)}`)
}

/** The budget month containing a date. */
export function monthOf(date: CalendarDate): BudgetMonth {
  const { year, month } = parts(date)
  return `${pad4(year)}-${pad2(month)}-01` as BudgetMonth
}

export function budgetMonth(value: string): BudgetMonth {
  const d = calendarDate(value)
  if (parts(d).day !== 1) throw new TypeError(`budget months must be day 01: ${value}`)
  return d as BudgetMonth
}

/** Calendar dates and budget months both sort correctly as plain strings. */
export const compare = (a: CalendarDate, b: CalendarDate): number => (a < b ? -1 : a > b ? 1 : 0)

// ── day arithmetic (Howard Hinnant's civil-from-days / days-from-civil) ──────────────

const floorDiv = (a: number, b: number): number => Math.floor(a / b)

/** Days since 1970-01-01. Pure integer arithmetic. */
export function toEpochDay(date: CalendarDate): number {
  const { year, month, day } = parts(date)
  const y = year - (month <= 2 ? 1 : 0)
  const era = floorDiv(y, 400)
  const yoe = y - era * 400
  const doy = floorDiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
  return era * 146097 + doe - 719468
}

export function fromEpochDay(days: number): CalendarDate {
  const z = days + 719468
  const era = floorDiv(z, 146097)
  const doe = z - era * 146097
  const yoe = floorDiv(
    doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096),
    365,
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
  const mp = floorDiv(5 * doy + 2, 153)
  const day = doy - floorDiv(153 * mp + 2, 5) + 1
  const month = mp + (mp < 10 ? 3 : -9)
  return fromParts(y + (month <= 2 ? 1 : 0), month, day)
}

export const addDays = (date: CalendarDate, n: number): CalendarDate =>
  fromEpochDay(toEpochDay(date) + n)

export const daysBetween = (from: CalendarDate, to: CalendarDate): number =>
  toEpochDay(to) - toEpochDay(from)

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeek(date: CalendarDate): Weekday {
  return ((((toEpochDay(date) + 4) % 7) + 7) % 7) as Weekday
}

// ── month arithmetic ────────────────────────────────────────────────────────────────

export function addMonths(month: BudgetMonth, n: number): BudgetMonth {
  const { year, month: m } = parts(month)
  const total = year * 12 + (m - 1) + n
  return `${pad4(floorDiv(total, 12))}-${pad2((((total % 12) + 12) % 12) + 1)}-01` as BudgetMonth
}

/** Signed month difference: `monthsBetween(Aug, Oct) === 2`. */
export function monthsBetween(from: BudgetMonth, to: BudgetMonth): number {
  const a = parts(from)
  const b = parts(to)
  return (b.year - a.year) * 12 + (b.month - a.month)
}

/**
 * Inclusive month span, as YNAB's `goal_months_to_budget` counts it (R27):
 * August through September is **2**, September through September is **1**.
 * Returns 0 when `to` is before `from` — the "no active demand" sentinel (R36).
 */
export function monthsToBudget(from: BudgetMonth, to: BudgetMonth): number {
  const diff = monthsBetween(from, to)
  return diff < 0 ? 0 : diff + 1
}

export const lastDayOfMonth = (month: BudgetMonth): CalendarDate => {
  const { year, month: m } = parts(month)
  return fromParts(year, m, daysInMonth(year, m))
}

// ── weekday occurrences (R30) ───────────────────────────────────────────────────────

/** Every date in `month` falling on `weekday`. */
export function weekdayOccurrences(month: BudgetMonth, weekday: Weekday): CalendarDate[] {
  const { year, month: m } = parts(month)
  const total = daysInMonth(year, m)
  const first = dayOfWeek(month)
  const offset = (((weekday - first) % 7) + 7) % 7
  const out: CalendarDate[] = []
  for (let day = 1 + offset; day <= total; day += 7) out.push(fromParts(year, m, day))
  return out
}

/**
 * Occurrences of `weekday` that a weekly target still demands funding for (R30).
 *
 * For the month containing `today`, only occurrences on or after `today` count — a weekly
 * target's monthly demand decays as the month elapses, because you cannot fund a Monday that
 * has already passed. Future months count every occurrence; past months count none.
 */
export function weekdayOccurrencesRemaining(
  month: BudgetMonth,
  weekday: Weekday,
  today: CalendarDate,
): number {
  const current = monthOf(today)
  if (month > current) return weekdayOccurrences(month, weekday).length
  if (month < current) return 0
  return weekdayOccurrences(month, weekday).filter((d) => d >= today).length
}
