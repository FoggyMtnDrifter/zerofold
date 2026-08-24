import { schema } from '@zerofold/db'
import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { incomeReport, netWorthReport, spendingReport } from './reports.ts'

/**
 * Reports.
 *
 * The thing worth testing is what each one *excludes*, because every wrong report in this
 * domain is wrong by double-counting or by counting a transfer as spending.
 */

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string
let savings: string

const TODAY = '2026-08-24'
const JUL = budgetMonth('2026-07-01')
const AUG = budgetMonth('2026-08-01')
const PERIOD = { from: JUL, through: AUG }

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: ZERO,
  }).accountId
  savings = createAccount(h.ctx, {
    planId,
    name: 'Savings',
    type: 'savings',
    balance: ZERO,
  }).accountId
})
afterEach(() => h.close())

const categoryId = (name: string) =>
  h.db
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(and(eq(schema.category.planId, planId), eq(schema.category.name, name)))
    .get()?.id ?? ''

const spend = (date: string, amount: number, category: string, account = checking) =>
  createTransaction(h.ctx, {
    planId,
    accountId: account,
    date: calendarDate(date),
    amount: milli(amount),
    categoryId: categoryId(category),
  })

const earn = (date: string, amount: number, account = checking) =>
  spend(date, amount, 'Inflow: Ready to Assign', account)

describe('spending', () => {
  it('totals by category, biggest outflow first', () => {
    spend('2026-07-05', -40_000, 'Groceries')
    spend('2026-08-05', -60_000, 'Groceries')
    spend('2026-08-06', -25_000, 'Transport')

    const report = spendingReport(h.db, planId, PERIOD)
    expect(report.total).toBe(milli(-125_000))
    expect(report.byCategory[0]).toMatchObject({ name: 'Groceries', amount: milli(-100_000) })
    expect(report.byCategory[1]).toMatchObject({ name: 'Transport', amount: milli(-25_000) })
  })

  it('splits by month across the period', () => {
    spend('2026-07-05', -40_000, 'Groceries')
    spend('2026-08-05', -60_000, 'Groceries')

    expect(spendingReport(h.db, planId, PERIOD).byMonth).toEqual([
      { month: JUL, amount: milli(-40_000) },
      { month: AUG, amount: milli(-60_000) },
    ])
  })

  it('does not count income as negative spending', () => {
    earn('2026-08-01', 500_000)
    spend('2026-08-05', -60_000, 'Groceries')

    expect(spendingReport(h.db, planId, PERIOD).total).toBe(milli(-60_000))
  })

  it('does not count a transfer between accounts as spending', () => {
    const toSavings =
      h.db
        .select({ id: schema.payee.id })
        .from(schema.payee)
        .where(and(eq(schema.payee.planId, planId), eq(schema.payee.transferAccountId, savings)))
        .get()?.id ?? ''

    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-10'),
      amount: milli(-200_000),
      payeeId: toSavings,
    })

    expect(spendingReport(h.db, planId, PERIOD).total).toBe(ZERO)
  })

  it('counts a card purchase once, not again when the card is paid', () => {
    const visa = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: ZERO,
    }).accountId
    spend('2026-08-05', -50_000, 'Groceries', visa)

    const toVisa =
      h.db
        .select({ id: schema.payee.id })
        .from(schema.payee)
        .where(and(eq(schema.payee.planId, planId), eq(schema.payee.transferAccountId, visa)))
        .get()?.id ?? ''
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-50_000),
      payeeId: toVisa,
    })

    // The purchase, once. Paying the card moves money that was already counted.
    expect(spendingReport(h.db, planId, PERIOD).total).toBe(milli(-50_000))
  })

  it('ignores anything outside the period', () => {
    spend('2026-06-30', -99_000, 'Groceries')
    spend('2026-07-01', -1_000, 'Groceries')
    expect(spendingReport(h.db, planId, PERIOD).total).toBe(milli(-1_000))
  })

  it('includes the last day of the final month', () => {
    // July, because a transaction cannot be dated in the future (ADR-0007) and today is the
    // 24th of August — so the only month whose last day is available to test is a past one.
    spend('2026-07-31', -5_000, 'Groceries')
    expect(spendingReport(h.db, planId, { from: JUL, through: JUL }).total).toBe(milli(-5_000))
  })
})

describe('income against spending', () => {
  it('pairs them per month and nets them', () => {
    earn('2026-07-02', 300_000)
    spend('2026-07-05', -40_000, 'Groceries')
    earn('2026-08-02', 300_000)
    spend('2026-08-05', -400_000, 'Groceries')

    const report = incomeReport(h.db, planId, PERIOD)
    expect(report.totalIncome).toBe(milli(600_000))
    expect(report.byMonth[0]).toMatchObject({ net: milli(260_000) })
    expect(report.byMonth[1]).toMatchObject({ net: milli(-100_000) })
  })

  it('does not treat money arriving on a card as income (R64)', () => {
    const visa = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: ZERO,
    }).accountId
    earn('2026-08-02', 20_000, visa)

    expect(incomeReport(h.db, planId, PERIOD).totalIncome).toBe(ZERO)
  })
})

describe('net worth', () => {
  it('carries a balance forward through a month with no activity', () => {
    earn('2026-07-02', 300_000)

    const points = netWorthReport(h.db, planId, PERIOD)
    expect(points[0]?.net).toBe(milli(300_000))
    // August had nothing in it, and the money did not disappear.
    expect(points[1]?.net).toBe(milli(300_000))
  })

  it('counts an account by where its balance stands, not by its type', () => {
    // A savings account overdrawn is a liability that month, whatever it is called.
    earn('2026-07-02', 100_000)
    spend('2026-07-03', -150_000, 'Groceries', savings)

    const july = netWorthReport(h.db, planId, PERIOD)[0]
    expect(july?.assets).toBe(milli(100_000))
    expect(july?.liabilities).toBe(milli(-150_000))
    expect(july?.net).toBe(milli(-50_000))
  })

  it('includes accounts that are not in the budget', () => {
    const mortgage = createAccount(h.ctx, {
      planId,
      name: 'Mortgage',
      type: 'mortgage',
      balance: milli(-250_000_000),
    }).accountId
    expect(mortgage).toBeTruthy()

    const august = netWorthReport(h.db, planId, PERIOD).at(-1)
    expect(august?.liabilities).toBe(milli(-250_000_000))
  })

  it('counts history from before the window in the opening position', () => {
    earn('2026-05-02', 400_000)
    const points = netWorthReport(h.db, planId, PERIOD)
    // May is outside the period, and the money is still there in July.
    expect(points[0]?.net).toBe(milli(400_000))
  })
})
