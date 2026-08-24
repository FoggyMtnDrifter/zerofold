import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { BudgetMonth, CalendarDate } from '@zerofold/shared/date'
import { addMonths, daysInMonth, fromParts, monthsBetween, parts } from '@zerofold/shared/date'
import { milli, type Milliunits, ZERO } from '@zerofold/shared/money'
import { and, eq, gte, lte, sql } from 'drizzle-orm'

/**
 * Reports.
 *
 * All read-only, all computed from the ledger rather than from the budget cache. A report that
 * disagreed with the register would be worse than no report, and the only way to guarantee it
 * does not is to ask the same rows the register asks.
 */

export interface Period {
  readonly from: BudgetMonth
  readonly through: BudgetMonth
}

const monthsIn = (period: Period): readonly BudgetMonth[] => {
  const span = monthsBetween(period.from, period.through)
  if (span < 0) return []
  return Array.from({ length: span + 1 }, (_, i) => addMonths(period.from, i))
}

const firstDay = (month: BudgetMonth): CalendarDate => month

/**
 * The last day of a month, without a `Date` anywhere near it.
 *
 * Constructing one and stepping back a day is the obvious way and the wrong one: it reintroduces
 * exactly the timezone question ADR-0005 exists to remove, on a value that is a pure calendar
 * fact. `daysInMonth` already knows this, leap years included.
 */
const lastDay = (month: BudgetMonth): CalendarDate => {
  const { year, month: index } = parts(month)
  return fromParts(year, index, daysInMonth(year, index))
}

export interface CategoryTotal {
  readonly categoryId: string
  readonly name: string
  readonly groupName: string
  readonly amount: Milliunits
}

export interface SpendingReport {
  readonly period: Period
  readonly total: Milliunits
  readonly byCategory: readonly CategoryTotal[]
  readonly byMonth: readonly { month: BudgetMonth; amount: Milliunits }[]
}

/**
 * What was spent, by category and by month.
 *
 * Only from on-budget accounts, and never from Inflow: a transfer to savings is not spending,
 * and income is not negative spending. Credit-card payment categories are excluded too — the
 * purchase was already counted in the category that made it, and counting the payment as well
 * would double every card transaction.
 */
export function spendingReport(db: Db, planId: string, period: Period): SpendingReport {
  const months = monthsIn(period)
  if (months.length === 0) {
    return { period, total: ZERO, byCategory: [], byMonth: [] }
  }

  const from = firstDay(months[0] as BudgetMonth)
  const through = lastDay(months.at(-1) as BudgetMonth)

  const spendable = and(
    eq(schema.transaction.planId, planId),
    eq(schema.transaction.deleted, false),
    eq(schema.account.onBudget, true),
    eq(schema.account.deleted, false),
    gte(schema.transaction.date, from),
    lte(schema.transaction.date, through),
    sql`${schema.category.internalKind} is null`,
  )

  const byCategory = db
    .select({
      categoryId: schema.category.id,
      name: schema.category.name,
      groupName: schema.categoryGroup.name,
      amount: sql<bigint>`sum(${schema.transaction.amount})`,
    })
    .from(schema.transaction)
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .innerJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
    .innerJoin(schema.categoryGroup, eq(schema.categoryGroup.id, schema.category.categoryGroupId))
    .where(spendable)
    .groupBy(schema.category.id)
    .all()
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.name,
      groupName: r.groupName,
      amount: milli(r.amount ?? 0n),
    }))
    // Largest outflow first, which is the order the question "where did it go" wants.
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))

  const monthly = new Map(
    db
      .select({
        month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
        amount: sql<bigint>`sum(${schema.transaction.amount})`,
      })
      .from(schema.transaction)
      .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
      .innerJoin(schema.category, eq(schema.category.id, schema.transaction.categoryId))
      .where(spendable)
      .groupBy(sql`1`)
      .all()
      .map((r) => [r.month, milli(r.amount ?? 0n)]),
  )

  return {
    period,
    total: byCategory.reduce((sum, c) => (sum + c.amount) as Milliunits, ZERO),
    byCategory,
    byMonth: months.map((month) => ({ month, amount: monthly.get(month) ?? ZERO })),
  }
}

export interface IncomeReport {
  readonly period: Period
  readonly totalIncome: Milliunits
  readonly totalSpending: Milliunits
  readonly byMonth: readonly {
    month: BudgetMonth
    income: Milliunits
    spending: Milliunits
    net: Milliunits
  }[]
}

/**
 * Income against spending, month by month.
 *
 * The pair is the point: either number alone says little, and the sign of their difference is
 * the question people actually open a report to answer.
 */
export function incomeReport(db: Db, planId: string, period: Period): IncomeReport {
  const months = monthsIn(period)
  const spending = spendingReport(db, planId, period)
  const spendingByMonth = new Map(spending.byMonth.map((m) => [m.month, m.amount]))

  const income = new Map(
    db
      .select({
        month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
        amount: sql<bigint>`sum(${schema.transaction.amount})`,
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
          // Inflow on a credit account is not income in either direction (R64).
          sql`${schema.account.type} not in ('creditCard', 'lineOfCredit')`,
          eq(schema.category.internalKind, 'inflow_rta'),
        ),
      )
      .groupBy(sql`1`)
      .all()
      .map((r) => [r.month, milli(r.amount ?? 0n)]),
  )

  const byMonth = months.map((month) => {
    const earned = income.get(month) ?? ZERO
    const spent = spendingByMonth.get(month) ?? ZERO
    return { month, income: earned, spending: spent, net: (earned + spent) as Milliunits }
  })

  return {
    period,
    totalIncome: byMonth.reduce((sum, m) => (sum + m.income) as Milliunits, ZERO),
    totalSpending: spending.total,
    byMonth,
  }
}

export interface NetWorthPoint {
  readonly month: BudgetMonth
  readonly assets: Milliunits
  readonly liabilities: Milliunits
  readonly net: Milliunits
}

/**
 * Net worth at the end of each month.
 *
 * Every account, on budget or not — a mortgage is not in the budget and is very much part of
 * what someone is worth. Computed as a running total of everything up to each month's end,
 * because a balance is a fact about all of history rather than about one month.
 */
export function netWorthReport(
  db: Db,
  planId: string,
  period: Period,
): readonly NetWorthPoint[] {
  const months = monthsIn(period)
  if (months.length === 0) return []

  const rows = db
    .select({
      month: sql<string>`substr(${schema.transaction.date}, 1, 7) || '-01'`,
      accountId: schema.transaction.accountId,
      type: schema.account.type,
      amount: sql<bigint>`sum(${schema.transaction.amount})`,
    })
    .from(schema.transaction)
    .innerJoin(schema.account, eq(schema.account.id, schema.transaction.accountId))
    .where(
      and(
        eq(schema.transaction.planId, planId),
        eq(schema.transaction.deleted, false),
        eq(schema.account.deleted, false),
        lte(schema.transaction.date, lastDay(months.at(-1) as BudgetMonth)),
      ),
    )
    .groupBy(sql`1, 2`)
    .all()

  /*
   * A running balance *per account*, then classified at each month end.
   *
   * Not by the sign of the month's own activity, which is a different and wrong question: a
   * savings account that happened to have a withdrawal in March is not a liability in March.
   * What makes something a liability is where its balance stands, and balances are facts about
   * all of history rather than about one month.
   */
  const balances = new Map<string, Milliunits>()
  const out: NetWorthPoint[] = []

  // Everything before the window still counts towards the opening position.
  const first = months[0] as BudgetMonth
  for (const row of rows) {
    if (row.month >= first) continue
    balances.set(
      row.accountId,
      ((balances.get(row.accountId) ?? ZERO) + milli(row.amount ?? 0n)) as Milliunits,
    )
  }

  for (const month of months) {
    for (const row of rows) {
      if (row.month !== month) continue
      balances.set(
        row.accountId,
        ((balances.get(row.accountId) ?? ZERO) + milli(row.amount ?? 0n)) as Milliunits,
      )
    }

    let assets = ZERO
    let liabilities = ZERO
    for (const balance of balances.values()) {
      // Classified by where the balance stands, not by account type: an overdrawn current
      // account is a liability, and a credit card in credit is an asset.
      if (balance >= ZERO) assets = (assets + balance) as Milliunits
      else liabilities = (liabilities + balance) as Milliunits
    }

    out.push({ month, assets, liabilities, net: (assets + liabilities) as Milliunits })
  }

  return out
}
