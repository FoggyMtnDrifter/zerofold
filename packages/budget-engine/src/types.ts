import type { BudgetMonth, CalendarDate } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'

/**
 * One categorised transaction.
 *
 * The engine takes transactions rather than per-category totals because coverage is
 * *sequential*: a charge on a card is covered by whatever the category has available at the
 * moment that charge is applied, and the order the charges are applied in changes the answer
 * (R1, R2, R6, R7). Totals cannot reproduce that — P1-03's 30000/20000 split is impossible to
 * derive from a sum.
 */
export interface LedgerEntry {
  readonly id: string
  readonly categoryId: string
  readonly date: CalendarDate
  /** Spending negative, refunds positive. */
  readonly amount: Milliunits
  readonly accountId: string
  /** False when the account is a credit card or line of credit. */
  readonly isCash: boolean
}

/**
 * Anything on a credit account that no budget category funded.
 *
 * One rule covers three cases that look different and behave identically: a payment transferred
 * in, an interest charge nobody categorised (R63), and the negative opening balance a card
 * arrives with (R37). Sign decides which — money in pays debt down, money out is debt the
 * budget has never seen.
 */
export interface CardEvent {
  readonly id: string
  readonly accountId: string
  readonly date: CalendarDate
  /** Positive reduces the card's debt; negative increases the uncovered part of it. */
  readonly amount: Milliunits
}

export interface Assignment {
  readonly categoryId: string
  readonly budgeted: Milliunits
}

export interface MonthInput {
  readonly month: BudgetMonth
  /**
   * Income reaching Ready to Assign in this month.
   *
   * Amounts categorised to Inflow on a *credit* account are not income in either direction
   * (R64), so this is computed by the caller rather than inferred from an entry.
   */
  readonly income: Milliunits
  readonly assignments: readonly Assignment[]
  readonly entries: readonly LedgerEntry[]
  readonly cardEvents: readonly CardEvent[]
}

/** A credit account, as the engine needs to know it. */
export interface CardInput {
  readonly accountId: string
  /** The category that holds money set aside to pay this card. */
  readonly paymentCategoryId: string
}

export interface EngineInput {
  /**
   * Every category the plan has, excluding Inflow: Ready to Assign — payment categories
   * included, since they hold money and appear in the grid.
   */
  readonly categories: readonly string[]
  readonly cards: readonly CardInput[]
  /** Ascending and contiguous. See `CarryState.totalBudgetedAllMonths` for why all of them. */
  readonly months: readonly MonthInput[]
}

export type OverspendKind = 'none' | 'cash' | 'credit'

export interface CellResult {
  readonly categoryId: string
  readonly budgeted: Milliunits
  readonly activity: Milliunits
  /** What YNAB calls "available": what is left to spend from this category. */
  readonly balance: Milliunits
  /** The balance carried in from the previous month — never negative (R10, R61). */
  readonly carriedForward: Milliunits
  /**
   * Which kind of overspending this cell represents, for display.
   *
   * A cell can be overspent both ways at once; this reports cash when there is any, because
   * that is the half that costs the budget money. The two amounts below are the truth.
   *
   * A *payment* category is never marked overspent, however negative it goes: a card paid
   * beyond its coverage is not a budgeting error and must not be surfaced as one (R60′).
   */
  readonly overspendKind: OverspendKind
  /** Overspending funded by money that was never assigned. Charges the next month's RTA (R10). */
  readonly cashOverspend: Milliunits
  /** Overspending that only increased debt. Costs nothing until the card is paid (R61). */
  readonly creditOverspend: Milliunits
}

/** What a card owes, split by whether the budget has already funded it. */
export interface CardResult {
  readonly accountId: string
  readonly paymentCategoryId: string
  /** Debt from categorised purchases, matched by money held in the payment category. */
  readonly coveredDebt: Milliunits
  /** Debt no category ever funded: the opening balance, interest, and credit overspending. */
  readonly uncoveredDebt: Milliunits
}

export interface MonthResult {
  readonly month: BudgetMonth
  readonly income: Milliunits
  readonly budgeted: Milliunits
  /** Excludes Inflow, includes credit-card payment categories (R5). */
  readonly activity: Milliunits
  /** Ready to Assign, as of this month. R8. */
  readonly toBeBudgeted: Milliunits
  readonly cells: readonly CellResult[]
  readonly cards: readonly CardResult[]
}
