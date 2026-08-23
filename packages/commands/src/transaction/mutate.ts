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
  /** Folds this write into an existing undo step, so a bulk action undoes as one. */
  readonly groupId?: string | undefined
  /**
   * What the undo control should say. Supplied by the caller for a grouped action, because only
   * the caller knows it is deleting eleven rows rather than one.
   */
  readonly groupLabel?: string | undefined
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

    /*
     * The inverse restores the whole row, not only the fields this call changed.
     *
     * Naming just the changed fields would produce a smaller entry that is wrong the moment two
     * edits overlap: undoing the second would leave the first's fields at whatever the second
     * happened to write. `force` is set because undo must not be stopped by the reconciled lock
     * — the user is asking to go back to a state that was already reconciled.
     */
    write.recordUndo({
      label: input.groupLabel ?? 'Edit transaction',
      inverse: {
        procedure: 'transaction.update',
        input: {
          planId: input.planId,
          transactionId: existing.id,
          date: existing.date,
          amount: existing.amount.toString(),
          payeeId: existing.payeeId,
          categoryId: existing.categoryId,
          memo: existing.memo,
          cleared: existing.cleared,
          approved: existing.approved,
          flagColor: existing.flagColor,
          force: true,
        },
      },
      forward: {
        procedure: 'transaction.update',
        input: {
          planId: input.planId,
          transactionId: existing.id,
          date,
          amount: amount.toString(),
          payeeId: input.payeeId ?? existing.payeeId,
          categoryId: input.categoryId ?? existing.categoryId,
          memo: input.memo ?? existing.memo,
          cleared,
          approved: input.approved ?? existing.approved,
          flagColor: input.flagColor ?? existing.flagColor,
          force: true,
        },
      },
      ...(input.groupId ? { groupId: input.groupId } : {}),
    })

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
  /** Folds this write into an existing undo step, so a bulk action undoes as one. */
  readonly groupId?: string | undefined
  /** What the undo control should say; see `UpdateTransactionInput`. */
  readonly groupLabel?: string | undefined
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

    write.recordUndo({
      label: input.groupLabel ?? 'Delete transaction',
      inverse: {
        procedure: 'transaction.restore',
        input: { planId: input.planId, transactionId: existing.id },
      },
      forward: {
        procedure: 'transaction.delete',
        input: { planId: input.planId, transactionId: existing.id, force: true },
      },
      ...(input.groupId ? { groupId: input.groupId } : {}),
    })

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

/**
 * Undo a deletion: clear the tombstone and put the money back.
 *
 * Deletion is soft, so this is a restoration rather than a re-creation — the row keeps its id,
 * which is what lets the undo entry for it stay valid, and what lets a delta request describe
 * the round trip as two changes to one transaction rather than a disappearance and an arrival.
 */
export function restoreTransaction(ctx: CommandContext, input: TransactionRef): void {
  const existing = ctx.db
    .select()
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.id, input.transactionId),
        eq(schema.transaction.planId, input.planId),
      ),
    )
    .get()

  if (!existing) throw new CommandError('No such transaction.', 'transaction.not_found')
  if (!existing.deleted) return

  withPlanWrite(ctx, input.planId, (write) => {
    const stamp = { deleted: false, knowledgeAtChange: write.knowledge, updatedAt: ctx.now }

    applyDelta(ctx, existing.accountId, existing.amount, existing.cleared, write)
    ctx.db.update(schema.transaction).set(stamp).where(eq(schema.transaction.id, existing.id)).run()
    ctx.db
      .update(schema.subtransaction)
      .set(stamp)
      .where(eq(schema.subtransaction.transactionId, existing.id))
      .run()

    // Both legs went together; they come back together, or the plan does not balance.
    if (existing.transferTransactionId) {
      const far = ctx.db
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.id, existing.transferTransactionId))
        .get()
      if (far?.deleted) {
        applyDelta(ctx, far.accountId, far.amount, far.cleared, write)
        ctx.db.update(schema.transaction).set(stamp).where(eq(schema.transaction.id, far.id)).run()
      }
    }

    write.recordUndo({
      label: 'Restore transaction',
      inverse: {
        procedure: 'transaction.delete',
        input: { planId: input.planId, transactionId: existing.id, force: true },
      },
      forward: {
        procedure: 'transaction.restore',
        input: { planId: input.planId, transactionId: existing.id },
      },
    })

    write.markDirtyFrom(monthOf(existing.date))
  })
}
