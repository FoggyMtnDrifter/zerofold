import { schema } from '@zerofold/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testHarness } from '../test-support.ts'
import { completeRegistration, instanceIsEmpty, mayRegister } from './registration.ts'

let h: ReturnType<typeof testHarness>
const NOW = '2026-08-22T12:00:00.000Z'
beforeEach(() => {
  h = testHarness()
})
afterEach(() => h.close())

const addUser = (id: string, email: string) => {
  h.db
    .insert(schema.authUser)
    .values({
      id,
      email,
      name: null,
      emailVerified: false,
      image: null,
      isAdmin: false,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    })
    .run()
  return id
}

const addInvite = (email: string, expiresAt: string, acceptedAt: string | null = null) => {
  const id = h.ctx.newId()
  h.db
    .insert(schema.invite)
    .values({
      id,
      email,
      tokenHash: 'hash',
      invitedByUserId: 'admin',
      role: null,
      expiresAt,
      acceptedAt,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

const closed = { allowOpenRegistration: false, now: NOW }

describe('first user becomes the admin', () => {
  it('lets the first account through with no invite, as admin', () => {
    expect(instanceIsEmpty(h.db)).toBe(true)
    const decision = mayRegister(h.db, 'first@example.com', closed)
    expect(decision).toEqual({ allowed: true, asAdmin: true, inviteId: null })
  })

  it('actually sets the admin flag', () => {
    const decision = mayRegister(h.db, 'first@example.com', closed)
    const userId = addUser('u1', 'first@example.com')
    completeRegistration(h.db, userId, decision, NOW)
    const user = h.db.select().from(schema.authUser).where(eq(schema.authUser.id, userId)).get()
    expect(user?.isAdmin).toBe(true)
  })

  it('stops granting admin once a user exists', () => {
    addUser('u1', 'first@example.com')
    expect(instanceIsEmpty(h.db)).toBe(false)
    const decision = mayRegister(h.db, 'second@example.com', closed)
    expect(decision.allowed).toBe(false)
  })

  it('treats an emptied instance as uninitialised again', () => {
    // Derived from a count rather than a stored flag, so it cannot drift out of step with
    // reality — an instance whose only user was removed genuinely needs a new first user.
    addUser('u1', 'first@example.com')
    h.db.delete(schema.authUser).where(eq(schema.authUser.id, 'u1')).run()
    expect(mayRegister(h.db, 'again@example.com', closed)).toEqual({
      allowed: true,
      asAdmin: true,
      inviteId: null,
    })
  })
})

describe('invite-only is the default posture', () => {
  beforeEach(() => addUser('u1', 'admin@example.com'))

  it('refuses an uninvited address', () => {
    const decision = mayRegister(h.db, 'stranger@example.com', closed)
    expect(decision).toMatchObject({ allowed: false, code: 'auth.invite_required' })
  })

  it('admits an invited address, not as admin', () => {
    addInvite('guest@example.com', '2026-12-01T00:00:00.000Z')
    const decision = mayRegister(h.db, 'guest@example.com', closed)
    expect(decision).toMatchObject({ allowed: true, asAdmin: false })
  })

  it('normalises case and surrounding space', () => {
    addInvite('guest@example.com', '2026-12-01T00:00:00.000Z')
    expect(mayRegister(h.db, '  Guest@Example.COM ', closed).allowed).toBe(true)
  })

  it('refuses an expired invite', () => {
    addInvite('guest@example.com', '2026-01-01T00:00:00.000Z')
    expect(mayRegister(h.db, 'guest@example.com', closed).allowed).toBe(false)
  })

  it('refuses an already-accepted invite — an invite is single-use', () => {
    addInvite('guest@example.com', '2026-12-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    expect(mayRegister(h.db, 'guest@example.com', closed).allowed).toBe(false)
  })

  it('marks the invite accepted so it cannot be reused', () => {
    const inviteId = addInvite('guest@example.com', '2026-12-01T00:00:00.000Z')
    const decision = mayRegister(h.db, 'guest@example.com', closed)
    const userId = addUser('u2', 'guest@example.com')
    completeRegistration(h.db, userId, decision, NOW)

    const invite = h.db.select().from(schema.invite).where(eq(schema.invite.id, inviteId)).get()
    expect(invite?.acceptedAt).toBe(NOW)
    expect(mayRegister(h.db, 'guest@example.com', closed).allowed).toBe(false)
  })

  it('does not grant admin to an invited user', () => {
    addInvite('guest@example.com', '2026-12-01T00:00:00.000Z')
    const decision = mayRegister(h.db, 'guest@example.com', closed)
    const userId = addUser('u2', 'guest@example.com')
    completeRegistration(h.db, userId, decision, NOW)
    const user = h.db.select().from(schema.authUser).where(eq(schema.authUser.id, userId)).get()
    expect(user?.isAdmin).toBe(false)
  })
})

describe('open registration is opt-in only', () => {
  it('admits an uninvited address when the operator has enabled it', () => {
    addUser('u1', 'admin@example.com')
    const decision = mayRegister(h.db, 'stranger@example.com', {
      allowOpenRegistration: true,
      now: NOW,
    })
    expect(decision).toMatchObject({ allowed: true, asAdmin: false })
  })

  it('still does not grant admin to the second user', () => {
    addUser('u1', 'admin@example.com')
    const decision = mayRegister(h.db, 'stranger@example.com', {
      allowOpenRegistration: true,
      now: NOW,
    })
    expect(decision).toMatchObject({ asAdmin: false })
  })
})
