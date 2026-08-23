import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import {
  bool,
  budgetMonth,
  calendarDate,
  id,
  int,
  json,
  money,
  planScoped,
  ref,
  timestamp,
  timestamps,
} from './columns.ts'
import type { AccountType, CategoryKind, GoalType, GroupKind, PayeeKind } from './enums.ts'

/** Rates and amounts keyed by the month they take effect, mirroring YNAB's `debt_*` maps. */
export type DebtScheduleMap = Record<string, number>

export const account = sqliteTable(
  'account',
  {
    id: id(),
    ...planScoped,
    name: text('name').notNull(),
    type: text('type').$type<AccountType>().notNull(),
    onBudget: bool('on_budget').notNull(),
    closed: bool('closed').notNull().default(false),
    note: text('note'),
    sortOrder: int('sort_order').notNull().default(0),

    /** The auto-created "Transfer : <name>" payee representing this account. */
    transferPayeeId: ref('transfer_payee_id'),
    lastReconciledAt: timestamp('last_reconciled_at'),

    /**
     * The opening balance, kept as a distinguished quantity rather than inferred from the
     * starting-balance transaction.
     *
     * It seeds uncovered debt for a credit account, and uncovered debt is what a payment
     * draws Ready to Assign against (R60'). It must survive export/import intact.
     */
    openingBalance: money('opening_balance').notNull(),

    debtOriginalBalance: money('debt_original_balance'),
    debtOriginationDate: calendarDate('debt_origination_date'),
    debtInterestRates: json<DebtScheduleMap>('debt_interest_rates'),
    debtMinimumPayments: json<DebtScheduleMap>('debt_minimum_payments'),
    debtEscrowAmounts: json<DebtScheduleMap>('debt_escrow_amounts'),

    // ── derived caches ──
    balance: money('balance').notNull(),
    clearedBalance: money('cleared_balance').notNull(),
    unclearedBalance: money('uncleared_balance').notNull(),

    /**
     * Debt on this card that no category ever funded — the opening balance, plus interest and
     * fees charged without a category (R63).
     *
     * **Not** derivable by summing negative category balances: uncategorised interest adds debt
     * attributable to no category at all, so the two diverge. Reconstructing it that way would
     * understate it by the accumulated interest and under-charge Ready to Assign at payment.
     */
    uncoveredDebt: money('uncovered_debt').notNull(),

    ...timestamps,
  },
  (t) => [
    index('account_plan').on(t.planId, t.sortOrder),
    index('account_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

export const payee = sqliteTable(
  'payee',
  {
    id: id(),
    ...planScoped,
    name: text('name').notNull(),
    /** Non-null marks this as an auto transfer payee, not user-editable. */
    transferAccountId: ref('transfer_account_id'),
    /**
     * System payees. All remain **ordinary listable payees** — the reconciliation adjustment
     * payee is a real row with `deleted: false` (R57), not hidden machinery.
     */
    internalKind: text('internal_kind').$type<PayeeKind>(),
    /** Remembered category, used to prefill on new entry. */
    lastCategoryId: ref('last_category_id'),
    ...timestamps,
  },
  (t) => [
    // Only user-created payees contend for a unique name. Transfer payees are named after
    // their account, and system payees (R57) are fixed, so neither participates.
    uniqueIndex('payee_name_unique')
      .on(t.planId, t.name)
      .where(
        sql`${t.deleted} = 0 AND ${t.transferAccountId} IS NULL AND ${t.internalKind} IS NULL`,
      ),
    index('payee_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

export const categoryGroup = sqliteTable(
  'category_group',
  {
    id: id(),
    ...planScoped,
    name: text('name').notNull(),
    hidden: bool('hidden').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),
    /** `internal_master`, `credit_card_payments`, `hidden` — YNAB marks all three (R48). */
    internalKind: text('internal_kind').$type<GroupKind>(),
    ...timestamps,
  },
  (t) => [index('category_group_plan').on(t.planId, t.sortOrder)],
)

export const category = sqliteTable(
  'category',
  {
    id: id(),
    ...planScoped,
    categoryGroupId: ref('category_group_id').notNull(),
    name: text('name').notNull(),
    note: text('note'),
    hidden: bool('hidden').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),

    /**
     * Our classification, richer than YNAB's wire `internal` boolean.
     *
     * Measured (R48): YNAB reports `internal: true` for `inflow_rta` and `uncategorized` only.
     * A credit-card payment category reports `internal: false` despite sitting in an internal
     * group. The compat API projects that boolean from this column rather than storing it.
     */
    internalKind: text('internal_kind').$type<CategoryKind>(),

    /** Set iff `internalKind = 'credit_card_payment'`. The category *is* a projection of an account. */
    creditAccountId: ref('credit_account_id'),

    /**
     * Present in YNAB's API but **never populated** by hiding a category (R14) — hiding leaves
     * the category in its own group. Kept for wire fidelity; nothing may depend on it.
     */
    originalCategoryGroupId: ref('original_category_group_id'),

    ...timestamps,
  },
  (t) => [
    index('category_group_idx').on(t.planId, t.categoryGroupId, t.sortOrder),
    uniqueIndex('category_credit_account').on(t.creditAccountId),
    index('category_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

/**
 * Targets, stored as **revisions** rather than one mutable record — divergence D2.
 *
 * YNAB keeps a single goal per category, so editing a target silently rewrites what past
 * months "needed". Revisions make a historical month reproducible, which the golden fixtures
 * depend on. The compat API projects the revision effective at the requested month into
 * YNAB's flat `goal_*` fields, so clients see no difference.
 */
export const categoryTarget = sqliteTable(
  'category_target',
  {
    id: id(),
    ...planScoped,
    categoryId: ref('category_id').notNull(),
    effectiveFromMonth: budgetMonth('effective_from_month').notNull(),

    goalType: text('goal_type').$type<GoalType>().notNull(),
    goalTarget: money('goal_target'),
    goalTargetMonth: budgetMonth('goal_target_month'),

    /** Day of month (1–31), or day of week (0=Sunday) when the cadence is weekly (R29). */
    goalDay: int('goal_day'),
    /** 1 monthly, 2 weekly, 13 yearly (R25, R29, R31a). NEED only — null for TB/TBD. */
    goalCadence: int('goal_cadence'),
    goalCadenceFrequency: int('goal_cadence_frequency'),

    /**
     * `true` = set-aside, `false` = refill (R25). Defaults to set-aside when unspecified,
     * matching the oracle. NEED only — null for TB and TBD, and reading it for those types
     * would coerce to `false` and silently behave as refill.
     */
    goalNeedsWholeAmount: bool('goal_needs_whole_amount'),

    /**
     * Whether the target recurs past its due month.
     *
     * Stored explicitly rather than inferred from `goalCadence`, because the two behaviours
     * are opposite: a repeating target rolls forward to the next occurrence (R31), a
     * non-repeating one goes quiet with `months_to_budget = 0` (R35). A yearly cadence with
     * repeat off would otherwise be misclassified.
     */
    repeats: bool('repeats').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('category_target_revision').on(t.planId, t.categoryId, t.effectiveFromMonth),
    index('category_target_category').on(t.planId, t.categoryId),
  ],
)
