import type { Milliunits } from '@zerofold/shared/money'
import { advance, type CarryState, emptyCarry, totalBudgeted } from './advance.ts'
import type { EngineInput, MonthResult } from './types.ts'

export interface EngineOutput {
  readonly months: readonly MonthResult[]
  /** The state after the last month, for a caller that wants to continue the fold later. */
  readonly carry: CarryState
}

/**
 * Evaluate every month of a plan.
 *
 * `input.months` must be every materialised month, ascending — not a window. Ready to Assign
 * subtracts assignments made in *later* months (R9), so evaluating a window in isolation would
 * silently overstate it by exactly the amount assigned beyond the window's end.
 */
export function run(input: EngineInput): EngineOutput {
  let state = emptyCarry(totalBudgeted(input.months))
  const months: MonthResult[] = []

  for (const month of input.months) {
    const step = advance(state, month, input.categories, input.cards, input.today)
    months.push(step.result)
    state = step.next
  }

  return { months, carry: state }
}

/** Ready to Assign for the last month, which is what a header usually wants. */
export const readyToAssign = (output: EngineOutput): Milliunits | undefined =>
  output.months.at(-1)?.toBeBudgeted
