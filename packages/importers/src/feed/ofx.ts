import type { CalendarDate } from '@zerofold/shared/date'
import { fromParts } from '@zerofold/shared/date'
import { type Milliunits, milli } from '@zerofold/shared/money'
import type { FeedImporter, FeedRow, ParseResult } from './types.ts'

/**
 * OFX and QFX.
 *
 * Two dialects of one format: SGML-ish with unclosed tags in OFX 1.x, real XML in 2.x. Both are
 * read the same way here, by scanning tag/value pairs rather than parsing a document — which is
 * what makes the unclosed-tag dialect tractable without a dependency, and is safe because the
 * fields we need are scalars inside `<STMTTRN>` blocks.
 *
 * QFX is OFX with Intuit extensions we ignore; it is the same parser.
 */

/**
 * OFX dates are `YYYYMMDD` with an optional time and bracketed timezone offset.
 *
 * The time is discarded deliberately. A transaction has a calendar date, and the timestamp an
 * institution attaches to it is when their batch ran, not when the money moved — converting it
 * through a timezone is how a Sunday purchase becomes a Monday one (ADR-0005).
 */
function parseDate(raw: string): CalendarDate | null {
  const digits = raw.trim().slice(0, 8)
  if (!/^\d{8}$/.test(digits)) return null
  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6, 8))
  try {
    return fromParts(year, month, day)
  } catch {
    return null
  }
}

function parseAmount(raw: string): Milliunits | null {
  const value = Number(raw.trim().replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  return milli(BigInt(Math.round(value * 1000)))
}

/** Every `<TAG>value` pair in a fragment, closed or not. */
function fields(fragment: string): Map<string, string> {
  const out = new Map<string, string>()
  const pattern = /<([A-Z0-9.]+)>([^<\r\n]*)/gi
  let match = pattern.exec(fragment)
  while (match) {
    const [, tag, value] = match
    if (tag && value !== undefined && value.trim() !== '') {
      // First wins: nested blocks repeat tag names, and the outer one is the row's own.
      if (!out.has(tag.toUpperCase())) out.set(tag.toUpperCase(), decode(value.trim()))
    }
    match = pattern.exec(fragment)
  }
  return out
}

/** OFX 2.x is XML, so its values carry entities; 1.x usually does not, and this is harmless. */
const decode = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")

export const ofx: FeedImporter = {
  id: 'ofx',
  label: 'OFX / QFX',
  extensions: ['.ofx', '.qfx', '.qbo'],

  detect(content, filename) {
    const head = content.slice(0, 4_000).toUpperCase()
    if (head.includes('<OFX>') || head.includes('OFXHEADER')) return 0.95
    if (filename && /\.(ofx|qfx|qbo)$/i.test(filename)) return 0.6
    return 0
  },

  parse(content): ParseResult {
    const rows: FeedRow[] = []
    const warnings: string[] = []

    const blocks = content.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi) ?? []
    if (blocks.length === 0) {
      warnings.push('The file contained no transaction records.')
    }

    for (const block of blocks) {
      const f = fields(block)
      const date = parseDate(f.get('DTPOSTED') ?? f.get('DTUSER') ?? '')
      const amount = parseAmount(f.get('TRNAMT') ?? '')

      if (!date || amount === null) {
        warnings.push(
          `Skipped a record with no usable ${date ? 'amount' : 'date'} (id ${f.get('FITID') ?? 'unknown'}).`,
        )
        continue
      }

      rows.push({
        date,
        amount,
        // NAME is the payee; PAYEE is a block with its own NAME in some dialects.
        payeeName: f.get('NAME') ?? f.get('PAYEE') ?? null,
        memo: f.get('MEMO') ?? null,
        /*
         * FITID is the institution's own identifier and is stable across re-downloads. It is
         * the single most valuable field in the format: overlapping date ranges are the normal
         * way people import, and this is what makes the overlap free of duplicates.
         */
        externalId: f.get('FITID') ?? null,
        cleared: true,
      })
    }

    const account = content.match(/<ACCTID>([^<\r\n]+)/i)?.[1]?.trim()
    const currency = content.match(/<CURDEF>([^<\r\n]+)/i)?.[1]?.trim()

    return {
      rows,
      warnings,
      ...(account ? { accountHint: account } : {}),
      ...(currency ? { currencyHint: currency } : {}),
    }
  },
}
