'use client'

import { useMemo } from 'react'
import { Register } from '@/components/register/register'
import type { ClearedStatus, FlagColor, RegisterRow } from '@/components/register/types'

const PAYEES = [
  'Corner Market',
  'City Transit',
  'Electric Co',
  'Bookshop',
  'Coffee',
  'Pharmacy',
  'Hardware Store',
  'Cinema',
]
const CATEGORIES = ['Groceries', 'Transport', 'Electricity', 'Hobbies', 'Eating Out', 'Health']
const FLAGS: (FlagColor | null)[] = [null, null, null, null, 'red', 'blue', 'green', 'yellow']
const CLEARED: ClearedStatus[] = ['uncleared', 'cleared', 'cleared', 'reconciled']

/**
 * Deterministic pseudo-random, so a run is reproducible and a regression is a real change
 * rather than a different dataset.
 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(count: number): RegisterRow[] {
  const random = mulberry32(20260823)
  const rows: RegisterRow[] = []
  const start = Date.UTC(2021, 7, 22)
  for (let i = 0; i < count; i++) {
    const day = new Date(start + Math.floor((i / count) * 5 * 365) * 86_400_000)
    const isSplit = random() < 0.04
    const isTransfer = random() < 0.05
    rows.push({
      id: `row-${i}`,
      date: day.toISOString().slice(0, 10),
      amount: BigInt(Math.floor(random() * 90_000) + 1_000) * (random() < 0.08 ? 1n : -1n),
      memo: random() < 0.25 ? 'note' : null,
      cleared: CLEARED[Math.floor(random() * CLEARED.length)] as ClearedStatus,
      approved: random() > 0.05,
      flagColor: FLAGS[Math.floor(random() * FLAGS.length)] ?? null,
      accountId: 'a1',
      accountName: 'Everyday',
      payeeId: null,
      payeeName: isTransfer
        ? 'Transfer : Savings'
        : (PAYEES[Math.floor(random() * PAYEES.length)] ?? null),
      categoryId: null,
      categoryName: isSplit ? null : (CATEGORIES[Math.floor(random() * CATEGORIES.length)] ?? null),
      isSplit,
      transferAccountId: isTransfer ? 'a2' : null,
    })
  }
  // Newest first, matching the real query's ordering.
  return rows.reverse()
}

export function RegisterHarness({ count }: { count: number }) {
  const rows = useMemo(() => generate(count), [count])
  return (
    <div className="flex h-dvh flex-col">
      <div className="border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Register harness</h1>
        <p className="text-2xs text-ink-subtle">
          {count.toLocaleString()} generated rows — development only
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <Register rows={rows} />
      </div>
    </div>
  )
}
