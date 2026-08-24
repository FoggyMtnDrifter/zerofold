import type { Db } from '@zerofold/db'
import { schema } from '@zerofold/db'
import type { FeedRow, ParseOptions } from '@zerofold/importers'
import { ImportError, pickImporter } from '@zerofold/importers'
import { addDays, compare } from '@zerofold/shared/date'
import { and, eq, gte, lte } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'
import { createTransaction } from '../transaction/create-transaction.ts'

/**
 * Importing a file into an account.
 *
 * The parsing is somebody else's problem — `@zerofold/importers` turns a file into dated
 * amounts and this decides what to do with them. That split is deliberate: which rows are
 * duplicates, what a payee is called, and whether something is already in the register are the
 * same questions whatever the file was, and answering them once is what keeps a new format to
 * one file.
 */

/** How far apart a file's date and the register's may be and still be the same transaction. */
const DATE_TOLERANCE_DAYS = 3

export type MatchReason = 'external-id' | 'same-amount-and-date' | null

export interface PreviewRow extends FeedRow {
  /** Stable across re-imports of an overlapping range; see `importIdFor`. */
  readonly importId: string
  /** The existing transaction this appears to be, if any. */
  readonly matchedTransactionId: string | null
  readonly matchReason: MatchReason
}

export interface ImportPreview {
  readonly importerId: string
  readonly rows: readonly PreviewRow[]
  readonly warnings: readonly string[]
  readonly newCount: number
  readonly duplicateCount: number
  readonly accountHint?: string | undefined
}

/**
 * A deterministic identity for a row, so the same row imported twice is the same row.
 *
 * Where the institution supplies its own identifier that is used verbatim, because it is stable
 * across re-downloads in a way nothing derived can be. Otherwise the identity is the account,
 * date, amount and an occurrence counter — the counter is what stops two genuinely separate
 * £3.20 coffees on the same day from collapsing into one, which is the failure mode of every
 * naive content hash.
 */
export function importIdFor(
  accountId: string,
  row: FeedRow,
  occurrence: number,
  source: string,
): string {
  if (row.externalId) return `${source}:${accountId}:${row.externalId}`
  return `${source}:${accountId}:${row.date}:${row.amount}:${occurrence}`
}

export interface PreviewInput {
  readonly planId: string
  readonly accountId: string
  readonly content: string
  readonly filename?: string | undefined
  readonly options?: ParseOptions | undefined
}

export function previewImport(db: Db, input: PreviewInput): ImportPreview {
  const account = db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, input.accountId), eq(schema.account.planId, input.planId)))
    .get()
  if (!account || account.deleted) throw new CommandError('No such account.', 'account.not_found')

  /*
   * Translated at the boundary rather than let through.
   *
   * The RPC layer shows a message to the user only for error types it explicitly knows, and
   * anything else becomes "Something went wrong" — which is the right default, and meant the
   * carefully worded "could not tell what kind of file this is" never reached anybody. The
   * command layer is where an importer's vocabulary becomes this system's, not the route.
   */
  let importer: ReturnType<typeof pickImporter>
  try {
    importer = pickImporter(input.content, input.filename)
  } catch (error) {
    if (error instanceof ImportError) throw new CommandError(error.message, error.code)
    throw error
  }

  const parsed = importer.parse(input.content, input.options)

  const seen = new Map<string, number>()
  const rows: PreviewRow[] = []
  /*
   * Existing transactions already claimed by an earlier row of this same file.
   *
   * Without it, two identical charges in the file both match the one transaction already in the
   * register, and the second real charge is reported as a duplicate and never imported. Two
   * £3.20 coffees on one day is not an edge case.
   */
  const claimed = new Set<string>()

  for (const row of parsed.rows) {
    const key = `${row.date}:${row.amount}`
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)

    const importId = importIdFor(input.accountId, row, occurrence, importer.id)
    const match = findMatch(db, input, row, importId, claimed)
    if (match) claimed.add(match.id)

    rows.push({
      ...row,
      importId,
      matchedTransactionId: match?.id ?? null,
      matchReason: match?.reason ?? null,
    })
  }

  const duplicateCount = rows.filter((r) => r.matchedTransactionId !== null).length

  return {
    importerId: importer.id,
    rows,
    warnings: parsed.warnings,
    newCount: rows.length - duplicateCount,
    duplicateCount,
    ...(parsed.accountHint ? { accountHint: parsed.accountHint } : {}),
  }
}

/**
 * Is this row already in the register?
 *
 * Two ways, in order of how much they can be trusted. An import id that has been seen before is
 * conclusive. Failing that, a transaction in the same account for the same amount within a few
 * days is *probably* the same thing — banks post a day or two after the purchase — and that
 * inference is offered to the user rather than acted on silently, because it is only a guess.
 */
function findMatch(
  db: Db,
  input: PreviewInput,
  row: FeedRow,
  importId: string,
  claimed: ReadonlySet<string>,
): { id: string; reason: MatchReason } | null {
  const byImportId = db
    .select({ id: schema.transaction.id })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.planId, input.planId),
        eq(schema.transaction.importId, importId),
        eq(schema.transaction.deleted, false),
      ),
    )
    .get()
  if (byImportId) return { id: byImportId.id, reason: 'external-id' }

  const candidates = db
    .select({ id: schema.transaction.id, importId: schema.transaction.importId })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.planId, input.planId),
        eq(schema.transaction.accountId, input.accountId),
        eq(schema.transaction.deleted, false),
        eq(schema.transaction.amount, row.amount),
        gte(schema.transaction.date, addDays(row.date, -DATE_TOLERANCE_DAYS)),
        lte(schema.transaction.date, addDays(row.date, DATE_TOLERANCE_DAYS)),
      ),
    )
    .all()

  // A row that already came from an import is spoken for, and so is one an earlier row of this
  // file has already matched. Matching either again would silently drop a real transaction.
  const free = candidates.find((c) => c.importId === null && !claimed.has(c.id))
  return free ? { id: free.id, reason: 'same-amount-and-date' } : null
}

export interface CommitInput extends PreviewInput {
  /**
   * The rows to actually create, by import id.
   *
   * The caller decides, not this function: the preview offers its guesses and the user
   * overrules them. Importing "everything the preview thought was new" would make the guess
   * binding, which is the one thing a guess must never be.
   */
  readonly acceptImportIds: readonly string[]
}

export interface CommitResult {
  readonly importBatchId: string
  readonly created: number
  readonly skipped: number
}

export function commitImport(ctx: CommandContext, input: CommitInput): CommitResult {
  const preview = previewImport(ctx.db, input)
  const accepted = new Set(input.acceptImportIds)
  const batchId = ctx.newId()

  let created = 0

  withPlanWrite(ctx, input.planId, (write) => {
    ctx.db
      .insert(schema.importBatch)
      .values({
        id: batchId,
        planId: input.planId,
        accountId: input.accountId,
        source: preview.importerId as 'csv' | 'ofx' | 'qfx' | 'qif' | 'json' | 'api',
        filename: input.filename ?? null,
        rowCount: preview.rows.length,
        matchedCount: preview.duplicateCount,
        createdCount: 0,
        status: 'running',
        createdByUserId: ctx.userId,
        knowledgeAtChange: write.knowledge,
      })
      .run()
  })

  for (const row of preview.rows) {
    if (!accepted.has(row.importId)) continue

    /*
     * Dated in the future by the file, which ADR-0007 does not allow.
     *
     * Clamped to today rather than refused: a bank that posts a pending charge with tomorrow's
     * date should not fail an otherwise good import, and the alternative — promoting it to a
     * schedule — would invent a recurrence nobody asked for.
     */
    const date = compare(row.date, ctx.today) > 0 ? ctx.today : row.date

    createTransaction(ctx, {
      planId: input.planId,
      accountId: input.accountId,
      date,
      amount: row.amount,
      memo: row.memo,
      payeeId: resolvePayee(ctx, input.planId, row.payeeName),
      // Imported rows arrive unapproved and uncategorised, exactly as scheduled ones do: the
      // register is where a person decides what they were.
      approved: false,
      cleared: row.cleared ? 'cleared' : 'uncleared',
      importId: row.importId,
      importBatchId: batchId,
      importPayeeName: row.payeeName,
      groupId: batchId,
      groupLabel: `Import ${preview.importerId.toUpperCase()}`,
    })
    created++
  }

  withPlanWrite(ctx, input.planId, (write) => {
    ctx.db
      .update(schema.importBatch)
      .set({ createdCount: created, status: 'complete', knowledgeAtChange: write.knowledge })
      .where(eq(schema.importBatch.id, batchId))
      .run()
  })

  return { importBatchId: batchId, created, skipped: preview.rows.length - created }
}

/**
 * Find or create the payee the file named.
 *
 * Created rather than matched fuzzily. "WHOLE FOODS #123" and "WHOLE FOODS #456" are the same
 * shop to a person and different strings to a computer, and guessing which distinct strings
 * mean the same payee is a rename the user cannot see happening. The original text is kept on
 * the transaction either way, so a later renaming pass has something to work from.
 */
function resolvePayee(ctx: CommandContext, planId: string, name: string | null): string | null {
  const trimmed = name?.trim()
  if (!trimmed) return null

  const existing = ctx.db
    .select({ id: schema.payee.id })
    .from(schema.payee)
    .where(and(eq(schema.payee.planId, planId), eq(schema.payee.name, trimmed)))
    .get()
  if (existing) return existing.id

  const id = ctx.newId()
  ctx.db
    .insert(schema.payee)
    .values({ id, planId, name: trimmed, transferAccountId: null, knowledgeAtChange: 0 })
    .run()
  return id
}
