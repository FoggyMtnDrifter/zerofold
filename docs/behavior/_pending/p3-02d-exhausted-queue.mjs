/**
 * P3-02d — what happens to spending with no income left to match against?
 *
 * R65 matches spending to income FIFO and averages the ages of the last ten spends. P3-02c left
 * open what an *unmatched* spend contributes: age zero, or nothing at all.
 *
 * The design separates them by making the matched ages large and the unmatched ones many:
 *
 *   income     100000 on 2026-01-01
 *   spending   15 x 10000 on 2026-08-01 .. 2026-08-15
 *
 * Exactly ten spends are funded, with ages 212 .. 221. Five are not.
 *
 *   unmatched counted as age 0  ->  last ten = [217,218,219,220,221,0,0,0,0,0]  mean 109.5 -> 110
 *   unmatched skipped entirely  ->  last ten funded = [212 .. 221]              mean 216.5 -> 217
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN = readFileSync(join(homedir(), '.config/zerofold/ynab-token'), 'utf8').trim()
const BASE = 'https://api.ynab.com/v1'
const PLAN = 'c997a8c9-f6b6-4a20-b770-124573f38487'
const CHECKING = '446c304a-3caf-4fd3-b0ba-8b3f1c9c1b9d'

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`)
  return body.data
}

const detail = async () => (await api(`/budgets/${PLAN}`)).budget

let plan = await detail()
const checking = plan.accounts.find((a) => a.name === 'AoM Checking' && !a.deleted)
const inflow = plan.categories.find((c) => c.name === 'Inflow: Ready to Assign')
const spendCat = plan.categories.find((c) => c.name === 'AoM spend')
if (!checking || !inflow || !spendCat) throw new Error('setup missing')
console.log('account', checking.id, '| spend category', spendCat.id)

// Start from nothing: any prior row would feed the queue and change the answer.
const existing = plan.transactions.filter((t) => !t.deleted)
for (const t of existing) {
  await api(`/budgets/${PLAN}/transactions/${t.id}`, { method: 'DELETE' })
}
console.log('cleared', existing.length, 'prior transactions')

const add = (date, amount, category) =>
  api(`/budgets/${PLAN}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      transaction: {
        account_id: checking.id,
        date,
        amount,
        category_id: category,
        cleared: 'cleared',
        approved: true,
      },
    }),
  })

await add('2026-01-01', 100000, inflow.id)
for (let day = 1; day <= 15; day++) {
  await add(`2026-08-${String(day).padStart(2, '0')}`, -10000, spendCat.id)
}
console.log('added 1 income and 15 spends')

plan = await detail()
const august = plan.months.find((m) => m.month === '2026-08-01')
console.log('\nobserved age_of_money for 2026-08-01:', august?.age_of_money)
console.log('  110 => unmatched spending counts as age 0')
console.log('  217 => unmatched spending is skipped')
console.log('  anything else => neither; needs a follow-up')
