/**
 * P1-12 — what actually breaks a same-date tie between two cards?
 *
 * P1-11 concluded "account order" but never recorded the transaction ids, and P1-03's three
 * contested categories all contradict account order while fitting transaction id ascending.
 * This is the case that discriminates: one category, two cards, identical date and identical
 * amount, funded for exactly half of the total. Whichever card is covered went first.
 *
 * Run repeatedly, because which transaction gets the smaller id is a coin flip we do not
 * control — the point is whether coverage tracks the id or the account.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN = readFileSync(join(homedir(), '.config/zerofold/ynab-token'), 'utf8').trim()
const BASE = 'https://api.ynab.com/v1'
const PLAN = 'c997a8c9-f6b6-4a20-b770-124573f38487'
const MONTH = '2026-08-01'
const DATE = '2026-08-12'
const ROUNDS = 5

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
const realCategory = plan.categories.find((c) => c.name.includes('Stuff'))
if (!realCategory) throw new Error('category not found')

/** Two cards, created in a known order so "account order" has a definite meaning. */
async function ensureCard(name) {
  const found = plan.accounts.find((a) => a.name === name && !a.deleted)
  if (found) return found
  const { account } = await api(`/budgets/${PLAN}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ account: { name, type: 'creditCard', balance: 0 } }),
  })
  plan = await detail()
  return account
}

const cardA = await ensureCard('P112 Card A')
const cardB = await ensureCard('P112 Card B')
console.log('card A', cardA.id, '| card B', cardB.id)

const payCat = (name) => plan.categories.find((c) => c.name === name && !c.deleted)

const results = []
for (let round = 0; round < ROUNDS; round++) {
  // Fund exactly half of what the two charges will cost.
  await api(`/budgets/${PLAN}/months/${MONTH}/categories/${realCategory.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: { budgeted: 40000 } }),
  })

  const made = []
  for (const card of [cardA, cardB]) {
    const { transaction } = await api(`/budgets/${PLAN}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        transaction: {
          account_id: card.id,
          date: DATE,
          amount: -40000,
          category_id: realCategory.id,
          cleared: 'cleared',
          approved: true,
        },
      }),
    })
    made.push({ card: card.name, cardId: card.id, txnId: transaction.id })
  }

  plan = await detail()
  const a = payCat('P112 Card A')
  const b = payCat('P112 Card B')

  const smallerId = made[0].txnId < made[1].txnId ? made[0] : made[1]
  const coveredFirst = (a?.balance ?? 0) > (b?.balance ?? 0) ? 'P112 Card A' : 'P112 Card B'

  results.push({
    round,
    txnA: made[0].txnId,
    txnB: made[1].txnId,
    payA: a?.balance,
    payB: b?.balance,
    smallerIdBelongsTo: smallerId.card,
    coveredFirst,
    idPredicts: smallerId.card === coveredFirst,
    accountOrderPredicts: coveredFirst === 'P112 Card A',
  })
  console.log(JSON.stringify(results.at(-1)))

  // Reset for the next round.
  for (const m of made)
    await api(`/budgets/${PLAN}/transactions/${m.id ?? m.txnId}`, { method: 'DELETE' })
  plan = await detail()
}

console.log('\nsummary')
console.log(
  '  transaction-id ascending predicts:',
  results.filter((r) => r.idPredicts).length,
  '/',
  results.length,
)
console.log(
  '  account order predicts:          ',
  results.filter((r) => r.accountOrderPredicts).length,
  '/',
  results.length,
)
