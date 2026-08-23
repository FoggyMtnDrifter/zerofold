'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { rpc } from '@/lib/rpc'

const TYPES = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['cash', 'Cash'],
  ['creditCard', 'Credit card'],
  ['lineOfCredit', 'Line of credit'],
  ['mortgage', 'Mortgage'],
  ['autoLoan', 'Auto loan'],
  ['studentLoan', 'Student loan'],
  ['personalLoan', 'Personal loan'],
  ['medicalDebt', 'Medical debt'],
  ['otherDebt', 'Other debt'],
  ['otherAsset', 'Other asset'],
  ['otherLiability', 'Other liability'],
] as const

/** Currency units in, milliunits out — the conversion happens once, at the boundary. */
const toMilliunits = (input: string): string => {
  const cleaned = input.replace(/[^0-9.-]/g, '').trim()
  if (!cleaned) return '0'
  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3))
  return (negative ? -milli : milli).toString()
}

export function AddAccountForm({ planId }: { planId: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const result = await rpc('account.create', {
      planId,
      name: String(form.get('name')),
      type: String(form.get('type')),
      balance: toMilliunits(String(form.get('balance') ?? '0')),
    })
    setBusy(false)
    if ('error' in result) {
      setError(result.error.message)
      return
    }
    /**
     * Navigate to the new account's register rather than only calling `refresh()`.
     *
     * It is where the user wants to be next, and it also sidesteps a real problem: `refresh()`
     * alone did not re-render the sidebar, which lives in a parent layout, so a freshly added
     * account stayed invisible until a full page load. Landing on the account makes the result
     * of the action self-evident instead of something to go looking for.
     */
    const { accountId } = result.data as { accountId: string }
    router.push(`/plans/${planId}/accounts/${accountId}`)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add an account</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="type">Type</Label>
            <select
              id="type"
              name="type"
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              defaultValue="checking"
            >
              {TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="balance">Current balance</Label>
            <Input id="balance" name="balance" defaultValue="0.00" inputMode="decimal" />
            <p className="text-2xs text-ink-subtle">
              Negative for a card or loan you already owe on.
            </p>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
