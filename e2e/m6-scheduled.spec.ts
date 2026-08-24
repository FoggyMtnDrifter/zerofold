import { type Browser, expect, type Page, test } from '@playwright/test'

/**
 * M6: scheduled transactions.
 *
 * The acceptance criterion is catching up after downtime — a schedule dormant across many
 * periods materialises all of them, and running the catch-up again materialises none. That is
 * what these drive, through the page load that triggers it.
 */

const PASSWORD = 'correct-horse-battery-staple'
const EMAIL = 'owner@example.test'

let page: Page
let planId: string
let accountId: string
/**
 * The plan's today, read from the app rather than computed here.
 *
 * The plan is in Auckland; the machine running the tests is not. Deriving dates from the test
 * runner's clock produces a schedule that is due tomorrow, or was due yesterday, depending on
 * the hour — which is the timezone bug the whole date layer exists to prevent, and would make
 * this suite fail for part of every day.
 */
/**
 * The plan's today, read from the app rather than computed here.
 *
 * The plan is in Auckland; the machine running the tests is not. Deriving dates from the test
 * runner's clock produces a schedule that is due tomorrow, or was due yesterday, depending on
 * the hour — which is exactly the timezone bug the whole date layer exists to prevent, and
 * would make this suite fail for part of every day.
 */
let today: string

const rpc = (procedure: string, data: unknown) =>
  page.request.post(`/api/rpc/${procedure}`, {
    data,
    headers: { origin: new URL(page.url()).origin },
  })

test.describe
  .serial('M6 scheduled', () => {
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

      const accounts = await (await rpc('account.list', { planId })).json()
      accountId = accounts.data.find((a: { name: string }) => a.name === 'Acct checking').id

      // The entry form defaults to the plan's today, which is the definition that matters here.
      await page.goto(`/plans/${planId}/accounts/${accountId}`)
      await page.getByRole('button', { name: 'Add transaction' }).click()
      today = await page.getByRole('textbox', { name: 'Date' }).inputValue()
      await page.getByRole('button', { name: 'Cancel' }).click()
    })

    test.afterAll(async () => {
      await page.close()
    })

    test('a schedule alone changes nothing (R20)', async () => {
      const before = await workingBalance()

      await rpc('scheduled.create', {
        planId,
        accountId,
        // Far enough ahead that nothing is due.
        date: futureDate(20),
        frequency: 'monthly',
        amount: '-120000',
        memo: 'rent',
      })

      await page.goto(`/plans/${planId}/scheduled`)
      await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
      await expect(page.getByText('rent').first()).toBeVisible()

      expect(await workingBalance()).toBe(before)
    })

    test('a missed occurrence is entered, unapproved, on the next page load', async () => {
      const created = await rpc('scheduled.create', {
        planId,
        accountId,
        date: pastDate(3),
        frequency: 'daily',
        amount: '-1000',
        memo: 'coffee habit',
      })
      // Asserted rather than assumed: a refused create and an absent banner look identical.
      expect(created.ok(), JSON.stringify(await created.json())).toBe(true)

      // The catch-up runs when the plan is rendered, not on a timer.
      await page.goto(`/plans/${planId}/accounts/${accountId}`)

      const banner = page.getByText(/entered from a schedule/)
      await expect(banner).toBeVisible()
      // Four days: three missed plus today.
      await expect(banner).toContainText('4 transactions')
    })

    test('loading the page again enters nothing more', async () => {
      const rowsBefore = await page.getByRole('row').count()
      await page.goto(`/plans/${planId}/accounts/${accountId}`)
      await expect(page.getByText(/entered from a schedule/)).toBeVisible()
      expect(await page.getByRole('row').count()).toBe(rowsBefore)
    })

    test('approving them clears the banner', async () => {
      await page.getByRole('button', { name: 'Approve all' }).click()
      await expect(page.getByText(/entered from a schedule/)).toBeHidden()
    })
  })

/** The plan's today, shifted by whole days. Calendar arithmetic, no clock involved. */
function shift(days: number): string {
  const [y = 0, m = 0, d = 0] = today.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

const futureDate = (days: number) => shift(days)
const pastDate = (days: number) => shift(-days)

async function workingBalance(): Promise<string> {
  await page.goto(`/plans/${planId}/accounts/${accountId}`)
  const header = await page.getByText(/Working/).innerText()
  return header
}
