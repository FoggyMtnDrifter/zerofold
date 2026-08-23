import { schema } from '@zerofold/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizePlan, NotAuthorizedError } from './authorize.ts'
import { createPlan } from './plan/create-plan.ts'
import { procedures, runProcedure } from './procedures.ts'
import { testHarness } from './test-support.ts'

let h: ReturnType<typeof testHarness>
let planId: string
beforeEach(() => {
  h = testHarness('2026-08-22', 'owner-1')
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
})
afterEach(() => h.close())

const addMember = (userId: string, role: 'owner' | 'editor' | 'viewer') =>
  h.db
    .insert(schema.planMembership)
    .values({ planId, userId, role, createdAt: h.ctx.now, updatedAt: h.ctx.now })
    .run()

describe('authorizePlan — the single choke point', () => {
  it('grants the creator owner', () => {
    expect(authorizePlan(h.db, planId, 'owner-1')).toBe('owner')
  })

  it('refuses a non-member', () => {
    expect(() => authorizePlan(h.db, planId, 'nobody')).toThrow(NotAuthorizedError)
  })

  it('gives the same error for a non-existent plan as for one you cannot see', () => {
    // Distinguishing them would let anyone enumerate plan ids.
    const a = (() => {
      try {
        authorizePlan(h.db, planId, 'nobody')
      } catch (e) {
        return (e as Error).message
      }
    })()
    const b = (() => {
      try {
        authorizePlan(h.db, 'does-not-exist', 'nobody')
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(a).toBe(b)
  })

  it('enforces the role ranking', () => {
    addMember('viewer-1', 'viewer')
    addMember('editor-1', 'editor')

    expect(authorizePlan(h.db, planId, 'viewer-1', 'viewer')).toBe('viewer')
    expect(() => authorizePlan(h.db, planId, 'viewer-1', 'editor')).toThrow(/read-only/)
    expect(authorizePlan(h.db, planId, 'editor-1', 'editor')).toBe('editor')
    expect(() => authorizePlan(h.db, planId, 'editor-1', 'owner')).toThrow(/owner/)
    expect(authorizePlan(h.db, planId, 'owner-1', 'owner')).toBe('owner')
  })

  it('refuses access to a soft-deleted plan', () => {
    h.db.update(schema.plan).set({ deleted: true }).where(eq(schema.plan.id, planId)).run()
    expect(() => authorizePlan(h.db, planId, 'owner-1')).toThrow(NotAuthorizedError)
  })
})

describe('runProcedure applies authorization from the declaration', () => {
  const run = (name: Parameters<typeof runProcedure>[0], userId: string, rawInput: unknown) =>
    runProcedure(name, { db: h.db, userId, today: h.ctx.today, rawInput })

  it('lets an editor create an account', () => {
    addMember('editor-1', 'editor')
    const result = run('account.create', 'editor-1', {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: '1000000',
    }) as { accountId: string }
    expect(result.accountId).toBeTruthy()
  })

  it('refuses a viewer trying to create an account', () => {
    addMember('viewer-1', 'viewer')
    expect(() =>
      run('account.create', 'viewer-1', {
        planId,
        name: 'Everyday',
        type: 'checking',
        balance: '1000',
      }),
    ).toThrow(NotAuthorizedError)
    // Nothing may have been written before the check.
    expect(h.db.select().from(schema.account).all()).toHaveLength(0)
  })

  it('refuses a non-member outright', () => {
    expect(() => run('account.list', 'stranger', { planId })).toThrow(NotAuthorizedError)
  })

  it('reserves account deletion for the owner', () => {
    addMember('editor-1', 'editor')
    const { accountId } = run('account.create', 'owner-1', {
      planId,
      name: 'Everyday',
      type: 'checking',
      balance: '0',
    }) as { accountId: string }

    expect(() =>
      run('account.delete', 'editor-1', { planId, accountId, confirmName: 'Everyday' }),
    ).toThrow(NotAuthorizedError)
  })

  it('rejects malformed input before reaching the handler', () => {
    expect(() =>
      run('account.create', 'owner-1', { planId, name: '', type: 'checking', balance: '0' }),
    ).toThrow()
    expect(() =>
      run('account.create', 'owner-1', { planId, name: 'X', type: 'notARealType', balance: '0' }),
    ).toThrow()
  })

  it('accepts milliunits as a string, so JSON never carries a lossy number', () => {
    // 2^53 + 1 milliunits survives only if it travels as a string.
    const big = '9007199254740993'
    const { accountId } = run('account.create', 'owner-1', {
      planId,
      name: 'Huge',
      type: 'checking',
      balance: big,
    }) as { accountId: string }
    const row = h.db.select().from(schema.account).where(eq(schema.account.id, accountId)).get()
    expect(row?.balance).toBe(9007199254740993n)
  })
})

describe('procedure surface', () => {
  it('every plan-scoped procedure declares a required role', () => {
    // A procedure that names a planId but declares no role would silently skip the check.
    // This asserts the pairing rather than trusting review to catch it.
    for (const [name, procedure] of Object.entries(procedures)) {
      const shape = (procedure.input as { shape?: Record<string, unknown> }).shape
      if (shape && Object.hasOwn(shape, 'planId')) {
        expect(procedure.plan, `${name} takes a planId but declares no role`).toBeTruthy()
      }
    }
  })
})
