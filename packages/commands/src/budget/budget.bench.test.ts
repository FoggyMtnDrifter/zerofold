import { schema } from '@zerofold/db'
import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { milli } from '@zerofold/shared/money'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { assign } from './assign.ts'
import { recompute, verify } from './recompute.ts'
import { budgetView } from './view.ts'

/**
 * The §6 budget-view budget: under a second at five years and 200 categories.
 *
 * Written before anyone can complain about it being slow, and against the shape that actually
 * gets slow — 60 months of history, every category assigned in every month. The assertion is
 * generous relative to the measurement on purpose: a threshold that only passes on a quiet
 * laptop is a test that fails for other people.
 */

const MONTHS = 60
const CATEGORIES = 200
const TODAY = '2031-07-15'

let h: ReturnType<typeof testHarness>
let planId: string

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Big', timezone: 'UTC' }).planId
  createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(500_000_000),
  })
  seed()
})
afterEach(() => h.close())

/**
 * Written straight to the tables rather than through `assign`.
 *
 * `assign` recomputes the whole plan on every call, so seeding 12,000 cells through it would
 * measure 12,000 recomputes rather than one. The rows it writes are the same rows.
 */
function seed(): void {
  const groupId = h.ctx.newId()
  h.db
    .insert(schema.categoryGroup)
    .values({ id: groupId, planId, name: 'Bulk', sortOrder: 99, internalKind: null })
    .run()

  const categoryIds = Array.from({ length: CATEGORIES }, (_, i) => {
    const id = h.ctx.newId()
    h.db
      .insert(schema.category)
      .values({ id, planId, categoryGroupId: groupId, name: `Category ${i}`, sortOrder: i })
      .run()
    return id
  })

  const first = budgetMonth('2026-08-01')
  for (let m = 0; m < MONTHS; m++) {
    const year = 2026 + Math.floor((7 + m) / 12)
    const month = ((7 + m) % 12) + 1
    const key = `${year}-${String(month).padStart(2, '0')}-01`

    for (const [i, categoryId] of categoryIds.entries()) {
      h.db
        .insert(schema.monthCategory)
        .values({
          planId,
          month: budgetMonth(key),
          categoryId,
          budgeted: milli(1_000 + i),
          activity: milli(0),
          balance: milli(0),
          carriedForward: milli(0),
          overspendKind: 'none',
        })
        .run()
    }

    // One spending transaction per month, so activity is not uniformly zero.
    h.db
      .insert(schema.transaction)
      .values({
        id: h.ctx.newId(),
        planId,
        accountId: h.db.select({ id: schema.account.id }).from(schema.account).get()?.id ?? '',
        date: calendarDate(`${year}-${String(month).padStart(2, '0')}-05`),
        amount: milli(-25_000),
        cleared: 'cleared',
        approved: true,
        isSplit: false,
        categoryId: categoryIds[m % CATEGORIES] ?? null,
      })
      .run()
  }

  h.db
    .update(schema.plan)
    .set({ firstMonth: first, lastMonth: budgetMonth('2031-07-01') })
    .where(eq(schema.plan.id, planId))
    .run()
}

describe(`budget view at ${MONTHS} months x ${CATEGORIES} categories`, () => {
  it('opens a month well inside the one-second budget', () => {
    const month = budgetMonth('2031-07-01')

    // One warm pass, then measure: the first call pays for statement preparation, which a
    // running server has already done by the time anyone opens a budget.
    budgetView(h.db, planId, month, month)

    const started = performance.now()
    const view = budgetView(h.db, planId, month, month)
    const elapsed = performance.now() - started

    // The starter set is in there too; the seeded 200 are what the timing is about.
    expect(view.groups.flatMap((g) => g.categories).length).toBeGreaterThanOrEqual(CATEGORIES)
    console.log(`budget view: ${elapsed.toFixed(1)}ms over ${MONTHS * CATEGORIES} cells`)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('assigns without paying for a full recompute', () => {
    /*
     * The §6 target is a repaint inside 16ms, and the write is the part of that the server
     * owns. It used to refresh the whole derived cache — 12,000 rows, about a second — which
     * is the reason this measurement exists at all.
     */
    const month = budgetMonth('2031-07-01')
    const categoryId =
      budgetView(h.db, planId, month, month)
        .groups.flatMap((g) => g.categories)
        .find((c) => c.name === 'Category 7')?.categoryId ?? ''

    assign(h.ctx, { planId, month, categoryId, budgeted: milli(1) }, month)

    const started = performance.now()
    assign(h.ctx, { planId, month, categoryId, budgeted: milli(123_456) }, month)
    const elapsed = performance.now() - started

    console.log(`assign: ${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(16)
  })

  it('recomputes and verifies the whole plan in reasonable time', () => {
    const month = budgetMonth('2031-07-01')

    const startedWrite = performance.now()
    recompute(h.ctx, planId, month)
    const wrote = performance.now() - startedWrite

    const startedVerify = performance.now()
    const discrepancies = verify(h.ctx, planId, month)
    const verified = performance.now() - startedVerify

    console.log(`recompute: ${wrote.toFixed(0)}ms, verify: ${verified.toFixed(0)}ms`)
    expect(discrepancies).toEqual([])
  })
})
