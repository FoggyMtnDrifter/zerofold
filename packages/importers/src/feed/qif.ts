import type { CalendarDate } from '@zerofold/shared/date'
import { fromParts } from '@zerofold/shared/date'
import { type Milliunits, milli } from '@zerofold/shared/money'
import type { FeedImporter, FeedRow, ParseResult } from './types.ts'

/**
 * QIF — Quicken Interchange Format.
 *
 * A record is a run of lines each tagged by its first character, terminated by `^`. It has no
 * schema, no encoding declaration and no unambiguous date format, which is why it is being
 * replaced everywhere and why banks still export it.
 */

/**
 * QIF dates are genuinely ambiguous and the format says nothing about which order.
 *
 * Quicken wrote US order with a `'` for 2000s years (`3/ 4'26`); European exports use
 * `DD/MM/YYYY`. Where a component exceeds 12 the order is decidable, so the whole file is
 * scanned for one such row before committing — one unambiguous date settles every ambiguous
 * one in the same file, which is far better than asking the user to guess.
 */
function detectDateOrder(lines: readonly string[]): 'dmy' | 'mdy' {
  for (const line of lines) {
    if (!line.startsWith('D')) continue
    const parts = line
      .slice(1)
      .trim()
      .split(/[/\-.]/)
    const first = Number(parts[0])
    const second = Number(parts[1])
    if (first > 12 && second <= 12) return 'dmy'
    if (second > 12 && first <= 12) return 'mdy'
  }
  // Undecidable. US order is the format's origin and the safer default for QIF specifically.
  return 'mdy'
}

function parseDate(raw: string, order: 'dmy' | 'mdy'): CalendarDate | null {
  const cleaned = raw.trim().replace(/'/g, '/')
  const parts = cleaned.split(/[/\-.]/).map((p) => Number(p.trim()))
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null

  const [a = 0, b = 0, c = 0] = parts
  const day = order === 'dmy' ? a : b
  const month = order === 'dmy' ? b : a

  // Two-digit years: Quicken's own pivot, and the one every other importer uses.
  const year = c < 100 ? (c < 70 ? 2000 + c : 1900 + c) : c

  try {
    return fromParts(year, month, day)
  } catch {
    return null
  }
}

/** QIF amounts carry thousands separators and occasionally a trailing minus. */
function parseAmount(raw: string): Milliunits | null {
  const cleaned = raw.trim().replace(/,/g, '')
  const trailingMinus = cleaned.endsWith('-')
  const body = trailingMinus ? cleaned.slice(0, -1) : cleaned
  const value = Number(body)
  if (!Number.isFinite(value)) return null
  const milliunits = Math.round(value * 1000)
  return milli(BigInt(trailingMinus ? -milliunits : milliunits))
}

export const qif: FeedImporter = {
  id: 'qif',
  label: 'QIF (Quicken Interchange Format)',
  extensions: ['.qif'],

  detect(content, filename) {
    const head = content.slice(0, 2_000)
    if (/^!Type:/im.test(head)) return 0.95
    if (filename?.toLowerCase().endsWith('.qif')) return 0.6
    // A bare record with the tags but no header still parses.
    if (/^D.+$/m.test(head) && /^\^/m.test(head)) return 0.4
    return 0
  },

  parse(content): ParseResult {
    const lines = content.split(/\r?\n/)
    const order = detectDateOrder(lines)
    const rows: FeedRow[] = []
    const warnings: string[] = []

    let current: Partial<{
      date: CalendarDate
      amount: Milliunits
      payeeName: string
      memo: string
      externalId: string
      cleared: boolean
    }> = {}
    let sawAccountType = false

    const flush = () => {
      if (current.date !== undefined && current.amount !== undefined) {
        rows.push({
          date: current.date,
          amount: current.amount,
          payeeName: current.payeeName ?? null,
          memo: current.memo ?? null,
          externalId: current.externalId ?? null,
          cleared: current.cleared ?? null,
        })
      } else if (Object.keys(current).length > 0) {
        warnings.push(`Skipped a record with no ${current.date === undefined ? 'date' : 'amount'}.`)
      }
      current = {}
    }

    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line === '') continue

      if (line.startsWith('!')) {
        // `!Type:Bank` and friends. `!Account` blocks describe accounts, not transactions.
        sawAccountType = /^!Type:/i.test(line)
        continue
      }

      if (line.startsWith('^')) {
        flush()
        continue
      }

      const tag = line[0] ?? ''
      const value = line.slice(1).trim()

      switch (tag) {
        case 'D': {
          const date = parseDate(value, order)
          if (date) current.date = date
          else warnings.push(`Could not read the date "${value}".`)
          break
        }
        case 'T':
        case 'U': {
          // T and U are the same amount; U is Quicken's later duplicate of it.
          const amount = parseAmount(value)
          if (amount !== null) current.amount = amount
          else warnings.push(`Could not read the amount "${value}".`)
          break
        }
        case 'P':
          current.payeeName = value
          break
        case 'M':
          current.memo = value
          break
        case 'N':
          // Cheque number, when it is one. Useful as an external id; not unique on its own.
          if (value) current.externalId = value
          break
        case 'C':
          // `*` or `c` is cleared, `X` or `R` is reconciled, empty is neither.
          current.cleared = value !== '' && value.toLowerCase() !== 'u'
          break
        default:
          break
      }
    }
    flush()

    if (!sawAccountType && rows.length > 0) {
      warnings.push('The file had no !Type header, so its account type is unknown.')
    }

    return { rows, warnings }
  },
}
