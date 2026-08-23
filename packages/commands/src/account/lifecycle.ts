import { schema } from '@zerofold/db'
import { ZERO } from '@zerofold/shared/money'
import { and, eq, or, sql } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'

export interface AccountRef {
  readonly planId: string
  readonly accountId: string
}

function loadAccount(ctx: CommandContext, ref: AccountRef) {
  const row = ctx.db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, ref.accountId), eq(schema.account.planId, ref.planId)))
    .get()
  if (!row || row.deleted) throw new CommandError('no such account', 'account.not_found')
  return row
}

/**
 * Close an account, keeping its history.
 *
 * Closing is our own operation: the oracle exposes no way to close an account from its UI at
 * any balance, offering only deletion (R66, divergence D7). Offering only deletion pushes
 * people toward discarding financial history in order to tidy a sidebar, which is the opposite
 * of what a budgeting tool should encourage.
 *
 * **A closed account must have a zero working balance.** A closed on-budget account still
 * holding money would keep contributing to Ready to Assign while being hidden from view, and a
 * closed tracking account holding a balance would keep moving net worth invisibly. Both are
 * incoherent, so the balance has to go somewhere explicit first — the caller moves or spends
 * it, then closes.
 */
export function closeAccount(ctx: CommandContext, ref: AccountRef): void {
  const acct = loadAccount(ctx, ref)
  if (acct.closed) return

  if (acct.balance !== ZERO) {
    throw new CommandError(
      `“${acct.name}” still has a balance. Move or spend it before closing the account, so the money does not stay in your budget while the account is hidden.`,
      'account.balance_not_zero',
    )
  }

  withPlanWrite(ctx, ref.planId, (write) => {
    ctx.db
      .update(schema.account)
      .set({ closed: true, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
      .where(eq(schema.account.id, ref.accountId))
      .run()

    // A closed credit account keeps its payment category, but hidden: the debt is settled, and
    // resurrecting the category on reopen is simpler than recreating it.
    ctx.db
      .update(schema.category)
      .set({ hidden: true, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
      .where(eq(schema.category.creditAccountId, ref.accountId))
      .run()

    audit(ctx, ref.planId, 'account.closed', ref.accountId, `closed “${acct.name}”`)
  })
}

export function reopenAccount(ctx: CommandContext, ref: AccountRef): void {
  const acct = loadAccount(ctx, ref)
  if (!acct.closed) return

  withPlanWrite(ctx, ref.planId, (write) => {
    ctx.db
      .update(schema.account)
      .set({ closed: false, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
      .where(eq(schema.account.id, ref.accountId))
      .run()
    ctx.db
      .update(schema.category)
      .set({ hidden: false, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
      .where(eq(schema.category.creditAccountId, ref.accountId))
      .run()
    audit(ctx, ref.planId, 'account.reopened', ref.accountId, `reopened “${acct.name}”`)
  })
}

/**
 * Delete an account and everything that only existed because of it.
 *
 * Destructive and retroactive: the account's transactions cease to exist, which removes their
 * income and moves Ready to Assign in every month from the earliest one onward (R23).
 *
 * Everything is **soft**-deleted. A hard delete would make the rows invisible to delta
 * requests, and a syncing client would keep them forever (R24).
 *
 * The confirmation requirement is divergence D6: the oracle deletes an account and its
 * transactions on a single unconfirmed click. Requiring the name to be typed is not
 * paternalism — it is the only guard between a misclick and unrecoverable financial history.
 */
export function deleteAccount(
  ctx: CommandContext,
  ref: AccountRef & { readonly confirmName: string },
): void {
  const acct = loadAccount(ctx, ref)
  if (ref.confirmName.trim() !== acct.name) {
    throw new CommandError(
      `To delete “${acct.name}” and its transactions, type the account name exactly.`,
      'account.confirmation_mismatch',
    )
  }

  withPlanWrite(ctx, ref.planId, (write) => {
    const stamp = { knowledgeAtChange: write.knowledge, deleted: true, updatedAt: ctx.now }

    // The earliest month this touches — everything from there forward must be recomputed.
    const earliest = ctx.db
      .select({ min: sql<string | null>`MIN(${schema.transaction.date})` })
      .from(schema.transaction)
      .where(
        and(
          eq(schema.transaction.planId, ref.planId),
          or(
            eq(schema.transaction.accountId, ref.accountId),
            eq(schema.transaction.transferAccountId, ref.accountId),
          ),
        ),
      )
      .get()

    // Both legs of every transfer touching this account. Deleting only the near side would
    // leave the far side pointing at an account that no longer exists — the invariant checker
    // would flag it, and the register would show a transfer to nowhere.
    ctx.db
      .update(schema.transaction)
      .set(stamp)
      .where(
        and(
          eq(schema.transaction.planId, ref.planId),
          or(
            eq(schema.transaction.accountId, ref.accountId),
            eq(schema.transaction.transferAccountId, ref.accountId),
          ),
        ),
      )
      .run()

    ctx.db
      .update(schema.scheduledTransaction)
      .set(stamp)
      .where(
        and(
          eq(schema.scheduledTransaction.planId, ref.planId),
          or(
            eq(schema.scheduledTransaction.accountId, ref.accountId),
            eq(schema.scheduledTransaction.transferAccountId, ref.accountId),
          ),
        ),
      )
      .run()

    // The payment category is a projection of the account and goes with it.
    ctx.db
      .update(schema.category)
      .set(stamp)
      .where(eq(schema.category.creditAccountId, ref.accountId))
      .run()

    // The transfer payee existed only to name this account as a destination.
    ctx.db
      .update(schema.payee)
      .set(stamp)
      .where(eq(schema.payee.transferAccountId, ref.accountId))
      .run()

    ctx.db.update(schema.account).set(stamp).where(eq(schema.account.id, ref.accountId)).run()

    if (earliest?.min) write.markDirtyFrom(`${earliest.min.slice(0, 7)}-01`)

    audit(
      ctx,
      ref.planId,
      'account.deleted',
      ref.accountId,
      `deleted “${acct.name}” and its transactions`,
    )
  })
}

function audit(
  ctx: CommandContext,
  planId: string,
  action: string,
  entityId: string,
  summary: string,
): void {
  ctx.db
    .insert(schema.auditEvent)
    .values({
      id: ctx.newId(),
      planId,
      userId: ctx.userId,
      at: ctx.now,
      action,
      entityType: 'account',
      entityId,
      summary,
      payload: null,
      ip: null,
    })
    .run()
}

/** Accounts that still appear in the sidebar. */
export const listOpenAccounts = (ctx: CommandContext, planId: string) =>
  ctx.db
    .select()
    .from(schema.account)
    .where(
      and(
        eq(schema.account.planId, planId),
        eq(schema.account.deleted, false),
        eq(schema.account.closed, false),
      ),
    )
    .orderBy(schema.account.sortOrder)
    .all()

/** Rows a delta request must report, tombstones included (R24). */
export const accountsChangedSince = (ctx: CommandContext, planId: string, knowledge: number) =>
  ctx.db
    .select()
    .from(schema.account)
    .where(
      and(
        eq(schema.account.planId, planId),
        sql`${schema.account.knowledgeAtChange} > ${knowledge}`,
      ),
    )
    .all()
