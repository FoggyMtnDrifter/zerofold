import { add, clampToZero, type Milliunits, min, neg, sub, ZERO } from '@zerofold/shared/money'
import type { CellInput, CellResult, MonthInput, MonthResult } from './types.ts'

/**
 * Everything one month needs to know about every month before it — and one thing it needs to
 * know about the months *after* it.
 *
 * That last part is the awkward one. `totalBudgetedAllMonths` covers the whole plan, future
 * included, because money assigned in September reduces August's Ready to Assign (R9). Ready to
 * Assign is not a per-month bucket that later months draw from; every assignment anywhere
 * reduces it everywhere. So it cannot come out of a left-to-right fold, and it is carried here
 * as a constant rather than accumulated.
 */
export interface CarryState {
  /** Available carried into the month, per category. Absent means zero. */
  readonly balances: ReadonlyMap<string, Milliunits>
  /** Income of every month up to and including the previous one. */
  readonly cumulativeIncome: Milliunits
  /** Cash overspending of every month strictly before this one. R8 uses `< M`, not `≤ M`. */
  readonly cashOverspendBefore: Milliunits
  /** Σ budgeted across every month of the plan. Constant through the fold. */
  readonly totalBudgetedAllMonths: Milliunits
}

export const emptyCarry = (totalBudgetedAllMonths: Milliunits): CarryState => ({
  balances: new Map(),
  cumulativeIncome: ZERO,
  cashOverspendBefore: ZERO,
  totalBudgetedAllMonths,
})

/**
 * Split an overspend into the part the budget must absorb and the part that is merely debt.
 *
 * Cash spending consumes a category's available balance before any credit spending is covered
 * (R2), regardless of date. That ordering is what decides the split: what is left after the
 * cash has been taken out is what remains to cover the card.
 */
function overspend(
  carriedForward: Milliunits,
  budgeted: Milliunits,
  activity: Milliunits,
  creditActivity: Milliunits,
) {
  const cashActivity = sub(activity, creditActivity)
  const afterCash = add(add(carriedForward, budgeted), cashActivity)

  const cashOverspend = clampToZero(neg(afterCash))
  const creditSpend = clampToZero(neg(creditActivity))
  const covered = min(clampToZero(afterCash), creditSpend)

  return { cashOverspend, creditOverspend: sub(creditSpend, covered) }
}

function evaluate(cell: CellInput, carriedForward: Milliunits): CellResult {
  const balance = add(add(carriedForward, cell.budgeted), cell.activity)
  const { cashOverspend, creditOverspend } = overspend(
    carriedForward,
    cell.budgeted,
    cell.activity,
    cell.creditActivity,
  )

  return {
    categoryId: cell.categoryId,
    budgeted: cell.budgeted,
    activity: cell.activity,
    balance,
    carriedForward,
    overspendKind: cashOverspend > ZERO ? 'cash' : creditOverspend > ZERO ? 'credit' : 'none',
    cashOverspend,
    creditOverspend,
  }
}

const EMPTY_CELL = (categoryId: string): CellInput => ({
  categoryId,
  budgeted: ZERO,
  activity: ZERO,
  creditActivity: ZERO,
})

/**
 * One month.
 *
 * Kept separate from the fold so that `recalculate --from=YYYY-MM` can resume mid-plan from a
 * stored `CarryState` instead of replaying from the beginning, and so the fold has nothing in
 * it but iteration.
 */
export function advance(
  state: CarryState,
  input: MonthInput,
  categories: readonly string[],
): { readonly result: MonthResult; readonly next: CarryState } {
  const supplied = new Map(input.cells.map((cell) => [cell.categoryId, cell]))

  const cells: CellResult[] = []
  const balances = new Map<string, Milliunits>()
  let budgeted = ZERO
  let activity = ZERO
  let cashOverspentHere = ZERO

  for (const categoryId of categories) {
    const cell = supplied.get(categoryId) ?? EMPTY_CELL(categoryId)
    const result = evaluate(cell, state.balances.get(categoryId) ?? ZERO)

    cells.push(result)
    // Nothing negative crosses a month boundary: both kinds of overspending clamp the category
    // to zero, and they differ only in who pays for it (R10, R61).
    balances.set(categoryId, clampToZero(result.balance))

    budgeted = add(budgeted, result.budgeted)
    activity = add(activity, result.activity)
    cashOverspentHere = add(cashOverspentHere, result.cashOverspend)
  }

  const cumulativeIncome = add(state.cumulativeIncome, input.income)

  return {
    result: {
      month: input.month,
      income: input.income,
      budgeted,
      activity,
      // R8. The three terms have three different windows on purpose: income through M,
      // assignments across all time, cash overspending strictly before M.
      toBeBudgeted: sub(
        sub(cumulativeIncome, state.totalBudgetedAllMonths),
        state.cashOverspendBefore,
      ),
      cells,
    },
    next: {
      balances,
      cumulativeIncome,
      cashOverspendBefore: add(state.cashOverspendBefore, cashOverspentHere),
      totalBudgetedAllMonths: state.totalBudgetedAllMonths,
    },
  }
}

/** Σ budgeted over every month, which R8 needs before the first month can be evaluated. */
export function totalBudgeted(months: readonly MonthInput[]): Milliunits {
  let total = ZERO
  for (const month of months) {
    for (const cell of month.cells) total = add(total, cell.budgeted)
  }
  return total
}
