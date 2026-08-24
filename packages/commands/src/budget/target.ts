import type { GoalType } from '@zerofold/budget-engine'
import { schema } from '@zerofold/db'
import type { BudgetMonth } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'

export interface SetTargetInput {
  readonly planId: string
  readonly categoryId: string
  /** The month this version of the target takes effect from. */
  readonly effectiveFrom: BudgetMonth
  readonly goalType: GoalType
  readonly goalTarget: Milliunits
  readonly goalTargetMonth?: BudgetMonth | null | undefined
  /** 0 = Sunday, for a weekly cadence (R29). */
  readonly goalDay?: number | null | undefined
  /** 1 monthly, 2 weekly, 13 yearly (R31a). */
  readonly goalCadence?: 1 | 2 | 13 | null | undefined
  /** `true` = set aside, `false` = fill up to (R25). */
  readonly goalNeedsWholeAmount?: boolean | null | undefined
  readonly repeats?: boolean | undefined
}

/**
 * Set a category's target.
 *
 * Writes a **revision** rather than editing in place (divergence D2). Editing one record would
 * silently rewrite what every past month needed, and a budget whose history changes when you
 * adjust a goal today is a budget whose past cannot be checked. Setting a target twice in the
 * same month replaces that month's revision; setting one in a later month leaves the earlier
 * revisions to keep describing the months they governed.
 */
export function setTarget(ctx: CommandContext, input: SetTargetInput): void {
  const category = ctx.db
    .select()
    .from(schema.category)
    .where(and(eq(schema.category.id, input.categoryId), eq(schema.category.planId, input.planId)))
    .get()

  if (!category || category.deleted) {
    throw new CommandError('No such category.', 'category.not_found')
  }
  if (category.internalKind === 'inflow_rta' || category.internalKind === 'uncategorized') {
    throw new CommandError('That category cannot have a target.', 'category.not_targetable')
  }
  if (input.goalTarget < 0n) {
    throw new CommandError('A target cannot be negative.', 'target.negative')
  }
  if ((input.goalType === 'TBD' || input.goalCadence === 13) && !input.goalTargetMonth) {
    throw new CommandError('That kind of target needs a month to reach it by.', 'target.no_date')
  }
  if (input.goalCadence === 2 && input.goalDay === undefined) {
    throw new CommandError('A weekly target needs a day of the week.', 'target.no_day')
  }

  withPlanWrite(ctx, input.planId, (write) => {
    ctx.db
      .insert(schema.categoryTarget)
      .values({
        id: ctx.newId(),
        planId: input.planId,
        categoryId: input.categoryId,
        effectiveFromMonth: input.effectiveFrom,
        goalType: input.goalType,
        goalTarget: input.goalTarget,
        goalTargetMonth: input.goalTargetMonth ?? null,
        goalDay: input.goalDay ?? null,
        goalCadence: input.goalCadence ?? null,
        goalCadenceFrequency: input.goalCadence ? 1 : null,
        goalNeedsWholeAmount: input.goalNeedsWholeAmount ?? null,
        repeats: input.repeats ?? true,
        knowledgeAtChange: write.knowledge,
      })
      .onConflictDoUpdate({
        target: [
          schema.categoryTarget.planId,
          schema.categoryTarget.categoryId,
          schema.categoryTarget.effectiveFromMonth,
        ],
        set: {
          goalType: input.goalType,
          goalTarget: input.goalTarget,
          goalTargetMonth: input.goalTargetMonth ?? null,
          goalDay: input.goalDay ?? null,
          goalCadence: input.goalCadence ?? null,
          goalCadenceFrequency: input.goalCadence ? 1 : null,
          goalNeedsWholeAmount: input.goalNeedsWholeAmount ?? null,
          repeats: input.repeats ?? true,
          deleted: false,
          knowledgeAtChange: write.knowledge,
          updatedAt: ctx.now,
        },
      })
      .run()

    write.markDirtyFrom(input.effectiveFrom)
  })
}

export interface ClearTargetInput {
  readonly planId: string
  readonly categoryId: string
  readonly effectiveFrom: BudgetMonth
}

/**
 * Stop targeting a category, from a month onward.
 *
 * Recorded as a revision like any other — a `TB` with a target of zero, which demands nothing
 * in any month (R26) — rather than by deleting the history. Removing the revisions would make
 * every past month recompute as though the target had never existed.
 */
export function clearTarget(ctx: CommandContext, input: ClearTargetInput): void {
  setTarget(ctx, {
    ...input,
    goalType: 'TB',
    goalTarget: 0n as Milliunits,
    repeats: false,
  })
}

export interface SnoozeInput {
  readonly planId: string
  readonly categoryId: string
  readonly month: BudgetMonth
  readonly snoozed: boolean
}

/**
 * Silence a category's target for one month.
 *
 * Per (category, month) rather than per category (R32) — the timestamp appears only in the
 * month it was set in. It changes no arithmetic: the need is still computed, still shown in
 * full when you look at the category, and still counted in the month's targets total. The one
 * thing it changes is the Underfunded total, which leaves it out (R33).
 */
export function snoozeTarget(ctx: CommandContext, input: SnoozeInput): void {
  withPlanWrite(ctx, input.planId, (write) => {
    const updated = ctx.db
      .update(schema.monthCategory)
      .set({
        goalSnoozedAt: input.snoozed ? ctx.now : null,
        knowledgeAtChange: write.knowledge,
      })
      .where(
        and(
          eq(schema.monthCategory.planId, input.planId),
          eq(schema.monthCategory.month, input.month),
          eq(schema.monthCategory.categoryId, input.categoryId),
        ),
      )
      .run()

    // A category with nothing assigned has no row yet; snoozing it is still meaningful.
    if (updated.changes === 0 && input.snoozed) {
      ctx.db
        .insert(schema.monthCategory)
        .values({
          planId: input.planId,
          month: input.month,
          categoryId: input.categoryId,
          budgeted: 0n as Milliunits,
          activity: 0n as Milliunits,
          balance: 0n as Milliunits,
          carriedForward: 0n as Milliunits,
          overspendKind: 'none',
          goalSnoozedAt: ctx.now,
          knowledgeAtChange: write.knowledge,
        })
        .run()
    }
  })
}
