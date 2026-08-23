import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from './create-transaction.ts'
import { listTransactions } from './list.ts'

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
    balance: ZERO,
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

const add = (n: number, accountId = checking) => {
  for (let i = 0; i < n; i++) {
    const day = String(1 + (i % 20)).padStart(2, '0')
    createTransaction(h.ctx, {
      planId,
      accountId,
      date: calendarDate(`2026-08-${day}`),
      amount: milli(-(i + 1) * 100),
      categoryId: groceries,
      memo: `row ${i}`,
    })
  }
}

describe('listTransactions', () => {
  it('returns newest first', () => {
    add(5)
    const { rows } = listTransactions(h.db, { planId, accountId: checking })
    const dates = rows.map((r) => r.date)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('joins the names the register displays', () => {
    add(1)
    const { rows } = listTransactions(h.db, { planId, accountId: checking })
    expect(rows[0]?.accountName).toBe('Everyday')
    expect(rows[0]?.categoryName).toBe('Groceries')
  })

  it('scopes to one account, and omits it for the All Accounts view', () => {
    add(3, checking)
    add(2, savings)
    expect(listTransactions(h.db, { planId, accountId: checking }).rows).toHaveLength(3)
    expect(listTransactions(h.db, { planId, accountId: savings }).rows).toHaveLength(2)
    expect(listTransactions(h.db, { planId }).rows).toHaveLength(5)
  })

  it('pages by keyset, covering every row exactly once', () => {
    // The property that matters: an OFFSET page would repeat or skip rows as soon as two rows
    // share a date, and here most of them do.
    add(50)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = listTransactions(h.db, {
        planId,
        accountId: checking,
        limit: 7,
        cursor: cursor ?? undefined,
      })
      seen.push(...page.rows.map((r) => r.id))
      cursor = page.nextCursor
      pages++
      expect(pages, 'pagination should terminate').toBeLessThan(20)
    } while (cursor)

    expect(seen).toHaveLength(50)
    expect(new Set(seen).size, 'no row appears twice').toBe(50)
  })

  it('reports no cursor on the last page', () => {
    add(3)
    const { nextCursor } = listTransactions(h.db, { planId, accountId: checking, limit: 10 })
    expect(nextCursor).toBeNull()
  })

  it('excludes deleted rows', () => {
    add(3)
    const first = listTransactions(h.db, { planId, accountId: checking }).rows[0]
    h.db
      .update(schema.transaction)
      .set({ deleted: true })
      .where(eq(schema.transaction.id, first?.id as string))
      .run()
    expect(listTransactions(h.db, { planId, accountId: checking }).rows).toHaveLength(2)
  })
})

describe('the uncategorized filter', () => {
  it('does not flag a split parent or a budget-to-budget transfer', () => {
    // A split parent's categories live on its parts, and a transfer between budget accounts
    // correctly has no category (R45). Neither needs the user's attention, so neither belongs
    // in a filter whose purpose is "these need categorising".
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-100_000),
      subtransactions: [
        { amount: milli(-60_000), categoryId: groceries },
        { amount: milli(-40_000), categoryId: groceries },
      ],
    })
    const transferPayee = h.db
      .select({ id: schema.payee.id })
      .from(schema.payee)
      .where(eq(schema.payee.transferAccountId, savings))
      .get()?.id as string
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-19'),
      amount: milli(-5_000),
      payeeId: transferPayee,
    })
    // …and one that genuinely does need a category.
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-18'),
      amount: milli(-1_000),
    })

    const { rows } = listTransactions(h.db, { planId, uncategorizedOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.amount).toBe(-1_000n)
  })
})

describe('the unapproved filter', () => {
  it('returns only rows awaiting approval', () => {
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-1_000),
      categoryId: groceries,
      approved: false,
    })
    add(2)
    const { rows } = listTransactions(h.db, { planId, unapprovedOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.approved).toBe(false)
  })
})
