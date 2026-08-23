'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { rpc } from '@/lib/rpc'
import { MoneyInput, toMilliunits } from './money-input'
import { Picker, type PickerOption } from './picker'

export interface NewTransactionRowProps {
  readonly planId: string
  readonly accountId: string
  /** The plan's today — not the browser's. See ADR-0005. */
  readonly today: string
  readonly payees: readonly PickerOption[]
  readonly categories: readonly PickerOption[]
  readonly onCreated: () => void
}

/**
 * Entry row.
 *
 * Outflow and inflow are separate fields rather than one signed amount. Every register works
 * this way for a reason: money leaving and money arriving are different acts, and asking
 * someone to remember a minus sign is asking them to make a silent, unrecoverable error.
 */
export function NewTransactionRow({
  planId,
  accountId,
  today,
  payees,
  categories,
  onCreated,
}: NewTransactionRowProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payeeId, setPayeeId] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    /**
     * Capture the form before any `await`.
     *
     * React nulls `event.currentTarget` once the handler yields, so touching it after an await
     * throws — and the throw silently skips everything after it. That is what made a saved
     * transaction appear not to save: the write succeeded, then `currentTarget.reset()` threw
     * and the refresh never ran.
     */
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    const outflow = toMilliunits(String(form.get('outflow') ?? ''))
    const inflow = toMilliunits(String(form.get('inflow') ?? ''))
    const amount = inflow - outflow

    const result = await rpc('transaction.create', {
      planId,
      accountId,
      date: String(form.get('date')),
      amount: amount.toString(),
      payeeId,
      categoryId,
      memo: String(form.get('memo') ?? '') || null,
      cleared: form.get('cleared') === 'on' ? 'cleared' : 'uncleared',
    })
    setBusy(false)

    if ('error' in result) {
      setError(result.error.message)
      return
    }
    formEl.reset()
    setPayeeId(null)
    setCategoryId(null)
    onCreated()
  }

  if (!open) {
    return (
      <div className="border-b bg-surface px-3 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="h-7 gap-1.5">
          <Plus className="size-3.5" aria-hidden />
          Add transaction
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="border-b bg-surface-sunken px-3 py-2">
      <div className="flex items-end gap-2">
        <label className="grid gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Date</span>
          <Input
            name="date"
            type="date"
            defaultValue={today}
            max={today}
            required
            className="h-8 w-36"
          />
        </label>
        <div className="grid flex-1 gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Payee</span>
          <Picker value={payeeId} options={payees} placeholder="Payee" onChange={setPayeeId} />
        </div>
        <div className="grid flex-1 gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Category</span>
          <Picker
            value={categoryId}
            options={categories}
            placeholder="Category"
            onChange={setCategoryId}
          />
        </div>
        <label className="grid flex-1 gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Memo</span>
          <Input name="memo" className="h-8" />
        </label>
        <label className="grid gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Outflow</span>
          <MoneyInput name="outflow" className="w-28" placeholder="0.00" />
        </label>
        <label className="grid gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Inflow</span>
          <MoneyInput name="inflow" className="w-28" placeholder="0.00" />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-xs text-ink-muted">
          <input type="checkbox" name="cleared" className="size-3.5" />
          Cleared
        </label>
        <Button type="submit" size="sm" disabled={busy} className="h-8">
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-negative">
          {error}
        </p>
      )}
    </form>
  )
}
