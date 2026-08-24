/**
 * Confirmation: five more unfunded spends, so all ten of the last ten are unmatched.
 *
 * If unmatched spending is age 0 and stays in the window, the mean is exactly 0. If it were
 * skipped, the window would still hold the ten funded spends and read 217. A rule that predicts
 * 0 and observes 0 here, having predicted 110 and observed 110 before, is not a coincidence.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN = readFileSync(join(homedir(), '.config/zerofold/ynab-token'), 'utf8').trim()
const BASE = 'https://api.ynab.com/v1'
const PLAN = 'c997a8c9-f6b6-4a20-b770-124573f38487'

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`)
  return body.data
}

const detail = async () => (await api(`/budgets/${PLAN}`)).budget
let plan = await detail()
const checking = plan.accounts.find((a) => a.name === 'AoM Checking' && !a.deleted)
const spendCat = plan.categories.find((c) => c.name === 'AoM spend')

for (let day = 16; day <= 20; day++) {
  await api(`/budgets/${PLAN}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      transaction: {
        account_id: checking.id,
        date: `2026-08-${day}`,
        amount: -10000,
        category_id: spendCat.id,
        cleared: 'cleared',
        approved: true,
      },
    }),
  })
}

plan = await detail()
const august = plan.months.find((m) => m.month === '2026-08-01')
console.log('after five more unfunded spends, age_of_money:', august?.age_of_money)
console.log('  0   => confirms: unmatched counts as age 0, inside the window')
console.log('  217 => would mean unmatched is skipped after all')
