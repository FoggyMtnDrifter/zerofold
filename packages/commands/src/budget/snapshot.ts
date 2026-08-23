import type {
  Assignment,
  CardEvent,
  CardInput,
  EngineInput,
  LedgerEntry,
  MonthInput,
} from '@zerofold/budget-engine'
import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import {
  addMonths,
  type BudgetMonth,
  budgetMonth,
  calendarDate,
  monthsBetween,
} from '@zerofold/shared/date'
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
 * Every categorised transaction, as the engine's ledger.
 *
 * Individually rather than summed, because coverage is applied one charge at a time against a
 * running balance and the order decides the answer (R1, R2, R6, R7′). A sum cannot express
 * "this charge was covered and that one was not".
 *
 * Splits contribute through their subtransactions rather than their parent, which carries no
 * category of its own — counting both would double every split.
 */
function ledgerEntries(db: Db, planId: string): LedgerEntry[] {
  const isCredit = sql<number>`case when ${schema.account.type} in ('creditCard', 'lineOfCredit') then 1 else 0 end`
  const budgetable = sql`${schema.category.internalKind} is null`

  const plain = db
    .select({
      id: schema.transaction.id,
      date: schema.transaction.date,
      categoryId: schema.transaction.categoryId,
      amount: schema.transaction.amount,
      accountId: schema.transaction.accountId,
      credit: isCredit,
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
        budgetable,
      ),
    )
    .all()

  const split = db
    .select({
      id: schema.subtransaction.id,
      date: schema.transaction.date,
      categoryId: schema.subtransaction.categoryId,
      amount: schema.subtransaction.amount,
      accountId: schema.transaction.accountId,
      credit: isCredit,
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
        budgetable,
      ),
    )
    .all()

  return [...plain, ...split]
    .filter((r): r is typeof r & { categoryId: string } => r.categoryId !== null)
    .map((r) => ({
      id: r.id,
      categoryId: r.categoryId,
      date: calendarDate(r.date),
      amount: milli(r.amount),
      accountId: r.accountId,
      /*
       * `Number(...)`, not `=== 0`.
       *
       * The connection runs with `safeIntegers`, so a raw `sql<number>` comes back as a BigInt
       * and `0n === 0` is false. Every cash transaction would be treated as a card charge —
       * silently, since credit overspending does not touch Ready to Assign, so the only symptom
       * is a figure that stays still when it should move. The custom column types exist to stop
       * this; a raw SQL expression steps around them.
       */
      isCash: Number(r.credit) === 0,
    }))
}

/**
 * Everything on a credit account that no budget category funded.
 *
 * One query for three things that behave identically: payments transferred in, interest nobody
 * categorised (R63), and the negative opening balance a card arrives with (R37). What they have
 * in common is precisely what matters — the budget never assigned money for them.
 *
 * Amounts categorised to Inflow on a card are included, because they are not income either
 * (R64); they reduce debt like any other money arriving at the card.
 */
function cardEvents(db: Db, planId: string): CardEvent[] {
  return db
    .select({
      id: schema.transaction.id,
      date: schema.transaction.date,
      amount: schema.transaction.amount,
      accountId: schema.transaction.accountId,
    })
    .from(schema.transaction)
    .leftJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .where(
      and(
        eq(schema.transaction.planId, planId),
        eq(schema.transaction.deleted, false),
        eq(schema.account.deleted, false),
        sql`${schema.account.type} in ('creditCard', 'lineOfCredit')`,
        sql`${schema.category.internalKind} is not null or ${schema.transaction.categoryId} is null`,
      ),
    )
    .all()
    .map((r) => ({
      id: r.id,
      date: calendarDate(r.date),
      amount: milli(r.amount),
      accountId: r.accountId,
    }))
}

/** Assignments, which are stored rather than derived — the one authoritative input. */
function assignmentsByMonth(db: Db, planId: string): Map<string, Assignment[]> {
  const out = new Map<string, Assignment[]>()
  const rows = db
    .select({
      month: schema.monthCategory.month,
      categoryId: schema.monthCategory.categoryId,
      budgeted: schema.monthCategory.budgeted,
    })
    .from(schema.monthCategory)
    .where(and(eq(schema.monthCategory.planId, planId), eq(schema.monthCategory.deleted, false)))
    .all()

  for (const row of rows) {
    const bucket = out.get(row.month) ?? []
    bucket.push({ categoryId: row.categoryId, budgeted: milli(row.budgeted) })
    out.set(row.month, bucket)
  }
  return out
}

/**
 * Every budgetable category, in display order.
 *
 * Hidden categories are included: hiding is a pure display flag (R14) and a hidden category
 * keeps its balance and still counts toward the month's totals (R15). Excluding them here
 * would quietly delete money from the budget. Payment categories are included too — they hold
 * money and appear in the grid.
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

/** The credit accounts and the payment category each one projects into the budget. */
export function planCards(db: Db, planId: string): readonly CardInput[] {
  return db
    .select({
      accountId: schema.account.id,
      paymentCategoryId: schema.category.id,
    })
    .from(schema.account)
    .innerJoin(schema.category, eq(schema.category.creditAccountId, schema.account.id))
    .where(
      and(
        eq(schema.account.planId, planId),
        eq(schema.account.deleted, false),
        eq(schema.category.deleted, false),
      ),
    )
    .all()
}

const monthOf = (date: string) => `${date.slice(0, 7)}-01`

export function snapshot(db: Db, planId: string, today: BudgetMonth): EngineInput {
  const months = planMonths(db, planId, today)
  const income = incomeByMonth(db, planId)
  const assignments = assignmentsByMonth(db, planId)

  const entries = new Map<string, LedgerEntry[]>()
  for (const entry of ledgerEntries(db, planId)) {
    const key = monthOf(entry.date)
    const bucket = entries.get(key)
    if (bucket) bucket.push(entry)
    else entries.set(key, [entry])
  }

  const events = new Map<string, CardEvent[]>()
  for (const event of cardEvents(db, planId)) {
    const key = monthOf(event.date)
    const bucket = events.get(key)
    if (bucket) bucket.push(event)
    else events.set(key, [event])
  }

  return {
    categories: budgetableCategories(db, planId),
    cards: planCards(db, planId),
    months: months.map(
      (month): MonthInput => ({
        month,
        income: income.get(month) ?? ZERO,
        assignments: assignments.get(month) ?? [],
        entries: entries.get(month) ?? [],
        cardEvents: events.get(month) ?? [],
      }),
    ),
  }
}

/** Sum of a month's income, used by callers that want it without a full snapshot. */
export const totalIncome = (input: EngineInput): Milliunits =>
  input.months.reduce((total, month) => add(total, month.income), ZERO)

export { budgetMonth }
