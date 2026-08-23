import { schema } from '@zerofold/db'
import { type Milliunits, ZERO } from '@zerofold/shared/money'
import { eq, sql } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'

/**
 * Which account types participate in the budget.
 *
 * Budget accounts hold money (or debt) that Ready to Assign accounts for. Tracking accounts
 * affect net worth only — which is why a transfer *to* one is real spending and categorisable,
 * while a transfer between two budget accounts is not (R44/R45).
 */
const ON_BUDGET_TYPES = new Set<schema.AccountType>([
  'checking',
  'savings',
  'cash',
  'creditCard',
  'lineOfCredit',
])

const CREDIT_TYPES = new Set<schema.AccountType>(['creditCard', 'lineOfCredit'])

export const isOnBudget = (type: schema.AccountType): boolean => ON_BUDGET_TYPES.has(type)
export const isCredit = (type: schema.AccountType): boolean => CREDIT_TYPES.has(type)

export interface CreateAccountInput {
  readonly planId: string
  readonly name: string
  readonly type: schema.AccountType
  /** Signed. Negative for a card or loan already carrying debt. */
  readonly balance: Milliunits
  readonly note?: string
}

export interface CreateAccountResult {
  readonly accountId: string
  readonly transferPayeeId: string
  readonly startingBalanceTransactionId: string | null
  readonly paymentCategoryId: string | null
}

export function createAccount(ctx: CommandContext, input: CreateAccountInput): CreateAccountResult {
  const name = input.name.trim()
  if (!name) throw new CommandError('an account needs a name', 'account.name_required')

  return withPlanWrite(ctx, input.planId, (write) => {
    const tx = ctx.db
    const accountId = ctx.newId()
    const onBudget = isOnBudget(input.type)
    const credit = isCredit(input.type)

    // The auto payee that represents this account as a transfer destination.
    const transferPayeeId = ctx.newId()
    tx.insert(schema.payee)
      .values({
        id: transferPayeeId,
        planId: input.planId,
        name: `Transfer : ${name}`,
        transferAccountId: accountId,
        internalKind: null,
        lastCategoryId: null,
        knowledgeAtChange: write.knowledge,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()

    /**
     * Opening debt is **uncovered**: no category ever funded it.
     *
     * This is the quantity a payment draws Ready to Assign against (R60'). It is seeded here
     * rather than inferred later, because it cannot be reconstructed from category balances
     * once uncategorised interest starts accruing against the same account (R63).
     */
    const uncoveredDebt = credit && input.balance < 0n ? (-input.balance as Milliunits) : ZERO

    const sortOrderRow = tx
      .select({ next: sql<number>`COALESCE(MAX(${schema.account.sortOrder}) + 1, 0)` })
      .from(schema.account)
      .where(eq(schema.account.planId, input.planId))
      .get()

    tx.insert(schema.account)
      .values({
        id: accountId,
        planId: input.planId,
        name,
        type: input.type,
        onBudget,
        closed: false,
        note: input.note ?? null,
        sortOrder: sortOrderRow?.next ?? 0,
        transferPayeeId,
        lastReconciledAt: null,
        openingBalance: input.balance,
        debtOriginalBalance: null,
        debtOriginationDate: null,
        debtInterestRates: null,
        debtMinimumPayments: null,
        debtEscrowAmounts: null,
        balance: input.balance,
        clearedBalance: input.balance,
        unclearedBalance: ZERO,
        uncoveredDebt,
        knowledgeAtChange: write.knowledge,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()

    /**
     * The credit-card payment category.
     *
     * It is a projection of the account, not a user entity: created with the account, removed
     * with it, and not renameable, movable or deletable on its own. Note it is created even
     * when the card opens in debt — opening debt creates **no** payment obligation, so the
     * category starts empty (R38).
     */
    let paymentCategoryId: string | null = null
    if (credit && onBudget) {
      const group = tx
        .select({ id: schema.categoryGroup.id })
        .from(schema.categoryGroup)
        .where(
          sql`${schema.categoryGroup.planId} = ${input.planId}
              AND ${schema.categoryGroup.internalKind} = 'credit_card_payments'`,
        )
        .get()
      if (!group) {
        throw new CommandError(
          'plan is missing its Credit Card Payments group',
          'plan.missing_internal_group',
        )
      }

      paymentCategoryId = ctx.newId()
      tx.insert(schema.category)
        .values({
          id: paymentCategoryId,
          planId: input.planId,
          categoryGroupId: group.id,
          name,
          note: null,
          hidden: false,
          sortOrder: sortOrderRow?.next ?? 0,
          // Our classification. The wire `internal` boolean is projected from this and is
          // FALSE for payment categories, despite the group being internal (R48).
          internalKind: 'credit_card_payment',
          creditAccountId: accountId,
          originalCategoryGroupId: null,
          knowledgeAtChange: write.knowledge,
          deleted: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run()
    }

    /**
     * The starting balance transaction.
     *
     * Categorised to Inflow: Ready to Assign whatever the sign and whatever the account — that
     * is what the oracle does. Whether it *counts* as income is a separate question the engine
     * answers: amounts on a credit account never do, either sign (R64), while a positive
     * balance on a cash account does (R22).
     */
    let startingBalanceTransactionId: string | null = null
    if (input.balance !== ZERO) {
      const startingPayeeId = ensureSystemPayee(
        ctx,
        input.planId,
        'starting_balance',
        write.knowledge,
      )
      const inflow = tx
        .select({ id: schema.category.id })
        .from(schema.category)
        .where(
          sql`${schema.category.planId} = ${input.planId}
              AND ${schema.category.internalKind} = 'inflow_rta'`,
        )
        .get()

      startingBalanceTransactionId = ctx.newId()
      tx.insert(schema.transaction)
        .values({
          id: startingBalanceTransactionId,
          planId: input.planId,
          accountId,
          date: ctx.today,
          amount: input.balance,
          memo: null,
          cleared: 'cleared',
          approved: true,
          flagColor: null,
          flagName: null,
          payeeId: startingPayeeId,
          categoryId: onBudget ? (inflow?.id ?? null) : null,
          transferAccountId: null,
          transferTransactionId: null,
          transferPairId: null,
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

      write.markDirtyFrom(`${ctx.today.slice(0, 7)}-01`)
    }

    return { accountId, transferPayeeId, startingBalanceTransactionId, paymentCategoryId }
  })
}

/** System payees are ordinary, listable rows — created on demand and reused (R57). */
function ensureSystemPayee(
  ctx: CommandContext,
  planId: string,
  kind: schema.PayeeKind,
  knowledge: number,
): string {
  const NAMES: Record<schema.PayeeKind, string> = {
    starting_balance: 'Starting Balance',
    reconciliation_adjustment: 'Reconciliation Balance Adjustment',
    manual_balance_adjustment: 'Manual Balance Adjustment',
  }
  const existing = ctx.db
    .select({ id: schema.payee.id })
    .from(schema.payee)
    .where(sql`${schema.payee.planId} = ${planId} AND ${schema.payee.internalKind} = ${kind}`)
    .get()
  if (existing) return existing.id

  const id = ctx.newId()
  ctx.db
    .insert(schema.payee)
    .values({
      id,
      planId,
      name: NAMES[kind],
      transferAccountId: null,
      internalKind: kind,
      lastCategoryId: null,
      knowledgeAtChange: knowledge,
      deleted: false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run()
  return id
}
