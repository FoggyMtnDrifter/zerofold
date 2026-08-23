import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, budgetMonth, id, int, json, ref, timestamp, timestamps } from './columns.ts'
import type { MembershipRole } from './enums.ts'

/** YNAB's CurrencyFormat shape, emitted verbatim by the compatibility API. */
export interface CurrencyFormat {
  iso_code: string
  example_format: string
  decimal_digits: number
  decimal_separator: string
  symbol_first: boolean
  group_separator: string
  currency_symbol: string
  display_symbol: boolean
}

export const plan = sqliteTable('plan', {
  id: id(),
  name: text('name').notNull(),
  currencyFormat: json<CurrencyFormat>('currency_format').notNull(),
  dateFormat: text('date_format').notNull().default('MM/DD/YYYY'),
  firstDayOfWeek: int('first_day_of_week').notNull().default(0),

  /**
   * IANA timezone. The **only** source of "today" for this plan — ADR-0005.
   *
   * Not the server's locale and not UTC. The oracle stamps API rows with the server's UTC date
   * and UI rows with the browser's local date, so one plan there can hold two rows created
   * hours apart bearing different dates (R59). One definition, resolved here.
   */
  timezone: text('timezone').notNull().default('UTC'),

  /** Derived cache: the month of the earliest transaction. Extends backwards on import. */
  firstMonth: budgetMonth('first_month'),
  lastMonth: budgetMonth('last_month'),

  /**
   * Monotonic per-plan counter for delta requests. Incremented once per write transaction;
   * every row touched records the new value in `knowledge_at_change`.
   */
  serverKnowledge: int('server_knowledge').notNull().default(0),

  deleted: bool('deleted').notNull().default(false),
  ...timestamps,
})

export const planMembership = sqliteTable(
  'plan_membership',
  {
    planId: ref('plan_id').notNull(),
    userId: ref('user_id').notNull(),
    role: text('role').$type<MembershipRole>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('plan_membership_pk').on(t.planId, t.userId),
    index('plan_membership_user').on(t.userId),
  ],
)

/**
 * Recompute watermark. One row per plan.
 *
 * `dirtyFromMonth` is the earliest month whose cached values may be stale; recomputation
 * replays from the newest checkpoint at or before it. An edit that moves a transaction between
 * months dirties the **earlier** of the two.
 */
export const planRecalc = sqliteTable('plan_recalc', {
  planId: ref('plan_id').primaryKey(),
  dirtyFromMonth: budgetMonth('dirty_from_month'),
  epoch: int('epoch').notNull().default(0),
  lastRunAt: timestamp('last_run_at'),
  runningBy: text('running_by'),
})

/**
 * Serialised `CarryState` at the entry to a month, written every N months during recompute so
 * a later replay need not start from the plan's first month.
 */
export const carryCheckpoint = sqliteTable(
  'carry_checkpoint',
  {
    planId: ref('plan_id').notNull(),
    month: budgetMonth('month').notNull(),
    state: json<unknown>('state').notNull(),
    epoch: int('epoch').notNull(),
  },
  (t) => [uniqueIndex('carry_checkpoint_pk').on(t.planId, t.month)],
)
