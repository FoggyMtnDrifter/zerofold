import { schema } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { milli, ZERO } from '@zerofold/shared/money'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { createTransaction } from '../transaction/create-transaction.ts'
import { listTransactions } from '../transaction/list.ts'
import { commitImport, importIdFor, previewImport } from './import.ts'

/**
 * Importing.
 *
 * The parsers have their own tests; these are about what happens next — which rows are already
 * in the register, what a re-import of an overlapping range does, and whether the user's
 * decision or the software's guess wins.
 */

let h: ReturnType<typeof testHarness>
let planId: string
let accountId: string

const TODAY = '2026-08-23'

const OFX = `OFXHEADER:100
<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260817<TRNAMT>-42.75<FITID>A1<NAME>WHOLE FOODS</STMTTRN>
<STMTTRN><DTPOSTED>20260818<TRNAMT>-12.00<FITID>A2<NAME>COFFEE</STMTTRN>
<STMTTRN><DTPOSTED>20260819<TRNAMT>2500.00<FITID>A3<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST></OFX>`

beforeEach(() => {
  h = testHarness(TODAY)
  planId = createPlan(h.ctx, { name: 'Household', timezone: 'UTC' }).planId
  accountId = createAccount(h.ctx, {
    planId,
    name: 'Everyday',
    type: 'checking',
    balance: milli(1_000_000),
  }).accountId
})
afterEach(() => h.close())

const preview = (content = OFX, filename = 'statement.ofx') =>
  previewImport(h.db, { planId, accountId, content, filename })

const commit = (content = OFX, only?: readonly string[]) => {
  const p = previewImport(h.db, { planId, accountId, content, filename: 'statement.ofx' })
  return commitImport(h.ctx, {
    planId,
    accountId,
    content,
    filename: 'statement.ofx',
    acceptImportIds: only ?? p.rows.filter((r) => !r.matchedTransactionId).map((r) => r.importId),
  })
}

const rows = () => listTransactions(h.db, { planId, accountId, limit: 100 }).rows

describe('preview', () => {
  it('reads the file and reports what is new', () => {
    const result = preview()
    expect(result.importerId).toBe('ofx')
    expect(result.rows).toHaveLength(3)
    expect(result.newCount).toBe(3)
    expect(result.duplicateCount).toBe(0)
  })

  it('changes nothing by itself', () => {
    preview()
    expect(rows()).toHaveLength(1) // just the starting balance
  })

  it('refuses a file it cannot recognise', () => {
    expect(() => preview('a paragraph of prose', 'notes.doc')).toThrow(/Could not tell/)
  })
})

describe('committing', () => {
  it('creates the accepted rows, unapproved', () => {
    const result = commit()
    expect(result.created).toBe(3)

    const imported = rows().filter((r) => r.memo !== null || r.payeeName !== 'Starting Balance')
    const coffee = rows().find((r) => r.payeeName === 'COFFEE')
    expect(coffee?.approved).toBe(false)
    expect(coffee?.amount).toBe(milli(-12_000))
    expect(imported.length).toBeGreaterThan(0)
  })

  it('creates a payee per distinct name in the file', () => {
    commit()
    const payees = h.db
      .select({ name: schema.payee.name })
      .from(schema.payee)
      .where(eq(schema.payee.planId, planId))
      .all()
      .map((p) => p.name)

    expect(payees).toContain('WHOLE FOODS')
    expect(payees).toContain('PAYROLL')
  })

  it('keeps the payee exactly as the file wrote it', () => {
    commit()
    const row = h.db
      .select({ original: schema.transaction.importPayeeNameOriginal })
      .from(schema.transaction)
      .where(eq(schema.transaction.importId, `ofx:${accountId}:A1`))
      .get()
    expect(row?.original).toBe('WHOLE FOODS')
  })

  it('records the batch', () => {
    const result = commit()
    const batch = h.db
      .select()
      .from(schema.importBatch)
      .where(eq(schema.importBatch.id, result.importBatchId))
      .get()

    expect(batch).toMatchObject({ source: 'ofx', rowCount: 3, createdCount: 3, status: 'complete' })
  })

  it('imports only what the caller accepted', () => {
    const p = preview()
    const one = p.rows[0]?.importId ?? ''
    const result = commit(OFX, [one])
    expect(result.created).toBe(1)
    expect(result.skipped).toBe(2)
  })
})

describe('re-importing an overlapping range', () => {
  it('recognises every row it already has, by the institution’s own id', () => {
    commit()

    const second = preview()
    expect(second.duplicateCount).toBe(3)
    expect(second.newCount).toBe(0)
    expect(second.rows.every((r) => r.matchReason === 'external-id')).toBe(true)
  })

  it('creates nothing on a second commit', () => {
    commit()
    const before = rows().length
    const again = commit()
    expect(again.created).toBe(0)
    expect(rows()).toHaveLength(before)
  })

  it('brings in only the rows that are actually new', () => {
    commit()

    const extended = OFX.replace(
      '</BANKTRANLIST>',
      '<STMTTRN><DTPOSTED>20260820<TRNAMT>-8.50<FITID>A4<NAME>BUS</STMTTRN></BANKTRANLIST>',
    )
    const result = commit(extended)
    expect(result.created).toBe(1)
    expect(rows().find((r) => r.payeeName === 'BUS')).toBeDefined()
  })
})

describe('matching a row typed by hand', () => {
  it('spots a transaction already entered for the same amount a day earlier', () => {
    createTransaction(h.ctx, {
      planId,
      accountId,
      date: calendarDate('2026-08-16'),
      amount: milli(-42_750),
      memo: 'typed in at the till',
    })

    const result = preview()
    const matched = result.rows.find((r) => r.amount === milli(-42_750))
    expect(matched?.matchedTransactionId).not.toBeNull()
    expect(matched?.matchReason).toBe('same-amount-and-date')
    expect(result.duplicateCount).toBe(1)
  })

  it('leaves the guess to the user rather than acting on it', () => {
    createTransaction(h.ctx, {
      planId,
      accountId,
      date: calendarDate('2026-08-16'),
      amount: milli(-42_750),
    })

    // The caller can accept a row the preview guessed was a duplicate.
    const p = preview()
    const all = p.rows.map((r) => r.importId)
    const result = commitImport(h.ctx, {
      planId,
      accountId,
      content: OFX,
      filename: 'statement.ofx',
      acceptImportIds: all,
    })
    expect(result.created).toBe(3)
  })

  it('does not match the same existing row twice', () => {
    // Two identical charges in the file, one already in the register: exactly one is a match.
    const twice = `OFXHEADER:100
<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260817<TRNAMT>-3.20<FITID>B1<NAME>COFFEE</STMTTRN>
<STMTTRN><DTPOSTED>20260817<TRNAMT>-3.20<FITID>B2<NAME>COFFEE</STMTTRN>
</BANKTRANLIST></OFX>`

    createTransaction(h.ctx, {
      planId,
      accountId,
      date: calendarDate('2026-08-17'),
      amount: milli(-3_200),
    })

    const result = previewImport(h.db, { planId, accountId, content: twice, filename: 'a.ofx' })
    expect(result.duplicateCount).toBe(1)
    expect(result.newCount).toBe(1)
  })
})

describe('a file with no identifiers of its own', () => {
  const CSV = ['Date,Description,Amount', '2026-08-17,SHOP,-3.20', '2026-08-17,SHOP,-3.20'].join(
    '\n',
  )

  it('keeps two identical rows apart by counting occurrences', () => {
    const result = previewImport(h.db, { planId, accountId, content: CSV, filename: 'a.csv' })
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.importId).not.toBe(result.rows[1]?.importId)
    expect(result.newCount).toBe(2)
  })

  it('still recognises them on a second import', () => {
    commitImport(h.ctx, {
      planId,
      accountId,
      content: CSV,
      filename: 'a.csv',
      acceptImportIds: previewImport(h.db, {
        planId,
        accountId,
        content: CSV,
        filename: 'a.csv',
      }).rows.map((r) => r.importId),
    })

    const again = previewImport(h.db, { planId, accountId, content: CSV, filename: 'a.csv' })
    expect(again.duplicateCount).toBe(2)
    expect(again.newCount).toBe(0)
  })
})

describe('a future-dated row', () => {
  it('is clamped to today rather than failing the import (ADR-0007)', () => {
    const future = `OFXHEADER:100
<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261231<TRNAMT>-5.00<FITID>F1<NAME>PENDING</STMTTRN>
</BANKTRANLIST></OFX>`

    const result = commit(future)
    expect(result.created).toBe(1)
    expect(rows().find((r) => r.payeeName === 'PENDING')?.date).toBe(TODAY)
  })
})

describe('import ids', () => {
  it('uses the institution’s identifier when there is one', () => {
    const row = {
      date: calendarDate('2026-08-17'),
      amount: ZERO,
      payeeName: null,
      memo: null,
      externalId: 'FIT-1',
      cleared: null,
    }
    expect(importIdFor('acct', row, 1, 'ofx')).toBe('ofx:acct:FIT-1')
    // The occurrence counter is irrelevant when the institution supplies an id.
    expect(importIdFor('acct', row, 9, 'ofx')).toBe('ofx:acct:FIT-1')
  })

  it('falls back to date, amount and occurrence when there is not', () => {
    const row = {
      date: calendarDate('2026-08-17'),
      amount: milli(-3_200),
      payeeName: null,
      memo: null,
      externalId: null,
      cleared: null,
    }
    expect(importIdFor('acct', row, 1, 'csv')).toBe('csv:acct:2026-08-17:-3200:1')
    expect(importIdFor('acct', row, 2, 'csv')).toBe('csv:acct:2026-08-17:-3200:2')
  })
})
