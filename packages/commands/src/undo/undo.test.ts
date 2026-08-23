import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { runProcedure } from '../procedures.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { deleteTransaction, updateTransaction } from '../transaction/mutate.ts'

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string
let groceries: string
let dining: string

const TODAY = '2026-08-22'

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
  const category = (name: string) =>
    h.db
      .select({ id: schema.category.id })
      .from(schema.category)
      .where(and(eq(schema.category.planId, planId), eq(schema.category.name, name)))
      .get()?.id ?? ''
  groceries = category('Groceries')
  dining = category('Dining Out')
})
afterEach(() => h.close())

const call = (name: 'undo.perform' | 'undo.redo' | 'undo.state') =>
  runProcedure(name, {
    db: h.db,
    userId: 'user-1',
    today: calendarDate(TODAY),
    rawInput: { planId },
  })

const spend = (amount: number, memo: string, categoryId = groceries) =>
  createTransaction(h.ctx, {
    planId,
    accountId: checking,
    date: calendarDate(TODAY),
    amount: milli(BigInt(amount)),
    categoryId,
    memo,
  }).transactionId

const txn = (id: string) =>
  h.db.select().from(schema.transaction).where(eq(schema.transaction.id, id)).get()

const balance = () =>
  h.db.select().from(schema.account).where(eq(schema.account.id, checking)).get()?.balance ?? ZERO

describe('undo', () => {
  it('reports what it would do before doing it', () => {
    expect(call('undo.state')).toEqual({ undo: null, redo: null })

    spend(-42_750, 'weekly shop')
    expect(call('undo.state')).toEqual({ undo: { label: 'Add transaction' }, redo: null })
  })

  it('refuses when there is nothing to undo', () => {
    expect(() => call('undo.perform')).toThrow(/nothing to undo/)
  })

  it('undoes a creation by removing it, and redo brings back the same row', () => {
    const id = spend(-42_750, 'weekly shop')
    expect(balance()).toBe(milli(957_250n))

    call('undo.perform')
    expect(txn(id)?.deleted).toBe(true)
    expect(balance()).toBe(milli(1_000_000n))

    call('undo.redo')
    // The same id, not a new one: a client's delta request has been tracking this row.
    expect(txn(id)?.deleted).toBe(false)
    expect(balance()).toBe(milli(957_250n))
  })

  it('undoes an edit by restoring every field, not only the ones that changed', () => {
    const id = spend(-42_750, 'weekly shop')
    updateTransaction(h.ctx, {
      planId,
      transactionId: id,
      amount: milli(-50_000n),
      categoryId: dining,
      memo: 'dinner',
    })

    call('undo.perform')

    const after = txn(id)
    expect(after?.amount).toBe(milli(-42_750n))
    expect(after?.categoryId).toBe(groceries)
    expect(after?.memo).toBe('weekly shop')
    expect(balance()).toBe(milli(957_250n))
  })

  it('undoes a deletion by restoring the row', () => {
    const id = spend(-42_750, 'weekly shop')
    deleteTransaction(h.ctx, { planId, transactionId: id })
    expect(balance()).toBe(milli(1_000_000n))

    call('undo.perform')
    expect(txn(id)?.deleted).toBe(false)
    expect(balance()).toBe(milli(957_250n))
  })

  it('walks back through several changes one at a time', () => {
    const first = spend(-10_000, 'one')
    const second = spend(-20_000, 'two')

    call('undo.perform')
    expect(txn(second)?.deleted).toBe(true)
    expect(txn(first)?.deleted).toBe(false)

    call('undo.perform')
    expect(txn(first)?.deleted).toBe(true)
    expect(balance()).toBe(milli(1_000_000n))
  })

  it('treats a grouped bulk action as one step', () => {
    const groupId = 'bulk-1'
    const ids = [spend(-10_000, 'one'), spend(-20_000, 'two'), spend(-30_000, 'three')]
    for (const transactionId of ids) {
      deleteTransaction(h.ctx, { planId, transactionId, groupId })
    }
    expect(balance()).toBe(milli(1_000_000n))

    call('undo.perform')

    // One press, all three back — not one row and a stack still eight deep.
    for (const id of ids) expect(txn(id)?.deleted).toBe(false)
    expect(balance()).toBe(milli(940_000n))
  })

  it('drops the redo stack once something new happens', () => {
    spend(-10_000, 'one')
    call('undo.perform')
    expect(call('undo.state')).toMatchObject({ redo: { label: 'Add transaction' } })

    spend(-20_000, 'two')
    expect(call('undo.state')).toMatchObject({ redo: null })
    expect(() => call('undo.redo')).toThrow(/nothing to redo/)
  })

  it('does not grow the stack while walking it', () => {
    spend(-10_000, 'one')
    const depth = () =>
      h.db.select().from(schema.undoEntry).where(eq(schema.undoEntry.planId, planId)).all().length

    expect(depth()).toBe(1)
    call('undo.perform')
    expect(depth()).toBe(1)
    call('undo.redo')
    expect(depth()).toBe(1)
  })

  it('keeps one person out of another person\u2019s stack', () => {
    spend(-10_000, 'mine')

    // A second editor on the same plan — so this tests stack isolation, not authorization.
    h.db.insert(schema.planMembership).values({ planId, userId: 'user-2', role: 'editor' }).run()

    const theirs = runProcedure('undo.state', {
      db: h.db,
      userId: 'user-2',
      today: calendarDate(TODAY),
      rawInput: { planId },
    })
    expect(theirs).toEqual({ undo: null, redo: null })
  })
})
