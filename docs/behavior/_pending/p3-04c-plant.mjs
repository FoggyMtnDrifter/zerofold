import { api } from './p0lib.mjs'

const { plan } = await api('')
const acct = plan.accounts.find((a) => a.name === 'Checking').id

/**
 * Month-end clamping cannot be observed today: date_next reports only the next occurrence,
 * and these dates are still in the future. Planting them now means that once each date passes
 * and auto-entry advances the pointer, date_next reveals what the following occurrence was.
 */
const CASES = [
  ['2026-08-31', 'monthly', 'the 31st monthly → Sept has 30 days'],
  ['2026-08-30', 'monthly', 'the 30th monthly → control, Sept has a 30th'],
  ['2026-08-31', 'everyOtherMonth', 'the 31st every other month → Oct has a 31st'],
  ['2026-08-31', 'yearly', 'the 31st yearly → Aug 2027 has a 31st'],
  ['2026-08-29', 'monthly', 'the 29th → matters for February later'],
]
for (const [date, frequency, note] of CASES) {
  const r = await api(
    '/scheduled_transactions',
    'POST',
    {
      scheduled_transaction: {
        account_id: acct,
        date,
        amount: -1000,
        frequency,
        memo: `P3-04c ${date} ${frequency}`,
      },
    },
    true,
  )
  console.log(
    r ? `planted  ${date} ${frequency.padEnd(16)} — ${note}` : `REJECTED ${date} ${frequency}`,
  )
}
console.log('\nRead these back on or after 2026-09-01 with p3-04c-read.mjs.')
