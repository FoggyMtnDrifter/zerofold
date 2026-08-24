'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { type RpcResult, rpc } from '@/lib/rpc'
import type { PickerOption } from './picker'
import { Register } from './register'
import { TransactionForm } from './transaction-form'
import type { RegisterRow } from './types'
import { UndoBar, type UndoState } from './undo-bar'

export interface RegisterViewProps {
  readonly planId: string
  readonly accountId: string
  readonly today: string
  readonly rows: readonly RegisterRow[]
  readonly payees: readonly PickerOption[]
  readonly categories: readonly PickerOption[]
  readonly undo: UndoState
}

/**
 * The interactive register: entry, selection and bulk actions over the presentational grid.
 *
 * State lives here rather than in `Register` so the grid stays a pure view of rows — which is
 * what lets the performance harness render it with 50,000 generated rows and no server at all.
 */
export function RegisterView({
  planId,
  accountId,
  today,
  rows,
  payees,
  categories,
  undo,
}: RegisterViewProps) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<RegisterRow | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const refresh = () => startTransition(() => router.refresh())

  const unapproved = rows.filter((row) => !row.approved).length

  /**
   * Apply an action to every selected row.
   *
   * Sequential rather than concurrent: these are writes against one SQLite connection with a
   * single writer, so firing them in parallel buys nothing and turns one failure into an
   * unpredictable partial result. Stopping at the first error leaves a state the user can
   * reason about — "the first three were approved" — rather than a scattered one.
   */
  const applyToSelection = (
    label: string,
    action: (
      id: string,
      group: { groupId: string; groupLabel: string },
    ) => Promise<RpcResult<unknown>>,
  ) => applyToSelectionOf([...selected], label, action)

  async function applyToSelectionOf(
    ids: readonly string[],
    label: string,
    action: (
      id: string,
      group: { groupId: string; groupLabel: string },
    ) => Promise<RpcResult<unknown>>,
  ) {
    setError(null)
    // One group id for the whole batch, so eleven deletions undo as one press rather than as
    // eleven. Generated here because "one user action" is a fact about this click, not about
    // any single write it performs.
    const groupId = crypto.randomUUID()
    const noun = ids.length === 1 ? 'transaction' : `${ids.length} transactions`
    for (const [index, id] of ids.entries()) {
      const result = await action(id, { groupId, groupLabel: `${label} ${noun}` })
      if ('error' in result) {
        setError(
          index === 0
            ? result.error.message
            : `Stopped after ${index} of ${ids.length}: ${result.error.message}`,
        )
        break
      }
    }
    setSelected(new Set())
    refresh()
  }

  const approveSelected = () =>
    applyToSelection('Approve', (transactionId, group) =>
      rpc('transaction.update', { planId, transactionId, approved: true, ...group }),
    )

  /**
   * Approve everything a schedule entered.
   *
   * Auto-entry puts rows in front of someone rather than silently into the balance (R53), and
   * the point of the banner is that they are *offered*. Approving in bulk is the common case —
   * rent went out for the amount it always does — without making it the automatic one.
   */
  const approveEntered = () =>
    applyToSelectionOf(
      rows.filter((row) => !row.approved).map((row) => row.id),
      'Approve',
      (transactionId, group) =>
        rpc('transaction.update', { planId, transactionId, approved: true, ...group }),
    )

  const deleteSelected = () =>
    applyToSelection('Delete', (transactionId, group) =>
      rpc('transaction.delete', { planId, transactionId, ...group }),
    )

  return (
    <div className="flex h-full flex-col">
      {/*
       * Undo closes any open editor. The form holds a snapshot of a row taken when it opened, and
       * an undo may have just changed that row underneath it — leaving it open would invite
       * saving stale values straight back over the change that was reversed.
       */}
      {unapproved > 0 && (
        <div className="flex items-center gap-2 border-b bg-underfunded-wash px-3 py-1.5 text-xs">
          <span className="font-medium text-ink">
            {unapproved} {unapproved === 1 ? 'transaction' : 'transactions'} entered from a schedule
          </span>
          <span className="text-ink-muted">Check the details, then approve.</span>
          <Button size="sm" variant="ghost" className="h-6" onClick={approveEntered}>
            Approve all
          </Button>
        </div>
      )}

      <UndoBar
        planId={planId}
        state={undo}
        onChanged={() => {
          setEditing(null)
          refresh()
        }}
      />

      {/*
       * Keyed by the row under edit so switching rows remounts the form.
       *
       * The key belongs here, on the component, not on the `<form>` element inside it: an inner
       * key resets the uncontrolled inputs but leaves the component's own state alone, which
       * silently produced a form showing one row's memo beside another row's category.
       */}
      <TransactionForm
        key={editing?.id ?? 'new'}
        planId={planId}
        accountId={accountId}
        today={today}
        payees={payees}
        categories={categories}
        editing={editing ?? undefined}
        onDone={() => {
          setEditing(null)
          refresh()
        }}
        onCancelEdit={() => setEditing(null)}
      />

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b bg-brand-wash px-3 py-1.5 text-xs">
          <span className="font-medium">{selected.size} selected</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={approveSelected}
            disabled={pending}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-negative hover:text-negative"
            onClick={deleteSelected}
            disabled={pending}
          >
            Delete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-ink-muted"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="border-b bg-negative-wash px-3 py-1.5 text-xs text-negative">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <Register
          rows={rows}
          selected={selected}
          onSelectedChange={setSelected}
          onActivate={setEditing}
        />
      </div>
    </div>
  )
}
