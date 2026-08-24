import { type Browser, expect, type Page, test } from '@playwright/test'

/**
 * M7: importing a file.
 *
 * The parsers have their own unit tests; this drives the part that only exists once the pieces
 * are together — reading a file in the browser, previewing without writing, and re-importing an
 * overlapping range without creating duplicates.
 */

const PASSWORD = 'correct-horse-battery-staple'
const EMAIL = 'owner@example.test'

let page: Page
let planId: string
let accountId: string

const statement = (extra = '') => `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260819<TRNAMT>-42.75<FITID>M7-1<NAME>WHOLE FOODS</STMTTRN>
<STMTTRN><DTPOSTED>20260820<TRNAMT>-8.50<FITID>M7-2<NAME>CITY TRANSIT</STMTTRN>
<STMTTRN><DTPOSTED>20260821<TRNAMT>1200.00<FITID>M7-3<NAME>ACME PAYROLL</STMTTRN>${extra}
</BANKTRANLIST></OFX>`

async function upload(content: string, name = 'statement.ofx') {
  await page.setInputFiles('input[type=file]', {
    name,
    mimeType: 'application/x-ofx',
    buffer: Buffer.from(content, 'utf8'),
  })
}

test.describe
  .serial('M7 import', () => {
    test.beforeAll(async ({ browser }: { browser: Browser }) => {
      page = await browser.newPage()
      for (let attempt = 0; attempt < 4; attempt++) {
        await page.goto('/sign-in')
        await page.getByLabel('Email').fill(EMAIL)
        await page.getByLabel('Password').fill(PASSWORD)
        await page.getByRole('button', { name: 'Sign in' }).click()
        const landed = await page
          .getByText('Ready to assign')
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false)
        if (landed) break
        await expect(page.getByRole('alert').filter({ hasText: 'Too many attempts' })).toBeVisible()
        await page.waitForTimeout(6_000)
      }
      planId = new URL(page.url()).pathname.split('/')[2] ?? ''

      const accounts = await (
        await page.request.post('/api/rpc/account.list', {
          data: { planId },
          headers: { origin: new URL(page.url()).origin },
        })
      ).json()
      accountId = accounts.data.find((a: { name: string }) => a.name === 'Acct savings').id
    })

    test.afterAll(async () => {
      await page.close()
    })

    test('a preview reads the file and writes nothing', async () => {
      await page.goto(`/plans/${planId}/accounts/${accountId}/import`)
      await upload(statement())

      await expect(page.getByText('3 new, 0 already here')).toBeVisible()
      await expect(page.getByText('read as ofx')).toBeVisible()
      await expect(page.getByText('WHOLE FOODS')).toBeVisible()

      // Nothing in the register yet: the preview is a read.
      await page.goto(`/plans/${planId}/accounts/${accountId}`)
      await expect(page.getByRole('row').filter({ hasText: 'WHOLE FOODS' })).toBeHidden()
    })

    test('importing creates the rows, unapproved', async () => {
      await page.goto(`/plans/${planId}/accounts/${accountId}/import`)
      await upload(statement())
      await page.getByRole('button', { name: 'Import 3' }).click()

      // Lands back on the register.
      await expect(page.getByRole('grid', { name: 'Transactions' })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: 'WHOLE FOODS' })).toBeVisible()
      await expect(page.getByText(/to review/)).toContainText('3 transactions')
    })

    test('re-importing an overlapping range brings in only what is new', async () => {
      await page.goto(`/plans/${planId}/accounts/${accountId}/import`)
      await upload(
        statement('\n<STMTTRN><DTPOSTED>20260822<TRNAMT>-15.00<FITID>M7-4<NAME>BOOKSHOP</STMTTRN>'),
      )

      await expect(page.getByText('1 new, 3 already here')).toBeVisible()
      await expect(page.getByText('already imported').first()).toBeVisible()

      await page.getByRole('button', { name: 'Import 1' }).click()
      await expect(page.getByRole('row').filter({ hasText: 'BOOKSHOP' })).toBeVisible()
      // The originals were not duplicated.
      await expect(page.getByRole('row').filter({ hasText: 'WHOLE FOODS' })).toHaveCount(1)
    })

    test('a file it cannot recognise is refused rather than guessed at', async () => {
      await page.goto(`/plans/${planId}/accounts/${accountId}/import`)
      await upload('just some prose, with no structure to it at all', 'notes.doc')
      // Filtered: Next renders an empty route-announcer with role=alert on every page.
      await expect(
        page.getByRole('alert').filter({ hasText: 'Could not tell what kind of file' }),
      ).toBeVisible()
    })
  })
