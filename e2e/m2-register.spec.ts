import { type Browser, expect, type Page, test } from '@playwright/test'

/**
 * M2: entering, editing and reconciling in the register, driven through the UI.
 *
 * These go through the browser rather than the RPC layer because every defect they were written
 * for lived between the two — a form that submitted a null category, a picker that opened blank,
 * a reconciled row quietly downgraded by an unrelated edit. The command tests already cover the
 * rules; these cover the wiring.
 *
 * Runs after `m1-acceptance` (workers: 1, files in name order) and reuses the admin it created.
 *
 * One sign-in for the whole file, and one page shared across the tests. Signing in per test
 * would trip the throttle on repeated sign-in attempts — behaviour worth keeping, so the tests
 * work with it rather than around it, retrying the way a person would.
 */

const PASSWORD = 'correct-horse-battery-staple'
const EMAIL = 'owner@example.test'
const ACCOUNT = 'Acct checking'

let page: Page

test.describe
  .serial('M2 register', () => {
    test.beforeAll(async ({ browser }: { browser: Browser }) => {
      page = await browser.newPage()
      // The preceding file ends on two deliberately wrong passwords, which leaves the sign-in
      // throttle warm. Waiting it out is the same thing a person would do.
      for (let attempt = 0; attempt < 4; attempt++) {
        await page.goto('/sign-in')
        await page.getByLabel('Email').fill(EMAIL)
        await page.getByLabel('Password').fill(PASSWORD)
        await page.getByRole('button', { name: 'Sign in' }).click()
        // `waitFor`, not `isVisible`: the latter answers immediately about the current DOM and
        // would report "not signed in" for a sign-in that simply had not finished rendering.
        const landed = await page
          .getByText('Ready to assign')
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false)
        if (landed) break
        // Filtered, not `.first()`: Next renders an empty route-announcer with role=alert on
        // every page, so an unfiltered query is ambiguous.
        await expect(page.getByRole('alert').filter({ hasText: 'Too many attempts' })).toBeVisible()
        await page.waitForTimeout(6_000)
      }
      await expect(page.getByText('Ready to assign')).toBeVisible()

      await page.getByRole('link', { name: ACCOUNT }).click()
      await expect(page.getByRole('grid', { name: 'Transactions' })).toBeVisible()
    })

    test.afterAll(async () => {
      await page.close()
    })

    test('a transaction entered through the form appears in the register', async () => {
      await page.getByRole('button', { name: 'Add transaction' }).click()
      await page.getByRole('textbox', { name: 'Outflow' }).fill('42.75')
      await page.getByRole('textbox', { name: 'Memo' }).fill('weekly shop')
      await page.getByRole('combobox', { name: 'Category' }).click()
      await page.getByRole('option', { name: 'Groceries' }).click()
      await page.getByRole('button', { name: 'Save' }).click()

      const row = page.getByRole('row').filter({ hasText: 'weekly shop' })
      await expect(row).toBeVisible()
      await expect(row).toContainText('Groceries')
      await expect(row).toContainText('-$42.75')
    })

    test('editing a row keeps the category it already had', async () => {
      // The regression this guards: the pickers are controlled state, so a form that opened
      // without seeding them submitted `categoryId: null` and erased the category on every edit.
      await page.getByRole('row').filter({ hasText: 'weekly shop' }).dblclick()
      await expect(page.getByRole('combobox', { name: 'Category' })).toHaveText(/Groceries/)
      await expect(page.getByRole('textbox', { name: 'Outflow' })).toHaveValue('42.75')

      await page.getByRole('textbox', { name: 'Outflow' }).fill('50.00')
      await page.getByRole('button', { name: 'Update' }).click()

      const row = page.getByRole('row').filter({ hasText: 'weekly shop' })
      await expect(row).toContainText('-$50.00')
      await expect(row).toContainText('Groceries')
    })

    test('reconciling against a different balance records an adjustment', async () => {
      await page.getByRole('button', { name: 'Reconcile' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()

      await dialog.getByRole('textbox', { name: 'Balance at your bank' }).fill('10.00')
      await dialog.getByRole('button', { name: 'Adjust and reconcile' }).click()
      await expect(dialog).toBeHidden()

      await expect(
        page.getByRole('row').filter({ hasText: 'Reconciliation Balance Adjustment' }),
      ).toBeVisible()
      await expect(page.getByText('Cleared $10.00')).toBeVisible()
    })

    test('a reconciled row refuses a casual edit but offers a way through', async () => {
      await page
        .getByRole('row')
        .filter({ hasText: 'Reconciliation Balance Adjustment' })
        .dblclick()
      await page.getByRole('textbox', { name: 'Memo' }).fill('checked against the statement')
      await page.getByRole('button', { name: 'Update' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'has been reconciled' })).toBeVisible()

      await page.getByRole('button', { name: 'Edit anyway' }).click()
      const edited = page.getByRole('row').filter({ hasText: 'checked against the statement' })
      await expect(edited).toBeVisible()

      // Still reconciled: fixing a memo must not silently undo a reconciliation.
      await edited.dblclick()
      await page.getByRole('button', { name: 'Update' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'has been reconciled' })).toBeVisible()
    })

    test('undo reverses the last change, and redo puts it back', async () => {
      // Undoing the forced edit from the previous test: its inverse carries `force`, because a
      // row that was reconciled when it was edited is still reconciled when you change your mind.
      await expect(page.getByRole('button', { name: /^Undo edit transaction/ })).toBeVisible()
      await page.getByRole('button', { name: /^Undo edit transaction/ }).click()

      await expect(
        page.getByRole('row').filter({ hasText: 'checked against the statement' }),
      ).toBeHidden()

      await page.getByRole('button', { name: /^Redo edit transaction/ }).click()
      await expect(
        page.getByRole('row').filter({ hasText: 'checked against the statement' }),
      ).toBeVisible()
    })

    test('a bulk delete undoes as one step', async () => {
      // Its own rows, because reconciliation has locked everything already in the register and a
      // bulk delete over those would be testing R71 rather than grouping.
      // The form stays open after a save, ready for the next entry, so it is opened once.
      await page.getByRole('button', { name: 'Add transaction' }).click()
      for (const memo of ['bulk one', 'bulk two']) {
        await page.getByRole('textbox', { name: 'Outflow' }).fill('1.00')
        await page.getByRole('textbox', { name: 'Memo' }).fill(memo)
        await page.getByRole('button', { name: 'Save' }).click()
        await expect(page.getByRole('row').filter({ hasText: memo })).toBeVisible()
      }
      await page.getByRole('button', { name: 'Cancel' }).click()

      await page.getByRole('checkbox', { name: /Select bulk one/ }).click()
      await page.getByRole('checkbox', { name: /Select bulk two/ }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(page.getByRole('row').filter({ hasText: 'bulk one' })).toBeHidden()
      await expect(page.getByRole('row').filter({ hasText: 'bulk two' })).toBeHidden()

      // The label counts what it will restore, and one press restores all of it.
      const undo = page.getByRole('button', { name: 'Undo delete 2 transactions' })
      await expect(undo).toBeVisible()
      await undo.click()

      await expect(page.getByRole('row').filter({ hasText: 'bulk one' })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: 'bulk two' })).toBeVisible()
    })
  })
