import { schema } from '@zerofold/db'
import { milli, ZERO } from '@zerofold/shared/money'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createAccount, isCredit, isOnBudget } from './create-account.ts'

let h: ReturnType<typeof testHarness>
let planId: string
beforeEach(() => {
  h = testHarness('2026-08-22')
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
})
afterEach(() => h.close())

const account = (id: string) =>
  h.db.select().from(schema.account).where(eq(schema.account.id, id)).get()

describe('account classification', () => {
  it.each([
    ['checking', true, false],
    ['savings', true, false],
    ['cash', true, false],
    ['creditCard', true, true],
    ['lineOfCredit', true, true],
    ['mortgage', false, false],
    ['autoLoan', false, false],
    ['studentLoan', false, false],
    ['personalLoan', false, false],
    ['medicalDebt', false, false],
    ['otherDebt', false, false],
    ['otherAsset', false, false],
    ['otherLiability', false, false],
  ] as const)('%s → onBudget %s, credit %s', (type, onBudget, credit) => {
    expect(isOnBudget(type)).toBe(onBudget)
    expect(isCredit(type)).toBe(credit)
  })

  it('covers all 13 YNAB account types', () => {
    expect(schema.ACCOUNT_TYPES).toHaveLength(13)
  })
})

describe('createAccount', () => {
  it('creates a transfer payee named for the account', () => {
    const { transferPayeeId, accountId } = createAccount(h.ctx, {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: milli(1_000_000),
    })
    const payee = h.db.select().from(schema.payee).where(eq(schema.payee.id, transferPayeeId)).get()
    expect(payee?.name).toBe('Transfer : Everyday')
    expect(payee?.transferAccountId).toBe(accountId)
  })

  it('writes a cleared starting balance categorised to Inflow (R22)', () => {
    const { startingBalanceTransactionId } = createAccount(h.ctx, {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: milli(1_000_000),
    })
    const txn = h.db
      .select()
      .from(schema.transaction)
      .where(eq(schema.transaction.id, startingBalanceTransactionId as string))
      .get()

    expect(txn?.amount).toBe(1_000_000n)
    expect(txn?.cleared).toBe('cleared')
    // Dated from the plan's today, never the server's UTC date — that mismatch is the bug
    // R59 found in the oracle, where one plan held rows with two different "today"s.
    expect(txn?.date).toBe('2026-08-22')

    const inflow = h.db
      .select()
      .from(schema.category)
      .where(eq(schema.category.id, txn?.categoryId as string))
      .get()
    expect(inflow?.internalKind).toBe('inflow_rta')
  })

  it('writes no starting balance transaction for a zero opening balance', () => {
    const r = createAccount(h.ctx, { planId, name: 'New', type: 'checking', balance: ZERO })
    expect(r.startingBalanceTransactionId).toBeNull()
  })

  it('auto-creates a payment category for a credit account', () => {
    const { paymentCategoryId, accountId } = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: ZERO,
    })
    const cat = h.db
      .select()
      .from(schema.category)
      .where(eq(schema.category.id, paymentCategoryId as string))
      .get()

    expect(cat?.name).toBe('Visa')
    expect(cat?.creditAccountId).toBe(accountId)
    expect(cat?.internalKind).toBe('credit_card_payment')

    const group = h.db
      .select()
      .from(schema.categoryGroup)
      .where(eq(schema.categoryGroup.id, cat?.categoryGroupId as string))
      .get()
    expect(group?.internalKind).toBe('credit_card_payments')
  })

  it('creates no payment category for a non-credit account', () => {
    const r = createAccount(h.ctx, { planId, name: 'Savings', type: 'savings', balance: ZERO })
    expect(r.paymentCategoryId).toBeNull()
  })

  it('creates no payment category for a tracking loan', () => {
    // A mortgage is debt, but it is off-budget: it affects net worth, not Ready to Assign.
    const r = createAccount(h.ctx, {
      planId,
      name: 'Mortgage',
      type: 'mortgage',
      balance: milli(-250_000_000),
    })
    expect(r.paymentCategoryId).toBeNull()
    expect(account(r.accountId)?.onBudget).toBe(false)
  })
})

describe('opening debt (R37, R38, R60′)', () => {
  it('seeds uncoveredDebt from a card opened in debt', () => {
    // Opening debt was never funded by a category, so paying it later must draw on Ready to
    // Assign (R60'). That is what this quantity is for.
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: milli(-300_000),
    })
    expect(account(accountId)?.uncoveredDebt).toBe(300_000n)
    expect(account(accountId)?.openingBalance).toBe(-300_000n)
  })

  it('leaves the payment category empty despite the debt (R38)', () => {
    // Opening debt creates no payment obligation — nothing is set aside for it.
    const { paymentCategoryId } = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: milli(-300_000),
    })
    const rows = h.db
      .select()
      .from(schema.monthCategory)
      .where(eq(schema.monthCategory.categoryId, paymentCategoryId as string))
      .all()
    expect(rows).toHaveLength(0)
  })

  it('records no uncovered debt for a cash account, whatever the sign', () => {
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'Overdrawn',
      type: 'checking',
      balance: milli(-50_000),
    })
    expect(account(accountId)?.uncoveredDebt).toBe(0n)
  })
})

describe('server_knowledge (the delta-request contract)', () => {
  it('increments once per command and stamps the rows it touched', () => {
    const before = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: milli(1_000),
    })
    const after = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()

    expect(after?.serverKnowledge).toBe((before?.serverKnowledge ?? 0) + 1)
    // A client syncing from `before` must see this account. If the stamp were missing the row
    // would be invisible to every delta request forever.
    expect(account(accountId)?.knowledgeAtChange).toBe(after?.serverKnowledge)
  })

  it('moves the recompute watermark to the month of the starting balance', () => {
    createAccount(h.ctx, { planId, name: 'Everyday', type: 'checking', balance: milli(1_000) })
    const recalc = h.db
      .select()
      .from(schema.planRecalc)
      .where(eq(schema.planRecalc.planId, planId))
      .get()
    expect(recalc?.dirtyFromMonth).toBe('2026-08-01')
  })

  it('rejects an unknown plan rather than writing a partial account', () => {
    expect(() =>
      createAccount(h.ctx, { planId: 'nope', name: 'X', type: 'checking', balance: ZERO }),
    ).toThrow(/no such plan/)
    expect(h.db.select().from(schema.account).all()).toHaveLength(0)
  })
})
