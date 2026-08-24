import type { CalendarDate } from '@zerofold/shared/date'
import { fromParts } from '@zerofold/shared/date'
import { type Milliunits, milli, sub, ZERO } from '@zerofold/shared/money'
import type { ColumnMapping, FeedImporter, FeedRow, ParseOptions, ParseResult } from './types.ts'

/**
 * CSV, which is not a format so much as a family of them.
 *
 * There is no standard for what a bank's export looks like, so this does two things: read the
 * delimited text correctly, and *guess* the column layout from the header when it can. The
 * guess is always overridable, because a guess that cannot be corrected is worse than no guess.
 */

/** RFC 4180 with the quoting rules banks actually use, including doubled quotes inside quotes. */
export function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]

    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      field = ''
      // A trailing \r from CRLF was appended to the last field; strip it there, not globally,
      // so a \r inside a quoted field survives.
      const last = row.at(-1)
      if (last?.endsWith('\r')) row[row.length - 1] = last.slice(0, -1)
      rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
    rows.push(row)
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Comma, semicolon or tab, whichever appears most consistently across the first few lines. */
function detectDelimiter(content: string): string {
  const sample = content.split(/\r?\n/).slice(0, 5)
  let best = ','
  let bestScore = -1

  for (const delimiter of [',', ';', '\t', '|']) {
    const counts = sample.map((line) => line.split(delimiter).length - 1)
    const total = counts.reduce((a, b) => a + b, 0)
    if (total === 0) continue
    // Consistency matters more than volume: a comma inside one description beats nothing, but a
    // semicolon appearing exactly four times on every line is the delimiter.
    const first = counts[0] ?? 0
    const consistent = counts.every((c) => c === first)
    const score = total + (consistent ? 100 : 0)
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

const HEADERS: Record<keyof ColumnMapping, readonly RegExp[]> = {
  date: [/^(transaction\s*)?date$/i, /^posted?(\s*date)?$/i, /^date\b/i],
  payee: [/^payee$/i, /^description$/i, /^name$/i, /^merchant$/i, /^details?$/i, /^narrative$/i],
  memo: [/^memo$/i, /^notes?$/i, /^reference$/i, /^particulars$/i],
  amount: [/^amount$/i, /^value$/i, /^transaction\s*amount$/i],
  outflow: [/^outflow$/i, /^debit$/i, /^withdrawals?$/i, /^money\s*out$/i, /^paid\s*out$/i],
  inflow: [/^inflow$/i, /^credit$/i, /^deposits?$/i, /^money\s*in$/i, /^paid\s*in$/i],
}

/** Match a header row against the names banks actually use. */
export function inferColumns(header: readonly string[]): ColumnMapping | null {
  const found: Partial<Record<keyof ColumnMapping, number>> = {}

  for (const [field, patterns] of Object.entries(HEADERS) as [
    keyof ColumnMapping,
    readonly RegExp[],
  ][]) {
    const index = header.findIndex((cell) => patterns.some((p) => p.test(cell.trim())))
    if (index >= 0) found[field] = index
  }

  if (found.date === undefined) return null
  if (found.amount === undefined && found.outflow === undefined && found.inflow === undefined) {
    return null
  }

  return {
    date: found.date,
    ...(found.payee === undefined ? {} : { payee: found.payee }),
    ...(found.memo === undefined ? {} : { memo: found.memo }),
    ...(found.amount === undefined ? {} : { amount: found.amount }),
    ...(found.outflow === undefined ? {} : { outflow: found.outflow }),
    ...(found.inflow === undefined ? {} : { inflow: found.inflow }),
  }
}

/**
 * Read a date without a `Date` object anywhere near it.
 *
 * ISO is unambiguous and tried first. Everything else is `03/04/2026`, which is two different
 * days depending on which side of the Atlantic wrote it — so the whole column is scanned for a
 * value that can only be read one way, exactly as the QIF reader does, and the caller can
 * override when even that is undecidable.
 */
function parseDate(raw: string, order: 'dmy' | 'mdy'): CalendarDate | null {
  const value = raw.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (iso) {
    try {
      return fromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    } catch {
      return null
    }
  }

  const parts = value.split(/[/\-.\s]+/).filter(Boolean)
  if (parts.length < 3) return null
  const [a = '', b = '', c = ''] = parts
  const first = Number(a)
  const second = Number(b)
  let year = Number(c)
  if (!Number.isFinite(first) || !Number.isFinite(second) || !Number.isFinite(year)) return null
  if (year < 100) year = year < 70 ? 2000 + year : 1900 + year

  const day = order === 'dmy' ? first : second
  const month = order === 'dmy' ? second : first
  try {
    return fromParts(year, month, day)
  } catch {
    return null
  }
}

function inferDateOrder(values: readonly string[]): 'dmy' | 'mdy' {
  for (const value of values) {
    if (/^\d{4}-/.test(value.trim())) continue
    const parts = value.trim().split(/[/\-.\s]+/)
    const first = Number(parts[0])
    const second = Number(parts[1])
    if (first > 12 && second <= 12) return 'dmy'
    if (second > 12 && first <= 12) return 'mdy'
  }
  return 'mdy'
}

/** Currency symbols, thousands separators, parentheses for negative, trailing sign. */
export function parseAmount(raw: string): Milliunits | null {
  let value = raw.trim()
  if (value === '') return ZERO

  const parenthesised = value.startsWith('(') && value.endsWith(')')
  if (parenthesised) value = value.slice(1, -1)

  const trailingMinus = value.endsWith('-')
  if (trailingMinus) value = value.slice(0, -1)

  // Strip anything that is not a digit, separator or leading sign.
  value = value.replace(/[^\d.,-]/g, '')

  /*
   * European decimals: "1.234,56" means one thousand two hundred. Deciding by which separator
   * comes *last* handles both conventions without a locale, and is right for every real bank
   * export I can find a counter-example for.
   */
  const lastComma = value.lastIndexOf(',')
  const lastDot = value.lastIndexOf('.')
  if (lastComma > lastDot) {
    value = value.replace(/\./g, '').replace(',', '.')
  } else {
    value = value.replace(/,/g, '')
  }

  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const milliunits = milli(BigInt(Math.round(number * 1000)))
  return parenthesised || trailingMinus ? (-milliunits as Milliunits) : milliunits
}

export const csv: FeedImporter = {
  id: 'csv',
  label: 'CSV',
  extensions: ['.csv', '.tsv', '.txt'],

  detect(content, filename) {
    if (filename && /\.(csv|tsv)$/i.test(filename)) return 0.7
    const rows = parseDelimited(content.slice(0, 4_000), detectDelimiter(content))
    const header = rows[0]
    if (header && header.length >= 2 && inferColumns(header)) return 0.8
    // Delimited text with a consistent column count is probably a CSV even unlabelled.
    if (rows.length > 1 && header && rows.every((r) => r.length === header.length)) return 0.3
    return 0
  },

  parse(content, options: ParseOptions = {}): ParseResult {
    const delimiter = detectDelimiter(content)
    const table = parseDelimited(content, delimiter)
    const warnings: string[] = []

    if (table.length === 0) return { rows: [], warnings: ['The file was empty.'] }

    const header = table[0] ?? []
    const inferred = inferColumns(header)
    const columns = options.columns ?? inferred
    if (!columns) {
      return {
        rows: [],
        warnings: [
          'Could not tell which columns hold the date and amount. Choose them and try again.',
        ],
      }
    }

    // A header row is only skipped if it *is* one; a file without headers starts at row zero.
    const body = inferred ? table.slice(1) : options.columns ? table : table.slice(1)

    const order = options.dateOrder ?? inferDateOrder(body.map((row) => row[columns.date] ?? ''))

    const rows: FeedRow[] = []
    for (const [index, row] of body.entries()) {
      const date = parseDate(row[columns.date] ?? '', order)
      if (!date) {
        warnings.push(`Row ${index + 1}: could not read the date "${row[columns.date] ?? ''}".`)
        continue
      }

      const amount = amountOf(row, columns)
      if (amount === null) {
        warnings.push(`Row ${index + 1}: could not read the amount.`)
        continue
      }
      if (amount === ZERO) continue

      rows.push({
        date,
        amount,
        payeeName:
          columns.payee === undefined ? null : (row[columns.payee]?.trim() ?? null) || null,
        memo: columns.memo === undefined ? null : (row[columns.memo]?.trim() ?? null) || null,
        // CSV carries no stable identifier; matching falls back to date, amount and payee.
        externalId: null,
        cleared: null,
      })
    }

    return { rows, warnings }
  },
}

/**
 * One signed column, or a debit/credit pair.
 *
 * The pair is the awkward case: banks write the outflow as a positive number in its own column,
 * so it has to be negated, and some write it as already-negative. Taking the absolute value of
 * the outflow column handles both, since a column named "withdrawals" is never a credit.
 */
function amountOf(row: readonly string[], columns: ColumnMapping): Milliunits | null {
  if (columns.amount !== undefined) return parseAmount(row[columns.amount] ?? '')

  const outflow = columns.outflow === undefined ? ZERO : parseAmount(row[columns.outflow] ?? '')
  const inflow = columns.inflow === undefined ? ZERO : parseAmount(row[columns.inflow] ?? '')
  if (outflow === null || inflow === null) return null

  const out = outflow < ZERO ? (-outflow as Milliunits) : outflow
  return sub(inflow, out)
}
