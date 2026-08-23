import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

/**
 * Moving between months.
 *
 * Links rather than buttons, because a month is a place: it should be shareable, bookmarkable
 * and reachable with the back button. The ends are disabled rather than hidden — a plan has a
 * first month, and a control that vanishes is harder to understand than one that will not move.
 */
export function MonthNav({
  planId,
  month,
  months,
}: {
  planId: string
  month: string
  months: readonly string[]
}) {
  const index = months.indexOf(month)
  const previous = index > 0 ? months[index - 1] : undefined
  const next = index >= 0 && index < months.length - 1 ? months[index + 1] : undefined

  return (
    <div className="flex items-center gap-1">
      <Step planId={planId} month={previous} label="Previous month">
        <ChevronLeft className="size-4" aria-hidden />
      </Step>
      <h1 className="min-w-44 text-center text-base font-semibold">{formatMonth(month)}</h1>
      <Step planId={planId} month={next} label="Next month">
        <ChevronRight className="size-4" aria-hidden />
      </Step>
    </div>
  )
}

function Step({
  planId,
  month,
  label,
  children,
}: {
  planId: string
  month: string | undefined
  label: string
  children: React.ReactNode
}) {
  if (!month) {
    return (
      <Button variant="ghost" size="icon" className="size-8" disabled aria-label={label}>
        {children}
      </Button>
    )
  }
  return (
    <Button variant="ghost" size="icon" className="size-8" asChild>
      <Link href={`/plans/${planId}?month=${month}`} aria-label={label}>
        {children}
      </Link>
    </Button>
  )
}

/**
 * "August 2026".
 *
 * Built from the string rather than a `Date`: the month is a calendar fact, and constructing a
 * `Date` from it would reintroduce the timezone question the whole date layer exists to avoid
 * (ADR-0005). The month names are a lookup for the same reason.
 */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export function formatMonth(month: string): string {
  const year = month.slice(0, 4)
  const index = Number(month.slice(5, 7)) - 1
  return `${MONTH_NAMES[index] ?? month.slice(5, 7)} ${year}`
}
