import type { Db, UndoCommand } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { CalendarDate } from '@zerofold/shared/date'
import { and, eq, sql } from 'drizzle-orm'
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
  /**
   * True while an undo or redo is being applied.
   *
   * It lives here rather than on each command's input so that no command has to remember to
   * forward it: a replayed write must not push a new undo entry, or the stack would grow as you
   * walk it and undo would never reach the beginning.
   */
  readonly replaying?: boolean
}

export const makeContext = (
  db: Db,
  userId: string,
  today: CalendarDate,
  now = new Date().toISOString(),
): CommandContext => ({ db, userId, today, now, newId: uuidv7 })

/** The same context, in replay mode: writes apply but do not push new undo entries. */
export const replaying = (ctx: CommandContext): CommandContext => ({ ...ctx, replaying: true })

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
 *
 * It is also where a command registers how to undo itself, so the undo entry and the change it
 * inverts commit or roll back together (ADR-0008).
 */
export interface PlanWrite {
  readonly knowledge: number
  /** Move the recompute watermark back to `month` if it is earlier than the current one. */
  markDirtyFrom(month: string): void
  /**
   * Record how to reverse this change, and how to reapply it.
   *
   * Commands that call this become undoable; commands that do not, are not — visibly, because
   * the control reads the stack rather than guessing. Pass `groupId` to fold several writes into
   * one step, so deleting eleven rows is one press of undo rather than eleven.
   */
  recordUndo(entry: UndoRegistration): void
}

export interface UndoRegistration {
  /** Shown on the control, in the user's terms: "Delete 11 transactions". */
  readonly label: string
  readonly inverse: UndoCommand
  readonly forward: UndoCommand
  /** Defaults to a fresh group — one write, one step. */
  readonly groupId?: string
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
      recordUndo(entry) {
        if (ctx.replaying) return

        /*
         * Anything new invalidates the redo stack.
         *
         * Deleting the undone entries rather than flagging them is deliberate: a redo entry that
         * outlives the state it was recorded against would reapply a command whose subject may
         * no longer exist, and "redo" would mean "attempt something from a world that ended".
         */
        tx.delete(schema.undoEntry)
          .where(
            and(
              eq(schema.undoEntry.planId, planId),
              eq(schema.undoEntry.userId, ctx.userId),
              eq(schema.undoEntry.undone, true),
            ),
          )
          .run()

        const highest = tx
          .select({ seq: schema.undoEntry.seq })
          .from(schema.undoEntry)
          .where(and(eq(schema.undoEntry.planId, planId), eq(schema.undoEntry.userId, ctx.userId)))
          .orderBy(sql`${schema.undoEntry.seq} DESC`)
          .limit(1)
          .get()

        tx.insert(schema.undoEntry)
          .values({
            id: ctx.newId(),
            planId,
            userId: ctx.userId,
            seq: (highest?.seq ?? 0) + 1,
            groupId: entry.groupId ?? ctx.newId(),
            at: ctx.now,
            label: entry.label,
            inverse: entry.inverse,
            forward: entry.forward,
            undone: false,
          })
          .run()
      },
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
