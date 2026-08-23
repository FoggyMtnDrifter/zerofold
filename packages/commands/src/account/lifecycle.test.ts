import { schema } from '@zerofold/db'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createAccount } from './create-account.ts'
import {
  accountsChangedSince,
  closeAccount,
  deleteAccount,
  listOpenAccounts,
  reopenAccount,
} from './lifecycle.ts'

let h: ReturnType<typeof testHarness>
let planId: string
beforeEach(() => {
  h = testHarness('2026-08-22')
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
})
afterEach(() => h.close())

const account = (id: string) =>
  h.db.select().from(schema.account).where(eq(schema.account.id, id)).get()

describe('closeAccount (D7 — our own operation; the oracle offers no Close at all)', () => {
  it('closes a zero-balance account and hides it from the sidebar', () => {
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'Old Savings',
      type: 'savings',
      balance: ZERO,
    })
    closeAccount(h.ctx, { planId, accountId })

    expect(account(accountId)?.closed).toBe(true)
    expect(account(accountId)?.deleted).toBe(false)
    expect(listOpenAccounts(h.ctx, planId).map((a) => a.id)).not.toContain(accountId)
  })

  it('refuses to close an account still holding money', () => {
    // A closed on-budget account with a balance would keep feeding Ready to Assign while being
    // invisible. The money has to go somewhere explicit first.
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: milli(50_000),
    })
    expect(() => closeAccount(h.ctx, { planId, accountId })).toThrow(/still has a balance/)
    expect(account(accountId)?.closed).toBe(false)
  })

  it('hides and restores a credit card payment category across close and reopen', () => {
    const { accountId, paymentCategoryId } = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: ZERO,
    })
    const cat = () =>
      h.db
        .select()
        .from(schema.category)
        .where(eq(schema.category.id, paymentCategoryId as string))
        .get()

    closeAccount(h.ctx, { planId, accountId })
    expect(cat()?.hidden).toBe(true)
    expect(cat()?.deleted).toBe(false)

    reopenAccount(h.ctx, { planId, accountId })
    expect(cat()?.hidden).toBe(false)
    expect(account(accountId)?.closed).toBe(false)
  })

  it('is idempotent', () => {
    const { accountId } = createAccount(h.ctx, {
      planId,
      name: 'S',
      type: 'savings',
      balance: ZERO,
    })
    closeAccount(h.ctx, { planId, accountId })
    const knowledgeAfterFirst = account(accountId)?.knowledgeAtChange
    closeAccount(h.ctx, { planId, accountId })
    expect(account(accountId)?.knowledgeAtChange).toBe(knowledgeAfterFirst)
  })
})

describe('deleteAccount (D6 — confirmation the oracle does not require)', () => {
  const make = () =>
    createAccount(h.ctx, {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: milli(1_000_000),
    })

  it('requires the account name to be typed exactly', () => {
    const { accountId } = make()
    expect(() => deleteAccount(h.ctx, { planId, accountId, confirmName: 'everyday' })).toThrow(
      /type the account name exactly/,
    )
    expect(account(accountId)?.deleted).toBe(false)
  })

  it('soft-deletes the account and its transactions', () => {
    const { accountId, startingBalanceTransactionId } = make()
    deleteAccount(h.ctx, { planId, accountId, confirmName: 'Everyday' })

    expect(account(accountId)?.deleted).toBe(true)
    const txn = h.db
      .select()
      .from(schema.transaction)
      .where(eq(schema.transaction.id, startingBalanceTransactionId as string))
      .get()
    expect(txn?.deleted).toBe(true)
  })

  it('keeps the row visible to delta requests as a tombstone (R24)', () => {
    const { accountId } = make()
    const before = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
    deleteAccount(h.ctx, { planId, accountId, confirmName: 'Everyday' })

    // A full listing omits it; a delta listing must still report it so a syncing client
    // can remove its local copy. A hard delete would strand it there forever.
    expect(listOpenAccounts(h.ctx, planId).map((a) => a.id)).not.toContain(accountId)
    const delta = accountsChangedSince(h.ctx, planId, before?.serverKnowledge ?? 0)
    expect(delta.find((a) => a.id === accountId)?.deleted).toBe(true)
  })

  it('deletes the transfer payee and the payment category with the account', () => {
    const { accountId, transferPayeeId, paymentCategoryId } = createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: ZERO,
    })
    deleteAccount(h.ctx, { planId, accountId, confirmName: 'Visa' })

    const payee = h.db.select().from(schema.payee).where(eq(schema.payee.id, transferPayeeId)).get()
    const cat = h.db
      .select()
      .from(schema.category)
      .where(eq(schema.category.id, paymentCategoryId as string))
      .get()
    expect(payee?.deleted).toBe(true)
    expect(cat?.deleted).toBe(true)
  })

  it('deletes BOTH legs of a transfer touching the account', () => {
    // Deleting only the near side leaves the far side pointing at an account that no longer
    // exists — a transfer to nowhere in the other register.
    const a = createAccount(h.ctx, { planId, name: 'A', type: 'checking', balance: ZERO })
    const b = createAccount(h.ctx, { planId, name: 'B', type: 'savings', balance: ZERO })

    const nearId = h.ctx.newId()
    const farId = h.ctx.newId()
    const pairId = h.ctx.newId()
    const base = {
      planId,
      date: '2026-08-20',
      cleared: 'uncleared' as const,
      approved: true,
      isSplit: false,
      deleted: false,
      knowledgeAtChange: 1,
      createdAt: h.ctx.now,
      updatedAt: h.ctx.now,
      transferPairId: pairId,
    }
    h.db
      .insert(schema.transaction)
      .values([
        {
          ...base,
          id: nearId,
          accountId: a.accountId,
          amount: milli(-5_000),
          transferAccountId: b.accountId,
          transferTransactionId: farId,
        },
        {
          ...base,
          id: farId,
          accountId: b.accountId,
          amount: milli(5_000),
          transferAccountId: a.accountId,
          transferTransactionId: nearId,
        },
      ])
      .run()

    deleteAccount(h.ctx, { planId, accountId: a.accountId, confirmName: 'A' })

    const far = h.db.select().from(schema.transaction).where(eq(schema.transaction.id, farId)).get()
    expect(far?.deleted).toBe(true)
  })

  it('marks the recompute watermark from the earliest affected month (R23)', () => {
    // Deleting an account removes its income retroactively, so every month from the earliest
    // transaction onward has to be recomputed.
    const { accountId } = make()
    deleteAccount(h.ctx, { planId, accountId, confirmName: 'Everyday' })
    const recalc = h.db
      .select()
      .from(schema.planRecalc)
      .where(eq(schema.planRecalc.planId, planId))
      .get()
    expect(recalc?.dirtyFromMonth).toBe('2026-08-01')
  })

  it('writes an audit event', () => {
    const { accountId } = make()
    deleteAccount(h.ctx, { planId, accountId, confirmName: 'Everyday' })
    const events = h.db
      .select()
      .from(schema.auditEvent)
      .where(
        and(eq(schema.auditEvent.planId, planId), eq(schema.auditEvent.action, 'account.deleted')),
      )
      .all()
    expect(events).toHaveLength(1)
    expect(events[0]?.entityId).toBe(accountId)
  })
})
