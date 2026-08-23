import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { Milliunits } from '@zerofold/shared/money'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'

export interface RegisterRow {
  readonly id: string
  readonly date: string
  readonly amount: Milliunits
  readonly memo: string | null
  readonly cleared: schema.ClearedStatus
  readonly approved: boolean
  readonly flagColor: schema.FlagColor | null
  readonly accountId: string
  readonly accountName: string
  readonly payeeId: string | null
  readonly payeeName: string | null
  readonly categoryId: string | null
  readonly categoryName: string | null
  readonly isSplit: boolean
  readonly transferAccountId: string | null
}

export interface ListTransactionsInput {
  readonly planId: string
  /** Omit for the All Accounts view. */
  readonly accountId?: string | undefined
  readonly limit?: number | undefined
  /** From a previous page's `nextCursor`. */
  readonly cursor?: string | undefined
  readonly unapprovedOnly?: boolean | undefined
  readonly uncategorizedOnly?: boolean | undefined
}

export interface ListTransactionsResult {
  readonly rows: readonly RegisterRow[]
  readonly nextCursor: string | null
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/**
 * A page of the register.
 *
 * Ordered `date DESC, id DESC` to match the `transaction_register` index, so the query is an
 * index scan rather than a sort — which is what keeps it flat as a register grows past tens of
 * thousands of rows.
 *
 * Paged by **keyset**, not OFFSET. An offset makes the database walk and discard every skipped
 * row, so page 500 costs 500× page 1; worse, a row inserted while the user scrolls shifts every
 * subsequent page and they see a duplicate or a gap. The cursor is `date|id`, and because ids
 * are UUIDv7 the tiebreak among same-day rows is chronological rather than arbitrary.
 */
export function listTransactions(db: Db, input: ListTransactionsInput): ListTransactionsResult {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const conditions = [
    eq(schema.transaction.planId, input.planId),
    eq(schema.transaction.deleted, false),
  ]
  if (input.accountId) conditions.push(eq(schema.transaction.accountId, input.accountId))
  if (input.unapprovedOnly) conditions.push(eq(schema.transaction.approved, false))
  if (input.uncategorizedOnly) {
    // A split parent is not uncategorised — its parts carry the categories. Neither is a
    // transfer between budget accounts, which correctly has no category (R45).
    conditions.push(
      and(
        isNull(schema.transaction.categoryId),
        eq(schema.transaction.isSplit, false),
        isNull(schema.transaction.transferAccountId),
      ) as never,
    )
  }
  if (input.cursor) {
    const [date, id] = input.cursor.split('|')
    if (date && id) {
      conditions.push(
        or(
          sql`${schema.transaction.date} < ${date}`,
          and(eq(schema.transaction.date, date), sql`${schema.transaction.id} < ${id}`),
        ) as never,
      )
    }
  }

  const rows = db
    .select({
      id: schema.transaction.id,
      date: schema.transaction.date,
      amount: schema.transaction.amount,
      memo: schema.transaction.memo,
      cleared: schema.transaction.cleared,
      approved: schema.transaction.approved,
      flagColor: schema.transaction.flagColor,
      accountId: schema.transaction.accountId,
      accountName: schema.account.name,
      payeeId: schema.transaction.payeeId,
      payeeName: schema.payee.name,
      categoryId: schema.transaction.categoryId,
      categoryName: schema.category.name,
      isSplit: schema.transaction.isSplit,
      transferAccountId: schema.transaction.transferAccountId,
    })
    .from(schema.transaction)
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .leftJoin(schema.payee, eq(schema.payee.id, schema.transaction.payeeId))
    .leftJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
    .where(and(...conditions))
    .orderBy(desc(schema.transaction.date), desc(schema.transaction.id))
    // One extra row, purely to learn whether another page exists without a second COUNT query.
    .limit(limit + 1)
    .all()

  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const nextCursor = rows.length > limit && last ? `${last.date}|${last.id}` : null

  return { rows: page as RegisterRow[], nextCursor }
}

/** Totals for the register header. Deliberately a separate query from the page. */
export function accountTotals(db: Db, planId: string, accountId: string) {
  return db
    .select({
      balance: schema.account.balance,
      clearedBalance: schema.account.clearedBalance,
      unclearedBalance: schema.account.unclearedBalance,
    })
    .from(schema.account)
    .where(and(eq(schema.account.planId, planId), eq(schema.account.id, accountId)))
    .get()
}
