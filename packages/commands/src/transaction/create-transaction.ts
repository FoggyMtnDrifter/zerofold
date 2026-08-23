import { schema } from '@zerofold/db'
import { type CalendarDate, calendarDate } from '@zerofold/shared/date'
import { type Milliunits, sum } from '@zerofold/shared/money'
import { and, eq, sql } from 'drizzle-orm'
import { type CommandContext, CommandError, type PlanWrite, withPlanWrite } from '../context.ts'

export interface SubtransactionInput {
  readonly amount: Milliunits
  readonly categoryId?: string | null
  readonly payeeId?: string | null
  readonly memo?: string | null
  readonly transferAccountId?: string | null
}

export interface CreateTransactionInput {
  readonly planId: string
  readonly accountId: string
  readonly date: CalendarDate
  readonly amount: Milliunits
  readonly payeeId?: string | null
  readonly categoryId?: string | null
  readonly memo?: string | null
  readonly cleared?: schema.ClearedStatus
  readonly approved?: boolean
  readonly flagColor?: schema.FlagColor | null
  readonly importId?: string | null
  readonly subtransactions?: readonly SubtransactionInput[]
}

export interface CreateTransactionResult {
  readonly transactionId: string
  /** The far leg, when this is a transfer. */
  readonly counterpartId: string | null
  readonly subtransactionIds: readonly string[]
}

export function createTransaction(
  ctx: CommandContext,
  input: CreateTransactionInput,
): CreateTransactionResult {
  return withPlanWrite(ctx, input.planId, (write) => insert(ctx, input, write))
}

function insert(
  ctx: CommandContext,
  input: CreateTransactionInput,
  write: PlanWrite,
): CreateTransactionResult {
  const db = ctx.db
  const account = requireAccount(ctx, input.planId, input.accountId)

  /**
   * A transaction may not be dated in the future — ADR-0007.
   *
   * Enforced here rather than as a database constraint: "today" is not a stable value, and a
   * row valid yesterday must not become invalid overnight or on restore from a backup.
   */
  if (input.date > ctx.today) {
    throw new CommandError(
      `${input.date} is in the future. Schedule it instead — a transaction records money that has already moved.`,
      'transaction.date_in_future',
    )
  }

  const subs = input.subtransactions ?? []
  const isSplit = subs.length > 0
  if (isSplit) {
    if (subs.length < 2) {
      throw new CommandError('A split needs at least two parts.', 'transaction.split_too_small')
    }
    const total = sum(subs.map((s) => s.amount))
    if (total !== input.amount) {
      throw new CommandError(
        `The parts of this split add up to ${total}, but the transaction is ${input.amount}.`,
        'transaction.split_mismatch',
      )
    }
  }

  const transactionId = ctx.newId()
  const transferAccountId = transferTargetFor(ctx, input.planId, input.payeeId ?? null)

  /**
   * A transfer between two on-budget accounts carries no category (R45).
   *
   * Money moving inside the budget is not spending. The oracle strips a submitted category
   * silently; we strip it too, for wire compatibility, but say so rather than pretending the
   * request was honoured.
   */
  let categoryId = isSplit ? null : (input.categoryId ?? null)
  let strippedCategory = false
  if (transferAccountId) {
    const destination = requireAccount(ctx, input.planId, transferAccountId)
    if (account.onBudget && destination.onBudget && categoryId) {
      categoryId = null
      strippedCategory = true
    }
  }

  const cleared = input.cleared ?? 'uncleared'
  const counterpartId = transferAccountId ? ctx.newId() : null
  const transferPairId = transferAccountId ? ctx.newId() : null

  db.insert(schema.transaction)
    .values({
      id: transactionId,
      planId: input.planId,
      accountId: input.accountId,
      date: input.date,
      amount: input.amount,
      memo: input.memo ?? null,
      cleared,
      approved: input.approved ?? true,
      flagColor: input.flagColor ?? null,
      flagName: null,
      payeeId: input.payeeId ?? null,
      categoryId,
      transferAccountId,
      transferTransactionId: counterpartId,
      transferPairId,
      matchedTransactionId: null,
      importId: input.importId ?? null,
      importPayeeName: null,
      importPayeeNameOriginal: null,
      importBatchId: null,
      debtTransactionType: null,
      isSplit,
      reconciliationId: null,
      knowledgeAtChange: write.knowledge,
      deleted: false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run()

  const subtransactionIds = subs.map((sub, index) => {
    const id = ctx.newId()
    db.insert(schema.subtransaction)
      .values({
        id,
        planId: input.planId,
        transactionId,
        sortOrder: index,
        amount: sub.amount,
        memo: sub.memo ?? null,
        payeeId: sub.payeeId ?? null,
        categoryId: sub.categoryId ?? null,
        transferAccountId: sub.transferAccountId ?? null,
        transferTransactionId: null,
        transferPairId: null,
        knowledgeAtChange: write.knowledge,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()
    return id
  })

  applyToBalance(ctx, input.accountId, input.amount, cleared, write)

  /**
   * The far leg of a transfer.
   *
   * Written in the same database transaction as the near leg, which is what makes the pair
   * invariant hold without a foreign key — one is impossible without the other. Its payee is
   * the *source* account's transfer payee, so each side names the other.
   */
  if (transferAccountId && counterpartId && transferPairId) {
    const sourceTransferPayee = db
      .select({ id: schema.payee.id })
      .from(schema.payee)
      .where(
        and(
          eq(schema.payee.planId, input.planId),
          eq(schema.payee.transferAccountId, input.accountId),
        ),
      )
      .get()

    const counterAmount = -input.amount as Milliunits
    db.insert(schema.transaction)
      .values({
        id: counterpartId,
        planId: input.planId,
        accountId: transferAccountId,
        date: input.date,
        amount: counterAmount,
        memo: input.memo ?? null,
        cleared: 'uncleared',
        approved: true,
        flagColor: null,
        flagName: null,
        payeeId: sourceTransferPayee?.id ?? null,
        categoryId: null,
        transferAccountId: input.accountId,
        transferTransactionId: transactionId,
        transferPairId,
        matchedTransactionId: null,
        importId: null,
        importPayeeName: null,
        importPayeeNameOriginal: null,
        importBatchId: null,
        debtTransactionType: null,
        isSplit: false,
        reconciliationId: null,
        knowledgeAtChange: write.knowledge,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()
    applyToBalance(ctx, transferAccountId, counterAmount, 'uncleared', write)
  }

  write.markDirtyFrom(`${input.date.slice(0, 7)}-01`)
  extendFirstMonth(ctx, input.planId, input.date)

  if (strippedCategory) {
    // Not an error — the oracle does the same — but a silent discard is how a client comes to
    // believe something was recorded that was not.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'category dropped: a transfer between two on-budget accounts is not spending',
        transactionId,
      }),
    )
  }

  return { transactionId, counterpartId, subtransactionIds }
}

function requireAccount(ctx: CommandContext, planId: string, accountId: string) {
  const account = ctx.db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, accountId), eq(schema.account.planId, planId)))
    .get()
  if (!account || account.deleted) {
    throw new CommandError('No such account.', 'transaction.account_not_found')
  }
  return account
}

/** A payee that names an account *is* a transfer instruction. */
function transferTargetFor(
  ctx: CommandContext,
  planId: string,
  payeeId: string | null,
): string | null {
  if (!payeeId) return null
  const payee = ctx.db
    .select({ transferAccountId: schema.payee.transferAccountId })
    .from(schema.payee)
    .where(and(eq(schema.payee.id, payeeId), eq(schema.payee.planId, planId)))
    .get()
  return payee?.transferAccountId ?? null
}

/**
 * Keep the account's cached balances in step.
 *
 * These are caches, not truth — `recalculate --verify` re-derives them from the ledger — but
 * they are what the sidebar reads, so they move with every write rather than waiting for a
 * recompute.
 */
function applyToBalance(
  ctx: CommandContext,
  accountId: string,
  amount: Milliunits,
  cleared: schema.ClearedStatus,
  write: PlanWrite,
): void {
  const settled = cleared !== 'uncleared'
  ctx.db
    .update(schema.account)
    .set({
      balance: sql`${schema.account.balance} + ${amount}`,
      clearedBalance: settled
        ? sql`${schema.account.clearedBalance} + ${amount}`
        : schema.account.clearedBalance,
      unclearedBalance: settled
        ? schema.account.unclearedBalance
        : sql`${schema.account.unclearedBalance} + ${amount}`,
      knowledgeAtChange: write.knowledge,
      updatedAt: ctx.now,
    })
    .where(eq(schema.account.id, accountId))
    .run()
}

/** A backdated transaction extends the plan's history — the oracle does this too. */
function extendFirstMonth(ctx: CommandContext, planId: string, date: CalendarDate): void {
  const month = calendarDate(`${date.slice(0, 7)}-01`)
  ctx.db
    .update(schema.plan)
    .set({
      firstMonth: sql`MIN(COALESCE(${schema.plan.firstMonth}, ${month}), ${month})`,
    })
    .where(eq(schema.plan.id, planId))
    .run()
}
