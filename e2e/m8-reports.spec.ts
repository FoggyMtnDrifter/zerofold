import { type Browser, expect, type Page, test } from '@playwright/test'

/**
 * M8: reports.
 *
 * The figures are covered by unit tests against the ledger; these check that the page agrees
 * with the rest of the application. A report that quietly disagrees with the sidebar is worse
 * than no report, so that is what this asserts.
 */

const PASSWORD = 'correct-horse-battery-staple'
const EMAIL = 'owner@example.test'

let page: Page
let planId: string

test.describe
  .serial('M8 reports', () => {
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
    })

    test.afterAll(async () => {
      await page.close()
    })

    test('the Reflect link goes somewhere now', async () => {
      await page.getByRole('link', { name: 'Reflect' }).click()
      await expect(page.getByRole('heading', { name: 'Reflect' })).toBeVisible()
      await expect(page.getByText('Where the money went')).toBeVisible()
      await expect(page.getByText('What you are worth')).toBeVisible()
    })

    test('net worth agrees with the account balances beside it', async () => {
      await page.goto(`/plans/${planId}/reflect`)

      const origin = new URL(page.url()).origin
      const accounts = await (
        await page.request.post('/api/rpc/account.list', {
          data: { planId },
          headers: { origin },
        })
      ).json()

      const expected = accounts.data.reduce(
        (total: bigint, a: { balance: string }) => total + BigInt(a.balance),
        0n,
      )

      const worth = await page.getByText('What you are worth').locator('..').innerText()
      const shown = /-?[\d,]+\.\d\d/.exec(worth)?.[0] ?? '0'
      const milliunits = toMilliunits(shown)

      // Reports read the ledger; the sidebar reads the cached balances. They must not disagree.
      expect(milliunits).toBe(expected)
    })

    test('age of money says "not yet" rather than zero below the ten-spend floor', async () => {
      await page.goto(`/plans/${planId}`)
      // Zero days and "we cannot tell yet" are different claims, and this plan is the latter.
      await expect(page.getByText('Age of money')).toBeVisible()
      await expect(page.getByText('not yet')).toBeVisible()
    })
  })

function toMilliunits(text: string): bigint {
  const cleaned = text.replace(/,/g, '')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3))
  return cleaned.startsWith('-') ? -value : value
}
