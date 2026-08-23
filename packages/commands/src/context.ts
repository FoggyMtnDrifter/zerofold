import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { CalendarDate } from '@zerofold/shared/date'
import { eq, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

/**
 * Everything a command may depend on, passed in rather than reached for.
 *
 * `today` and `now` are arguments for the same reason the engine takes them: a command that
 * reads the clock cannot be tested deterministically, and "today" has exactly one definition —
 * the plan's timezone (ADR-0005).
 */
export interface CommandContext {
  readonly db: Db
  readonly userId: string
  readonly today: CalendarDate
  readonly now: string
  readonly newId: () => string
}

export const makeContext = (
  db: Db,
  userId: string,
  today: CalendarDate,
  now = new Date().toISOString(),
): CommandContext => ({ db, userId, today, now, newId: uuidv7 })

/**
 * A write against one plan.
 *
 * Every mutation runs through here so that three things always happen together, atomically:
 *
 *   1. `plan.server_knowledge` increments exactly once
 *   2. every row the command touches records that value in `knowledge_at_change`
 *   3. the recompute watermark moves back if an earlier month was affected
 *
 * A delta request is then `WHERE knowledge_at_change > ?`, which is only correct if no write
 * can escape this path. That is the reason it exists rather than each command doing its own
 * bookkeeping.
 */
export interface PlanWrite {
  readonly knowledge: number
  /** Move the recompute watermark back to `month` if it is earlier than the current one. */
  markDirtyFrom(month: string): void
}

export function withPlanWrite<T>(
  ctx: CommandContext,
  planId: string,
  fn: (write: PlanWrite) => T,
): T {
  return ctx.db.transaction((tx) => {
    const updated = tx
      .update(schema.plan)
      .set({ serverKnowledge: sql`${schema.plan.serverKnowledge} + 1`, updatedAt: ctx.now })
      .where(eq(schema.plan.id, planId))
      .returning({ knowledge: schema.plan.serverKnowledge })
      .all()

    const knowledge = updated[0]?.knowledge
    if (knowledge === undefined) throw new PlanNotFoundError(planId)

    const write: PlanWrite = {
      knowledge,
      markDirtyFrom(month) {
        tx.insert(schema.planRecalc)
          .values({ planId, dirtyFromMonth: month, epoch: 0, lastRunAt: null, runningBy: null })
          .onConflictDoUpdate({
            target: schema.planRecalc.planId,
            // MIN over NULL returns NULL in SQLite, so COALESCE the incoming value in first.
            set: {
              dirtyFromMonth: sql`MIN(COALESCE(${schema.planRecalc.dirtyFromMonth}, ${month}), ${month})`,
            },
          })
          .run()
      },
    }
    return fn(write)
  })
}

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`no such plan: ${planId}`)
    this.name = 'PlanNotFoundError'
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}
