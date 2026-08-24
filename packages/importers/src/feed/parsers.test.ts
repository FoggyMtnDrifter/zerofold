import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { describe, expect, it } from 'vitest'
import { csv, inferColumns, parseAmount, parseDelimited } from './csv.ts'
import { ofx } from './ofx.ts'
import { qif } from './qif.ts'
import { detectAll, pickImporter } from './registry.ts'

/**
 * The parsers, against the shapes banks actually emit.
 *
 * Every fixture here is written to look like a real export rather than a minimal one — the
 * BOM, the CRLF, the quoted comma, the European decimal, the trailing minus. Those are what
 * break importers, not the happy path.
 */

describe('QIF', () => {
  const FILE = [
    '!Type:Bank',
    'D08/17/2026',
    'PWHOLE FOODS #123',
    'T-42.75',
    'MWeekly shop',
    'N1234',
    'C*',
    '^',
    'D08/18/2026',
    'PSALARY',
    'T2,500.00',
    '^',
  ].join('\r\n')

  it('reads records terminated by a caret', () => {
    const { rows } = qif.parse(FILE)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      date: calendarDate('2026-08-17'),
      amount: milli(-42_750),
      payeeName: 'WHOLE FOODS #123',
      memo: 'Weekly shop',
      externalId: '1234',
      cleared: true,
    })
  })

  it('reads thousands separators', () => {
    expect(qif.parse(FILE).rows[1]?.amount).toBe(milli(2_500_000))
  })

  it('settles an ambiguous date order from one unambiguous row in the same file', () => {
    // 17 cannot be a month, so the whole file is day-first.
    const european = ['!Type:Bank', 'D17/08/2026', 'T-10.00', '^', 'D04/08/2026', 'T-20.00', '^']
    const { rows } = qif.parse(european.join('\n'))
    expect(rows[0]?.date).toBe(calendarDate('2026-08-17'))
    expect(rows[1]?.date).toBe(calendarDate('2026-08-04'))
  })

  it('reads a trailing minus', () => {
    expect(qif.parse('!Type:Bank\nD08/17/2026\nT42.75-\n^').rows[0]?.amount).toBe(milli(-42_750))
  })

  it('reports a record it could not use rather than dropping it', () => {
    const { rows, warnings } = qif.parse('!Type:Bank\nD08/17/2026\nPNo amount\n^')
    expect(rows).toHaveLength(0)
    expect(warnings[0]).toMatch(/no amount/i)
  })
})

describe('OFX', () => {
  /** OFX 1.x: SGML with unclosed tags, which is the dialect most banks still send. */
  const FILE = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>000123456789</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260817120000[-4:EDT]
<TRNAMT>-42.75
<FITID>2026081700001
<NAME>WHOLE FOODS #123
<MEMO>Weekly shop
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260818
<TRNAMT>2500.00
<FITID>2026081800002
<NAME>ACME PAYROLL
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

  it('reads unclosed SGML tags', () => {
    const { rows } = ofx.parse(FILE)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      date: calendarDate('2026-08-17'),
      amount: milli(-42_750),
      payeeName: 'WHOLE FOODS #123',
      externalId: '2026081700001',
    })
  })

  it('drops the time and keeps the calendar date', () => {
    // A timestamp with a timezone is when the batch ran, not when the money moved.
    expect(ofx.parse(FILE).rows[0]?.date).toBe(calendarDate('2026-08-17'))
  })

  it('reports the account and currency the file claims', () => {
    const result = ofx.parse(FILE)
    expect(result.accountHint).toBe('000123456789')
    expect(result.currencyHint).toBe('USD')
  })

  it('reads the XML dialect and its entities', () => {
    const xml = `<?xml version="1.0"?><OFX><BANKTRANLIST><STMTTRN>
      <DTPOSTED>20260817</DTPOSTED><TRNAMT>-10.00</TRNAMT>
      <FITID>abc</FITID><NAME>Marks &amp; Spencer</NAME>
      </STMTTRN></BANKTRANLIST></OFX>`
    expect(ofx.parse(xml).rows[0]?.payeeName).toBe('Marks & Spencer')
  })

  it('says so when there is nothing in it', () => {
    expect(ofx.parse('<OFX></OFX>').warnings[0]).toMatch(/no transaction records/i)
  })
})

describe('CSV', () => {
  const FILE = [
    'Date,Description,Amount',
    '2026-08-17,"WHOLE FOODS #123, LTD",-42.75',
    '2026-08-18,ACME PAYROLL,"2,500.00"',
  ].join('\r\n')

  it('reads quoted fields containing the delimiter', () => {
    const { rows } = csv.parse(FILE)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.payeeName).toBe('WHOLE FOODS #123, LTD')
    expect(rows[1]?.amount).toBe(milli(2_500_000))
  })

  it('reads a debit/credit pair, whichever way the bank signs it', () => {
    const paired = [
      'Date,Details,Money Out,Money In',
      '17/08/2026,Groceries,42.75,',
      '18/08/2026,Salary,,2500.00',
    ].join('\n')
    const { rows } = csv.parse(paired)
    expect(rows[0]?.amount).toBe(milli(-42_750))
    expect(rows[1]?.amount).toBe(milli(2_500_000))
  })

  it('settles day-first from a row that can only be read one way', () => {
    const { rows } = csv.parse(
      ['Date,Description,Amount', '17/08/2026,A,-1.00', '04/08/2026,B,-2.00'].join('\n'),
    )
    expect(rows[0]?.date).toBe(calendarDate('2026-08-17'))
    expect(rows[1]?.date).toBe(calendarDate('2026-08-04'))
  })

  it('takes an explicit date order when the file cannot settle it', () => {
    const ambiguous = ['Date,Description,Amount', '03/04/2026,A,-1.00'].join('\n')
    expect(csv.parse(ambiguous, { dateOrder: 'dmy' }).rows[0]?.date).toBe(
      calendarDate('2026-04-03'),
    )
    expect(csv.parse(ambiguous, { dateOrder: 'mdy' }).rows[0]?.date).toBe(
      calendarDate('2026-03-04'),
    )
  })

  it('reads semicolons and European decimals', () => {
    const european = ['Datum;Beschreibung;Betrag', '17.08.2026;Supermarkt;-1.234,56'].join('\n')
    const { rows } = csv.parse(european, {
      columns: { date: 0, payee: 1, amount: 2 },
      dateOrder: 'dmy',
    })
    expect(rows[0]?.amount).toBe(milli(-1_234_560))
  })

  it('asks for the columns rather than guessing when the header is unrecognisable', () => {
    const opaque = ['Col1,Col2,Col3', 'x,y,z'].join('\n')
    const { rows, warnings } = csv.parse(opaque)
    expect(rows).toHaveLength(0)
    expect(warnings[0]).toMatch(/which columns/i)
  })

  it('reports the rows it skipped', () => {
    const withJunk = ['Date,Description,Amount', 'not a date,A,-1.00', '2026-08-17,B,-2.00'].join(
      '\n',
    )
    const { rows, warnings } = csv.parse(withJunk)
    expect(rows).toHaveLength(1)
    expect(warnings[0]).toMatch(/could not read the date/i)
  })

  it('skips zero-amount rows, which banks use as spacers', () => {
    const withZero = ['Date,Description,Amount', '2026-08-17,Balance carried,0.00'].join('\n')
    expect(csv.parse(withZero).rows).toHaveLength(0)
  })
})

describe('amount parsing', () => {
  it.each([
    ['-42.75', -42_750],
    ['(42.75)', -42_750],
    ['42.75-', -42_750],
    ['$1,234.56', 1_234_560],
    ['1.234,56', 1_234_560],
    ['£10', 10_000],
    ['', 0],
  ])('reads %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected === 0 ? ZERO : milli(expected))
  })
})

describe('delimited reading', () => {
  it('keeps a doubled quote inside a quoted field', () => {
    expect(parseDelimited('a,"say ""hi""",c', ',')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('keeps a newline inside a quoted field', () => {
    expect(parseDelimited('a,"one\ntwo",c\n', ',')).toEqual([['a', 'one\ntwo', 'c']])
  })
})

describe('choosing an adapter', () => {
  it('recognises each format by its content, not its name', () => {
    expect(pickImporter('!Type:Bank\nD08/17/2026\nT-1.00\n^').id).toBe('qif')
    expect(pickImporter('OFXHEADER:100\n<OFX></OFX>').id).toBe('ofx')
    expect(pickImporter('Date,Description,Amount\n2026-08-17,A,-1.00').id).toBe('csv')
  })

  it('reads a QFX served under some other extension', () => {
    expect(pickImporter('<OFX><STMTTRN></STMTTRN></OFX>', 'statement.qbo').id).toBe('ofx')
  })

  it('refuses rather than parsing something confidently and wrongly', () => {
    expect(() => pickImporter('this is just prose, with no structure at all')).toThrow(
      /Could not tell what kind of file/,
    )
  })

  it('ranks candidates so the caller can offer a choice', () => {
    const candidates = detectAll('Date,Description,Amount\n2026-08-17,A,-1.00', 'x.csv')
    expect(candidates[0]?.importer.id).toBe('csv')
    expect(candidates[0]?.confidence).toBeGreaterThan(0.5)
  })
})

describe('column inference', () => {
  it.each([
    [['Date', 'Payee', 'Amount'], { date: 0, payee: 1, amount: 2 }],
    [
      ['Posted Date', 'Description', 'Debit', 'Credit'],
      { date: 0, payee: 1, outflow: 2, inflow: 3 },
    ],
    [
      ['Transaction Date', 'Narrative', 'Money Out', 'Money In'],
      { date: 0, payee: 1, outflow: 2, inflow: 3 },
    ],
  ])('recognises %s', (header, expected) => {
    expect(inferColumns(header)).toMatchObject(expected)
  })

  it('returns nothing when it cannot find a date or an amount', () => {
    expect(inferColumns(['Foo', 'Bar'])).toBeNull()
  })
})
