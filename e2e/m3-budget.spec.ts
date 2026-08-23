import { type Browser, expect, type Page, test } from '@playwright/test'

/**
 * M3: the budget view.
 *
 * Driven through the UI against a real plan, so the assertions cover the whole path — the
 * engine, the queries that feed it, the optimistic cell, and the numbers that have to move
 * together when one of them changes.
 *
 * Runs after `m2-register`, whose transactions this inherits, and shares one signed-in page
 * for the same throttle reason.
 */

const PASSWORD = 'correct-horse-battery-staple'
const EMAIL = 'owner@example.test'

let page: Page

/** Row locator: the grid is divs, so a category is found by its assignment control. */
const cell = (name: string) => page.getByRole('textbox', { name: `Assigned to ${name}` })

test.describe
  .serial('M3 budget', () => {
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
      await expect(page.getByText('Ready to assign')).toBeVisible()
    })

    test.afterAll(async () => {
      await page.close()
    })

    test('shows every starter category, and no internal ones', async () => {
      await expect(cell('Groceries')).toBeVisible()
      await expect(cell('Emergency Fund')).toBeVisible()
      // Inflow and Uncategorized are not envelopes and have no row.
      await expect(page.getByText('Inflow: Ready to Assign')).toBeHidden()
      await expect(cell('Uncategorized')).toBeHidden()
    })

    test('assigning moves the category, its group and Ready to Assign together', async () => {
      const before = await readyToAssign()

      await cell('Groceries').fill('200')
      await cell('Groceries').press('Enter')

      // $200 assigned against the $50 outflow the register tests left behind.
      await expect(available('Groceries')).toContainText('$150.00')
      await expect
        .poll(readyToAssign, { message: 'Ready to Assign should drop by the amount assigned' })
        .toBe(before - 200_000n)
    })

    test('an unfunded category shows the overspend, and funding it clears it', async () => {
      // The register tests left a $50 outflow on Groceries in this plan.
      await cell('Groceries').fill('0')
      await cell('Groceries').press('Enter')
      await expect(available('Groceries')).toContainText('-$50.00')

      await cell('Groceries').fill('50')
      await cell('Groceries').press('Enter')
      await expect(available('Groceries')).toContainText('$0.00')
    })

    test('a balance carries into next month with nothing assigned there', async () => {
      await cell('Emergency Fund').fill('125')
      await cell('Emergency Fund').press('Enter')
      await expect(available('Emergency Fund')).toContainText('$125.00')

      await page.getByRole('link', { name: 'Next month' }).click()
      await expect(cell('Emergency Fund')).toHaveValue('0.00')
      await expect(available('Emergency Fund')).toContainText('$125.00')

      // A link where there is a month to go to; only the ends of the range are buttons.
      await page.getByRole('link', { name: 'Previous month' }).click()
      await expect(cell('Emergency Fund')).toHaveValue('125.00')
    })

    test('the cached figures agree with a from-scratch recompute', async () => {
      // The invariant the whole derived layer rests on. Recompute first, since ordinary edits
      // deliberately leave the cache behind.
      const planId = new URL(page.url()).pathname.split('/')[2]
      const recomputed = await page.request.post('/api/rpc/budget.recompute', {
        data: { planId },
        headers: { origin: new URL(page.url()).origin },
      })
      expect(recomputed.ok()).toBe(true)

      const response = await page.request.post('/api/rpc/budget.verify', {
        data: { planId },
        headers: { origin: new URL(page.url()).origin },
      })
      expect(await response.json()).toMatchObject({ data: { ok: true, discrepancies: [] } })
    })
  })

/** The header figure, in milliunits, read back off the page. */
async function readyToAssign(): Promise<bigint> {
  const text = await page.getByRole('group', { name: 'Ready to assign' }).innerText()
  const match = /-?[\d,]+\.\d\d/.exec(text)
  const cleaned = (match?.[0] ?? '0').replace(/,/g, '')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3))
  return cleaned.startsWith('-') ? -value : value
}

const available = (name: string) => page.getByRole('gridcell', { name: `Available in ${name}` })
