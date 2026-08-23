'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { rpc } from '@/lib/rpc'
import { fromMilliunits, MoneyInput, toMilliunits } from './money-input'
import { Picker, type PickerOption } from './picker'
import type { RegisterRow } from './types'

export interface TransactionFormProps {
  readonly planId: string
  readonly accountId: string
  /** The plan's today — not the browser's. See ADR-0005. */
  readonly today: string
  readonly payees: readonly PickerOption[]
  readonly categories: readonly PickerOption[]
  /** Present when editing; absent when creating. */
  readonly editing?: RegisterRow | undefined
  readonly onDone: () => void
  readonly onCancelEdit?: (() => void) | undefined
}

/**
 * One form for entering and for editing.
 *
 * It sits above the grid rather than replacing a row inside it. Editing in place would mean a
 * row that changes height, and the virtualiser's fixed row height is what lets it compute any
 * scroll offset arithmetically instead of measuring — the property the 50,000-row budget rests
 * on. A form anchored above keeps that intact and keeps one code path for both operations.
 *
 * The caller must key this component by the row under edit (see `RegisterView`): the seeded
 * values below are initial state, and initial state is only read on mount.
 *
 * Outflow and inflow are separate fields rather than one signed amount. Money leaving and money
 * arriving are different acts, and asking someone to remember a minus sign is asking them to
 * make a silent, unrecoverable error.
 */
export function TransactionForm({
  planId,
  accountId,
  today,
  payees,
  categories,
  editing,
  onDone,
  onCancelEdit,
}: TransactionFormProps) {
  const isEditing = Boolean(editing)
  // Distinct per row so the label/control pairing stays unambiguous across remounts.
  const idBase = `tx-${editing?.id ?? 'new'}`
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when the last attempt was refused only because the row is reconciled (R71). The refusal
  // is a speed bump, not a prohibition — the escape belongs next to the message that raised it,
  // or the user's only route is to un-reconcile an account to fix a typo.
  const [needsForce, setNeedsForce] = useState(false)
  // Seeded from the row under edit. The pickers are controlled, so without this an edit would
  // submit `payeeId: null` and silently erase the payee and category of every row it touched —
  // the form must open holding what the row already holds.
  const [payeeId, setPayeeId] = useState<string | null>(editing?.payeeId ?? null)
  const [categoryId, setCategoryId] = useState<string | null>(editing?.categoryId ?? null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Captured before any await: React nulls `currentTarget` once the handler yields.
    await submit(event.currentTarget, false)
  }

  async function submit(formEl: HTMLFormElement, force: boolean) {
    setError(null)
    setBusy(true)
    const form = new FormData(formEl)
    /*
     * The checkbox has two states; the domain has three. A reconciled row whose box is still
     * ticked stays reconciled — treating it as merely "cleared" would quietly undo a
     * reconciliation as a side effect of fixing a memo.
     */
    const ticked = form.get('cleared') === 'on'
    const cleared = ticked
      ? editing?.cleared === 'reconciled'
        ? ('reconciled' as const)
        : ('cleared' as const)
      : ('uncleared' as const)
    const amount =
      toMilliunits(String(form.get('inflow') ?? '')) -
      toMilliunits(String(form.get('outflow') ?? ''))

    const result = editing
      ? await rpc('transaction.update', {
          planId,
          transactionId: editing.id,
          date: String(form.get('date')),
          amount: amount.toString(),
          payeeId,
          categoryId,
          memo: String(form.get('memo') ?? '') || null,
          cleared,
          ...(force ? { force: true } : {}),
        })
      : await rpc('transaction.create', {
          planId,
          accountId,
          date: String(form.get('date')),
          amount: amount.toString(),
          payeeId,
          categoryId,
          memo: String(form.get('memo') ?? '') || null,
          cleared,
        })

    setBusy(false)
    if ('error' in result) {
      setError(result.error.message)
      setNeedsForce(result.error.code === 'transaction.reconciled_locked')
      return
    }
    setNeedsForce(false)
    if (!isEditing) {
      formEl.reset()
      setPayeeId(null)
      setCategoryId(null)
    }
    onDone()
  }

  if (!isEditing && !open) {
    return (
      <div className="border-b bg-surface px-3 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="h-7 gap-1.5">
          <Plus className="size-3.5" aria-hidden />
          Add transaction
        </Button>
      </div>
    )
  }

  const outflow = editing && editing.amount < 0n ? fromMilliunits(-editing.amount) : ''
  const inflow = editing && editing.amount > 0n ? fromMilliunits(editing.amount) : ''

  return (
    <form
      onSubmit={onSubmit}
      aria-label={isEditing ? 'Edit transaction' : 'New transaction'}
      className="border-b bg-surface-sunken px-3 py-2"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1" htmlFor={`${idBase}-date`}>
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Date</span>
          <Input
            id={`${idBase}-date`}
            name="date"
            type="date"
            defaultValue={editing?.date ?? today}
            max={today}
            required
            className="h-8 w-36"
          />
        </label>
        <div className="grid min-w-40 flex-1 gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Payee</span>
          <Picker
            value={payeeId}
            options={payees}
            label="Payee"
            placeholder="Payee"
            onChange={setPayeeId}
          />
        </div>
        <div className="grid min-w-40 flex-1 gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Category</span>
          <Picker
            value={categoryId}
            options={categories}
            label="Category"
            placeholder="Category"
            onChange={setCategoryId}
          />
        </div>
        <label className="grid min-w-40 flex-1 gap-1" htmlFor={`${idBase}-memo`}>
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Memo</span>
          <Input
            id={`${idBase}-memo`}
            name="memo"
            defaultValue={editing?.memo ?? ''}
            className="h-8"
          />
        </label>
        <label className="grid gap-1" htmlFor={`${idBase}-outflow`}>
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Outflow</span>
          <MoneyInput
            id={`${idBase}-outflow`}
            name="outflow"
            defaultValue={outflow}
            className="w-28"
            placeholder="0.00"
          />
        </label>
        <label className="grid gap-1" htmlFor={`${idBase}-inflow`}>
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">Inflow</span>
          <MoneyInput
            id={`${idBase}-inflow`}
            name="inflow"
            defaultValue={inflow}
            className="w-28"
            placeholder="0.00"
          />
        </label>
        <label
          className="flex h-8 items-center gap-1.5 text-xs text-ink-muted"
          htmlFor={`${idBase}-cleared`}
        >
          <input
            id={`${idBase}-cleared`}
            type="checkbox"
            name="cleared"
            defaultChecked={editing?.cleared !== 'uncleared'}
            className="size-3.5"
          />
          Cleared
        </label>
        <Button type="submit" size="sm" disabled={busy} className="h-8">
          {busy ? 'Saving…' : isEditing ? 'Update' : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => {
            setError(null)
            if (isEditing) onCancelEdit?.()
            else setOpen(false)
          }}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-negative">
          <span>{error}</span>
          {needsForce && (
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-6"
              disabled={busy}
              onClick={(event) => {
                // Re-submit the same form, this time saying so explicitly.
                event.preventDefault()
                const formEl = event.currentTarget.form
                if (formEl) void submit(formEl, true)
              }}
            >
              Edit anyway
            </Button>
          )}
        </div>
      )}
    </form>
  )
}
