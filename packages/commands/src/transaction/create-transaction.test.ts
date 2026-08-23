import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from './create-transaction.ts'

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string
let savings: string
let visa: string
let tracking: string
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
  visa = createAccount(h.ctx, { planId, name: 'Visa', type: 'creditCard', balance: ZERO }).accountId
  tracking = createAccount(h.ctx, {
    planId,
    name: 'Brokerage',
    type: 'otherAsset',
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

describe('dates (ADR-0007)', () => {
  it('refuses a future-dated transaction', () => {
    expect(() =>
      createTransaction(h.ctx, {
        planId,
        accountId: checking,
        date: calendarDate('2026-08-23'),
        amount: milli(-1000),
      }),
    ).toThrow(/in the future/)
  })

  it('accepts today', () => {
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-22'),
      amount: milli(-1000),
    })
    expect(txn(r.transactionId)?.date).toBe('2026-08-22')
  })

  it('accepts an arbitrarily old date — divergence D1', () => {
    // The oracle rejects dates over ~5 years old. Importing a decade of history is a
    // first-class use case for a self-hosted app, so we do not.
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2009-03-14'),
      amount: milli(-1000),
    })
    expect(txn(r.transactionId)?.date).toBe('2009-03-14')
    const plan = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
    expect(plan?.firstMonth, 'a backdated entry extends the plan history').toBe('2009-03-01')
  })
})

describe('balances', () => {
  it('moves working and uncleared balances', () => {
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-25_000),
      categoryId: groceries,
    })
    const a = account(checking)
    expect(a?.balance).toBe(975_000n)
    expect(a?.clearedBalance).toBe(1_000_000n) // the opening balance only
    expect(a?.unclearedBalance).toBe(-25_000n)
  })

  it('moves the cleared balance for a cleared transaction', () => {
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-25_000),
      categoryId: groceries,
      cleared: 'cleared',
    })
    const a = account(checking)
    expect(a?.clearedBalance).toBe(975_000n)
    expect(a?.unclearedBalance).toBe(0n)
  })
})

describe('transfers', () => {
  it('creates both legs, mutually linked and equal-and-opposite', () => {
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-50_000),
      payeeId: transferPayeeFor(savings),
    })
    expect(r.counterpartId).toBeTruthy()

    const near = txn(r.transactionId)
    const far = txn(r.counterpartId as string)
    expect(near?.amount).toBe(-50_000n)
    expect(far?.amount).toBe(50_000n)
    expect(near?.transferTransactionId).toBe(far?.id)
    expect(far?.transferTransactionId).toBe(near?.id)
    expect(near?.transferPairId).toBe(far?.transferPairId)
    expect(far?.accountId).toBe(savings)
  })

  it('moves both account balances', () => {
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-50_000),
      payeeId: transferPayeeFor(savings),
    })
    expect(account(checking)?.balance).toBe(950_000n)
    expect(account(savings)?.balance).toBe(50_000n)
  })

  it('strips the category on an on-budget → on-budget transfer (R45)', () => {
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-50_000),
      payeeId: transferPayeeFor(visa),
      categoryId: groceries,
    })
    expect(txn(r.transactionId)?.categoryId).toBeNull()
  })

  it('KEEPS the category on an on-budget → tracking transfer (R44)', () => {
    // Money leaving the budget for a tracking account is real spending, so it stays
    // categorised. This is the half of the rule that is easy to get wrong by treating all
    // transfers alike.
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-50_000),
      payeeId: transferPayeeFor(tracking),
      categoryId: groceries,
    })
    expect(txn(r.transactionId)?.categoryId).toBe(groceries)
  })
})

describe('splits', () => {
  it('records parts that sum to the parent, with the parent uncategorised (R47)', () => {
    const r = createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-100_000),
      subtransactions: [
        { amount: milli(-60_000), categoryId: groceries },
        { amount: milli(-40_000), categoryId: null },
      ],
    })
    const parent = txn(r.transactionId)
    expect(parent?.isSplit).toBe(true)
    // Stored null. The phantom "Split" id the oracle emits is synthesised at the API boundary.
    expect(parent?.categoryId).toBeNull()
    expect(r.subtransactionIds).toHaveLength(2)
  })

  it('refuses parts that do not add up', () => {
    expect(() =>
      createTransaction(h.ctx, {
        planId,
        accountId: checking,
        date: calendarDate('2026-08-20'),
        amount: milli(-100_000),
        subtransactions: [
          { amount: milli(-60_000), categoryId: groceries },
          { amount: milli(-30_000), categoryId: null },
        ],
      }),
    ).toThrow(/add up to/)
  })

  it('refuses a split of one', () => {
    expect(() =>
      createTransaction(h.ctx, {
        planId,
        accountId: checking,
        date: calendarDate('2026-08-20'),
        amount: milli(-100_000),
        subtransactions: [{ amount: milli(-100_000), categoryId: groceries }],
      }),
    ).toThrow(/at least two/)
  })

  it('writes nothing at all when a split is rejected', () => {
    const before = h.db.select().from(schema.transaction).all().length
    expect(() =>
      createTransaction(h.ctx, {
        planId,
        accountId: checking,
        date: calendarDate('2026-08-20'),
        amount: milli(-100_000),
        subtransactions: [{ amount: milli(-1), categoryId: groceries }],
      }),
    ).toThrow()
    expect(h.db.select().from(schema.transaction).all()).toHaveLength(before)
  })
})

describe('recompute watermark', () => {
  it('dirties from the transaction month, and a backdated entry moves it earlier', () => {
    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-08-20'),
      amount: milli(-1000),
      categoryId: groceries,
    })
    const recalc = () =>
      h.db.select().from(schema.planRecalc).where(eq(schema.planRecalc.planId, planId)).get()
    expect(recalc()?.dirtyFromMonth).toBe('2026-08-01')

    createTransaction(h.ctx, {
      planId,
      accountId: checking,
      date: calendarDate('2026-05-04'),
      amount: milli(-1000),
      categoryId: groceries,
    })
    expect(recalc()?.dirtyFromMonth, 'the earlier of the two').toBe('2026-05-01')
  })
})
