import { schema } from '@zerofold/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testHarness } from '../test-support.ts'
import { createPlan } from './create-plan.ts'

let h: ReturnType<typeof testHarness>
beforeEach(() => {
  h = testHarness()
})
afterEach(() => h.close())

describe('createPlan', () => {
  it('seeds exactly the three internal groups', () => {
    const { planId } = createPlan(h.ctx, { name: 'Household', timezone: 'Europe/London' })
    const groups = h.db
      .select()
      .from(schema.categoryGroup)
      .where(eq(schema.categoryGroup.planId, planId))
      .all()

    const internal = groups.filter((g) => g.internalKind !== null)
    expect(internal.map((g) => g.internalKind).sort()).toEqual([
      'credit_card_payments',
      'hidden',
      'internal_master',
    ])
  })

  it('seeds exactly two internal categories — Inflow and Uncategorized (R48)', () => {
    // The measured set. Notably there is NO 'Deferred Income' category, which the original
    // plan assumed, and a payment category is NOT internal despite its group being so.
    const { planId } = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' })
    const internal = h.db
      .select()
      .from(schema.category)
      .where(eq(schema.category.planId, planId))
      .all()
      .filter((c) => c.internalKind === 'inflow_rta' || c.internalKind === 'uncategorized')

    expect(internal).toHaveLength(2)
    expect(internal.map((c) => c.name).sort()).toEqual(['Inflow: Ready to Assign', 'Uncategorized'])
  })

  it('makes the creator the owner', () => {
    const { planId } = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' })
    const membership = h.db
      .select()
      .from(schema.planMembership)
      .where(eq(schema.planMembership.planId, planId))
      .all()
    expect(membership).toEqual([expect.objectContaining({ userId: 'user-1', role: 'owner' })])
  })

  it('starts at server_knowledge 0 with a clean recompute watermark', () => {
    const { planId } = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' })
    const plan = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
    expect(plan?.serverKnowledge).toBe(0)
    const recalc = h.db
      .select()
      .from(schema.planRecalc)
      .where(eq(schema.planRecalc.planId, planId))
      .get()
    expect(recalc?.dirtyFromMonth).toBeNull()
  })

  it('records the plan timezone, since it is the only source of "today" (ADR-0005)', () => {
    const { planId } = createPlan(h.ctx, { name: 'H', timezone: 'Pacific/Auckland' })
    const plan = h.db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
    expect(plan?.timezone).toBe('Pacific/Auckland')
  })
})
