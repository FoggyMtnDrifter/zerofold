import { run } from '@zerofold/budget-engine'
import { schema } from '@zerofold/db'
import type { BudgetMonth } from '@zerofold/shared/date'
import { and, eq } from 'drizzle-orm'
import type { CommandContext, PlanWrite } from '../context.ts'
import { withPlanWrite } from '../context.ts'
import { snapshot } from './snapshot.ts'

/**
 * Recompute a plan's derived budget figures and write them to the cache.
 *
 * `month_category.budgeted` is the only authoritative value in that table; every other column
 * is a cache of what the engine produced. This function is therefore always safe to run: it
 * reads the inputs, recomputes from scratch, and overwrites the outputs. `verify` below runs
 * the same computation and compares instead of writing, which is what makes the cache
 * falsifiable rather than merely convenient.
 *
 * Nothing on screen waits for this. The budget view runs the engine over live inputs, so the
 * cache exists for the things that cannot: delta requests, which need a stable
 * `knowledge_at_change` per row, and the compatible API. Writes dominate the cost — a
 * five-year plan with 200 categories is 12,000 rows and about a second, against 16ms for the
 * engine pass over the same data — which is exactly why editing a cell no longer triggers one.
 */
export function recompute(ctx: CommandContext, planId: string, today: BudgetMonth): void {
  withPlanWrite(ctx, planId, (write) => {
    writeCache(ctx, planId, today, write)
    // The plan is clean as of now; a later edit moves the watermark back again.
    ctx.db.delete(schema.planRecalc).where(eq(schema.planRecalc.planId, planId)).run()
  })
}

function writeCache(
  ctx: CommandContext,
  planId: string,
  today: BudgetMonth,
  write: PlanWrite,
): void {
  const output = run(snapshot(ctx.db, planId, today))

  for (const month of output.months) {
    ctx.db
      .insert(schema.month)
      .values({
        planId,
        month: month.month,
        income: month.income,
        budgeted: month.budgeted,
        activity: month.activity,
        toBeBudgeted: month.toBeBudgeted,
        ageOfMoney: month.ageOfMoney,
        knowledgeAtChange: write.knowledge,
      })
      .onConflictDoUpdate({
        target: [schema.month.planId, schema.month.month],
        set: {
          income: month.income,
          budgeted: month.budgeted,
          activity: month.activity,
          toBeBudgeted: month.toBeBudgeted,
          ageOfMoney: month.ageOfMoney,
          knowledgeAtChange: write.knowledge,
        },
      })
      .run()

    for (const cell of month.cells) {
      ctx.db
        .insert(schema.monthCategory)
        .values({
          planId,
          month: month.month,
          categoryId: cell.categoryId,
          budgeted: cell.budgeted,
          activity: cell.activity,
          balance: cell.balance,
          carriedForward: cell.carriedForward,
          overspendKind: cell.overspendKind,
          derivedForDate: today,
          knowledgeAtChange: write.knowledge,
        })
        .onConflictDoUpdate({
          target: [
            schema.monthCategory.planId,
            schema.monthCategory.month,
            schema.monthCategory.categoryId,
          ],
          // `budgeted` is deliberately absent: it is the input, and a recompute that wrote it
          // back could only ever overwrite the truth with a copy of itself — or, on a bug,
          // with something else.
          set: {
            activity: cell.activity,
            balance: cell.balance,
            carriedForward: cell.carriedForward,
            overspendKind: cell.overspendKind,
            derivedForDate: today,
            knowledgeAtChange: write.knowledge,
          },
        })
        .run()
    }
  }
}

export interface Discrepancy {
  readonly month: string
  readonly categoryId: string | null
  readonly field: string
  readonly cached: bigint | string | null
  readonly computed: bigint | string | null
}

/**
 * Compare the cache against a from-scratch recompute, without writing anything.
 *
 * The plan calls for `zerofold recalculate --verify` to assert cache-equals-recompute. This is
 * that assertion. A cache nobody checks is a second source of truth, and the failure mode is a
 * budget that looks right and is not.
 */
export function verify(ctx: CommandContext, planId: string, today: BudgetMonth): Discrepancy[] {
  const output = run(snapshot(ctx.db, planId, today))
  const out: Discrepancy[] = []

  const cachedMonths = new Map(
    ctx.db
      .select()
      .from(schema.month)
      .where(eq(schema.month.planId, planId))
      .all()
      .map((row) => [row.month, row]),
  )

  const cachedCells = new Map(
    ctx.db
      .select()
      .from(schema.monthCategory)
      .where(and(eq(schema.monthCategory.planId, planId), eq(schema.monthCategory.deleted, false)))
      .all()
      .map((row) => [`${row.month}/${row.categoryId}`, row]),
  )

  for (const month of output.months) {
    const cached = cachedMonths.get(month.month)
    if (!cached) {
      out.push({
        month: month.month,
        categoryId: null,
        field: 'month',
        cached: null,
        computed: 'present',
      })
      continue
    }
    for (const field of ['income', 'budgeted', 'activity', 'toBeBudgeted'] as const) {
      if (cached[field] !== month[field]) {
        out.push({
          month: month.month,
          categoryId: null,
          field,
          cached: cached[field],
          computed: month[field],
        })
      }
    }

    for (const cell of month.cells) {
      const row = cachedCells.get(`${month.month}/${cell.categoryId}`)
      if (!row) {
        // A cell with nothing in it was never written, which is correct rather than missing.
        if (cell.budgeted === 0n && cell.activity === 0n && cell.balance === 0n) continue
        out.push({
          month: month.month,
          categoryId: cell.categoryId,
          field: 'cell',
          cached: null,
          computed: 'present',
        })
        continue
      }
      for (const field of ['budgeted', 'activity', 'balance', 'carriedForward'] as const) {
        if (row[field] !== cell[field]) {
          out.push({
            month: month.month,
            categoryId: cell.categoryId,
            field,
            cached: row[field],
            computed: cell[field],
          })
        }
      }
      if (row.overspendKind !== cell.overspendKind) {
        out.push({
          month: month.month,
          categoryId: cell.categoryId,
          field: 'overspendKind',
          cached: row.overspendKind,
          computed: cell.overspendKind,
        })
      }
    }
  }

  return out
}

/**
 * Recompute inside a write that is already open.
 *
 * For callers that must leave the cache current within one transaction — a delta request served
 * from a dirty plan, for instance. Ordinary edits mark the plan dirty and move on.
 */
export const refreshCache = (
  ctx: CommandContext,
  planId: string,
  today: BudgetMonth,
  write: PlanWrite,
): void => writeCache(ctx, planId, today, write)
