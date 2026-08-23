import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { reconcile } from './reconcile.ts'

let h: ReturnType<typeof testHarness>
let planId: string
let accountId: string
let groceries: string

beforeEach(() => {
  h = testHarness('2026-08-22')
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  // Opening balance is written cleared, so the account starts with cleared 100000.
  accountId = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(100_000),
  }).accountId
  groceries =
    h.db
      .select({ id: schema.category.id })
      .from(schema.category)
      .where(and(eq(schema.category.planId, planId), eq(schema.category.name, 'Groceries')))
      .get()?.id ?? ''
})
afterEach(() => h.close())

const account = () =>
  h.db.select().from(schema.account).where(eq(schema.account.id, accountId)).get()
const rows = () =>
  h.db.select().from(schema.transaction).where(eq(schema.transaction.accountId, accountId)).all()

const addUncleared = (amount = -12_000) =>
  createTransaction(h.ctx, {
    planId,
    accountId,
    date: calendarDate('2026-08-20'),
    amount: milli(amount),
    categoryId: groceries,
  }).transactionId

describe('reconcile compares against the CLEARED balance (R55)', () => {
  it('ignores uncleared rows entirely', () => {
    addUncleared(-12_000)
    expect(account()?.clearedBalance).toBe(100_000n)
    expect(account()?.balance).toBe(88_000n)

    // Matching the cleared balance means no adjustment, even though the working balance differs.
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(100_000) })
    expect(result.difference).toBe(0n)
    expect(result.adjustmentTransactionId).toBeNull()
  })

  it('leaves uncleared rows uncleared', () => {
    const unclearedId = addUncleared()
    reconcile(h.ctx, { planId, accountId, statementBalance: milli(100_000) })
    const row = rows().find((r) => r.id === unclearedId)
    expect(row?.cleared).toBe('uncleared')
  })
})

describe('reconcile locks cleared rows (R56)', () => {
  it('flips every cleared row to reconciled in bulk', () => {
    // `reconciled` is never set at entry time — only this command may write it.
    expect(rows().every((r) => r.cleared === 'cleared')).toBe(true)
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(100_000) })
    expect(result.lockedCount).toBe(1)
    expect(rows().find((r) => r.memo === null)?.cleared).toBe('reconciled')
  })
})

describe('the adjustment (R57)', () => {
  it('is the difference between statement and cleared', () => {
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    expect(result.priorClearedBalance).toBe(100_000n)
    expect(result.difference).toBe(-15_000n)

    const adjustment = rows().find((r) => r.id === result.adjustmentTransactionId)
    expect(adjustment?.amount).toBe(-15_000n)
    expect(adjustment?.cleared).toBe('reconciled')
    expect(adjustment?.approved).toBe(true)
  })

  it('is categorised to Inflow: Ready to Assign, not to a spending category', () => {
    // An unexplained discrepancy is not spending. Booking it to a category would attribute
    // money to something the user never bought.
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    const adjustment = rows().find((r) => r.id === result.adjustmentTransactionId)
    const category = h.db
      .select()
      .from(schema.category)
      .where(eq(schema.category.id, adjustment?.categoryId as string))
      .get()
    expect(category?.internalKind).toBe('inflow_rta')
  })

  it('uses an ordinary, listable payee', () => {
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    const adjustment = rows().find((r) => r.id === result.adjustmentTransactionId)
    const payee = h.db
      .select()
      .from(schema.payee)
      .where(eq(schema.payee.id, adjustment?.payeeId as string))
      .get()
    expect(payee?.name).toBe('Reconciliation Balance Adjustment')
    expect(payee?.deleted).toBe(false)
  })

  it('reuses the same payee across reconciliations', () => {
    reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    reconcile(h.ctx, { planId, accountId, statementBalance: milli(70_000) })
    const payees = h.db
      .select()
      .from(schema.payee)
      .where(eq(schema.payee.internalKind, 'reconciliation_adjustment'))
      .all()
    expect(payees).toHaveLength(1)
  })

  it('leaves the cleared balance equal to the statement', () => {
    reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    expect(account()?.clearedBalance).toBe(85_000n)
  })

  it('adjusts the working balance by the same difference', () => {
    addUncleared(-12_000) // working 88000, cleared 100000
    reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    // cleared 100000 → 85000 is −15000, so working 88000 → 73000, and the uncleared
    // −12000 is still outstanding.
    expect(account()?.balance).toBe(73_000n)
    expect(account()?.unclearedBalance).toBe(-12_000n)
  })

  it('writes no adjustment when the balances already agree', () => {
    const before = rows().length
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(100_000) })
    expect(result.adjustmentTransactionId).toBeNull()
    expect(rows()).toHaveLength(before)
  })
})

describe('the reconciliation record (R58)', () => {
  it('stamps the account and keeps the prior balance so the adjustment stays explicable', () => {
    expect(account()?.lastReconciledAt).toBeNull()
    const result = reconcile(h.ctx, { planId, accountId, statementBalance: milli(85_000) })
    expect(account()?.lastReconciledAt).toBe(h.ctx.now)

    const record = h.db
      .select()
      .from(schema.reconciliation)
      .where(eq(schema.reconciliation.id, result.reconciliationId))
      .get()
    // Without priorClearedBalance a later reader sees an adjustment and no way to know what
    // it corrected.
    expect(record?.priorClearedBalance).toBe(100_000n)
    expect(record?.statementBalance).toBe(85_000n)
    expect(record?.adjustmentTransactionId).toBe(result.adjustmentTransactionId)
  })
})

describe('guards', () => {
  it('refuses a closed account', () => {
    h.db.update(schema.account).set({ closed: true }).where(eq(schema.account.id, accountId)).run()
    expect(() => reconcile(h.ctx, { planId, accountId, statementBalance: ZERO })).toThrow(/closed/)
  })
})
