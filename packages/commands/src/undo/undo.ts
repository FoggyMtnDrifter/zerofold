import type { UndoCommand } from '@zerofold/db'
import { schema } from '@zerofold/db'
import { and, eq, sql } from 'drizzle-orm'
import { type CommandContext, CommandError } from '../context.ts'

/**
 * The undo stack.
 *
 * This module owns the stack and nothing else: it decides which entry is next and marks it, but
 * it does not run commands. Running them means dispatching a procedure by name, which lives with
 * the procedure registry — keeping it out of here is what stops undo from becoming a second way
 * to write to the database (ADR-0008).
 */

export interface StackEntry {
  readonly id: string
  readonly label: string
  readonly command: UndoCommand
}

export interface UndoState {
  readonly undo: { readonly label: string } | null
  readonly redo: { readonly label: string } | null
}

const mine = (ctx: CommandContext, planId: string) =>
  and(eq(schema.undoEntry.planId, planId), eq(schema.undoEntry.userId, ctx.userId))

/** What the control should offer, without doing anything. */
export function undoState(ctx: CommandContext, planId: string): UndoState {
  const back = peek(ctx, planId, false)
  const forward = peek(ctx, planId, true)
  return {
    undo: back ? { label: back.label } : null,
    redo: forward ? { label: forward.label } : null,
  }
}

/**
 * The entry an undo (or redo) would act on.
 *
 * Ordered by `seq` rather than by time: two writes within the same millisecond are ordinary, and
 * a stack that sometimes walks backwards is worse than no stack at all.
 */
function peek(ctx: CommandContext, planId: string, undone: boolean) {
  return ctx.db
    .select()
    .from(schema.undoEntry)
    .where(and(mine(ctx, planId), eq(schema.undoEntry.undone, undone)))
    .orderBy(undone ? sql`${schema.undoEntry.seq} ASC` : sql`${schema.undoEntry.seq} DESC`)
    .limit(1)
    .get()
}

/**
 * Everything in the group the next undo would act on, newest first.
 *
 * A group is one user action that performed several writes. Reversing them newest-first matters:
 * they were recorded in the order they happened, and undoing in any other order can hit a state
 * the inverse was not recorded against.
 */
export function nextUndo(ctx: CommandContext, planId: string): readonly StackEntry[] {
  const head = peek(ctx, planId, false)
  if (!head) throw new CommandError('There is nothing to undo.', 'undo.empty')
  return group(ctx, planId, head.groupId, false).map((row) => ({
    id: row.id,
    label: row.label,
    command: row.inverse,
  }))
}

/** The group a redo would reapply, oldest first — the order the user originally performed it. */
export function nextRedo(ctx: CommandContext, planId: string): readonly StackEntry[] {
  const head = peek(ctx, planId, true)
  if (!head) throw new CommandError('There is nothing to redo.', 'undo.nothing_to_redo')
  return group(ctx, planId, head.groupId, true)
    .map((row) => ({ id: row.id, label: row.label, command: row.forward }))
    .reverse()
}

function group(ctx: CommandContext, planId: string, groupId: string, undone: boolean) {
  return ctx.db
    .select()
    .from(schema.undoEntry)
    .where(
      and(
        mine(ctx, planId),
        eq(schema.undoEntry.groupId, groupId),
        eq(schema.undoEntry.undone, undone),
      ),
    )
    .orderBy(sql`${schema.undoEntry.seq} DESC`)
    .all()
}

/** Move entries between the undo and redo halves of the stack. */
export function markUndone(ctx: CommandContext, ids: readonly string[], undone: boolean): void {
  for (const id of ids) {
    ctx.db.update(schema.undoEntry).set({ undone }).where(eq(schema.undoEntry.id, id)).run()
  }
}
