import { type CalendarDate, calendarDate } from '@zerofold/shared/date'

/**
 * Today's date in a plan's timezone.
 *
 * **This is the only place in the system that reads a clock.** Everything downstream — every
 * command, the whole engine — takes `today` as an argument (ADR-0005). Keeping the read in one
 * function is what makes that enforceable rather than aspirational.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is exactly our `CalendarDate` shape, so no parsing or
 * reassembly is needed and there is no intermediate `Date` to mis-convert.
 */
export function todayIn(timezone: string, now: Date = new Date()): CalendarDate {
  try {
    return calendarDate(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now),
    )
  } catch {
    // An unknown timezone must not take the instance down; fall back to UTC and carry on.
    return calendarDate(now.toISOString().slice(0, 10))
  }
}
