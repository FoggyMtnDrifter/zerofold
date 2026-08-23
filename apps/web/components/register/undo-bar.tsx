'use client'

import { Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { rpc } from '@/lib/rpc'

export interface UndoState {
  readonly undo: { readonly label: string } | null
  readonly redo: { readonly label: string } | null
}

/**
 * Undo and redo for the current plan.
 *
 * The state arrives as a prop from the server rather than being fetched here. The server is what
 * knows what the last change was — including one made in another tab — and rendering it with the
 * page means `router.refresh()` updates the control for free, with no second request and no
 * window where the register and the control disagree about what just happened.
 */
export function UndoBar({
  planId,
  state,
  onChanged,
}: {
  planId: string
  state: UndoState
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const walk = useCallback(
    async (direction: 'undo.perform' | 'undo.redo') => {
      setError(null)
      setBusy(true)
      const result = await rpc(direction, { planId })
      setBusy(false)
      if ('error' in result) {
        setError(result.error.message)
        return
      }
      onChanged()
    },
    [planId, onChanged],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return

      // Let the browser's own undo handle text the user is in the middle of typing. Stealing
      // Ctrl-Z from a half-written memo to delete a transaction would be a genuinely bad trade.
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) {
        return
      }

      event.preventDefault()
      void walk(event.shiftKey ? 'undo.redo' : 'undo.perform')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [walk])

  // Nothing to offer and nothing to say: the bar stays out of the way rather than sitting there
  // permanently greyed out.
  if (!state.undo && !state.redo && !error) return null

  return (
    <div className="flex items-center gap-2 border-b bg-surface px-3 py-1 text-xs">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-1.5"
        disabled={!state.undo || busy}
        onClick={() => walk('undo.perform')}
      >
        <Undo2 className="size-3.5" aria-hidden />
        {state.undo ? `Undo ${state.undo.label.toLowerCase()}` : 'Undo'}
      </Button>
      {state.redo && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1.5"
          disabled={busy}
          onClick={() => walk('undo.redo')}
        >
          <Redo2 className="size-3.5" aria-hidden />
          Redo {state.redo.label.toLowerCase()}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-negative">
          {error}
        </span>
      )}
    </div>
  )
}
