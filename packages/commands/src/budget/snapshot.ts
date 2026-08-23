import type { EngineInput, MonthInput } from '@zerofold/budget-engine'
import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import { addMonths, type BudgetMonth, budgetMonth, monthsBetween } from '@zerofold/shared/date'
import { add, type Milliunits, milli, ZERO } from '@zerofold/shared/money'
import { and, eq, sql } from 'drizzle-orm'
import { CommandError } from '../context.ts'

/**
 * Which account types are credit.
 *
 * Duplicated as a list here rather than reaching for `isCredit`, because these queries need it
 * as SQL and not as a predicate. `account.test.ts` asserts the two agree.
 */
export const CREDIT_ACCOUNT_TYPES = ['creditCard', 'lineOfCredit'] as const

/**
 * Read a plan into the engine's input shape.
 *
 * Everything here is a query; no arithmetic that the engine could do instead. The split of
 * responsibility matters: this file knows what a transaction is, and the engine knows what a
 * budget is, and neither knows the other. That is what lets the engine be tested against a
 * measured table with no database in sight.
 */

/** A month plus its category cells, keyed for assembly. */
interface CellRow {
  readonly month: string
  readonly categoryId: string
  readonly budgeted: bigint
  readonly activity: bigint
  readonly creditActivity: bigint
}

/**
 * The months a plan spans.
 *
 * From the first month it has any history in, through the last of: next month, and the last
 * month anyone has assigned into.
 *
 * Next month rather than this one, because that is what was measured. At baseline — a fresh
 * plan, nothing assigned, today in August — the oracle's horizon was August *and September*,
 * while October returned 404 (P0-A, "structural observations"). One month ahead is what lets
 * someone budget next month before it arrives, which is the entire method; two would be an
 * invention. Months materialise lazily there too, and this is what stops a five-year-old plan
 * from evaluating to the end of time.
 */
export function planMonths(db: Db, planId: string, today: BudgetMonth): readonly BudgetMonth[] {
  const plan = db
    .select({ firstMonth: schema.plan.firstMonth, lastMonth: schema.plan.lastMonth })
    .from(schema.plan)
    .where(eq(schema.plan.id, planId))
    .get()
  if (!plan) throw new CommandError('No such plan.', 'plan.not_found')

  const first = plan.firstMonth ? budgetMonth(plan.firstMonth) : today
  const horizon = addMonths(today, 1)
  const last = plan.lastMonth && plan.lastMonth > horizon ? budgetMonth(plan.lastMonth) : horizon

  const span = monthsBetween(first, last)
  if (span < 0) return [first]

  // A guard rather than a limit: a plan spanning centuries means a corrupt `first_month`, and
  // materialising it would turn a bad row into an unbounded loop.
  if (span > 1_200) {
    throw new CommandError(
      'This plan spans an implausible number of months; its first month looks wrong.',
      'plan.month_span_implausible',
    )
  }

  return Array.from({ length: span + 1 }, (_, i) => addMonths(first, i))
}

/**
 * Income reaching Ready to Assign, by month.
 *
 * Only from accounts that are on budget and not credit: an amount categorised to Inflow on a
 * credit card never affects income in either direction (R64) — it is a reduction of debt, not
 * money arriving in the budget.
 */
function incomeByMonth(db: Db, planId: string): Map<string, Milliunits> {
  const rows = db
    .select({
      month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
      total: sql<bigint>`sum(${schema.transaction.amount})`,
    })
    .from(schema.transaction)
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .innerJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
    .where(
      and(
        eq(schema.transaction.planId, planId),
        eq(schema.transaction.deleted, false),
        eq(schema.account.onBudget, true),
        eq(schema.account.deleted, false),
        sql`${schema.account.type} not in ('creditCard', 'lineOfCredit')`,
        eq(schema.category.internalKind, 'inflow_rta'),
      ),
    )
    .groupBy(sql`1`)
    .all()

  return new Map(rows.map((r) => [r.month, milli(BigInt(r.total ?? 0))]))
}

/**
 * Category activity by month, with the credit-funded part separated out.
 *
 * Splits contribute through their subtransactions rather than their parent, because the parent
 * of a split carries no category of its own — counting both would double every split.
 */
function activityByMonth(db: Db, planId: string): CellRow[] {
  const plain = db
    .select({
      month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
      categoryId: schema.transaction.categoryId,
      total: sql<bigint>`sum(${schema.transaction.amount})`,
      credit: sql<bigint>`sum(case when ${schema.account.type} in ('creditCard', 'lineOfCredit') then ${schema.transaction.amount} else 0 end)`,
    })
    .from(schema.transaction)
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .innerJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
    .where(
      and(
        eq(schema.transaction.planId, planId),
        eq(schema.transaction.deleted, false),
        eq(schema.account.onBudget, true),
        eq(schema.account.deleted, false),
        sql`${schema.category.internalKind} is null or ${schema.category.internalKind} = 'credit_card_payment'`,
      ),
    )
    .groupBy(sql`1, 2`)
    .all()

  const split = db
    .select({
      month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
      categoryId: schema.subtransaction.categoryId,
      total: sql<bigint>`sum(${schema.subtransaction.amount})`,
      credit: sql<bigint>`sum(case when ${schema.account.type} in ('creditCard', 'lineOfCredit') then ${schema.subtransaction.amount} else 0 end)`,
    })
    .from(schema.subtransaction)
    .innerJoin(schema.transaction, eq(schema.transaction.id, schema.subtransaction.transactionId))
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .innerJoin(schema.category, eq(schema.category.id, schema.subtransaction.categoryId))
    .where(
      and(
        eq(schema.subtransaction.planId, planId),
        eq(schema.subtransaction.deleted, false),
        eq(schema.transaction.deleted, false),
        eq(schema.account.onBudget, true),
        eq(schema.account.deleted, false),
        sql`${schema.category.internalKind} is null or ${schema.category.internalKind} = 'credit_card_payment'`,
      ),
    )
    .groupBy(sql`1, 2`)
    .all()

  return [...plain, ...split]
    .filter((r): r is typeof r & { categoryId: string } => r.categoryId !== null)
    .map((r) => ({
      month: r.month,
      categoryId: r.categoryId,
      budgeted: 0n,
      activity: BigInt(r.total ?? 0),
      creditActivity: BigInt(r.credit ?? 0),
    }))
}

/** Assignments, which are stored rather than derived — the one authoritative input. */
function budgetedByMonth(db: Db, planId: string): CellRow[] {
  return db
    .select({
      month: schema.monthCategory.month,
      categoryId: schema.monthCategory.categoryId,
      budgeted: schema.monthCategory.budgeted,
    })
    .from(schema.monthCategory)
    .where(and(eq(schema.monthCategory.planId, planId), eq(schema.monthCategory.deleted, false)))
    .all()
    .map((r) => ({
      month: r.month,
      categoryId: r.categoryId,
      budgeted: r.budgeted,
      activity: 0n,
      creditActivity: 0n,
    }))
}

/**
 * Every budgetable category, in display order.
 *
 * Hidden categories are included: hiding is a pure display flag (R14) and a hidden category
 * keeps its balance and still counts toward the month's totals (R15). Excluding them here
 * would quietly delete money from the budget.
 */
export function budgetableCategories(db: Db, planId: string): readonly string[] {
  return db
    .select({ id: schema.category.id })
    .from(schema.category)
    .innerJoin(schema.categoryGroup, eq(schema.categoryGroup.id, schema.category.categoryGroupId))
    .where(
      and(
        eq(schema.category.planId, planId),
        eq(schema.category.deleted, false),
        sql`${schema.category.internalKind} is null or ${schema.category.internalKind} = 'credit_card_payment'`,
      ),
    )
    .orderBy(schema.categoryGroup.sortOrder, schema.category.sortOrder)
    .all()
    .map((r) => r.id)
}

export function snapshot(db: Db, planId: string, today: BudgetMonth): EngineInput {
  const months = planMonths(db, planId, today)
  const categories = budgetableCategories(db, planId)
  const income = incomeByMonth(db, planId)

  const cells = new Map<string, Map<string, CellRow>>()
  for (const row of [...budgetedByMonth(db, planId), ...activityByMonth(db, planId)]) {
    const bucket = cells.get(row.month) ?? new Map<string, CellRow>()
    const existing = bucket.get(row.categoryId)
    bucket.set(
      row.categoryId,
      existing
        ? {
            ...existing,
            budgeted: existing.budgeted + row.budgeted,
            activity: existing.activity + row.activity,
            creditActivity: existing.creditActivity + row.creditActivity,
          }
        : row,
    )
    cells.set(row.month, bucket)
  }

  return {
    categories,
    months: months.map(
      (month): MonthInput => ({
        month,
        income: income.get(month) ?? ZERO,
        cells: [...(cells.get(month)?.values() ?? [])].map((cell) => ({
          categoryId: cell.categoryId,
          budgeted: milli(cell.budgeted),
          activity: milli(cell.activity),
          creditActivity: milli(cell.creditActivity),
        })),
      }),
    ),
  }
}

/** Sum of a month's income, used by callers that want it without a full snapshot. */
export const totalIncome = (input: EngineInput): Milliunits =>
  input.months.reduce((total, month) => add(total, month.income), ZERO)

export { budgetMonth }
