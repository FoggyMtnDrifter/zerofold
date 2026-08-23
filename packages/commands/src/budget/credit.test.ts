import { schema } from '@zerofold/db'
import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { assign } from './assign.ts'
import { budgetView } from './view.ts'

/**
 * Credit cards through the command layer.
 *
 * The engine's own tests prove the rules; these prove the queries that feed it — which is where
 * the interesting failures live. The first one found here was a cash transaction arriving with
 * `isCash: false` because a raw SQL expression returned a BigInt, which made every cash purchase
 * behave like a card charge and showed up as a figure that would not move.
 */

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string
let visa: string

const TODAY = '2026-08-22'
const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
  visa = createAccount(h.ctx, { planId, name: 'Visa', type: 'creditCard', balance: ZERO }).accountId
})
afterEach(() => h.close())

const categoryId = (name: string) =>
  h.db
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(and(eq(schema.category.planId, planId), eq(schema.category.name, name)))
    .get()?.id ?? ''

const view = (month = AUG) => budgetView(h.db, planId, month, AUG)

const cell = (name: string, month = AUG) =>
  view(month)
    .groups.flatMap((g) => g.categories)
    .find((c) => c.name === name)

const put = (name: string, amount: number, month = AUG) =>
  assign(h.ctx, { planId, month, categoryId: categoryId(name), budgeted: milli(amount) }, AUG)

const charge = (accountId: string, amount: number, category: string | null, date = TODAY) =>
  createTransaction(h.ctx, {
    planId,
    accountId,
    date: calendarDate(date),
    amount: milli(amount),
    ...(category === null ? {} : { categoryId: categoryId(category) }),
  }).transactionId

describe('a credit account', () => {
  it('brings a payment category with it, named for the card', () => {
    expect(cell('Visa')).toBeDefined()
    expect(cell('Visa')?.balance).toBe(ZERO)
  })

  it('moves what the category can afford into the payment category (R1)', () => {
    put('Groceries', 100_000)
    charge(visa, -140_000, 'Groceries')

    expect(cell('Groceries')?.balance).toBe(milli(-40_000))
    expect(cell('Groceries')?.overspendKind).toBe('credit')
    expect(cell('Visa')?.balance).toBe(milli(100_000))
    // Nothing left the budget, so Ready to Assign is untouched (R4/R61).
    expect(view(SEP).readyToAssign).toBe(milli(900_000))
  })

  it('spends cash before it covers the card (R2)', () => {
    put('Groceries', 100_000)
    charge(visa, -80_000, 'Groceries', '2026-08-05')
    charge(checking, -60_000, 'Groceries', '2026-08-15')

    // Cash takes 60000 first even though it is later, leaving 40000 to cover an 80000 charge.
    expect(cell('Visa')?.balance).toBe(milli(40_000))
    expect(cell('Groceries')?.balance).toBe(milli(-40_000))
    expect(cell('Groceries')?.overspendKind).toBe('credit')
  })

  it('counts a cash overspend against the next month and a credit one against nothing', () => {
    put('Groceries', 0)
    charge(checking, -30_000, 'Groceries')
    put('Transport', 0)
    charge(visa, -30_000, 'Transport')

    expect(cell('Groceries')?.overspendKind).toBe('cash')
    expect(cell('Transport')?.overspendKind).toBe('credit')
    // Only the cash half is billed forward.
    expect(view(SEP).readyToAssign).toBe(milli(970_000))
  })
})

describe('paying a card', () => {
  it('draws down the payment category and leaves Ready to Assign alone (R60′)', () => {
    put('Groceries', 100_000)
    charge(visa, -60_000, 'Groceries')

    const before = view().readyToAssign
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate(TODAY),
      amount: milli(-60_000),
      payeeId: transferPayeeFor(visa),
    })

    expect(cell('Visa')?.balance).toBe(ZERO)
    expect(view().readyToAssign).toBe(before)
  })

  it('paying debt no category funded comes out of Ready to Assign', () => {
    // A second card that arrives already owing money.
    const store = createAccount(h.ctx, {
      planId,
      name: 'Store Card',
      type: 'creditCard',
      balance: milli(-50_000),
    }).accountId

    // The opening balance is not income (R37), so nothing has changed yet.
    expect(view().readyToAssign).toBe(milli(1_000_000))

    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate(TODAY),
      amount: milli(-9_000),
      payeeId: transferPayeeFor(store),
    })

    expect(view().readyToAssign).toBe(milli(991_000))
    expect(cell('Store Card')?.balance).toBe(milli(-9_000))
    // A payment category in the red is not overspending and must not be flagged as such.
    expect(cell('Store Card')?.overspendKind).toBe('none')
  })

  it('an uncategorised charge on a card is debt the budget has never seen (R63)', () => {
    charge(visa, -3_000, null)

    expect(view().readyToAssign).toBe(milli(1_000_000))
    expect(cell('Visa')?.balance).toBe(ZERO)
  })
})

/** The payee that expresses "transfer to this account". */
function transferPayeeFor(accountId: string): string {
  return (
    h.db
      .select({ id: schema.payee.id })
      .from(schema.payee)
      .where(and(eq(schema.payee.planId, planId), eq(schema.payee.transferAccountId, accountId)))
      .get()?.id ?? ''
  )
}
