import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import { and, eq } from 'drizzle-orm'

export type Role = 'owner' | 'editor' | 'viewer'

/** Ordered least to most privileged, so a comparison is an index comparison. */
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }

export class NotAuthorizedError extends Error {
  readonly code = 'auth.forbidden'
  constructor(message = 'You do not have access to this plan.') {
    super(message)
    this.name = 'NotAuthorizedError'
  }
}

/**
 * The single per-plan authorization check.
 *
 * Every procedure that names a plan passes through here, and it is the **only** place
 * membership is consulted. §6 requires this to be one choke point rather than a check repeated
 * per route, for the obvious reason: a check repeated in twenty places is a check missing from
 * one of them, and the missing one is not discoverable by reading any single file.
 *
 * It deliberately does not distinguish "plan does not exist" from "you may not see it".
 * Reporting the difference would let anyone enumerate plan ids.
 */
export function authorizePlan(
  db: Db,
  planId: string,
  userId: string,
  minimum: Role = 'viewer',
): Role {
  const membership = db
    .select({ role: schema.planMembership.role })
    .from(schema.planMembership)
    .innerJoin(schema.plan, eq(schema.plan.id, schema.planMembership.planId))
    .where(
      and(
        eq(schema.planMembership.planId, planId),
        eq(schema.planMembership.userId, userId),
        eq(schema.plan.deleted, false),
      ),
    )
    .get()

  if (!membership) throw new NotAuthorizedError()

  const role = membership.role as Role
  if (RANK[role] < RANK[minimum]) {
    throw new NotAuthorizedError(
      minimum === 'owner'
        ? 'Only the plan owner can do that.'
        : 'You have read-only access to this plan.',
    )
  }
  return role
}
