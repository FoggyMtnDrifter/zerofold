import { Check, CircleDashed, Lock } from 'lucide-react'
import type { ClearedStatus } from './types'

const STATES = {
  uncleared: {
    Icon: CircleDashed,
    className: 'text-uncleared',
    label: 'Uncleared — your bank has not seen this yet',
  },
  cleared: {
    Icon: Check,
    className: 'text-cleared',
    label: 'Cleared — your bank has this transaction',
  },
  reconciled: {
    Icon: Lock,
    className: 'text-reconciled',
    label: 'Reconciled — matched against a statement and locked',
  },
} as const

/**
 * The cleared state, as an icon with a real label.
 *
 * Three states rather than a checkbox, because they are three genuinely different claims:
 * *I have recorded this*, *my bank agrees*, and *this was matched against a statement and is
 * now locked* (R56, R71). A two-state control would have to conflate two of them.
 *
 * Shape carries the meaning as well as colour, so the distinction survives a colour-vision
 * difference and a monochrome print.
 */
export function ClearedIndicator({ status }: { status: ClearedStatus }) {
  const { Icon, className, label } = STATES[status]
  return (
    <span title={label} aria-label={label} className={className}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  )
}
