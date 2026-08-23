import { schema } from '@zerofold/db'
import type { BudgetMonth } from '@zerofold/shared/date'
import { type Milliunits, sub, ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { type CommandContext, CommandError, type PlanWrite, withPlanWrite } from '../context.ts'
import { refreshCache } from './recompute.ts'

export interface AssignInput {
  readonly planId: string
  readonly month: BudgetMonth
  readonly categoryId: string
  /** The new total for the month, not a delta. */
  readonly budgeted: Milliunits
  readonly note?: string | undefined
  /** Folds several assignments into one undo step and one ledger group. */
  readonly groupId?: string | undefined
  readonly groupLabel?: string | undefined
}

/**
 * Assign money to a category for a month.
 *
 * The caller states the new total rather than a movement, because that is what the budget grid
 * edits — a cell you type into. The *ledger* records the difference, since money moving is what
 * actually happened.
 */
export function assign(ctx: CommandContext, input: AssignInput, today: BudgetMonth): void {
  const category = ctx.db
    .select()
    .from(schema.category)
    .where(and(eq(schema.category.id, input.categoryId), eq(schema.category.planId, input.planId)))
    .get()

  if (!category || category.deleted) {
    throw new CommandError('No such category.', 'category.not_found')
  }
  if (category.internalKind === 'inflow_rta' || category.internalKind === 'uncategorized') {
    // Assigning *to* Ready to Assign is the one thing it cannot receive: it is the pool
    // everything else is assigned from, and "uncategorized" is an absence, not an envelope.
    throw new CommandError('That category cannot be assigned to.', 'category.not_assignable')
  }

  withPlanWrite(ctx, input.planId, (write) => {
    const previous = currentBudgeted(ctx, input)
    const delta = sub(input.budgeted, previous)

    upsertBudgeted(ctx, input, write)
    if (delta !== ZERO) appendMovement(ctx, input, delta, write)

    extendHorizon(ctx, input.planId, input.month, today)
    write.markDirtyFrom(input.month)
    refreshCache(ctx, input.planId, today, write)

    write.recordUndo({
      label: input.groupLabel ?? 'Assign',
      inverse: {
        procedure: 'budget.assign',
        input: {
          planId: input.planId,
          month: input.month,
          categoryId: input.categoryId,
          budgeted: previous.toString(),
        },
      },
      forward: {
        procedure: 'budget.assign',
        input: {
          planId: input.planId,
          month: input.month,
          categoryId: input.categoryId,
          budgeted: input.budgeted.toString(),
        },
      },
      ...(input.groupId ? { groupId: input.groupId } : {}),
    })
  })
}

const currentBudgeted = (ctx: CommandContext, input: AssignInput): Milliunits =>
  ctx.db
    .select({ budgeted: schema.monthCategory.budgeted })
    .from(schema.monthCategory)
    .where(
      and(
        eq(schema.monthCategory.planId, input.planId),
        eq(schema.monthCategory.month, input.month),
        eq(schema.monthCategory.categoryId, input.categoryId),
      ),
    )
    .get()?.budgeted ?? ZERO

function upsertBudgeted(ctx: CommandContext, input: AssignInput, write: PlanWrite): void {
  ctx.db
    .insert(schema.monthCategory)
    .values({
      planId: input.planId,
      month: input.month,
      categoryId: input.categoryId,
      budgeted: input.budgeted,
      activity: ZERO,
      balance: ZERO,
      carriedForward: ZERO,
      overspendKind: 'none',
      knowledgeAtChange: write.knowledge,
    })
    .onConflictDoUpdate({
      target: [
        schema.monthCategory.planId,
        schema.monthCategory.month,
        schema.monthCategory.categoryId,
      ],
      set: { budgeted: input.budgeted, deleted: false, knowledgeAtChange: write.knowledge },
    })
    .run()
}

/**
 * Append to the ledger. Never edit it.
 *
 * Setting a category back to zero writes a compensating movement in the opposite direction
 * rather than removing the original (R13) — measured, and the reconciliation
 * `Σ(into) − Σ(out of) = budgeted` per (month, category) is asserted as an invariant in the
 * tests. An editable ledger would answer "how much is in this category" but not "how did it
 * get there", which is the only question a ledger exists to answer.
 */
function appendMovement(
  ctx: CommandContext,
  input: AssignInput,
  delta: Milliunits,
  write: PlanWrite,
): void {
  const intoCategory = delta > ZERO
  ctx.db
    .insert(schema.moneyMovement)
    .values({
      id: ctx.newId(),
      planId: input.planId,
      month: input.month,
      movedAt: ctx.now,
      // A null side is Ready to Assign: money always comes from somewhere and goes somewhere.
      fromCategoryId: intoCategory ? null : input.categoryId,
      toCategoryId: intoCategory ? input.categoryId : null,
      amount: (intoCategory ? delta : -delta) as Milliunits,
      performedByUserId: ctx.userId,
      knowledgeAtChange: write.knowledge,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .run()
}

/**
 * Assigning into a month brings it into existence, as it does in the oracle.
 *
 * A plan with no recorded first month has not lost its history — it has none yet, and its
 * horizon starts today. Reading the null as "the month being assigned into" is what would make
 * assigning into September delete August from the plan.
 */
function extendHorizon(
  ctx: CommandContext,
  planId: string,
  month: BudgetMonth,
  today: BudgetMonth,
): void {
  const plan = ctx.db
    .select({ lastMonth: schema.plan.lastMonth, firstMonth: schema.plan.firstMonth })
    .from(schema.plan)
    .where(eq(schema.plan.id, planId))
    .get()

  const first = plan?.firstMonth ?? today
  const set: Record<string, string> = {}
  if (!plan?.lastMonth || plan.lastMonth < month) set.lastMonth = month
  if (!plan?.firstMonth || first > month) set.firstMonth = month < first ? month : first
  if (Object.keys(set).length === 0) return

  ctx.db.update(schema.plan).set(set).where(eq(schema.plan.id, planId)).run()
}

/**
 * Move money from one category to another in one step.
 *
 * Two assignments would do the same arithmetic, but this is one movement in the ledger with
 * both ends filled in — which is the difference between "$50 left Groceries and $50 arrived in
 * Dining Out" and a record that merely implies it.
 */
export interface MoveInput {
  readonly planId: string
  readonly month: BudgetMonth
  readonly fromCategoryId: string | null
  readonly toCategoryId: string | null
  readonly amount: Milliunits
  readonly note?: string | undefined
}

export function moveMoney(ctx: CommandContext, input: MoveInput, today: BudgetMonth): void {
  if (input.amount <= ZERO) {
    throw new CommandError('Move a positive amount.', 'budget.move_not_positive')
  }
  if (input.fromCategoryId === input.toCategoryId) {
    throw new CommandError('Choose two different categories.', 'budget.move_same_category')
  }

  const groupId = ctx.newId()
  // Expressed as two assignments so both cells go through the same validation and undo path;
  // the shared group makes it one step to reverse.
  if (input.fromCategoryId) {
    const from = readBudgeted(ctx, input.planId, input.month, input.fromCategoryId)
    assign(
      ctx,
      {
        planId: input.planId,
        month: input.month,
        categoryId: input.fromCategoryId,
        budgeted: sub(from, input.amount),
        groupId,
        groupLabel: 'Move money',
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      today,
    )
  }
  if (input.toCategoryId) {
    const to = readBudgeted(ctx, input.planId, input.month, input.toCategoryId)
    assign(
      ctx,
      {
        planId: input.planId,
        month: input.month,
        categoryId: input.toCategoryId,
        budgeted: (to + input.amount) as Milliunits,
        groupId,
        groupLabel: 'Move money',
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      today,
    )
  }
}

const readBudgeted = (
  ctx: CommandContext,
  planId: string,
  month: BudgetMonth,
  categoryId: string,
): Milliunits =>
  ctx.db
    .select({ budgeted: schema.monthCategory.budgeted })
    .from(schema.monthCategory)
    .where(
      and(
        eq(schema.monthCategory.planId, planId),
        eq(schema.monthCategory.month, month),
        eq(schema.monthCategory.categoryId, categoryId),
      ),
    )
    .get()?.budgeted ?? ZERO
