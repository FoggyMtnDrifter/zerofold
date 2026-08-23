'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { type RpcResult, rpc } from '@/lib/rpc'
import type { PickerOption } from './picker'
import { Register } from './register'
import { TransactionForm } from './transaction-form'
import type { RegisterRow } from './types'

export interface RegisterViewProps {
  readonly planId: string
  readonly accountId: string
  readonly today: string
  readonly rows: readonly RegisterRow[]
  readonly payees: readonly PickerOption[]
  readonly categories: readonly PickerOption[]
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
}: RegisterViewProps) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<RegisterRow | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const refresh = () => startTransition(() => router.refresh())

  /**
   * Apply an action to every selected row.
   *
   * Sequential rather than concurrent: these are writes against one SQLite connection with a
   * single writer, so firing them in parallel buys nothing and turns one failure into an
   * unpredictable partial result. Stopping at the first error leaves a state the user can
   * reason about — "the first three were approved" — rather than a scattered one.
   */
  async function applyToSelection(
    label: string,
    action: (id: string) => Promise<RpcResult<unknown>>,
  ) {
    setError(null)
    const ids = [...selected]
    for (const [index, id] of ids.entries()) {
      const result = await action(id)
      if ('error' in result) {
        setError(
          index === 0
            ? result.error.message
            : `${label} stopped after ${index} of ${ids.length}: ${result.error.message}`,
        )
        break
      }
    }
    setSelected(new Set())
    refresh()
  }

  const approveSelected = () =>
    applyToSelection('Approving', (transactionId) =>
      rpc('transaction.update', { planId, transactionId, approved: true }),
    )

  const deleteSelected = () =>
    applyToSelection('Deleting', (transactionId) =>
      rpc('transaction.delete', { planId, transactionId }),
    )

  return (
    <div className="flex h-full flex-col">
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
