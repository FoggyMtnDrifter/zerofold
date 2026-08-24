import type { CalendarDate } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'

/**
 * One row as an importer understands it, before it becomes a transaction.
 *
 * Deliberately thin. An importer's job is to turn a file into dated amounts with the text that
 * came with them — not to guess categories, match payees, or decide what is a duplicate. Those
 * are the same decisions whatever the file format was, so they live once in the command layer
 * rather than three times in three parsers.
 */
export interface FeedRow {
  readonly date: CalendarDate
  readonly amount: Milliunits
  /** The payee as the institution wrote it, before any cleaning. */
  readonly payeeName: string | null
  readonly memo: string | null
  /**
   * The institution's own identifier for this row, when the format carries one.
   *
   * OFX has `FITID` and QIF sometimes carries a cheque number; CSV usually has nothing. Where
   * it exists it is far better than a heuristic, because it is stable across re-downloads of an
   * overlapping date range — which is exactly when duplicates arise.
   */
  readonly externalId: string | null
  /** Cleared at the institution, where the format says. */
  readonly cleared: boolean | null
}

export interface ParseResult {
  readonly rows: readonly FeedRow[]
  /**
   * What the file said that we could not use.
   *
   * Reported rather than dropped: an import that silently ignores half a file is worse than one
   * that refuses, because the user has no way to notice.
   */
  readonly warnings: readonly string[]
  /** The account the file claims to be for, when it says. */
  readonly accountHint?: string | undefined
  readonly currencyHint?: string | undefined
}

/**
 * A format adapter.
 *
 * Adding one means writing this interface and registering it — no changes to the import
 * command, the matcher, or the UI. That is the whole point of the seam: the formats people ask
 * for next are not knowable now.
 */
export interface FeedImporter {
  readonly id: string
  readonly label: string
  readonly extensions: readonly string[]
  /**
   * How confident this adapter is that it can read the content, 0 to 1.
   *
   * Sniffing content rather than trusting the extension, because a bank that serves QFX as
   * `.qbo` or CSV as `.txt` is ordinary. Ties are broken by the highest score, and a total
   * absence of confidence is an error the user can act on rather than a wrong parse.
   */
  detect(content: string, filename?: string): number
  parse(content: string, options?: ParseOptions): ParseResult
}

export interface ParseOptions {
  /** CSV only: which column holds what, when the header cannot be recognised. */
  readonly columns?: ColumnMapping | undefined
  /** CSV only: how to read an ambiguous date like 03/04/2026. */
  readonly dateOrder?: 'dmy' | 'mdy' | undefined
}

export interface ColumnMapping {
  readonly date: number
  readonly payee?: number | undefined
  readonly memo?: number | undefined
  /** A single signed column… */
  readonly amount?: number | undefined
  /** …or a pair, which many banks use instead. */
  readonly outflow?: number | undefined
  readonly inflow?: number | undefined
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ImportError'
  }
}
