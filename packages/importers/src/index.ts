/**
 * Import adapters.
 *
 * Two layers over one canonical intermediate representation: `feed/` for ongoing per-account
 * transaction files, `plan/` for one-time whole-budget migration. The CIR is the same document
 * as our native export format, so export, restore and migration are one code path.
 *
 * A format adapter implements `FeedImporter` and is added to `FEED_IMPORTERS`. Everything
 * downstream — duplicate matching, payee cleaning, the review screen — is format-agnostic, so
 * a new bank's peculiar CSV or a new format entirely costs one file and one line.
 */
export { csv, inferColumns, parseAmount, parseDelimited } from './feed/csv.ts'
export { ofx } from './feed/ofx.ts'
export { qif } from './feed/qif.ts'
export { type Detection, detectAll, FEED_IMPORTERS, pickImporter } from './feed/registry.ts'
export type {
  ColumnMapping,
  FeedImporter,
  FeedRow,
  ParseOptions,
  ParseResult,
} from './feed/types.ts'
export { ImportError } from './feed/types.ts'

export const IMPORTERS_VERSION = '1.0.0'
