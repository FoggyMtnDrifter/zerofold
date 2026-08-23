'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowLeftRight, Split } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Money, toneFor } from '@/components/money'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { ClearedIndicator } from './cleared-indicator'
import { FlagMark } from './flag'
import type { RegisterRow } from './types'

/**
 * Row height in pixels.
 *
 * Fixed, and shared between the virtualiser and the CSS. Measuring rows would let content
 * decide the height, which is a nicer default in general and the wrong trade here: with a
 * uniform height the virtualiser can compute any scroll offset arithmetically instead of
 * measuring, so jumping to row 40,000 costs the same as jumping to row 4.
 */
const ROW_HEIGHT = 32
const OVERSCAN = 12

export interface RegisterProps {
  readonly rows: readonly RegisterRow[]
  readonly showAccount?: boolean
  readonly onLoadMore?: () => void
  readonly hasMore?: boolean
  /**
   * Selection is controlled when a parent supplies it, so bulk actions can act on it. The
   * uncontrolled fallback keeps the component usable on its own — the dev harness renders it
   * with no parent at all.
   */
  readonly selected?: ReadonlySet<string>
  readonly onSelectedChange?: (next: ReadonlySet<string>) => void
  readonly onActivate?: (row: RegisterRow) => void
}

export function Register({
  rows,
  showAccount = false,
  onLoadMore,
  hasMore,
  selected: controlledSelected,
  onSelectedChange,
  onActivate,
}: RegisterProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [uncontrolled, setUncontrolled] = useState<ReadonlySet<string>>(new Set())
  const selected = controlledSelected ?? uncontrolled
  const setSelected = onSelectedChange ?? setUncontrolled
  const [focusedIndex, setFocusedIndex] = useState(0)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  const items = virtualizer.getVirtualItems()

  /**
   * A running balance, computed over the whole list rather than the visible window.
   *
   * It has to be: the balance shown against a row depends on every row after it, so deriving
   * it from what happens to be on screen would make the same row show different numbers
   * depending on scroll position.
   */
  const runningBalances = useMemo(() => {
    const out = new Array<bigint>(rows.length)
    let total = 0n
    for (let i = rows.length - 1; i >= 0; i--) {
      total += rows[i]?.amount ?? 0n
      out[i] = total
    }
    return out
  }, [rows])

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
    },
    [selected, setSelected],
  )

  /**
   * Keyboard traversal.
   *
   * §5 requires everything reachable by mouse to be reachable by keyboard. Power users live in
   * the register, and reaching for a mouse to move down one row is the difference between a
   * tool and a form.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const last = rows.length - 1
      const move = (to: number) => {
        const clamped = Math.max(0, Math.min(last, to))
        setFocusedIndex(clamped)
        virtualizer.scrollToIndex(clamped, { align: 'auto' })
        event.preventDefault()
      }
      switch (event.key) {
        case 'ArrowDown':
        case 'j':
          return move(focusedIndex + 1)
        case 'ArrowUp':
        case 'k':
          return move(focusedIndex - 1)
        case 'PageDown':
          return move(focusedIndex + 20)
        case 'PageUp':
          return move(focusedIndex - 20)
        case 'Home':
          return move(0)
        case 'End':
          return move(last)
        case ' ': {
          const row = rows[focusedIndex]
          if (row) {
            toggle(row.id)
            event.preventDefault()
          }
          return
        }
        case 'Enter': {
          const row = rows[focusedIndex]
          if (row && onActivate) {
            onActivate(row)
            event.preventDefault()
          }
          return
        }
        case 'Escape':
          if (selected.size > 0) {
            setSelected(new Set())
            event.preventDefault()
          }
          return
      }
    },
    [focusedIndex, rows, toggle, virtualizer, onActivate, selected, setSelected],
  )

  // Load the next page while the user is still a screenful away from the end, so scrolling
  // never visibly stalls at a page boundary.
  const lastItem = items.at(-1)
  if (hasMore && onLoadMore && lastItem && lastItem.index >= rows.length - OVERSCAN * 2) {
    queueMicrotask(onLoadMore)
  }

  return (
    <div className="flex h-full flex-col">
      {/*
       * ARIA grid roles on divs, not a `<table>`.
       *
       * Virtualisation is why: only a window of rows exists in the DOM and each is absolutely
       * positioned at a computed offset, which a table's own layout would fight. The roles carry
       * the structure a table element would have conveyed. The rows are not tab stops by design
       * — focus lives on the grid and the arrow keys move within it, per the ARIA grid pattern,
       * so a 50,000-row register does not become 50,000 tab stops.
       */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: see above — grid pattern, not tab stops */}
      {/* biome-ignore lint/a11y/useSemanticElements: see above — virtualised rows cannot be a table */}
      <div
        role="row"
        className="flex items-center gap-2 border-b bg-surface px-3 py-1.5 text-2xs font-medium uppercase tracking-wide text-ink-subtle"
      >
        <span className="w-6" />
        <span className="w-6" />
        <span className="w-24">Date</span>
        {showAccount && <span className="w-32">Account</span>}
        <span className="flex-1">Payee</span>
        <span className="flex-1">Category</span>
        <span className="flex-1">Memo</span>
        <span className="w-28 text-right">Amount</span>
        <span className="w-28 text-right">Balance</span>
        <span className="w-6" />
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: see above — virtualised rows cannot be a table */}
      <div
        ref={scrollRef}
        // The grid itself takes focus so the whole register is keyboard-operable without
        // tabbing through thousands of rows.
        tabIndex={0}
        role="grid"
        aria-rowcount={rows.length}
        aria-label="Transactions"
        onKeyDown={onKeyDown}
        className="flex-1 overflow-auto outline-none"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <Row
                key={row.id}
                row={row}
                balance={runningBalances[item.index] ?? 0n}
                showAccount={showAccount}
                selected={selected.has(row.id)}
                focused={item.index === focusedIndex}
                rowIndex={item.index}
                onToggle={toggle}
                {...(onActivate ? { onActivate } : {})}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
              />
            )
          })}
        </div>
      </div>

      <div className="border-t bg-surface px-3 py-1.5 text-2xs text-ink-subtle">
        {rows.length.toLocaleString()} {rows.length === 1 ? 'transaction' : 'transactions'}
        {selected.size > 0 && ` · ${selected.size} selected`}
      </div>
    </div>
  )
}

function Row({
  row,
  balance,
  showAccount,
  selected,
  focused,
  rowIndex,
  onToggle,
  onActivate,
  style,
}: {
  row: RegisterRow
  balance: bigint
  showAccount: boolean
  selected: boolean
  focused: boolean
  rowIndex: number
  onToggle: (id: string) => void
  onActivate?: (row: RegisterRow) => void
  style: React.CSSProperties
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus lives on the grid, not the row
    // biome-ignore lint/a11y/useSemanticElements: virtualised rows cannot be a table
    <div
      role="row"
      aria-rowindex={rowIndex + 1}
      aria-selected={selected}
      onDoubleClick={onActivate ? () => onActivate(row) : undefined}
      style={style}
      className={cn(
        'flex items-center gap-2 border-b border-hairline/60 px-3 text-sm',
        selected && 'bg-brand-wash',
        focused && 'ring-1 ring-inset ring-[var(--focus-ring)]',
        !selected && !focused && 'hover:bg-surface-sunken',
        // An unapproved row is muted rather than badged: it is the normal state of an imported
        // transaction, and a badge on every row of a fresh import is noise, not information.
        !row.approved && 'text-ink-muted italic',
      )}
    >
      <span className="w-6">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(row.id)}
          // Named by what distinguishes it from its neighbours — payee and date — rather than
          // by its direction, which every row in a register shares with half the others.
          aria-label={`Select ${row.payeeName ?? row.memo ?? 'transaction'} on ${row.date}`}
        />
      </span>
      <span className="w-6">
        <FlagMark color={row.flagColor} />
      </span>
      <span className="w-24 tabular text-ink-muted">{row.date}</span>
      {showAccount && <span className="w-32 truncate text-ink-muted">{row.accountName}</span>}
      <span className="flex flex-1 items-center gap-1 truncate">
        {row.transferAccountId && (
          <ArrowLeftRight className="size-3 shrink-0 text-ink-subtle" aria-label="Transfer" />
        )}
        {row.payeeName ?? <span className="text-ink-subtle">—</span>}
      </span>
      <span className="flex flex-1 items-center gap-1 truncate">
        {row.isSplit ? (
          <>
            <Split className="size-3 shrink-0 text-ink-subtle" aria-hidden />
            <span className="text-ink-muted">Split</span>
          </>
        ) : (
          (row.categoryName ?? <span className="text-ink-subtle">—</span>)
        )}
      </span>
      <span className="flex-1 truncate text-ink-subtle">{row.memo}</span>
      <span className="w-28 text-right">
        <Money amount={row.amount} tone={toneFor(row.amount)} />
      </span>
      <span className="w-28 text-right">
        <Money amount={balance} tone="neutral" />
      </span>
      <span className="w-6">
        <ClearedIndicator status={row.cleared} />
      </span>
    </div>
  )
}
