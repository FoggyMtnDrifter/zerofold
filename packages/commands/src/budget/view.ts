import { run, type TargetResult } from '@zerofold/budget-engine'
import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { BudgetMonth, CalendarDate } from '@zerofold/shared/date'
import { add, type Milliunits, ZERO } from '@zerofold/shared/money'
import { and, eq, isNotNull } from 'drizzle-orm'
import { CommandError } from '../context.ts'
import { snapshot } from './snapshot.ts'

export interface CardState {
  readonly accountId: string
  /** Debt from categorised purchases, already funded by the categories that made them. */
  readonly coveredDebt: Milliunits
  /** Debt no category funded: the opening balance, interest, and credit overspending. */
  readonly uncoveredDebt: Milliunits
}

export interface BudgetCell {
  readonly categoryId: string
  readonly name: string
  readonly hidden: boolean
  /**
   * Set when this row is a credit card's payment category.
   *
   * It is not an envelope you spend from: money arrives by covering charges and leaves by
   * paying the card, and its balance going negative is not an error (R60′).
   */
  readonly card: CardState | null
  readonly budgeted: Milliunits
  readonly activity: Milliunits
  readonly balance: Milliunits
  readonly overspendKind: 'none' | 'cash' | 'credit'
  readonly target: TargetResult | null
  /**
   * Set when the user has silenced this category's target for this month.
   *
   * It suppresses the nag and excludes the category from the Underfunded total, and changes
   * nothing about the target math (R32, R33). Snooze hides the fact, it does not alter it.
   */
  readonly snoozed: boolean
}

export interface BudgetGroup {
  readonly categoryGroupId: string
  readonly name: string
  readonly hidden: boolean
  /** Excludes hidden categories (R15). */
  readonly budgeted: Milliunits
  readonly activity: Milliunits
  readonly balance: Milliunits
  readonly categories: readonly BudgetCell[]
}

export interface BudgetView {
  readonly month: BudgetMonth
  readonly readyToAssign: Milliunits
  /** Month totals, which unlike group subtotals *include* hidden categories (R15). */
  readonly income: Milliunits
  readonly budgeted: Milliunits
  readonly activity: Milliunits
  readonly groups: readonly BudgetGroup[]
  readonly months: readonly BudgetMonth[]
  /**
   * What every target still wants this month.
   *
   * Excludes snoozed categories, and *only* this aggregate does — the "cost to be me" total
   * counts them (R33). Two different aggregations over the same rows, and reusing one for both
   * is a bug that only appears once a plan has a snoozed category in it.
   */
  readonly underfunded: Milliunits
  /** Null below the ten-spend floor, which means "not enough history", not "zero days". */
  readonly ageOfMoney: number | null
}

/**
 * The budget grid for one month.
 *
 * Computed rather than read from the cache. The cache exists so that a *stale* read is cheap
 * and a delta request has something to compare against; a view that served it directly would
 * be one missed invalidation away from showing numbers that are simply wrong, and the whole
 * promise of this application is that the numbers are right. `recompute --verify` asserts the
 * two agree.
 */
export function budgetView(
  db: Db,
  planId: string,
  month: BudgetMonth,
  today: BudgetMonth,
  /** The plan's actual date, not just its month — a weekly target decays through it (R30). */
  todayDate?: CalendarDate,
): BudgetView {
  const input = snapshot(db, planId, today, todayDate)
  const output = run(input)

  const current = output.months.find((m) => m.month === month)
  if (!current) {
    throw new CommandError(
      `This plan has no ${month}. Assign into it to bring it into existence.`,
      'budget.month_not_materialised',
    )
  }

  const cells = new Map(current.cells.map((cell) => [cell.categoryId, cell]))

  const snoozed = new Set(
    db
      .select({ categoryId: schema.monthCategory.categoryId })
      .from(schema.monthCategory)
      .where(
        and(
          eq(schema.monthCategory.planId, planId),
          eq(schema.monthCategory.month, month),
          isNotNull(schema.monthCategory.goalSnoozedAt),
        ),
      )
      .all()
      .map((r) => r.categoryId),
  )

  const rows = db
    .select({
      categoryId: schema.category.id,
      name: schema.category.name,
      hidden: schema.category.hidden,
      groupId: schema.categoryGroup.id,
      groupName: schema.categoryGroup.name,
      groupHidden: schema.categoryGroup.hidden,
      groupOrder: schema.categoryGroup.sortOrder,
      order: schema.category.sortOrder,
      internalKind: schema.category.internalKind,
    })
    .from(schema.category)
    .innerJoin(schema.categoryGroup, eq(schema.categoryGroup.id, schema.category.categoryGroupId))
    .where(and(eq(schema.category.planId, planId), eq(schema.category.deleted, false)))
    .orderBy(schema.categoryGroup.sortOrder, schema.category.sortOrder)
    .all()

  const groups: BudgetGroup[] = []
  const index = new Map<string, BudgetGroup>()

  for (const row of rows) {
    // Inflow and Uncategorized are not envelopes; they have no row in the grid.
    if (row.internalKind === 'inflow_rta' || row.internalKind === 'uncategorized') continue

    const cell = cells.get(row.categoryId)
    const card = current.cards.find((c) => c.paymentCategoryId === row.categoryId)
    const entry: BudgetCell = {
      categoryId: row.categoryId,
      name: row.name,
      hidden: row.hidden,
      card: card
        ? {
            accountId: card.accountId,
            coveredDebt: card.coveredDebt,
            uncoveredDebt: card.uncoveredDebt,
          }
        : null,
      budgeted: cell?.budgeted ?? ZERO,
      activity: cell?.activity ?? ZERO,
      balance: cell?.balance ?? ZERO,
      overspendKind: cell?.overspendKind ?? 'none',
      target: cell?.target ?? null,
      snoozed: snoozed.has(row.categoryId),
    }

    const existing = index.get(row.groupId)
    if (existing) {
      index.set(row.groupId, withCategory(existing, entry))
    } else {
      const group: BudgetGroup = {
        categoryGroupId: row.groupId,
        name: row.groupName,
        hidden: row.groupHidden,
        budgeted: ZERO,
        activity: ZERO,
        balance: ZERO,
        categories: [],
      }
      index.set(row.groupId, withCategory(group, entry))
      groups.push(group)
    }
  }

  let underfunded = ZERO
  for (const group of groups) {
    for (const category of index.get(group.categoryGroupId)?.categories ?? []) {
      if (category.snoozed) continue
      underfunded = add(underfunded, category.target?.underFunded ?? ZERO)
    }
  }

  return {
    month,
    underfunded,
    ageOfMoney: current.ageOfMoney,
    readyToAssign: current.toBeBudgeted,
    income: current.income,
    budgeted: current.budgeted,
    activity: current.activity,
    // `groups` preserves query order; `index` holds the accumulated values.
    groups: groups.map((g) => index.get(g.categoryGroupId) ?? g),
    months: output.months.map((m) => m.month),
  }
}

/** Subtotals skip hidden categories, while the month's own totals do not (R15). */
function withCategory(group: BudgetGroup, cell: BudgetCell): BudgetGroup {
  if (cell.hidden) return { ...group, categories: [...group.categories, cell] }
  return {
    ...group,
    budgeted: add(group.budgeted, cell.budgeted),
    activity: add(group.activity, cell.activity),
    balance: add(group.balance, cell.balance),
    categories: [...group.categories, cell],
  }
}
