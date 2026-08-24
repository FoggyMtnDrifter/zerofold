import type { CalendarDate } from '@zerofold/shared/date'
import { daysBetween } from '@zerofold/shared/date'
import { type Milliunits, ZERO } from '@zerofold/shared/money'

/**
 * Age of Money — how long, on average, money sat between arriving and being spent.
 *
 * A FIFO queue over income, consumed by spending in date order, and the mean age of the last
 * ten spends. Every part of that sentence was measured and three parts of it are things a
 * reasonable implementation would get wrong:
 *
 *   - it is the **mean**, not the median (R65)
 *   - matching is genuinely **FIFO** — oldest income first, not most recent (R65)
 *   - it rounds **half up**, a third rounding rule distinct from both target ones (R67)
 *
 * A credit-card *purchase* is not spending here: it creates debt and moves no money. The card
 * *payment* is the moment money leaves, and that is what counts (R68).
 */

/** One tranche of income still waiting to be spent. */
interface Bucket {
  readonly date: CalendarDate
  remaining: Milliunits
}

export interface AgeOfMoneyEvent {
  readonly date: CalendarDate
  /** Positive is income arriving; negative is money leaving. */
  readonly amount: Milliunits
}

/** The floor below which the oracle reports nothing rather than a number. */
export const MINIMUM_SPENDS = 10

export interface AgeOfMoneyState {
  /** Income not yet spent, oldest first. */
  readonly queue: readonly Bucket[]
  /** The ages of the most recent spends, oldest first, capped at the window. */
  readonly recentAges: readonly number[]
  /** Every spend ever seen, for the ten-transaction floor. */
  readonly spendCount: number
}

export const emptyAgeOfMoney = (): AgeOfMoneyState => ({
  queue: [],
  recentAges: [],
  spendCount: 0,
})

/**
 * Feed one month's events through the queue.
 *
 * The queue persists across months by design: an August figure can depend on income from June,
 * so this cannot be computed from a single month's slice. An empty month neither adds to the
 * queue nor consumes it, which is what keeps the fold's gap-jumping optimisation valid.
 */
export function advanceAgeOfMoney(
  state: AgeOfMoneyState,
  events: readonly AgeOfMoneyEvent[],
): AgeOfMoneyState {
  const queue = state.queue.map((b) => ({ date: b.date, remaining: b.remaining }))
  const recentAges = [...state.recentAges]
  let spendCount = state.spendCount

  const ordered = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  for (const event of ordered) {
    if (event.amount === ZERO) continue

    if (event.amount > ZERO) {
      queue.push({ date: event.date, remaining: event.amount })
      continue
    }

    spendCount++
    recentAges.push(ageOf(queue, event))
    if (recentAges.length > MINIMUM_SPENDS) recentAges.shift()
  }

  return { queue, recentAges, spendCount }
}

/**
 * Consume the queue for one spend and report the age it earns.
 *
 * A spend that outruns the queue takes **age zero** rather than being skipped (R70). The
 * distinction matters more than it looks: skipping would make a plan report a *healthier* age
 * the more it overspent, because only the well-aged spends would remain in the window.
 *
 * Where a spend draws on more than one bucket the age is weighted by how much came from each,
 * which is what "on average" has to mean for a single spend spanning two tranches of income.
 */
function ageOf(queue: { date: CalendarDate; remaining: Milliunits }[], event: AgeOfMoneyEvent): number {
  let outstanding = -event.amount as Milliunits
  let weighted = 0n
  let matched = ZERO

  while (outstanding > ZERO && queue.length > 0) {
    const bucket = queue[0]
    if (!bucket) break

    const taken = bucket.remaining < outstanding ? bucket.remaining : outstanding
    weighted += taken * BigInt(daysBetween(bucket.date, event.date))
    matched = (matched + taken) as Milliunits
    outstanding = (outstanding - taken) as Milliunits
    bucket.remaining = (bucket.remaining - taken) as Milliunits
    if (bucket.remaining <= ZERO) queue.shift()
  }

  // Money the plan never had cannot have sat anywhere, so it has no age.
  if (matched === ZERO) return 0

  /*
   * Not rounded here.
   *
   * Only the *final* mean's rounding was measured (R67, half up). Every observed per-spend age
   * was a whole number of days by construction, so how a fractional one should behave is
   * undetermined — and truncating each of ten ages before averaging them would shave up to a
   * day off the answer for no measured reason. Carrying the exact value and rounding once, at
   * the end, introduces no rule that was not observed.
   */
  return Number(weighted) / Number(matched)
}

/**
 * The reported figure, or null below the floor.
 *
 * Null rather than zero: a plan with nine spends has not got an Age of Money of zero, it has
 * not got one at all, and the two mean very different things to someone reading it (R65).
 */
export function ageOfMoney(state: AgeOfMoneyState): number | null {
  if (state.spendCount < MINIMUM_SPENDS) return null
  if (state.recentAges.length === 0) return null

  const total = state.recentAges.reduce((sum, age) => sum + age, 0)
  // Round half up — a third rule, distinct from the targets' ceil and floor (R67).
  return Math.floor(total / state.recentAges.length + 0.5)
}
