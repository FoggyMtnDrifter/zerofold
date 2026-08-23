/**
 * Domain enumerations.
 *
 * Values mirror YNAB's API v1 spelling exactly, because the compatibility API emits them
 * verbatim and existing clients switch on them.
 */

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'creditCard',
  'lineOfCredit',
  'otherAsset',
  'otherLiability',
  'mortgage',
  'autoLoan',
  'studentLoan',
  'personalLoan',
  'medicalDebt',
  'otherDebt',
] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/** Account classes that participate in the budget and can hold a payment category. */
export const CREDIT_TYPES = ['creditCard', 'lineOfCredit'] as const
export type CreditType = (typeof CREDIT_TYPES)[number]

export const CLEARED_STATUSES = ['uncleared', 'cleared', 'reconciled'] as const
export type ClearedStatus = (typeof CLEARED_STATUSES)[number]

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type FlagColor = (typeof FLAG_COLORS)[number]

/**
 * Internal categories.
 *
 * Measured (R48): a plan has exactly two categories with `internal = true` —
 * `Inflow: Ready to Assign` and `Uncategorized`. There is **no** Deferred Income category,
 * which the original plan assumed.
 *
 * Credit-card payment categories report `internal: false` on the wire despite living in an
 * internal group, so `internalKind` here is our own richer classification and the compat API
 * projects YNAB's narrower `internal` boolean from it.
 */
export const CATEGORY_KINDS = ['inflow_rta', 'uncategorized', 'credit_card_payment'] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

/** Groups that YNAB marks `internal: true` (R48). */
export const GROUP_KINDS = ['internal_master', 'credit_card_payments', 'hidden'] as const
export type GroupKind = (typeof GROUP_KINDS)[number]

/** System payees. All are real, listable payee rows — the adjustment payee especially (R57). */
export const PAYEE_KINDS = [
  'starting_balance',
  'reconciliation_adjustment',
  'manual_balance_adjustment',
] as const
export type PayeeKind = (typeof PAYEE_KINDS)[number]

export const GOAL_TYPES = ['TB', 'TBD', 'MF', 'NEED', 'DEBT'] as const
export type GoalType = (typeof GOAL_TYPES)[number]

/** Cadence encoding, measured: 1 monthly (R25), 2 weekly (R29), 13 yearly (R31a). */
export const CADENCE = { none: 0, monthly: 1, weekly: 2, yearly: 13 } as const

export const FREQUENCIES = [
  'never',
  'daily',
  'weekly',
  'everyOtherWeek',
  'twiceAMonth',
  'every4Weeks',
  'monthly',
  'everyOtherMonth',
  'every3Months',
  'every4Months',
  'twiceAYear',
  'yearly',
  'everyOtherYear',
] as const
export type Frequency = (typeof FREQUENCIES)[number]

export const DEBT_TRANSACTION_TYPES = [
  'payment',
  'refund',
  'fee',
  'interest',
  'escrow',
  'balanceAdjustment',
  'credit',
  'charge',
] as const
export type DebtTransactionType = (typeof DEBT_TRANSACTION_TYPES)[number]

export const MEMBERSHIP_ROLES = ['owner', 'editor', 'viewer'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]
