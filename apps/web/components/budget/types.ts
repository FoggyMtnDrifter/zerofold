/** The budget grid as the server hands it over. Mirrors `BudgetView` from the command layer. */
export interface CardState {
  readonly accountId: string
  readonly coveredDebt: bigint
  readonly uncoveredDebt: bigint
}

export interface BudgetCell {
  readonly categoryId: string
  readonly name: string
  readonly hidden: boolean
  /** Set when this row is a credit card's payment category. */
  readonly card: CardState | null
  readonly budgeted: bigint
  readonly activity: bigint
  readonly balance: bigint
  readonly overspendKind: 'none' | 'cash' | 'credit'
}

export interface BudgetGroup {
  readonly categoryGroupId: string
  readonly name: string
  readonly hidden: boolean
  readonly budgeted: bigint
  readonly activity: bigint
  readonly balance: bigint
  readonly categories: readonly BudgetCell[]
}

export interface BudgetView {
  readonly month: string
  readonly readyToAssign: bigint
  readonly income: bigint
  readonly budgeted: bigint
  readonly activity: bigint
  readonly groups: readonly BudgetGroup[]
  readonly months: readonly string[]
}
