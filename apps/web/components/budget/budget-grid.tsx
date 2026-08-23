'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useState, useTransition } from 'react'
import { Money } from '@/components/money'
import { fromMilliunits, MoneyInput, toMilliunits } from '@/components/register/money-input'
import { rpc } from '@/lib/rpc'
import { cn } from '@/lib/utils'
import type { BudgetView } from './types'

/**
 * The budget grid.
 *
 * Every row is one category in one month, and the only editable thing on the screen is the
 * middle column. That is the method in miniature: you assign, and everything else is derived.
 */
export function BudgetGrid({ planId, view }: { planId: string; view: BudgetView }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  /**
   * Assignments the server has not confirmed yet.
   *
   * Typing into a cell has to move the whole screen at once — the row, its group, and Ready to
   * Assign — or the number you just typed sits there contradicting the total above it. Applying
   * the difference locally is exact while a balance stays on one side of zero; an overspend
   * that crosses zero is not linear, and that case resolves when the refresh lands.
   */
  const [pending, setPending] = useState<ReadonlyMap<string, bigint>>(new Map())

  const adjusted = useMemo(() => applyPending(view, pending), [view, pending])

  const commit = useCallback(
    async (categoryId: string, next: bigint, previous: bigint) => {
      if (next === previous) return
      setError(null)
      setPending((current) => new Map(current).set(categoryId, next))

      const result = await rpc('budget.assign', {
        planId,
        month: view.month,
        categoryId,
        budgeted: next.toString(),
      })

      if ('error' in result) {
        setError(result.error.message)
        setPending((current) => {
          const copy = new Map(current)
          copy.delete(categoryId)
          return copy
        })
        return
      }

      startTransition(() => {
        router.refresh()
        // Cleared only after the refresh is requested, so the cell never blinks back to its old
        // value in the gap between the write landing and the new props arriving.
        setPending(new Map())
      })
    },
    [planId, view.month, router],
  )

  const toggle = (groupId: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      {error && (
        <p role="alert" className="border-b bg-negative-wash px-4 py-1.5 text-xs text-negative">
          {error}
        </p>
      )}

      {/* biome-ignore lint/a11y/useFocusableInteractive: a header row is not a tab stop */}
      {/* biome-ignore lint/a11y/useSemanticElements: see the grid comment below */}
      <div
        role="row"
        className="flex items-center gap-2 border-b bg-surface px-4 py-1.5 text-2xs font-medium uppercase tracking-wide text-ink-subtle"
      >
        <span className="flex-1">Category</span>
        <span className="w-32 text-right">Assigned</span>
        <span className="w-32 text-right">Activity</span>
        <span className="w-32 text-right">Available</span>
      </div>

      {/*
       * ARIA grid semantics on divs.
       *
       * A `<table>` would be the honest element for a static grid, and this one is not static:
       * groups collapse, and the middle column is a live control per row. The roles carry the
       * structure a table would have conveyed, which is also what makes each cell addressable
       * by name rather than by position.
       */}
      {/* biome-ignore lint/a11y/useSemanticElements: see above */}
      <div role="grid" aria-label="Budget" className="flex-1 overflow-auto">
        {adjusted.groups.map((group) => {
          const open = !collapsed.has(group.categoryGroupId)
          return (
            // biome-ignore lint/a11y/useSemanticElements: see the grid comment above
            <section key={group.categoryGroupId} role="rowgroup">
              {/* biome-ignore lint/a11y/useFocusableInteractive: the control inside takes focus */}
              {/* biome-ignore lint/a11y/useSemanticElements: see above */}
              <div
                role="row"
                className="flex items-center gap-2 border-b bg-surface-sunken px-4 py-1.5 text-sm font-medium"
              >
                <button
                  type="button"
                  onClick={() => toggle(group.categoryGroupId)}
                  aria-expanded={open}
                  className="flex flex-1 items-center gap-1.5 text-left"
                >
                  {open ? (
                    <ChevronDown className="size-3.5 text-ink-subtle" aria-hidden />
                  ) : (
                    <ChevronRight className="size-3.5 text-ink-subtle" aria-hidden />
                  )}
                  {group.name}
                </button>
                <Money amount={group.budgeted} className="w-32 text-right" tone="neutral" />
                <Money amount={group.activity} className="w-32 text-right" tone="neutral" />
                <Money amount={group.balance} className="w-32 text-right" />
              </div>

              {open &&
                group.categories.map((category) => (
                  // biome-ignore lint/a11y/useFocusableInteractive: the control inside takes focus
                  // biome-ignore lint/a11y/useSemanticElements: see above
                  <div
                    key={category.categoryId}
                    role="row"
                    className="flex items-center gap-2 border-b border-hairline/60 px-4 py-1 text-sm hover:bg-surface-sunken"
                  >
                    <span
                      className={cn('flex-1 truncate', category.hidden && 'text-ink-subtle italic')}
                    >
                      {category.name}
                      {category.hidden && <span className="ml-1.5 text-2xs">(hidden)</span>}
                    </span>

                    <AssignedCell
                      label={`Assigned to ${category.name}`}
                      value={category.budgeted}
                      onCommit={(next) => commit(category.categoryId, next, category.budgeted)}
                    />

                    <Money amount={category.activity} className="w-32 text-right" tone="neutral" />
                    <AvailablePill
                      label={`Available in ${category.name}`}
                      amount={category.balance}
                      overspendKind={category.overspendKind}
                    />
                  </div>
                ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One editable cell.
 *
 * Uncontrolled while focused, so typing is never interrupted by a re-render arriving from the
 * server, and re-seeded from props by the key whenever the committed value changes.
 */
function AssignedCell({
  label,
  value,
  onCommit,
}: {
  label: string
  value: bigint
  onCommit: (next: bigint) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? fromMilliunits(value)

  return (
    <MoneyInput
      aria-label={label}
      value={shown}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => {
        if (draft !== null) onCommit(toMilliunits(draft))
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
      className="h-7 w-32 text-right tabular-nums"
    />
  )
}

/**
 * Available, shown as a pill because its sign is the point.
 *
 * Credit overspending is amber rather than red: nothing has gone wrong with the budget, the
 * debt simply is not covered yet (R61). Cash overspending is red, because money that was never
 * assigned has already left.
 */
function AvailablePill({
  label,
  amount,
  overspendKind,
}: {
  label: string
  amount: bigint
  overspendKind: 'none' | 'cash' | 'credit'
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: see the grid comment in BudgetGrid
    // biome-ignore lint/a11y/useFocusableInteractive: a read-only cell is not a tab stop
    <span role="gridcell" aria-label={label} className="w-32 text-right">
      <span
        className={cn(
          'inline-block rounded-full px-2 py-0.5 text-sm tabular-nums',
          overspendKind === 'cash' && 'bg-negative-wash text-negative',
          overspendKind === 'credit' && 'bg-underfunded-wash text-underfunded',
          overspendKind === 'none' && amount > 0n && 'bg-positive-wash text-positive',
          overspendKind === 'none' && amount === 0n && 'text-ink-muted',
        )}
        title={
          overspendKind === 'cash'
            ? 'Overspent with money that was never assigned. Next month pays for it.'
            : overspendKind === 'credit'
              ? 'Overspent on a card. It is debt until you cover it.'
              : undefined
        }
      >
        <Money amount={amount} tone="neutral" />
      </span>
    </span>
  )
}

/** Re-derive the visible totals from the assignments the server has not confirmed yet. */
function applyPending(view: BudgetView, pending: ReadonlyMap<string, bigint>): BudgetView {
  if (pending.size === 0) return view

  let readyDelta = 0n
  const groups = view.groups.map((group) => {
    let budgetedDelta = 0n
    const categories = group.categories.map((category) => {
      const next = pending.get(category.categoryId)
      if (next === undefined) return category
      const delta = next - category.budgeted
      readyDelta += delta
      if (!category.hidden) budgetedDelta += delta
      return { ...category, budgeted: next, balance: category.balance + delta }
    })
    return {
      ...group,
      categories,
      budgeted: group.budgeted + budgetedDelta,
      balance: group.balance + budgetedDelta,
    }
  })

  return {
    ...view,
    groups,
    budgeted: view.budgeted + readyDelta,
    readyToAssign: view.readyToAssign - readyDelta,
  }
}
