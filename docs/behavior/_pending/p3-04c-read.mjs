import { api } from './p0lib.mjs'

const { scheduled_transactions: st } = await api('/scheduled_transactions')
const mine = st.filter((s) => s.memo?.startsWith('P3-04c') && !s.deleted)
console.table(
  mine.map((s) => ({
    memo: s.memo,
    date_first: s.date_first,
    date_next: s.date_next,
    frequency: s.frequency,
  })),
)
console.log('\nThe 31st-monthly row is the answer: 2026-09-30 means clamp-to-last-day,')
console.log('2026-10-01 means overflow, and a skip to 2026-10-31 means the occurrence is dropped.')
