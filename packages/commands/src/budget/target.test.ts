import { schema } from '@zerofold/db'
import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { assign } from './assign.ts'
import { clearTarget, setTarget, snoozeTarget } from './target.ts'
import { budgetView } from './view.ts'

/**
 * Targets through the command layer: revisions, snooze, and the two aggregates.
 *
 * The engine's tests prove the formulas. These prove that the right revision is chosen for each
 * month, which is the whole point of storing them as revisions (divergence D2).
 */

let h: ReturnType<typeof testHarness>
let planId: string

const TODAY = '2026-08-22'
const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  })
})
afterEach(() => h.close())

const categoryId = (name: string) =>
  h.db
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(and(eq(schema.category.planId, planId), eq(schema.category.name, name)))
    .get()?.id ?? ''

const view = (month = AUG) =>
  budgetView(h.db, planId, month, AUG, calendarDate(TODAY))

const cell = (name: string, month = AUG) =>
  view(month)
    .groups.flatMap((g) => g.categories)
    .find((c) => c.name === name)

const put = (name: string, amount: number, month = AUG) =>
  assign(h.ctx, { planId, month, categoryId: categoryId(name), budgeted: milli(amount) }, AUG)

describe('setting a target', () => {
  it('reports what a category still needs this month', () => {
    setTarget(h.ctx, {
      planId,
      categoryId: categoryId('Groceries'),
      effectiveFrom: AUG,
      goalType: 'NEED',
      goalTarget: milli(400_000),
      goalCadence: 1,
      goalNeedsWholeAmount: true,
    })

    expect(cell('Groceries')?.target?.underFunded).toBe(milli(400_000))
    put('Groceries', 150_000)
    expect(cell('Groceries')?.target?.underFunded).toBe(milli(250_000))
    expect(cell('Groceries')?.target?.percentageComplete).toBe(37)
  })

  it('refuses a target on Ready to Assign', () => {
    expect(() =>
      setTarget(h.ctx, {
        planId,
        categoryId: categoryId('Inflow: Ready to Assign'),
        effectiveFrom: AUG,
        goalType: 'NEED',
        goalTarget: milli(1),
      }),
    ).toThrow(/cannot have a target/)
  })

  it('refuses a dated target with no date', () => {
    expect(() =>
      setTarget(h.ctx, {
        planId,
        categoryId: categoryId('Groceries'),
        effectiveFrom: AUG,
        goalType: 'TBD',
        goalTarget: milli(100),
      }),
    ).toThrow(/needs a month/)
  })
})

describe('revisions', () => {
  it('leaves an earlier month describing what it actually needed', () => {
    setTarget(h.ctx, {
      planId,
      categoryId: categoryId('Groceries'),
      effectiveFrom: AUG,
      goalType: 'NEED',
      goalTarget: milli(400_000),
      goalCadence: 1,
      goalNeedsWholeAmount: true,
    })
    // A bigger target from September onward.
    setTarget(h.ctx, {
      planId,
      categoryId: categoryId('Groceries'),
      effectiveFrom: SEP,
      goalType: 'NEED',
      goalTarget: milli(600_000),
      goalCadence: 1,
      goalNeedsWholeAmount: true,
    })

    // August still needed 400000, not 600000. This is the whole reason revisions exist.
    expect(cell('Groceries', AUG)?.target?.underFunded).toBe(milli(400_000))
    expect(cell('Groceries', SEP)?.target?.underFunded).toBe(milli(600_000))
  })

  it('replaces the revision when the same month is set twice', () => {
    for (const amount of [400_000, 250_000]) {
      setTarget(h.ctx, {
        planId,
        categoryId: categoryId('Groceries'),
        effectiveFrom: AUG,
        goalType: 'NEED',
        goalTarget: milli(amount),
        goalCadence: 1,
        goalNeedsWholeAmount: true,
      })
    }

    expect(cell('Groceries')?.target?.underFunded).toBe(milli(250_000))
    expect(
      h.db.select().from(schema.categoryTarget).where(eq(schema.categoryTarget.planId, planId)).all(),
    ).toHaveLength(1)
  })

  it('stops demanding from the month it is cleared, and not before', () => {
    setTarget(h.ctx, {
      planId,
      categoryId: categoryId('Groceries'),
      effectiveFrom: AUG,
      goalType: 'NEED',
      goalTarget: milli(400_000),
      goalCadence: 1,
      goalNeedsWholeAmount: true,
    })
    clearTarget(h.ctx, { planId, categoryId: categoryId('Groceries'), effectiveFrom: SEP })

    expect(cell('Groceries', AUG)?.target?.underFunded).toBe(milli(400_000))
    expect(cell('Groceries', SEP)?.target?.underFunded).toBe(ZERO)
  })
})

describe('the two aggregates (R33)', () => {
  const targetFor = (name: string, amount: number) =>
    setTarget(h.ctx, {
      planId,
      categoryId: categoryId(name),
      effectiveFrom: AUG,
      goalType: 'NEED',
      goalTarget: milli(amount),
      goalCadence: 1,
      goalNeedsWholeAmount: true,
    })

  it('sums what every target still wants', () => {
    targetFor('Groceries', 400_000)
    targetFor('Transport', 100_000)
    put('Groceries', 150_000)

    expect(view().underfunded).toBe(milli(350_000))
  })

  it('leaves a snoozed category out of the underfunded total but not out of the math', () => {
    targetFor('Groceries', 400_000)
    targetFor('Transport', 100_000)
    snoozeTarget(h.ctx, { planId, categoryId: categoryId('Transport'), month: AUG, snoozed: true })

    expect(view().underfunded).toBe(milli(400_000))
    // The need itself is unchanged, and still visible on the row (R32).
    expect(cell('Transport')?.target?.underFunded).toBe(milli(100_000))
    expect(cell('Transport')?.snoozed).toBe(true)
  })

  it('snoozes only the month it was set in', () => {
    targetFor('Transport', 100_000)
    snoozeTarget(h.ctx, { planId, categoryId: categoryId('Transport'), month: AUG, snoozed: true })

    expect(cell('Transport', AUG)?.snoozed).toBe(true)
    expect(cell('Transport', SEP)?.snoozed).toBe(false)
    expect(view(SEP).underfunded).toBe(milli(100_000))
  })

  it('can be un-snoozed', () => {
    targetFor('Transport', 100_000)
    const category = categoryId('Transport')
    snoozeTarget(h.ctx, { planId, categoryId: category, month: AUG, snoozed: true })
    snoozeTarget(h.ctx, { planId, categoryId: category, month: AUG, snoozed: false })

    expect(cell('Transport')?.snoozed).toBe(false)
    expect(view().underfunded).toBe(milli(100_000))
  })
})

describe('a credit card payment category', () => {
  it('is underfunded by what the card owes, with no target set (R39)', () => {
    createAccount(h.ctx, {
      planId,
      name: 'Visa',
      type: 'creditCard',
      balance: milli(-300_000),
    })

    expect(cell('Visa')?.target?.underFunded).toBe(milli(300_000))
    expect(view().underfunded).toBe(milli(300_000))
  })
})
