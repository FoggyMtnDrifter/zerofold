import type { BudgetMonth } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'

/**
 * One category's inputs for one month.
 *
 * `budgeted` is the only value a person sets. Everything else here is a fact about
 * transactions, and everything the engine returns is derived from the two.
 */
export interface CellInput {
  readonly categoryId: string
  /** ★ The assignment. The single authoritative input in the whole model. */
  readonly budgeted: Milliunits
  /**
   * Net activity for the month: spending negative, refunds positive.
   *
   * This is the total. `creditActivity` says how much of it happened on a credit account,
   * which decides whether an overspend is billed to next month's Ready to Assign (R10) or
   * carried as debt (R61).
   */
  readonly activity: Milliunits
  /**
   * The part of `activity` that happened on a credit account, same sign convention.
   *
   * Zero for a plan with no credit accounts, which is why an engine that ignored this would
   * look correct for a long time and then be wrong about every card.
   */
  readonly creditActivity: Milliunits
}

export interface MonthInput {
  readonly month: BudgetMonth
  /**
   * Income reaching Ready to Assign in this month.
   *
   * Amounts categorised to Inflow on a *credit* account are not income in either direction
   * (R64), so this is computed by the caller rather than inferred from a cell.
   */
  readonly income: Milliunits
  /** Sparse: a category with no assignment and no activity may be omitted. */
  readonly cells: readonly CellInput[]
}

export interface EngineInput {
  /**
   * Every category the plan has, excluding Inflow: Ready to Assign.
   *
   * Listed separately from the cells because a category with neither an assignment nor any
   * activity in a month still carries its balance through it.
   */
  readonly categories: readonly string[]
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
   */
  readonly overspendKind: OverspendKind
  /** Overspending funded by money that was never assigned. Charges the next month's RTA (R10). */
  readonly cashOverspend: Milliunits
  /** Overspending that only increased debt. Costs nothing until the card is paid (R61). */
  readonly creditOverspend: Milliunits
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
}
