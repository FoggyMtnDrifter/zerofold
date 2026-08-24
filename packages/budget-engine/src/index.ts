/**
 * The budgeting engine.
 *
 * No I/O, no clock, no database, no React — ADR-0002. `today` is always an argument. The one
 * import is `@zerofold/shared`, for the milliunit and calendar-date types: a second definition
 * of what a milliunit is would be a worse outcome than the dependency, since the two would
 * eventually round differently and only one of them would be tested here.
 *
 * The rules it implements are measured, not assumed. Every one carries its R-number to the
 * document in `docs/behavior/` that recorded the observation.
 */
export { advance, type CardDebt, type CarryState, emptyCarry, totalBudgeted } from './advance.ts'
export { type EngineOutput, readyToAssign, run } from './run.ts'
export type { Cadence, GoalType, Target, TargetContext, TargetResult } from './target.ts'
export { computeTarget } from './target.ts'
export type {
  Assignment,
  CardEvent,
  CardInput,
  CardResult,
  CategoryTarget,
  CellResult,
  EngineInput,
  LedgerEntry,
  MonthInput,
  MonthResult,
  OverspendKind,
} from './types.ts'

export const ENGINE_VERSION = '1.0.0'
