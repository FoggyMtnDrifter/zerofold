import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { CommandError } from '../context.ts'

/**
 * Whether this instance has any users yet.
 *
 * Drives two things: the setup screen, and first-user-becomes-admin. Deliberately a count
 * rather than a stored "initialised" flag, so it cannot drift out of step with reality — an
 * instance whose only user was deleted is genuinely uninitialised again.
 */
export function instanceIsEmpty(db: Db): boolean {
  const row = db.select({ n: sql<number>`count(*)` }).from(schema.authUser).get()
  return Number(row?.n ?? 0) === 0
}

export type RegistrationDecision =
  | { readonly allowed: true; readonly asAdmin: boolean; readonly inviteId: string | null }
  | { readonly allowed: false; readonly reason: string; readonly code: string }

/**
 * May this email register?
 *
 * The default posture is **invite-only**, because a self-hosted instance reachable from the
 * internet with open registration is an account farm. Three ways through:
 *
 *   1. the instance is empty — the first account is the admin, and needs no invite because
 *      there is nobody to issue one
 *   2. a valid, unexpired, unaccepted invite for that address
 *   3. the operator has deliberately set ZEROFOLD_ALLOW_OPEN_REGISTRATION
 */
export function mayRegister(
  db: Db,
  email: string,
  options: { readonly allowOpenRegistration: boolean; readonly now: string },
): RegistrationDecision {
  const normalised = email.trim().toLowerCase()
  if (!normalised) {
    return { allowed: false, reason: 'An email address is required.', code: 'auth.email_required' }
  }

  if (instanceIsEmpty(db)) {
    return { allowed: true, asAdmin: true, inviteId: null }
  }

  const invite = db
    .select()
    .from(schema.invite)
    .where(
      and(
        eq(schema.invite.email, normalised),
        isNull(schema.invite.acceptedAt),
        gt(schema.invite.expiresAt, options.now),
      ),
    )
    .get()

  if (invite) return { allowed: true, asAdmin: false, inviteId: invite.id }
  if (options.allowOpenRegistration) return { allowed: true, asAdmin: false, inviteId: null }

  return {
    allowed: false,
    reason: 'Registration on this instance is by invitation only.',
    code: 'auth.invite_required',
  }
}

/** Apply the consequences of a successful registration. */
export function completeRegistration(
  db: Db,
  userId: string,
  decision: RegistrationDecision,
  now: string,
): void {
  if (!decision.allowed) throw new CommandError(decision.reason, decision.code)

  if (decision.asAdmin) {
    // Auth timestamps are instants stored as epoch integers, unlike the ISO strings used for
    // domain metadata — Better Auth binds Date objects. See packages/db/src/schema/auth.ts.
    db.update(schema.authUser)
      .set({ isAdmin: true, updatedAt: new Date(now) })
      .where(eq(schema.authUser.id, userId))
      .run()
  }
  if (decision.inviteId) {
    db.update(schema.invite)
      .set({ acceptedAt: now, updatedAt: now })
      .where(eq(schema.invite.id, decision.inviteId))
      .run()
  }
}
