import { csv } from './csv.ts'
import { ofx } from './ofx.ts'
import { qif } from './qif.ts'
import { type FeedImporter, ImportError } from './types.ts'

/**
 * The registered format adapters.
 *
 * Adding a format means writing a `FeedImporter` and adding it here. Nothing downstream — the
 * matcher, the import command, the review screen — knows how many there are or what they read,
 * which is the point: the formats people ask for next are not knowable now.
 */
export const FEED_IMPORTERS: readonly FeedImporter[] = [ofx, qif, csv]

export interface Detection {
  readonly importer: FeedImporter
  readonly confidence: number
}

/** Every adapter that thinks it can read this, most confident first. */
export function detectAll(content: string, filename?: string): readonly Detection[] {
  return FEED_IMPORTERS.map((importer) => ({
    importer,
    confidence: importer.detect(content, filename),
  }))
    .filter((d) => d.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
}

/**
 * The adapter to use, or an error naming what was tried.
 *
 * Sniffing content rather than trusting the extension, because a bank serving QFX as `.qbo` or
 * CSV as `.txt` is ordinary. Refusing outright beats parsing confidently and wrongly.
 */
export function pickImporter(content: string, filename?: string): FeedImporter {
  const best = detectAll(content, filename)[0]
  if (!best) {
    throw new ImportError(
      `Could not tell what kind of file this is. Zerofold reads ${FEED_IMPORTERS.map((i) => i.label).join(', ')}.`,
      'import.unrecognised_format',
    )
  }
  return best.importer
}
