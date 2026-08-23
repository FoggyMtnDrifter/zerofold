import { schema } from '@zerofold/db'
import type { CalendarDate } from '@zerofold/shared/date'
import { type Milliunits, sub, ZERO } from '@zerofold/shared/money'
import { and, eq, ne, sql } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'

export interface ReconcileInput {
  readonly planId: string
  readonly accountId: string
  /** The balance the institution says the account holds. */
  readonly statementBalance: Milliunits
  readonly statementDate?: CalendarDate | undefined
}

export interface ReconcileResult {
  readonly reconciliationId: string
  readonly priorClearedBalance: Milliunits
  readonly difference: Milliunits
  readonly adjustmentTransactionId: string | null
  readonly lockedCount: number
}

/**
 * Reconcile an account against a statement balance.
 *
 * Three measured rules shape this:
 *
 *   R55 — the comparison is against the **cleared** balance, not the working balance.
 *         Uncleared rows are money the institution has not seen and are left untouched.
 *   R56 — every cleared row becomes `reconciled`, in bulk, at this moment. `reconciled` is
 *         therefore never set at entry time; only this command may write it.
 *   R57 — any difference becomes one adjustment transaction categorised to Inflow: Ready to
 *         Assign, so an unexplained discrepancy lands in the budget rather than being
 *         attributed to a category the user never spent from.
 */
export function reconcile(ctx: CommandContext, input: ReconcileInput): ReconcileResult {
  const account = ctx.db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, input.accountId), eq(schema.account.planId, input.planId)))
    .get()
  if (!account || account.deleted) {
    throw new CommandError('No such account.', 'reconcile.account_not_found')
  }
  if (account.closed) {
    throw new CommandError('That account is closed.', 'reconcile.account_closed')
  }

  return withPlanWrite(ctx, input.planId, (write) => {
    const priorClearedBalance = account.clearedBalance
    const difference = sub(input.statementBalance, priorClearedBalance)
    const reconciliationId = ctx.newId()

    let adjustmentTransactionId: string | null = null

    if (difference !== ZERO) {
      const payeeId = reconciliationPayee(ctx, input.planId, write.knowledge)
      const inflow = ctx.db
        .select({ id: schema.category.id })
        .from(schema.category)
        .where(
          and(
            eq(schema.category.planId, input.planId),
            eq(schema.category.internalKind, 'inflow_rta'),
          ),
        )
        .get()

      adjustmentTransactionId = ctx.newId()
      ctx.db
        .insert(schema.transaction)
        .values({
          id: adjustmentTransactionId,
          planId: input.planId,
          accountId: input.accountId,
          // The plan's today, not the statement date: this is a correction made now, and
          // backdating it would silently alter a month the user has already closed out.
          date: ctx.today,
          amount: difference,
          memo: 'Balance adjustment recorded during reconciliation',
          cleared: 'reconciled',
          approved: true,
          flagColor: null,
          flagName: null,
          payeeId,
          // Only on-budget accounts have a Ready to Assign to adjust against.
          categoryId: account.onBudget ? (inflow?.id ?? null) : null,
          transferAccountId: null,
          transferTransactionId: null,
          transferPairId: null,
          matchedTransactionId: null,
          importId: null,
          importPayeeName: null,
          importPayeeNameOriginal: null,
          importBatchId: null,
          debtTransactionType: 'balanceAdjustment',
          isSplit: false,
          reconciliationId,
          knowledgeAtChange: write.knowledge,
          deleted: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run()
    }

    // R56: everything already cleared becomes reconciled, in one statement. Uncleared rows are
    // deliberately excluded — they are not part of what the statement asserts.
    const locked = ctx.db
      .update(schema.transaction)
      .set({
        cleared: 'reconciled',
        reconciliationId,
        knowledgeAtChange: write.knowledge,
        updatedAt: ctx.now,
      })
      .where(
        and(
          eq(schema.transaction.planId, input.planId),
          eq(schema.transaction.accountId, input.accountId),
          eq(schema.transaction.cleared, 'cleared'),
          eq(schema.transaction.deleted, false),
        ),
      )
      .returning({ id: schema.transaction.id })
      .all()

    ctx.db
      .insert(schema.reconciliation)
      .values({
        id: reconciliationId,
        planId: input.planId,
        accountId: input.accountId,
        reconciledAt: ctx.now,
        statementDate: input.statementDate ?? ctx.today,
        statementBalance: input.statementBalance,
        // Kept so the adjustment stays explicable after the fact: without it, a later reader
        // sees an adjustment of some amount and no way to know what it corrected.
        priorClearedBalance,
        adjustmentTransactionId,
        performedByUserId: ctx.userId,
        knowledgeAtChange: write.knowledge,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()

    ctx.db
      .update(schema.account)
      .set({
        lastReconciledAt: ctx.now,
        balance: sql`${schema.account.balance} + ${difference}`,
        clearedBalance: input.statementBalance,
        knowledgeAtChange: write.knowledge,
        updatedAt: ctx.now,
      })
      .where(eq(schema.account.id, input.accountId))
      .run()

    if (difference !== ZERO) write.markDirtyFrom(`${ctx.today.slice(0, 7)}-01`)

    return {
      reconciliationId,
      priorClearedBalance,
      difference,
      adjustmentTransactionId,
      lockedCount: locked.length,
    }
  })
}

/** The adjustment payee is an ordinary, listable payee row (R57) — not hidden machinery. */
function reconciliationPayee(ctx: CommandContext, planId: string, knowledge: number): string {
  const existing = ctx.db
    .select({ id: schema.payee.id })
    .from(schema.payee)
    .where(
      and(
        eq(schema.payee.planId, planId),
        eq(schema.payee.internalKind, 'reconciliation_adjustment'),
      ),
    )
    .get()
  if (existing) return existing.id

  const id = ctx.newId()
  ctx.db
    .insert(schema.payee)
    .values({
      id,
      planId,
      name: 'Reconciliation Balance Adjustment',
      transferAccountId: null,
      internalKind: 'reconciliation_adjustment',
      lastCategoryId: null,
      knowledgeAtChange: knowledge,
      deleted: false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run()
  return id
}

/** Rows the statement does not yet account for. Shown during the flow, never altered by it. */
export const unclearedFor = (ctx: CommandContext, planId: string, accountId: string) =>
  ctx.db
    .select()
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.planId, planId),
        eq(schema.transaction.accountId, accountId),
        eq(schema.transaction.cleared, 'uncleared'),
        eq(schema.transaction.deleted, false),
        ne(schema.transaction.amount, ZERO),
      ),
    )
    .all()
