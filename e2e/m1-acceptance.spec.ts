import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test'

/**
 * M1 acceptance criteria, end to end against a running server and a real database.
 *
 * The tests are ordered and share one instance: the acceptance criteria are themselves a
 * sequence (an empty instance, then a first user, then an invited one), and splitting them
 * across isolated databases would test something easier than what was specified.
 */

const PASSWORD = 'correct-horse-battery-staple'

type Json = Record<string, unknown>

const signUp = (api: APIRequestContext, email: string, name: string) =>
  api.post('/api/auth/sign-up/email', { data: { email, password: PASSWORD, name } })

const rpc = (api: APIRequestContext, procedure: string, data: Json) =>
  api.post(`/api/rpc/${procedure}`, { data })

const BASE_URL = 'http://127.0.0.1:3399'

let planId: string
/**
 * One request context for the whole sequence.
 *
 * Playwright's per-test `request` fixture starts with a clean cookie jar, which would discard
 * the session established by signing up. These criteria are a sequence performed by one user,
 * so they share one session — as a real user would.
 */
let api: APIRequestContext

test.describe
  .serial('M1 acceptance', () => {
    test.beforeAll(async () => {
      api = await playwrightRequest.newContext({
        baseURL: BASE_URL,
        // A browser sends Origin on credentialed requests; an API context does not. Better
        // Auth's CSRF check rejects a cookie-bearing request without one, which is correct
        // behaviour — so the test sends what a browser would rather than weakening the check.
        extraHTTPHeaders: { origin: BASE_URL },
      })
    })
    test.afterAll(async () => {
      await api.dispose()
    })

    test('the instance is alive and its database reachable', async () => {
      const response = await api.get('/healthz')
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'ok', database: 'ok' })
    })

    test('the first account on an empty instance becomes the admin, with no invite', async () => {
      const response = await signUp(api, 'owner@example.test', 'Owner')
      expect(response.status()).toBe(200)
      const body = (await response.json()) as { user: { isAdmin: boolean; email: string } }
      expect(body.user.email).toBe('owner@example.test')
      expect(body.user.isAdmin).toBe(true)
    })

    test('a second registration without an invite is refused', async () => {
      const response = await signUp(api, 'stranger@example.test', 'Stranger')
      expect(response.status()).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'auth.invite_required' })
    })

    test('RPC refuses an unauthenticated caller', async () => {
      // A deliberately separate context, carrying no session cookie.
      const anonymous = await playwrightRequest.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { origin: BASE_URL },
      })
      const response = await rpc(anonymous, 'plan.create', { name: 'X', timezone: 'UTC' })
      expect(response.status()).toBe(401)
      await anonymous.dispose()
    })

    test('a plan can be created', async () => {
      const response = await rpc(api, 'plan.create', {
        name: 'Household',
        timezone: 'Pacific/Auckland',
      })
      expect(response.status()).toBe(200)
      const body = (await response.json()) as { data: { planId: string; inflowCategoryId: string } }
      expect(body.data.inflowCategoryId).toBeTruthy()
      planId = body.data.planId
    })

    /**
     * All thirteen account types, with the classification each implies.
     *
     * `onBudget` decides whether an account's money participates in Ready to Assign, and it is
     * the single most consequential property of an account — a mortgage classified as on-budget
     * would add a quarter of a million dollars of debt to the budget.
     */
    const ACCOUNT_TYPES = [
      { type: 'checking', onBudget: true, payment: false },
      { type: 'savings', onBudget: true, payment: false },
      { type: 'cash', onBudget: true, payment: false },
      { type: 'creditCard', onBudget: true, payment: true },
      { type: 'lineOfCredit', onBudget: true, payment: true },
      { type: 'otherAsset', onBudget: false, payment: false },
      { type: 'otherLiability', onBudget: false, payment: false },
      { type: 'mortgage', onBudget: false, payment: false },
      { type: 'autoLoan', onBudget: false, payment: false },
      { type: 'studentLoan', onBudget: false, payment: false },
      { type: 'personalLoan', onBudget: false, payment: false },
      { type: 'medicalDebt', onBudget: false, payment: false },
      { type: 'otherDebt', onBudget: false, payment: false },
    ] as const

    test('every account type is created with the right budget classification', async () => {
      for (const { type, onBudget, payment } of ACCOUNT_TYPES) {
        const response = await rpc(api, 'account.create', {
          planId,
          name: `Acct ${type}`,
          type,
          balance: '0',
        })
        expect(response.status(), `creating ${type}`).toBe(200)
        const body = (await response.json()) as {
          data: { accountId: string; paymentCategoryId: string | null }
        }
        expect(
          body.data.paymentCategoryId !== null,
          `${type} should ${payment ? '' : 'not '}have a payment category`,
        ).toBe(payment)
      }

      const listed = await rpc(api, 'account.list', { planId })
      const accounts = ((await listed.json()) as { data: { name: string; onBudget: boolean }[] })
        .data
      expect(accounts).toHaveLength(ACCOUNT_TYPES.length)

      for (const { type, onBudget } of ACCOUNT_TYPES) {
        const account = accounts.find((a) => a.name === `Acct ${type}`)
        expect(account?.onBudget, `${type} onBudget`).toBe(onBudget)
      }
    })

    test('deleting a credit account requires confirmation and removes its payment category', async () => {
      const created = await rpc(api, 'account.create', {
        planId,
        name: 'Doomed Card',
        type: 'creditCard',
        balance: '0',
      })
      const { data } = (await created.json()) as {
        data: { accountId: string; paymentCategoryId: string }
      }
      expect(data.paymentCategoryId).toBeTruthy()

      // The confirmation is divergence D6 — the oracle deletes on one unconfirmed click.
      const wrong = await rpc(api, 'account.delete', {
        planId,
        accountId: data.accountId,
        confirmName: 'doomed card',
      })
      expect(wrong.status()).toBe(409)
      // RPC nests errors in an envelope; Better Auth returns them flat. Both shapes are
      // deliberate and the tests assert the real one for each surface.
      expect(await wrong.json()).toMatchObject({
        error: { code: 'account.confirmation_mismatch' },
      })

      const right = await rpc(api, 'account.delete', {
        planId,
        accountId: data.accountId,
        confirmName: 'Doomed Card',
      })
      expect(right.status()).toBe(200)

      const listed = await rpc(api, 'account.list', { planId })
      const accounts = ((await listed.json()) as { data: { name: string }[] }).data
      expect(accounts.map((a) => a.name)).not.toContain('Doomed Card')
    })

    test('a closed account keeps its history but leaves the sidebar', async () => {
      const created = await rpc(api, 'account.create', {
        planId,
        name: 'Dormant',
        type: 'savings',
        balance: '0',
      })
      const { data } = (await created.json()) as { data: { accountId: string } }

      const closed = await rpc(api, 'account.close', { planId, accountId: data.accountId })
      expect(closed.status()).toBe(200)

      const listed = await rpc(api, 'account.list', { planId })
      const accounts = ((await listed.json()) as { data: { name: string }[] }).data
      expect(accounts.map((a) => a.name)).not.toContain('Dormant')

      const reopened = await rpc(api, 'account.reopen', { planId, accountId: data.accountId })
      expect(reopened.status()).toBe(200)
      const relisted = await rpc(api, 'account.list', { planId })
      const after = ((await relisted.json()) as { data: { name: string }[] }).data
      expect(after.map((a) => a.name)).toContain('Dormant')
    })

    test('an account holding money cannot be closed', async () => {
      const created = await rpc(api, 'account.create', {
        planId,
        name: 'Funded',
        type: 'checking',
        balance: '250000',
      })
      const { data } = (await created.json()) as { data: { accountId: string } }
      const response = await rpc(api, 'account.close', { planId, accountId: data.accountId })
      expect(response.status()).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'account.balance_not_zero' } })
    })

    test('the shell renders, in both themes', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'August 2026' })).toBeVisible()
      // The register grid is a real table, so it is navigable and announceable.
      await expect(page.getByRole('columnheader', { name: 'Available' })).toBeVisible()

      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.getByRole('heading', { name: 'August 2026' })).toBeVisible()
    })
  })
