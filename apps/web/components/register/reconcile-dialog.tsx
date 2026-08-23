'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Money } from '@/components/money'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { rpc } from '@/lib/rpc'
import { fromMilliunits, MoneyInput, toMilliunits } from './money-input'

/**
 * Reconciliation.
 *
 * The comparison is against the **cleared** balance, never the working balance (R55): uncleared
 * rows are money the institution has not seen, so including them would ask the user to
 * reconcile against a number their statement cannot possibly show. The dialog says so, because
 * "why doesn't this match?" is the single most common confusion in reconciling.
 */
export function ReconcileDialog({
  planId,
  accountId,
  clearedBalance,
  unclearedBalance,
}: {
  planId: string
  accountId: string
  clearedBalance: bigint
  unclearedBalance: bigint
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [statement, setStatement] = useState(() => fromMilliunits(clearedBalance))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const difference = toMilliunits(statement) - clearedBalance

  async function confirm() {
    setError(null)
    setBusy(true)
    const result = await rpc('account.reconcile', {
      planId,
      accountId,
      statementBalance: toMilliunits(statement).toString(),
    })
    setBusy(false)
    if ('error' in result) {
      setError(result.error.message)
      return
    }
    setOpen(false)
    router.refresh()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setStatement(fromMilliunits(clearedBalance))
          setError(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Reconcile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconcile this account</DialogTitle>
          <DialogDescription>
            Enter the balance your bank shows. Compare it against the cleared balance — anything
            still uncleared has not reached your bank yet, so it is not in their number either.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Cleared in Zerofold</dt>
          <dd className="text-right">
            <Money amount={clearedBalance} tone="neutral" />
          </dd>
          <dt className="text-ink-muted">Uncleared, not yet at your bank</dt>
          <dd className="text-right">
            <Money amount={unclearedBalance} tone="neutral" />
          </dd>
        </dl>

        <div className="grid gap-1.5">
          <Label htmlFor="statement">Balance at your bank</Label>
          <MoneyInput
            id="statement"
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            className="h-9"
          />
        </div>

        {difference === 0n ? (
          <p className="rounded-md bg-positive-wash px-3 py-2 text-xs text-ink">
            These match. Reconciling will lock the cleared transactions.
          </p>
        ) : (
          <p className="rounded-md bg-underfunded-wash px-3 py-2 text-xs text-ink">
            Off by <Money amount={difference} />. Reconciling records an adjustment for the
            difference against Ready to Assign — so an unexplained discrepancy lands in your budget
            rather than being blamed on a category you never spent from.
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy}>
            {busy ? 'Reconciling…' : difference === 0n ? 'Reconcile' : 'Adjust and reconcile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
