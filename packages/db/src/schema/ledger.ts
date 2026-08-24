import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, calendarDate, id, int, json, money, planScoped, ref, timestamps } from './columns.ts'
import type { ClearedStatus, DebtTransactionType, FlagColor, Frequency } from './enums.ts'

export const transaction = sqliteTable(
  'transaction',
  {
    id: id(),
    ...planScoped,
    accountId: ref('account_id').notNull(),

    /**
     * A calendar date, and never in the future — ADR-0007. A future-dated entry is promoted to
     * a scheduled transaction instead. Enforced in the command layer, deliberately **not** as a
     * CHECK constraint: "today" is not stable, and a row valid yesterday must not become
     * invalid overnight or on restore from backup.
     */
    date: calendarDate('date').notNull(),
    amount: money('amount').notNull(),
    memo: text('memo'),
    cleared: text('cleared').$type<ClearedStatus>().notNull().default('uncleared'),
    approved: bool('approved').notNull().default(true),
    flagColor: text('flag_color').$type<FlagColor>(),
    flagName: text('flag_name'),

    payeeId: ref('payee_id'),

    /**
     * Null for a split parent.
     *
     * YNAB emits a phantom id here with `category_name: "Split"` that appears in neither the
     * category list nor the month payload (R47). We store null and synthesise that phantom at
     * the compat-API boundary, because existing clients switch on the field and emitting a bare
     * null would be a quiet behavioural difference.
     */
    categoryId: ref('category_id'),

    transferAccountId: ref('transfer_account_id'),
    /**
     * Deliberately **not** a foreign key: two rows referencing each other cannot both be
     * inserted under a non-deferrable constraint, and `DEFERRABLE` is Postgres-only (ADR-0003).
     * Pair integrity is enforced by the command layer and asserted by `zerofold verify`.
     */
    transferTransactionId: ref('transfer_transaction_id'),
    /** Identical on both legs. Makes "fetch the other leg" one indexed lookup. Extension D4. */
    transferPairId: ref('transfer_pair_id'),

    matchedTransactionId: ref('matched_transaction_id'),
    /**
     * The schedule that entered this row, when one did.
     *
     * Without it there is no way to tell an auto-entered transaction from a typed one after
     * the fact — `approved: false` says it needs looking at, not where it came from — and no
     * way to answer "what did this schedule create" when someone deletes it.
     */
    scheduledTransactionId: ref('scheduled_transaction_id'),

    importId: text('import_id'),
    importPayeeName: text('import_payee_name'),
    importPayeeNameOriginal: text('import_payee_name_original'),
    importBatchId: ref('import_batch_id'),

    debtTransactionType: text('debt_transaction_type').$type<DebtTransactionType>(),
    isSplit: bool('is_split').notNull().default(false),
    /** Set when a reconciliation locked this row (R56). */
    reconciliationId: ref('reconciliation_id'),

    ...timestamps,
  },
  (t) => [
    // The register scan. `id DESC` is a total-order tiebreak among same-day rows; UUIDv7 makes
    // it chronological rather than arbitrary (ADR-0006).
    index('transaction_register').on(t.planId, t.accountId, t.date, t.id),
    index('transaction_date').on(t.planId, t.date),
    index('transaction_category').on(t.planId, t.categoryId, t.date),
    index('transaction_knowledge').on(t.planId, t.knowledgeAtChange),
    index('transaction_pair').on(t.transferPairId),
    // Duplicate-import guarantee: re-importing the same file creates nothing new.
    uniqueIndex('transaction_import_unique')
      .on(t.planId, t.accountId, t.importId)
      .where(sql`${t.importId} IS NOT NULL AND ${t.deleted} = 0`),
  ],
)

export const subtransaction = sqliteTable(
  'subtransaction',
  {
    id: id(),
    ...planScoped,
    transactionId: ref('transaction_id').notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    amount: money('amount').notNull(),
    memo: text('memo'),
    payeeId: ref('payee_id'),
    categoryId: ref('category_id'),
    /**
     * A split leg may itself be a transfer, in which case the far side is a full **top-level**
     * transaction in the other account, not a subtransaction (R46). One parent can therefore
     * spawn several independent transfer partners, each needing its own pair check.
     */
    transferAccountId: ref('transfer_account_id'),
    transferTransactionId: ref('transfer_transaction_id'),
    transferPairId: ref('transfer_pair_id'),
    ...timestamps,
  },
  (t) => [index('subtransaction_parent').on(t.transactionId, t.sortOrder)],
)

export const scheduledTransaction = sqliteTable(
  'scheduled_transaction',
  {
    id: id(),
    ...planScoped,
    accountId: ref('account_id').notNull(),
    dateFirst: calendarDate('date_first').notNull(),
    /**
     * The next occurrence at or after today.
     *
     * Stored state advanced by the entry process, not computed on read. We advance it inside
     * the creating transaction rather than returning a provisional value as the oracle does
     * (R50).
     */
    dateNext: calendarDate('date_next').notNull(),
    frequency: text('frequency').$type<Frequency>().notNull(),
    amount: money('amount').notNull(),
    memo: text('memo'),
    flagColor: text('flag_color').$type<FlagColor>(),
    payeeId: ref('payee_id'),
    categoryId: ref('category_id'),
    transferAccountId: ref('transfer_account_id'),

    /** Extensions D3 — present in YNAB's UI but absent from its API. */
    endDate: calendarDate('end_date'),
    endAfterOccurrences: int('end_after_occurrences'),
    /**
     * Auto-enter back-fills **every** missed occurrence, not just the latest (R53), so the
     * scheduler must be idempotent across repeated runs and across downtime.
     */
    autoEnter: bool('auto_enter').notNull().default(true),
    lastEnteredDate: calendarDate('last_entered_date'),
    isSplit: bool('is_split').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('scheduled_next').on(t.planId, t.dateNext),
    index('scheduled_knowledge').on(t.planId, t.knowledgeAtChange),
  ],
)

export const scheduledSubtransaction = sqliteTable('scheduled_subtransaction', {
  id: id(),
  ...planScoped,
  scheduledTransactionId: ref('scheduled_transaction_id').notNull(),
  sortOrder: int('sort_order').notNull().default(0),
  amount: money('amount').notNull(),
  memo: text('memo'),
  payeeId: ref('payee_id'),
  categoryId: ref('category_id'),
  transferAccountId: ref('transfer_account_id'),
  ...timestamps,
})

/** Extension D3: skip or override a single occurrence without detaching the series. */
export const scheduledTransactionException = sqliteTable(
  'scheduled_transaction_exception',
  {
    id: id(),
    ...planScoped,
    scheduledTransactionId: ref('scheduled_transaction_id').notNull(),
    occurrenceDate: calendarDate('occurrence_date').notNull(),
    action: text('action').$type<'skip' | 'override'>().notNull(),
    override: json<unknown>('override'),
    ...timestamps,
  },
  (t) => [uniqueIndex('sched_exception_unique').on(t.scheduledTransactionId, t.occurrenceDate)],
)

export const reconciliation = sqliteTable(
  'reconciliation',
  {
    id: id(),
    ...planScoped,
    accountId: ref('account_id').notNull(),
    reconciledAt: text('reconciled_at').notNull(),
    statementDate: calendarDate('statement_date'),
    statementBalance: money('statement_balance').notNull(),
    /** Kept so the adjustment remains reproducible after the fact (R55). */
    priorClearedBalance: money('prior_cleared_balance').notNull(),
    adjustmentTransactionId: ref('adjustment_transaction_id'),
    performedByUserId: ref('performed_by_user_id'),
    ...timestamps,
  },
  (t) => [index('reconciliation_account').on(t.planId, t.accountId, t.reconciledAt)],
)
