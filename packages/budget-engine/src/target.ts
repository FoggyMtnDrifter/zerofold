import {
  addMonths,
  type BudgetMonth,
  type CalendarDate,
  dayOfWeek,
  daysInMonth,
  fromParts,
  monthsBetween,
  parts,
  type Weekday,
} from '@zerofold/shared/date'
import {
  ceilToCent,
  clampToZero,
  divideCeilToCent,
  floorToPercent,
  type Milliunits,
  sub,
  ZERO,
} from '@zerofold/shared/money'

/**
 * Targets.
 *
 * Every formula here is measured, and two of them were measured wrong first. R27 was stated
 * from a target observed only in its unfunded state, where several candidate formulas coincide;
 * partial funding separated them. The order of operations in it is load-bearing: the ceiling is
 * applied to the per-month share and the month's own assignment is subtracted *after*, and
 * reversing that changes the answer whenever the division is inexact.
 */

export type GoalType = 'NEED' | 'TB' | 'TBD' | 'MF' | 'DEBT'

/** 1 monthly, 2 weekly, 13 yearly (R31a). NEED only. */
export type Cadence = 1 | 2 | 13

export interface Target {
  readonly goalType: GoalType
  readonly goalTarget: Milliunits
  readonly goalTargetMonth: BudgetMonth | null
  /** Day of week, 0 = Sunday, when the cadence is weekly (R29). */
  readonly goalDay: number | null
  readonly goalCadence: Cadence | null
  /** `true` = set aside, `false` = fill up to (R25). NEED only. */
  readonly goalNeedsWholeAmount: boolean | null
  /** Whether it rolls forward past its due month (R31) or goes quiet (R35). */
  readonly repeats: boolean
}

export interface TargetContext {
  readonly month: BudgetMonth
  /** The balance entering the month — available before this month's activity. */
  readonly carriedForward: Milliunits
  readonly budgeted: Milliunits
  /** The plan's today. R30 makes a weekly target a function of it. */
  readonly today: CalendarDate
  /**
   * For a credit-card payment category: what the card still owes.
   *
   * Payment categories carry an implicit requirement equal to the balance even with no target
   * at all (R39), so this is checked before `goalType` is.
   */
  readonly cardDebt?: Milliunits | undefined
}

export interface TargetResult {
  /** What this month still needs. Rounded **up** to the cent (R28). */
  readonly underFunded: Milliunits
  /** 0 is the sentinel for "no active demand", and the division guard (R36). */
  readonly monthsToBudget: number
  readonly overallFunded: Milliunits
  readonly overallLeft: Milliunits
  /** Rounded **down** to a whole percent (R34) — the opposite direction to `underFunded`. */
  readonly percentageComplete: number
  /** What the target amounts to for this month, before funding is taken into account. */
  readonly targetSnapshot: Milliunits
}

const QUIET = (funded: Milliunits, target: Milliunits): TargetResult => ({
  underFunded: ZERO,
  monthsToBudget: 0,
  overallFunded: funded,
  overallLeft: sub(target, funded),
  percentageComplete: floorToPercent(funded, target),
  targetSnapshot: target,
})

/**
 * A credit-card payment category's implicit requirement.
 *
 * It exists with no target record at all, which is why this is checked before `goalType`:
 * "you need to assign this much more to pay off your current balance" is a property of the
 * account, not of anything the user set up (R39). The amount tracks the live balance, so it
 * moves whenever a charge or a payment lands with no edit to anything (R41).
 */
function paymentCategory(debt: Milliunits, context: TargetContext): TargetResult {
  const available = (context.carriedForward + context.budgeted) as Milliunits
  return {
    underFunded: clampToZero(sub(debt, available)),
    monthsToBudget: debt > ZERO ? 1 : 0,
    overallFunded: available,
    overallLeft: sub(debt, available),
    percentageComplete: floorToPercent(available, debt),
    targetSnapshot: debt,
  }
}

export function computeTarget(target: Target | null, context: TargetContext): TargetResult | null {
  // Before `goalType`, because the requirement exists without a target (R39).
  if (context.cardDebt !== undefined) return paymentCategory(context.cardDebt, context)
  if (!target) return null

  const funded = fundedFor(target, context)

  // No deadline, no per-month obligation, however little is in it (R26).
  if (target.goalType === 'TB') return QUIET(funded, target.goalTarget)

  const monthsToBudget = monthsRemaining(target, context.month)
  if (monthsToBudget === 0) return QUIET(funded, target.goalTarget)

  const demand = monthlyDemand(target, context, monthsToBudget)

  /*
   * Two shapes, and they are not interchangeable.
   *
   * A dated target spreads what is still missing over the months still available, so the
   * carried balance is already inside the share and only *this month's* assignment comes off
   * afterwards — after the ceiling, which is what R28 turns on. An undated one compares the
   * target against everything that counts as funding it, which for fill-up-to includes the
   * carried balance (R25).
   *
   * Writing one of these where the other belongs is right in about half the cells and wrong in
   * the rest, which is exactly how the first R27 survived being wrong.
   */
  const underFunded = target.goalTargetMonth
    ? clampToZero(sub(demand, context.budgeted))
    : clampToZero(sub(demand, funded))

  return {
    underFunded,
    monthsToBudget,
    overallFunded: funded,
    overallLeft: sub(target.goalTarget, funded),
    percentageComplete: floorToPercent(funded, target.goalTarget),
    targetSnapshot: demand,
  }
}

/**
 * What counts as satisfying the target this month (R25).
 *
 * Set aside looks only at what you put in; fill-up-to counts what was already there. The whole
 * distinction lives in this one line, and it is the field the brief flagged as most commonly
 * got wrong. An unset flag means set aside, matching the oracle's own default.
 */
function fundedFor(target: Target, context: TargetContext): Milliunits {
  if (target.goalType === 'TB' || target.goalType === 'TBD') {
    return (context.carriedForward + context.budgeted) as Milliunits
  }
  const setAside = target.goalNeedsWholeAmount !== false
  return setAside ? context.budgeted : ((context.carriedForward + context.budgeted) as Milliunits)
}

/**
 * How much this month is asked for, before subtracting what it already holds.
 *
 * Dated targets spread what is still missing over the months still available (R27); undated
 * repeating ones ask for their amount every period.
 */
function monthlyDemand(target: Target, context: TargetContext, monthsToBudget: number): Milliunits {
  if (target.goalCadence === 2) {
    // Weekly: the amount is per occurrence, and the current month counts only the occurrences
    // still ahead (R29, R30). A month already half gone asks for less than it did on the 1st.
    const occurrences = weeklyOccurrences(target, context)
    return ceilToCent((BigInt(occurrences) * target.goalTarget) as Milliunits)
  }

  if (target.goalTargetMonth) {
    // R27: spread the shortfall over the remaining months, ceiling to the cent.
    return divideCeilToCent(
      clampToZero(sub(target.goalTarget, context.carriedForward)),
      monthsToBudget,
    )
  }

  return ceilToCent(target.goalTarget)
}

/**
 * Occurrences of the target weekday, counting only those still ahead in the current month.
 *
 * "Remaining occurrences of the weekday" and "whole weeks remaining" agree for most weekdays,
 * which is why P2-02 had to separate them by changing the weekday rather than by waiting.
 */
function weeklyOccurrences(target: Target, context: TargetContext): number {
  const weekday = (target.goalDay ?? 0) as Weekday
  const { year, month } = parts(context.month)
  const inMonth = daysInMonth(year, month)

  const todayParts = parts(context.today)
  const isCurrentMonth = todayParts.year === year && todayParts.month === month
  const from = isCurrentMonth ? todayParts.day : 1

  let count = 0
  for (let day = from; day <= inMonth; day++) {
    if (dayOfWeek(fromParts(year, month, day)) === weekday) count++
  }
  return count
}

/**
 * Months from this one through the due month, inclusive — the divisor in R27.
 *
 * Past its due month a repeating target rolls to the next occurrence and asks for the full
 * amount again (R31); a non-repeating one goes silent rather than overdue (R35). Returning 0
 * for "no active demand" is the sentinel every caller checks before dividing (R36).
 */
function monthsRemaining(target: Target, month: BudgetMonth): number {
  if (!target.goalTargetMonth) {
    // An undated repeating target asks every period; an undated non-repeating one is a TB in
    // all but name and has already returned above.
    return 1
  }

  const span = monthsBetween(month, target.goalTargetMonth) + 1
  if (span > 0) return span
  if (!target.repeats) return 0

  const period = target.goalCadence === 13 ? 12 : 1
  // Roll forward to the first occurrence at or after this month.
  let due = target.goalTargetMonth
  while (monthsBetween(month, due) < 0) due = addMonths(due, period)
  return monthsBetween(month, due) + 1
}
