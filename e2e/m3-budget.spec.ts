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

    test('a target says what the month still needs, and funding it says so', async () => {
      const health = await categoryNamed('Health')

      // $400 a month, set aside. Nothing assigned yet, so it wants the whole amount.
      await rpc('target.set', {
        planId: planIdOf(),
        categoryId: health,
        effectiveFrom: '2026-08-01',
        goalType: 'NEED',
        goalTarget: '400000',
        goalCadence: 1,
        goalNeedsWholeAmount: true,
      })

      await page.reload()
      await expect(page.getByRole('row').filter({ hasText: 'Health' })).toContainText(
        '$400.00 more',
      )

      await cell('Health').fill('400')
      await cell('Health').press('Enter')
      await expect(page.getByRole('row').filter({ hasText: 'Health' })).toContainText('funded')
    })

    test('snoozing hides the nag without changing the need (R32, R33)', async () => {
      const hobbies = await categoryNamed('Hobbies')

      await rpc('target.set', {
        planId: planIdOf(),
        categoryId: hobbies,
        effectiveFrom: '2026-08-01',
        goalType: 'NEED',
        goalTarget: '50000',
        goalCadence: 1,
        goalNeedsWholeAmount: true,
      })
      await page.reload()
      await expect(page.getByRole('row').filter({ hasText: 'Hobbies' })).toContainText(
        '$50.00 more',
      )

      const before = await underfunded()
      await rpc('target.snooze', {
        planId: planIdOf(),
        categoryId: hobbies,
        month: '2026-08-01',
        snoozed: true,
      })
      await page.reload()

      await expect(page.getByRole('row').filter({ hasText: 'Hobbies' })).toContainText('snoozed')
      // Out of the total, and the need itself untouched — two aggregates, one of them blind.
      expect(await underfunded()).toBe(before - 50_000n)

      const view = await (
        await rpc('budget.view', { planId: planIdOf(), month: '2026-08-01' })
      ).json()
      const row = view.data.groups
        .flatMap((g: { categories: TargetRow[] }) => g.categories)
        .find((c: TargetRow) => c.name === 'Hobbies')
      expect(row?.target?.underFunded).toBe('50000')
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

interface TargetRow {
  name: string
  categoryId: string
  target: { underFunded: string } | null
}

const planIdOf = () => new URL(page.url()).pathname.split('/')[2] ?? ''

const rpc = (procedure: string, data: unknown) =>
  page.request.post(`/api/rpc/${procedure}`, {
    data,
    headers: { origin: new URL(page.url()).origin },
  })

/** A category's id, by the name shown in the grid. */
async function categoryNamed(name: string): Promise<string> {
  const view = await (await rpc('budget.view', { planId: planIdOf(), month: '2026-08-01' })).json()
  const found = view.data.groups
    .flatMap((g: { categories: TargetRow[] }) => g.categories)
    .find((c: TargetRow) => c.name === name)
  if (!found) throw new Error(`no category named ${name}`)
  return found.categoryId
}

/** The header's underfunded total, in milliunits. */
async function underfunded(): Promise<bigint> {
  const text = await page.getByRole('group', { name: 'Underfunded' }).innerText()
  return parseMoney(text)
}

function parseMoney(text: string): bigint {
  const match = /-?[\d,]+\.\d\d/.exec(text)
  const cleaned = (match?.[0] ?? '0').replace(/,/g, '')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3))
  return cleaned.startsWith('-') ? -value : value
}
