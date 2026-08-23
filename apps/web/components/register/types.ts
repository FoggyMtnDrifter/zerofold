export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled'
export type FlagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

/** One row as the register displays it. Mirrors `RegisterRow` from the command layer. */
export interface RegisterRow {
  readonly id: string
  readonly date: string
  readonly amount: bigint
  readonly memo: string | null
  readonly cleared: ClearedStatus
  readonly approved: boolean
  readonly flagColor: FlagColor | null
  readonly accountId: string
  readonly accountName: string
  readonly payeeName: string | null
  readonly categoryName: string | null
  readonly isSplit: boolean
  readonly transferAccountId: string | null
}
