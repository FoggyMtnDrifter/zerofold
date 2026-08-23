import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import {
  bool,
  budgetMonth,
  id,
  int,
  money,
  planScoped,
  ref,
  timestamp,
  timestamps,
} from './columns.ts'

export const month = sqliteTable(
  'month',
  {
    planId: ref('plan_id').notNull(),
    month: budgetMonth('month').notNull(),
    note: text('note'),

    // ── all derived ──
    income: money('income').notNull(),
    budgeted: money('budgeted').notNull(),
    activity: money('activity').notNull(),
    toBeBudgeted: money('to_be_budgeted').notNull(),
    /** Null below the 10-spending-transaction floor; 0 before any spending (R65). */
    ageOfMoney: int('age_of_money'),

    cacheEpoch: int('cache_epoch').notNull().default(0),
    knowledgeAtChange: int('knowledge_at_change').notNull().default(0),
    deleted: bool('deleted').notNull().default(false),
  },
  (t) => [uniqueIndex('month_pk').on(t.planId, t.month)],
)

/**
 * Per-month, per-category state.
 *
 * **`budgeted` is the only authoritative value in this table.** Everything else is cache,
 * and `zerofold recalculate --verify` asserts it equals a from-scratch recompute.
 */
export const monthCategory = sqliteTable(
  'month_category',
  {
    planId: ref('plan_id').notNull(),
    month: budgetMonth('month').notNull(),
    categoryId: ref('category_id').notNull(),

    /** ★ Input. Everything below is output. */
    budgeted: money('budgeted').notNull(),

    activity: money('activity').notNull(),
    /** YNAB's name for "available". */
    balance: money('balance').notNull(),
    carriedForward: money('carried_forward').notNull(),
    overspendKind: text('overspend_kind').$type<'none' | 'cash' | 'credit'>().notNull(),

    // ── derived target figures ──
    goalTargetSnapshot: money('goal_target_snapshot'),
    goalUnderFunded: money('goal_under_funded'),
    goalPercentageComplete: int('goal_percentage_complete'),
    goalMonthsToBudget: int('goal_months_to_budget'),
    goalOverallFunded: money('goal_overall_funded'),
    goalOverallLeft: money('goal_overall_left'),

    /**
     * Snooze is per **(category, month)**, not per category — measured (R32): the timestamp
     * appears only in the month it was set in. It lives here rather than on the target record,
     * which is where the original plan put it.
     *
     * It suppresses the row's nag and excludes the category from the Underfunded aggregate, but
     * does **not** change `goalUnderFunded` itself (R32/R33).
     */
    goalSnoozedAt: timestamp('goal_snoozed_at'),

    cacheEpoch: int('cache_epoch').notNull().default(0),

    /**
     * The date these derived values were computed for.
     *
     * Most rules are pure functions of stored data, but two are not: a weekly target's demand
     * decays as the month elapses (R30) and a debt target's amount tracks the live account
     * balance (R41). A row whose `derivedForDate` is not today's date **in the plan's
     * timezone** is stale even though nothing was edited.
     */
    derivedForDate: text('derived_for_date'),

    knowledgeAtChange: int('knowledge_at_change').notNull().default(0),
    deleted: bool('deleted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('month_category_pk').on(t.planId, t.month, t.categoryId),
    index('month_category_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

/**
 * The assignment ledger.
 *
 * Every change to `monthCategory.budgeted` writes a movement here in the same transaction —
 * measured (R13): the oracle does this for plain API assignments too, not only for the UI's
 * "move money" flow, and reverting an assignment **appends a compensating movement** rather
 * than editing the original. Reconciling movements against `budgeted` matched exactly on
 * every pair tested.
 *
 * A null category id means Ready to Assign. Category deletion is expressed here too (R16/R21),
 * so the ledger stays the complete record of where every unit went.
 */
export const moneyMovement = sqliteTable(
  'money_movement',
  {
    id: id(),
    ...planScoped,
    groupId: ref('money_movement_group_id'),
    month: budgetMonth('month').notNull(),
    movedAt: timestamp('moved_at').notNull(),
    note: text('note'),
    fromCategoryId: ref('from_category_id'),
    toCategoryId: ref('to_category_id'),
    amount: money('amount').notNull(),
    performedByUserId: ref('performed_by_user_id'),
  },
  (t) => [
    index('money_movement_month').on(t.planId, t.month, t.movedAt),
    index('money_movement_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

/** Groups movements made by one user action, e.g. a quick-budget applied to many categories. */
export const moneyMovementGroup = sqliteTable('money_movement_group', {
  id: id(),
  ...planScoped,
  month: budgetMonth('month').notNull(),
  groupCreatedAt: timestamp('group_created_at').notNull(),
  note: text('note'),
  performedByUserId: ref('performed_by_user_id'),
  ...timestamps,
})
