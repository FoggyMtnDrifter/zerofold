import { schema } from '@zerofold/db'
import type { CalendarDate } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'
import { and, eq, sql } from 'drizzle-orm'
import { type CommandContext, CommandError, type PlanWrite, withPlanWrite } from '../context.ts'

type Txn = typeof schema.transaction.$inferSelect

export interface TransactionRef {
  readonly planId: string
  readonly transactionId: string
}

/**
 * Optional fields are declared `| undefined` rather than bare `?`, because
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined" — and
 * validated input from Zod is always the latter. Writing `?: boolean` here would compile
 * everywhere except at the one call site that matters.
 */
export interface UpdateTransactionInput extends TransactionRef {
  readonly date?: CalendarDate | undefined
  readonly amount?: Milliunits | undefined
  readonly payeeId?: string | null | undefined
  readonly categoryId?: string | null | undefined
  readonly memo?: string | null | undefined
  readonly cleared?: schema.ClearedStatus | undefined
  readonly approved?: boolean | undefined
  readonly flagColor?: schema.FlagColor | null | undefined
  /** Editing a reconciled row requires saying so explicitly. See R71. */
  readonly force?: boolean | undefined
}

function load(ctx: CommandContext, ref: TransactionRef): Txn {
  const row = ctx.db
    .select()
    .from(schema.transaction)
    .where(
      and(eq(schema.transaction.id, ref.transactionId), eq(schema.transaction.planId, ref.planId)),
    )
    .get()
  if (!row || row.deleted) throw new CommandError('No such transaction.', 'transaction.not_found')
  return row
}

/**
 * R71 — a reconciled transaction is locked against casual editing.
 *
 * Reconciliation is an assertion that these rows match a statement (R56). Editing one silently
 * invalidates that assertion, and the user finds out at the next reconciliation when the
 * numbers no longer agree and there is no record of why. The edit is still permitted — it is
 * their data — but it must be deliberate.
 */
function guardReconciled(txn: Txn, force: boolean | undefined): void {
  if (txn.cleared === 'reconciled' && !force) {
    throw new CommandError(
      'That transaction has been reconciled. Editing it will make the account no longer match the statement it was reconciled against.',
      'transaction.reconciled_locked',
    )
  }
}

/** Reverse a row's contribution to its account's cached balances. */
function unapply(ctx: CommandContext, txn: Txn, write: PlanWrite): void {
  applyDelta(ctx, txn.accountId, -txn.amount as Milliunits, txn.cleared, write)
}

function applyDelta(
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

const monthOf = (date: string) => `${date.slice(0, 7)}-01`

export function updateTransaction(ctx: CommandContext, input: UpdateTransactionInput): void {
  const existing = load(ctx, input)
  guardReconciled(existing, input.force)

  if (input.date && input.date > ctx.today) {
    throw new CommandError(
      `${input.date} is in the future. Schedule it instead.`,
      'transaction.date_in_future',
    )
  }

  withPlanWrite(ctx, input.planId, (write) => {
    const date = input.date ?? (existing.date as CalendarDate)
    const amount = input.amount ?? existing.amount
    const cleared = input.cleared ?? existing.cleared

    // Reverse the old contribution, then apply the new. Doing it as a delta on the changed
    // field only would be wrong whenever `cleared` changes, because the amount then has to move
    // between two different columns.
    unapply(ctx, existing, write)
    applyDelta(ctx, existing.accountId, amount, cleared, write)

    ctx.db
      .update(schema.transaction)
      .set({
        date,
        amount,
        cleared,
        ...(input.payeeId !== undefined ? { payeeId: input.payeeId } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.approved !== undefined ? { approved: input.approved } : {}),
        ...(input.flagColor !== undefined ? { flagColor: input.flagColor } : {}),
        knowledgeAtChange: write.knowledge,
        updatedAt: ctx.now,
      })
      .where(eq(schema.transaction.id, existing.id))
      .run()

    /**
     * Keep the far leg of a transfer in step.
     *
     * Date and amount are properties of the *movement*, not of one side of it, so they must
     * change together. A pair that disagrees is invisible in either register on its own — you
     * see a correct-looking row in each account and a plan whose totals do not balance.
     *
     * Memo, flag, approval and cleared status are per-side and deliberately not propagated:
     * clearing one side of a transfer says the money left one account, which is genuinely
     * independent of whether it has landed in the other.
     */
    if (existing.transferTransactionId) {
      const far = ctx.db
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.id, existing.transferTransactionId))
        .get()

      if (far && !far.deleted) {
        const farAmount = -amount as Milliunits
        unapply(ctx, far, write)
        applyDelta(ctx, far.accountId, farAmount, far.cleared, write)
        ctx.db
          .update(schema.transaction)
          .set({
            date,
            amount: farAmount,
            knowledgeAtChange: write.knowledge,
            updatedAt: ctx.now,
          })
          .where(eq(schema.transaction.id, far.id))
          .run()
      }
    }

    // Both the old and the new month need recomputing when a date moves, so dirty from the
    // earlier of the two.
    write.markDirtyFrom(monthOf(existing.date))
    if (date !== existing.date) write.markDirtyFrom(monthOf(date))
  })
}

export interface DeleteTransactionInput extends TransactionRef {
  readonly force?: boolean | undefined
}

/**
 * Delete a transaction, and the far leg if it is a transfer.
 *
 * Soft, so delta requests can report it (R24). Both legs go together: deleting one side of a
 * transfer would leave the other pointing at a row that no longer exists — a transfer from
 * nowhere, and a balance that never reconciles.
 */
export function deleteTransaction(ctx: CommandContext, input: DeleteTransactionInput): void {
  const existing = load(ctx, input)
  guardReconciled(existing, input.force)

  withPlanWrite(ctx, input.planId, (write) => {
    const stamp = { deleted: true, knowledgeAtChange: write.knowledge, updatedAt: ctx.now }

    unapply(ctx, existing, write)
    ctx.db.update(schema.transaction).set(stamp).where(eq(schema.transaction.id, existing.id)).run()
    ctx.db
      .update(schema.subtransaction)
      .set(stamp)
      .where(eq(schema.subtransaction.transactionId, existing.id))
      .run()

    if (existing.transferTransactionId) {
      const far = ctx.db
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.id, existing.transferTransactionId))
        .get()
      if (far && !far.deleted) {
        unapply(ctx, far, write)
        ctx.db.update(schema.transaction).set(stamp).where(eq(schema.transaction.id, far.id)).run()
      }
    }

    write.markDirtyFrom(monthOf(existing.date))
  })
}
