import { Flag } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlagColor } from './types'

const FLAG_CLASS: Record<FlagColor, string> = {
  red: 'text-flag-red',
  orange: 'text-flag-orange',
  yellow: 'text-flag-yellow',
  green: 'text-flag-green',
  blue: 'text-flag-blue',
  purple: 'text-flag-purple',
}

/**
 * A flag is user-assigned meaning, so the label says the colour rather than inventing an
 * interpretation. Only the user knows whether their red means "dispute this" or "tax".
 */
export function FlagMark({ color }: { color: FlagColor | null }) {
  if (!color) return <span className="inline-block size-3.5" aria-hidden />
  return (
    <span aria-label={`${color} flag`} title={`${color} flag`}>
      <Flag className={cn('size-3.5 fill-current', FLAG_CLASS[color])} aria-hidden />
    </span>
  )
}
