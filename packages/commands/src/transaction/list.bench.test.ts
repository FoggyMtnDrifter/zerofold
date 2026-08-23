import { schema } from '@zerofold/db'
import { ZERO } from '@zerofold/shared/money'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../account/create-account.ts'
import { createPlan } from '../plan/create-plan.ts'
import { testHarness } from '../test-support.ts'
import { listTransactions } from './list.ts'

/**
 * The §6 performance budget, enforced rather than assumed.
 *
 * The stated target is a register of 50,000 transactions opening in under 500ms. That budget
 * covers the query, serialisation, transport and render, so the query itself must be a small
 * fraction of it — hence the much tighter number here. Virtualisation cannot rescue a slow
 * query: it reduces how many rows are *painted*, not how many the database reads.
 */
const ROWS = 50_000
const ACCOUNTS = 6
const CATEGORIES = 200
const PAGE_BUDGET_MS = 50

let h: ReturnType<typeof testHarness>
let planId: string
const accountIds: string[] = []

beforeAll(() => {
  h = testHarness('2026-08-22')
  planId = createPlan(h.ctx, { name: 'Big', timezone: 'UTC' }).planId

  for (let i = 0; i < ACCOUNTS; i++) {
    accountIds.push(
      createAccount(h.ctx, { planId, name: `Account ${i}`, type: 'checking', balance: ZERO })
        .accountId,
    )
  }

  const groupId =
    h.db
      .select({ id: schema.categoryGroup.id })
      .from(schema.categoryGroup)
      .where(
        and(eq(schema.categoryGroup.planId, planId), eq(schema.categoryGroup.name, 'Essentials')),
      )
      .get()?.id ?? ''

  const categoryIds: string[] = []
  const insertCategory = h.sqlite.prepare(
    `INSERT INTO category (id, plan_id, category_group_id, name, hidden, sort_order,
       knowledge_at_change, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?, ?)`,
  )
  const payeeIds: string[] = []
  const insertPayee = h.sqlite.prepare(
    `INSERT INTO payee (id, plan_id, name, knowledge_at_change, deleted, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
  )
  const insertTxn = h.sqlite.prepare(
    `INSERT INTO "transaction" (id, plan_id, account_id, date, amount, memo, cleared, approved,
       payee_id, category_id, is_split, knowledge_at_change, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  )

  // One transaction for the whole seed: 50k individual commits would dominate the timing and
  // measure SQLite's fsync rather than the query.
  h.sqlite.transaction(() => {
    for (let i = 0; i < CATEGORIES; i++) {
      const id = h.ctx.newId()
      insertCategory.run(id, planId, groupId, `Category ${i}`, i, h.ctx.now, h.ctx.now)
      categoryIds.push(id)
    }
    for (let i = 0; i < 500; i++) {
      const id = h.ctx.newId()
      insertPayee.run(id, planId, `Payee ${i}`, h.ctx.now, h.ctx.now)
      payeeIds.push(id)
    }
    // Five years of history, spread across accounts, many rows sharing a date — which is the
    // case that breaks naive pagination.
    const start = Date.UTC(2021, 7, 22)
    for (let i = 0; i < ROWS; i++) {
      const day = new Date(start + Math.floor((i / ROWS) * 5 * 365) * 86_400_000)
      insertTxn.run(
        h.ctx.newId(),
        planId,
        accountIds[i % ACCOUNTS] as string,
        day.toISOString().slice(0, 10),
        BigInt(-((i % 900) + 100) * 100),
        null,
        i % 3 === 0 ? 'cleared' : 'uncleared',
        1,
        payeeIds[i % payeeIds.length] as string,
        categoryIds[i % categoryIds.length] as string,
        h.ctx.now,
        h.ctx.now,
      )
    }
  })()
}, 120_000)

afterAll(() => h.close())

const timed = <T>(fn: () => T): [T, number] => {
  const started = performance.now()
  const value = fn()
  return [value, performance.now() - started]
}

describe(`register at ${ROWS.toLocaleString()} transactions`, () => {
  it('seeded the expected volume', () => {
    const { n } = h.sqlite.prepare('SELECT count(*) AS n FROM "transaction"').get() as {
      n: bigint
    }
    expect(Number(n)).toBeGreaterThanOrEqual(ROWS)
  })

  it('uses the register index rather than sorting', () => {
    // The assertion that actually protects the budget. A plan containing "USE TEMP B-TREE FOR
    // ORDER BY" means SQLite is sorting the whole table on every page, which stays fast on a
    // seed of 500 and collapses on a real register.
    const plan = h.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM "transaction"
         WHERE plan_id = ? AND deleted = 0 AND account_id = ?
         ORDER BY date DESC, id DESC LIMIT 100`,
      )
      .all(planId, accountIds[0] as string) as { detail: string }[]
    const detail = plan.map((p) => p.detail).join(' | ')
    expect(detail).toMatch(/transaction_register/)
    expect(detail).not.toMatch(/TEMP B-TREE/)
  })

  it(`returns the first page in under ${PAGE_BUDGET_MS}ms`, () => {
    const [page, ms] = timed(() =>
      listTransactions(h.db, { planId, accountId: accountIds[0] as string, limit: 100 }),
    )
    expect(page.rows).toHaveLength(100)
    console.log(`    first page: ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(PAGE_BUDGET_MS)
  })

  it('stays flat deep into the register', () => {
    // The point of keyset paging: page 200 must cost what page 1 costs. With OFFSET this is
    // where the curve turns.
    let cursor: string | null = null
    let deepest = 0
    for (let i = 0; i < 200; i++) {
      const [page, ms] = timed(() =>
        listTransactions(h.db, {
          planId,
          accountId: accountIds[0] as string,
          limit: 100,
          cursor: cursor ?? undefined,
        }),
      )
      deepest = ms
      cursor = page.nextCursor
      if (!cursor) break
    }
    console.log(`    page ~200:  ${deepest.toFixed(1)}ms`)
    expect(deepest).toBeLessThan(PAGE_BUDGET_MS)
  })

  it('serves the All Accounts view within budget', () => {
    const [page, ms] = timed(() => listTransactions(h.db, { planId, limit: 100 }))
    expect(page.rows).toHaveLength(100)
    console.log(`    all accounts: ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(PAGE_BUDGET_MS)
  })
})
