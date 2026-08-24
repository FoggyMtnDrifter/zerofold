import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { makeContext } from '../context.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { listTransactions } from '../transaction/list.ts'
import {
  createScheduled,
  deleteScheduled,
  enterDueTransactions,
  listUpcoming,
} from './scheduled.ts'

/**
 * Scheduled transactions.
 *
 * The rules the scheduler has to get right are that it back-fills *every* missed occurrence
 * rather than the latest one (R53), and that running it again enters nothing. Those two pull in
 * opposite directions, so most of these tests are about the second one.
 */

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string

const TODAY = '2026-08-23'

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
})
afterEach(() => h.close())

/** A context whose today is a later date, for stepping the clock without touching the data. */
const on = (date: string) => makeContext(h.db, 'user-1', calendarDate(date), `${date}T12:00:00Z`)

const schedule = (
  frequency: Parameters<typeof createScheduled>[1]['frequency'],
  date = '2026-08-16',
) =>
  createScheduled(h.ctx, {
    planId,
    accountId: checking,
    date: calendarDate(date),
    frequency,
    amount: milli(-25_000),
    memo: 'rent',
  }).scheduledTransactionId

const entered = () =>
  listTransactions(h.db, { planId, accountId: checking, limit: 500 }).rows.filter(
    (r) => r.memo === 'rent',
  )

describe('creating a schedule', () => {
  it('settles date_next rather than returning it unadvanced (R50)', () => {
    const id = schedule('weekly')
    const row = h.db
      .select()
      .from(schema.scheduledTransaction)
      .where(eq(schema.scheduledTransaction.id, id))
      .get()

    expect(row?.dateNext).toBe('2026-08-16')
    expect(row?.autoEnter).toBe(true)
  })

  it('refuses a start more than a week in the past (R49)', () => {
    expect(() =>
      createScheduled(h.ctx, {
        planId,
        accountId: checking,
        date: calendarDate('2026-01-31'),
        frequency: 'monthly',
        amount: milli(-1),
      }),
    ).toThrow(/more than a week in the past/)
  })

  it('accepts one exactly inside the week-long overlap', () => {
    expect(() => schedule('monthly', '2026-08-16')).not.toThrow()
  })
})

describe('R53 — auto-entry back-fills every missed occurrence', () => {
  it('enters one row per elapsed occurrence, not just the latest', () => {
    schedule('daily')
    const result = enterDueTransactions(h.ctx, planId)

    // 16th through 23rd inclusive.
    expect(result.entered).toBe(8)
    expect(entered()).toHaveLength(8)
  })

  it('leaves them unapproved and uncleared, so they are offered rather than assumed', () => {
    schedule('weekly')
    enterDueTransactions(h.ctx, planId)

    const rows = entered()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.approved).toBe(false)
      expect(row.cleared).toBe('uncleared')
    }
  })

  it('links each row back to the schedule that made it', () => {
    const id = schedule('weekly')
    enterDueTransactions(h.ctx, planId)

    const rows = h.db
      .select()
      .from(schema.transaction)
      .where(eq(schema.transaction.scheduledTransactionId, id))
      .all()
    expect(rows).toHaveLength(2)
  })
})

describe('idempotence', () => {
  it('enters nothing the second time', () => {
    schedule('daily')
    expect(enterDueTransactions(h.ctx, planId).entered).toBe(8)
    expect(enterDueTransactions(h.ctx, planId).entered).toBe(0)
    expect(entered()).toHaveLength(8)
  })

  it('catches up after downtime without re-entering what it already did', () => {
    schedule('daily')
    enterDueTransactions(h.ctx, planId)
    expect(entered()).toHaveLength(8)

    // A fortnight later, as if the server had been off.
    const later = on('2026-09-06')
    expect(enterDueTransactions(later, planId).entered).toBe(14)
    expect(entered()).toHaveLength(22)

    // And again, immediately: nothing.
    expect(enterDueTransactions(later, planId).entered).toBe(0)
  })

  it('does not run ahead of today', () => {
    schedule('monthly')
    enterDueTransactions(h.ctx, planId)
    // Only August's occurrence exists; September's is in the future.
    expect(entered()).toHaveLength(1)
  })
})

describe('R54 — a one-off is consumed by its own entry', () => {
  it('enters once and then stops being a schedule', () => {
    const id = schedule('never')
    const result = enterDueTransactions(h.ctx, planId)

    expect(result.entered).toBe(1)
    expect(result.consumed).toBe(1)
    expect(entered()).toHaveLength(1)

    const row = h.db
      .select()
      .from(schema.scheduledTransaction)
      .where(eq(schema.scheduledTransaction.id, id))
      .get()
    // Soft deleted rather than removed, so a syncing client is told (divergence D12).
    expect(row?.deleted).toBe(true)

    expect(enterDueTransactions(h.ctx, planId).entered).toBe(0)
  })
})

describe('the extensions YNAB’s UI has and its API does not (D3)', () => {
  it('stops at an end date', () => {
    createScheduled(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-16'),
      frequency: 'daily',
      amount: milli(-1_000),
      memo: 'rent',
      endDate: calendarDate('2026-08-19'),
    })

    expect(enterDueTransactions(h.ctx, planId).entered).toBe(4)
    expect(enterDueTransactions(on('2026-09-30'), planId).entered).toBe(0)
  })

  it('stops after a count', () => {
    createScheduled(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-16'),
      frequency: 'daily',
      amount: milli(-1_000),
      memo: 'rent',
      endAfterOccurrences: 3,
    })

    expect(enterDueTransactions(h.ctx, planId).entered).toBe(3)
    expect(enterDueTransactions(on('2026-09-30'), planId).entered).toBe(0)
  })
})

describe('what is coming up', () => {
  it('lists occurrences in date order across schedules', () => {
    createScheduled(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-25'),
      frequency: 'monthly',
      amount: milli(-120_000),
      memo: 'rent',
    })
    createScheduled(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-24'),
      frequency: 'weekly',
      amount: milli(-3_000),
      memo: 'coffee',
    })

    const upcoming = listUpcoming(h.ctx, planId, calendarDate('2026-09-02'))
    expect(upcoming.map((o) => o.date)).toEqual(
      ['2026-08-24', '2026-08-25', '2026-08-31'].map(calendarDate),
    )
  })

  it('drops a deleted schedule', () => {
    const id = schedule('weekly', '2026-08-24')
    deleteScheduled(h.ctx, { planId, scheduledTransactionId: id })
    expect(listUpcoming(h.ctx, planId, calendarDate('2026-09-02'))).toEqual([])
  })
})

describe('R20 — a schedule changes nothing until it is entered', () => {
  it('leaves the account balance alone', () => {
    const before = h.db
      .select({ balance: schema.account.balance })
      .from(schema.account)
      .where(eq(schema.account.id, checking))
      .get()?.balance

    schedule('monthly', '2026-08-25')

    expect(
      h.db
        .select({ balance: schema.account.balance })
        .from(schema.account)
        .where(eq(schema.account.id, checking))
        .get()?.balance,
    ).toBe(before)
    expect(entered()).toHaveLength(0)
  })

  it('affects the budget only once entered', () => {
    const groceries =
      h.db
        .select({ id: schema.category.id })
        .from(schema.category)
        .where(and(eq(schema.category.planId, planId), eq(schema.category.name, 'Groceries')))
        .get()?.id ?? ''

    createScheduled(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      frequency: 'monthly',
      amount: milli(-40_000),
      categoryId: groceries,
      memo: 'rent',
    })

    const activity = () =>
      listTransactions(h.db, { planId, accountId: checking, limit: 500 })
        .rows.filter((r) => r.categoryId === groceries)
        .reduce((total, r) => (total + r.amount) as typeof ZERO, ZERO)

    expect(activity()).toBe(ZERO)
    enterDueTransactions(h.ctx, planId)
    expect(activity()).toBe(milli(-40_000))
  })
})
