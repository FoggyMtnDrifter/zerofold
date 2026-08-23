import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from './create-transaction.ts'
import { deleteTransaction, updateTransaction } from './mutate.ts'

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string
let savings: string
let groceries: string

beforeEach(() => {
  h = testHarness('2026-08-22')
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
  savings = createAccount(h.ctx, {
    planId,
    name: 'Savings',
    type: 'savings',
    balance: ZERO,
  }).accountId
  groceries =
    h.db
      .select({ id: schema.category.id })
      .from(schema.category)
      .where(and(eq(schema.category.planId, planId), eq(schema.category.name, 'Groceries')))
      .get()?.id ?? ''
})
afterEach(() => h.close())

const txn = (id: string) =>
  h.db.select().from(schema.transaction).where(eq(schema.transaction.id, id)).get()
const account = (id: string) =>
  h.db.select().from(schema.account).where(eq(schema.account.id, id)).get()
const transferPayeeFor = (accountId: string) =>
  h.db
    .select({ id: schema.payee.id })
    .from(schema.payee)
    .where(eq(schema.payee.transferAccountId, accountId))
    .get()?.id as string

const spend = (amount = -25_000, date = '2026-08-20') =>
  createTransaction(h.ctx, {
    planId,
    accountId: checking,
    date: calendarDate(date),
    amount: milli(amount),
    categoryId: groceries,
  }).transactionId

const transfer = (amount = -50_000) =>
  createTransaction(h.ctx, {
    planId,
    accountId: checking,
    date: calendarDate('2026-08-20'),
    amount: milli(amount),
    payeeId: transferPayeeFor(savings),
  })

describe('updateTransaction', () => {
  it('adjusts the balance by the difference, not the new amount', () => {
    const id = spend(-25_000)
    expect(account(checking)?.balance).toBe(975_000n)
    updateTransaction(h.ctx, { planId, transactionId: id, amount: milli(-40_000) })
    expect(account(checking)?.balance).toBe(960_000n)
  })

  it('moves the amount between cleared and uncleared when the status changes', () => {
    // Computing a delta on the amount alone would be wrong here: the money has to move
    // between two different columns even though the amount did not change.
    const id = spend(-25_000)
    expect(account(checking)?.unclearedBalance).toBe(-25_000n)
    updateTransaction(h.ctx, { planId, transactionId: id, cleared: 'cleared' })
    const a = account(checking)
    expect(a?.unclearedBalance).toBe(0n)
    expect(a?.clearedBalance).toBe(975_000n)
    expect(a?.balance).toBe(975_000n)
  })

  it('refuses a future date', () => {
    const id = spend()
    expect(() =>
      updateTransaction(h.ctx, {
        planId,
        transactionId: id,
        date: calendarDate('2026-09-01'),
      }),
    ).toThrow(/in the future/)
  })

  it('dirties both the old and the new month when a date moves', () => {
    const id = spend(-25_000, '2026-08-20')
    updateTransaction(h.ctx, { planId, transactionId: id, date: calendarDate('2026-06-15') })
    const recalc = h.db
      .select()
      .from(schema.planRecalc)
      .where(eq(schema.planRecalc.planId, planId))
      .get()
    expect(recalc?.dirtyFromMonth, 'the earlier of the two').toBe('2026-06-01')
  })
})

describe('transfer pairs stay in step', () => {
  it('propagates an amount change to the far leg and both balances', () => {
    const { transactionId, counterpartId } = transfer(-50_000)
    updateTransaction(h.ctx, { planId, transactionId, amount: milli(-75_000) })

    expect(txn(transactionId)?.amount).toBe(-75_000n)
    expect(txn(counterpartId as string)?.amount).toBe(75_000n)
    expect(account(checking)?.balance).toBe(925_000n)
    expect(account(savings)?.balance).toBe(75_000n)
  })

  it('propagates a date change to the far leg', () => {
    // A date is a property of the movement, not of one side of it. A pair that disagrees looks
    // correct in either register alone and makes the plan's totals wrong.
    const { transactionId, counterpartId } = transfer()
    updateTransaction(h.ctx, { planId, transactionId, date: calendarDate('2026-07-04') })
    expect(txn(counterpartId as string)?.date).toBe('2026-07-04')
  })

  it('does NOT propagate cleared status — that is per side', () => {
    // Clearing one side says the money left one account, which is independent of whether it
    // has landed in the other.
    const { transactionId, counterpartId } = transfer()
    updateTransaction(h.ctx, { planId, transactionId, cleared: 'cleared' })
    expect(txn(transactionId)?.cleared).toBe('cleared')
    expect(txn(counterpartId as string)?.cleared).toBe('uncleared')
  })
})

describe('deleteTransaction', () => {
  it('soft-deletes and reverses the balance', () => {
    const id = spend(-25_000)
    deleteTransaction(h.ctx, { planId, transactionId: id })
    expect(txn(id)?.deleted).toBe(true)
    expect(account(checking)?.balance).toBe(1_000_000n)
  })

  it('deletes both legs of a transfer and reverses both balances', () => {
    const { transactionId, counterpartId } = transfer(-50_000)
    deleteTransaction(h.ctx, { planId, transactionId })
    expect(txn(transactionId)?.deleted).toBe(true)
    expect(txn(counterpartId as string)?.deleted).toBe(true)
    expect(account(checking)?.balance).toBe(1_000_000n)
    expect(account(savings)?.balance).toBe(0n)
  })

  it('deletes a split parent together with its parts', () => {
    const { transactionId, subtransactionIds } = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-100_000),
      subtransactions: [
        { amount: milli(-60_000), categoryId: groceries },
        { amount: milli(-40_000), categoryId: null },
      ],
    })
    deleteTransaction(h.ctx, { planId, transactionId })
    for (const id of subtransactionIds) {
      const sub = h.db
        .select()
        .from(schema.subtransaction)
        .where(eq(schema.subtransaction.id, id))
        .get()
      expect(sub?.deleted).toBe(true)
    }
  })

  it('is not findable afterwards', () => {
    const id = spend()
    deleteTransaction(h.ctx, { planId, transactionId: id })
    expect(() => deleteTransaction(h.ctx, { planId, transactionId: id })).toThrow(/No such/)
  })
})

describe('reconciled rows are locked (R71)', () => {
  const reconciled = () => {
    const id = spend(-25_000)
    h.db
      .update(schema.transaction)
      .set({ cleared: 'reconciled' })
      .where(eq(schema.transaction.id, id))
      .run()
    return id
  }

  it('refuses a casual edit', () => {
    expect(() =>
      updateTransaction(h.ctx, { planId, transactionId: reconciled(), amount: milli(-1) }),
    ).toThrow(/reconciled/)
  })

  it('refuses a casual delete', () => {
    expect(() => deleteTransaction(h.ctx, { planId, transactionId: reconciled() })).toThrow(
      /reconciled/,
    )
  })

  it('permits a deliberate one — it is the user’s data', () => {
    const id = reconciled()
    updateTransaction(h.ctx, { planId, transactionId: id, amount: milli(-30_000), force: true })
    expect(txn(id)?.amount).toBe(-30_000n)
  })
})
