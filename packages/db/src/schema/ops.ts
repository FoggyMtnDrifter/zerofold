/** Instance operations: invites, tokens, import, migration, audit. */
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import {
  bool,
  calendarDate,
  id,
  int,
  json,
  planScoped,
  ref,
  timestamp,
  timestamps,
} from './columns.ts'

export const invite = sqliteTable(
  'invite',
  {
    id: id(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: ref('invited_by_user_id').notNull(),
    role: text('role'),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('invite_token').on(t.tokenHash), index('invite_email').on(t.email)],
)

/** Personal access tokens for the YNAB-compatible API. Only the hash is stored. */
export const apiToken = sqliteTable(
  'api_token',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** First few characters, so the UI can identify a token without holding the secret. */
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('api_token_hash').on(t.tokenHash), index('api_token_user').on(t.userId)],
)

export const importMapping = sqliteTable('import_mapping', {
  id: id(),
  ...planScoped,
  accountId: ref('account_id'),
  name: text('name').notNull(),
  format: text('format').notNull(),
  columnMap: json<Record<string, string>>('column_map').notNull(),
  dateFormat: text('date_format'),
  amountStyle: text('amount_style').$type<'single' | 'debit_credit' | 'inverted'>().notNull(),
  decimalSeparator: text('decimal_separator'),
  skipRows: int('skip_rows').notNull().default(0),
  ...timestamps,
})

export const importBatch = sqliteTable(
  'import_batch',
  {
    id: id(),
    ...planScoped,
    accountId: ref('account_id'),
    source: text('source').$type<'csv' | 'ofx' | 'qfx' | 'qif' | 'json' | 'api'>().notNull(),
    filename: text('filename'),
    fileHash: text('file_hash'),
    mappingId: ref('mapping_id'),
    rowCount: int('row_count').notNull().default(0),
    matchedCount: int('matched_count').notNull().default(0),
    createdCount: int('created_count').notNull().default(0),
    status: text('status').notNull(),
    createdByUserId: ref('created_by_user_id'),
    ...timestamps,
  },
  (t) => [index('import_batch_plan').on(t.planId, t.createdAt)],
)

/**
 * A whole-plan migration from another tool.
 *
 * `lossReport` records every source field the adapter could not map, surfaced to the user
 * afterwards. Silent data loss during a migration is the fastest way to lose someone's trust,
 * and it is the default behaviour of most import tools.
 */
export const planMigration = sqliteTable('plan_migration', {
  id: id(),
  ...planScoped,
  adapterId: text('adapter_id').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  sourceLabel: text('source_label'),
  status: text('status').notNull(),
  cirVersion: text('cir_version').notNull(),
  counts: json<Record<string, number>>('counts'),
  lossReport: json<unknown[]>('loss_report'),
  dryRun: bool('dry_run').notNull().default(false),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  createdByUserId: ref('created_by_user_id'),
})

/**
 * Maps an external system's ids to ours.
 *
 * Makes re-running a migration idempotent, and makes incremental re-sync possible — someone can
 * run Zerofold alongside their existing tool during a trial rather than committing on day one.
 */
export const externalIdMap = sqliteTable(
  'external_id_map',
  {
    planId: ref('plan_id').notNull(),
    entityType: text('entity_type').notNull(),
    externalSystem: text('external_system').notNull(),
    externalId: text('external_id').notNull(),
    internalId: ref('internal_id').notNull(),
  },
  (t) => [
    uniqueIndex('external_id_pk').on(t.planId, t.entityType, t.externalSystem, t.externalId),
    index('external_id_internal').on(t.internalId),
  ],
)

/** Destructive actions, recorded. Account deletion in particular — see divergence D6. */
export const auditEvent = sqliteTable(
  'audit_event',
  {
    id: id(),
    planId: ref('plan_id'),
    userId: ref('user_id'),
    at: timestamp('at').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: ref('entity_id'),
    summary: text('summary'),
    payload: json<unknown>('payload'),
    ip: text('ip'),
  },
  (t) => [index('audit_event_plan').on(t.planId, t.at), index('audit_event_user').on(t.userId)],
)

/** Backups produced by `VACUUM INTO`, for retention management. */
export const backupRecord = sqliteTable('backup_record', {
  id: id(),
  path: text('path').notNull(),
  sizeBytes: int('size_bytes').notNull(),
  takenAt: timestamp('taken_at').notNull(),
  trigger: text('trigger').$type<'scheduled' | 'manual' | 'pre_migration'>().notNull(),
  forDate: calendarDate('for_date'),
})

/**
 * The undo stack: one entry per user action, holding the command that reverses it.
 *
 * Written inside the same transaction as the change it inverts (see `withPlanWrite`), so an
 * entry cannot survive a rolled-back write. ADR-0008 explains why this stores commands rather
 * than row images.
 */
export const undoEntry = sqliteTable(
  'undo_entry',
  {
    id: id(),
    planId: ref('plan_id').notNull(),
    /** Undo is per person: one user's Ctrl-Z does not reach into another's work. */
    userId: ref('user_id').notNull(),
    /**
     * Order within a plan. Monotonic and gap-tolerant — it orders entries, it does not count
     * them, so a rolled-back transaction leaving a hole is harmless.
     */
    seq: int('seq').notNull(),
    /** One user action is one step, even when it performed many writes. */
    groupId: ref('group_id').notNull(),
    at: timestamp('at').notNull(),
    /** Shown on the control, in the user's terms: "Delete 11 transactions". */
    label: text('label').notNull(),
    /** The command that reverses the change. */
    inverse: json<UndoCommand>('inverse').notNull(),
    /** The command that reapplies it, for redo. */
    forward: json<UndoCommand>('forward').notNull(),
    undone: bool('undone').notNull().default(false),
  },
  (t) => [
    index('undo_entry_stack').on(t.planId, t.userId, t.seq),
    index('undo_entry_group').on(t.groupId),
  ],
)

/** A procedure name and its input, as the RPC layer would receive them. */
export interface UndoCommand {
  readonly procedure: string
  readonly input: Record<string, unknown>
}
