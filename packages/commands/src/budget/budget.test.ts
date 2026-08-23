import { schema } from '@zerofold/db'
import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { type Milliunits, milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { assign, moveMoney } from './assign.ts'
import { recompute, verify } from './recompute.ts'
import { budgetView } from './view.ts'

let h: ReturnType<typeof testHarness>
let planId: string
let checking: string

const TODAY = '2026-08-22'
const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')
const OCT = budgetMonth('2026-10-01')

const categoryId = (name: string) =>
  h.db
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(and(eq(schema.category.planId, planId), eq(schema.category.name, name)))
    .get()?.id ?? ''

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  // $1000 of income, exactly as the P0-A experiment was set up.
  checking = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
})
afterEach(() => h.close())

const view = (month = AUG) => budgetView(h.db, planId, month, AUG)
const rtaFor = (month = AUG) => view(month).readyToAssign

const put = (month: typeof AUG, name: string, amount: number) =>
  assign(h.ctx, { planId, month, categoryId: categoryId(name), budgeted: milli(amount) }, AUG)

const spend = (amount: number, name: string, date = TODAY) =>
  createTransaction(h.ctx, {
    planId,
    accountId: checking,
    date: calendarDate(date),
    amount: milli(amount),
    categoryId: categoryId(name),
  })

describe('the budget view reproduces P0-A', () => {
  it('starts with the whole starting balance ready to assign', () => {
    expect(rtaFor(AUG)).toBe(milli(1_000_000))
  })

  it('an assignment in September reduces August (R9)', () => {
    put(SEP, 'Groceries', 300_000)
    expect(rtaFor(AUG)).toBe(milli(700_000))
    expect(rtaFor(SEP)).toBe(milli(700_000))
  })

  it('a positive balance carries forward (R11)', () => {
    put(AUG, 'Groceries', 100_000)
    const september = view(SEP).groups.flatMap((g) => g.categories)
    expect(september.find((c) => c.name === 'Groceries')?.balance).toBe(milli(100_000))
    expect(september.find((c) => c.name === 'Groceries')?.budgeted).toBe(ZERO)
  })

  it('cash overspending zeroes the category and charges the next month (R10)', () => {
    put(AUG, 'Groceries', 100_000)
    spend(-140_000, 'Groceries')

    expect(rtaFor(AUG)).toBe(milli(900_000))
    expect(rtaFor(SEP)).toBe(milli(860_000))

    const aug = view(AUG)
      .groups.flatMap((g) => g.categories)
      .find((c) => c.name === 'Groceries')
    const sep = view(SEP)
      .groups.flatMap((g) => g.categories)
      .find((c) => c.name === 'Groceries')
    expect(aug?.balance).toBe(milli(-40_000))
    expect(aug?.overspendKind).toBe('cash')
    expect(sep?.balance).toBe(ZERO)
  })

  it('Ready to Assign is allowed to go negative (R12)', () => {
    put(AUG, 'Groceries', 100_000)
    spend(-140_000, 'Groceries')
    put(AUG, 'Eating Out', 5_000_000)

    expect(rtaFor(AUG)).toBe(milli(-4_100_000))
    expect(rtaFor(SEP)).toBe(milli(-4_140_000))
  })
})

describe('the assignment ledger', () => {
  /** R13: Σ(into) − Σ(out of) per (month, category) must equal the stored `budgeted`. */
  const reconcile = (month: string, category: string): Milliunits => {
    const rows = h.db
      .select()
      .from(schema.moneyMovement)
      .where(and(eq(schema.moneyMovement.planId, planId), eq(schema.moneyMovement.month, month)))
      .all()
    let total = 0n
    for (const row of rows) {
      if (row.toCategoryId === category) total += row.amount
      if (row.fromCategoryId === category) total -= row.amount
    }
    return total as Milliunits
  }

  const storedBudgeted = (month: string, category: string) =>
    h.db
      .select({ budgeted: schema.monthCategory.budgeted })
      .from(schema.monthCategory)
      .where(
        and(
          eq(schema.monthCategory.planId, planId),
          eq(schema.monthCategory.month, month),
          eq(schema.monthCategory.categoryId, category),
        ),
      )
      .get()?.budgeted ?? ZERO

  it('reconciles exactly to budgeted after an assignment', () => {
    put(AUG, 'Groceries', 100_000)
    const id = categoryId('Groceries')
    expect(reconcile(AUG, id)).toBe(milli(100_000))
    expect(reconcile(AUG, id)).toBe(storedBudgeted(AUG, id))
  })

  it('compensates rather than edits when an assignment is reverted (R13)', () => {
    put(AUG, 'Groceries', 100_000)
    put(AUG, 'Groceries', 0)

    const id = categoryId('Groceries')
    const rows = h.db
      .select()
      .from(schema.moneyMovement)
      .where(eq(schema.moneyMovement.planId, planId))
      .all()

    // Two movements, not one edited into nothing.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.amount)).toEqual([milli(100_000), milli(100_000)])
    expect(rows[0]?.toCategoryId).toBe(id)
    expect(rows[1]?.fromCategoryId).toBe(id)
    expect(reconcile(AUG, id)).toBe(ZERO)
    expect(reconcile(AUG, id)).toBe(storedBudgeted(AUG, id))
  })

  it('writes no movement when the amount does not change', () => {
    put(AUG, 'Groceries', 100_000)
    put(AUG, 'Groceries', 100_000)
    const rows = h.db.select().from(schema.moneyMovement).all()
    expect(rows).toHaveLength(1)
  })

  it('records a move between categories as one group', () => {
    put(AUG, 'Groceries', 100_000)
    moveMoney(
      h.ctx,
      {
        planId,
        month: AUG,
        fromCategoryId: categoryId('Groceries'),
        toCategoryId: categoryId('Eating Out'),
        amount: milli(30_000),
      },
      AUG,
    )

    expect(reconcile(AUG, categoryId('Groceries'))).toBe(milli(70_000))
    expect(reconcile(AUG, categoryId('Eating Out'))).toBe(milli(30_000))

    const moves = h.db
      .select()
      .from(schema.moneyMovement)
      .all()
      .filter((r) => r.groupId !== null)
    expect(moves).toHaveLength(2)
    expect(new Set(moves.map((m) => m.groupId)).size).toBe(1)
  })

  it('refuses to assign to Ready to Assign itself', () => {
    expect(() =>
      assign(
        h.ctx,
        {
          planId,
          month: AUG,
          categoryId: categoryId('Inflow: Ready to Assign'),
          budgeted: milli(1),
        },
        AUG,
      ),
    ).toThrow(/cannot be assigned to/)
  })
})

describe('the cache', () => {
  it('agrees with a from-scratch recompute', () => {
    put(AUG, 'Groceries', 100_000)
    spend(-140_000, 'Groceries')
    put(SEP, 'Eating Out', 250_000)
    recompute(h.ctx, planId, AUG)

    expect(verify(h.ctx, planId, AUG)).toEqual([])
  })

  it('notices when the cache is wrong', () => {
    put(AUG, 'Groceries', 100_000)
    recompute(h.ctx, planId, AUG)

    // Corrupt one derived value by hand; `verify` exists precisely to catch this.
    h.db
      .update(schema.monthCategory)
      .set({ balance: milli(1) })
      .where(
        and(
          eq(schema.monthCategory.categoryId, categoryId('Groceries')),
          eq(schema.monthCategory.month, AUG),
        ),
      )
      .run()

    const found = verify(h.ctx, planId, AUG)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      month: AUG,
      field: 'balance',
      cached: milli(1),
      computed: milli(100_000),
    })
  })

  it('leaves the authoritative assignment alone when it refreshes', () => {
    put(AUG, 'Groceries', 100_000)
    recompute(h.ctx, planId, AUG)
    recompute(h.ctx, planId, AUG)

    expect(
      h.db
        .select({ budgeted: schema.monthCategory.budgeted })
        .from(schema.monthCategory)
        .where(eq(schema.monthCategory.categoryId, categoryId('Groceries')))
        .get()?.budgeted,
    ).toBe(milli(100_000))
  })
})

describe('the grid', () => {
  it('groups categories and subtotals them', () => {
    put(AUG, 'Groceries', 100_000)
    put(AUG, 'Transport', 40_000)

    const essentials = view().groups.find((g) => g.categories.some((c) => c.name === 'Groceries'))
    expect(essentials?.budgeted).toBe(milli(140_000))
    expect(essentials?.balance).toBe(milli(140_000))
  })

  it('omits Inflow and Uncategorized from the grid', () => {
    const names = view().groups.flatMap((g) => g.categories.map((c) => c.name))
    expect(names).not.toContain('Inflow: Ready to Assign')
    expect(names).not.toContain('Uncategorized')
  })

  it('keeps a hidden category out of its group subtotal but in the month total (R15)', () => {
    put(AUG, 'Groceries', 100_000)
    put(AUG, 'Transport', 40_000)
    h.db
      .update(schema.category)
      .set({ hidden: true })
      .where(eq(schema.category.id, categoryId('Transport')))
      .run()

    const after = view()
    const group = after.groups.find((g) => g.categories.some((c) => c.name === 'Groceries'))

    expect(group?.budgeted).toBe(milli(100_000))
    // The month still counts it, and Ready to Assign still reflects it.
    expect(after.budgeted).toBe(milli(140_000))
    expect(after.readyToAssign).toBe(milli(860_000))
  })

  it('brings a future month into existence by assigning into it', () => {
    expect(() => view(OCT)).toThrow(/no 2026-10-01/)
    put(OCT, 'Groceries', 10_000)
    expect(view(OCT).readyToAssign).toBe(milli(990_000))
  })
})
