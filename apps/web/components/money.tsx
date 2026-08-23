import { cn } from '@/lib/utils'

/**
 * Format milliunits for display.
 *
 * The **only** place money becomes a string (ADR-0004). Everything upstream is an integer
 * count of milliunits; formatting happens here, at the boundary, once.
 */
export function formatMoney(
  milliunits: bigint,
  options: { readonly currency?: string; readonly locale?: string; readonly signed?: boolean } = {},
): string {
  const { currency = 'USD', locale = 'en-US', signed = false } = options
  // Divide by exactly 1000 in integer space, then hand the formatter a number that is already
  // at cent precision, so no rounding decision is delegated to Intl.
  const whole = milliunits / 1000n
  const remainder = milliunits % 1000n
  const asNumber = Number(whole) + Number(remainder) / 1000

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(asNumber)
}

export type MoneyTone = 'positive' | 'negative' | 'underfunded' | 'neutral'

/**
 * Decide what a balance *means*, so the colour can be driven by meaning rather than sign.
 *
 * `overspendKind` matters because the two overspends are different situations. Cash
 * overspending is money that left the budget and will be taken out of next month's Ready to
 * Assign (R10); credit overspending is debt that grew, costs nothing yet, and is settled later
 * (R61). Showing both in the same alarming red would misrepresent one of them.
 */
export function toneFor(
  amount: bigint,
  overspendKind: 'none' | 'cash' | 'credit' = 'none',
): MoneyTone {
  if (amount > 0n) return 'positive'
  if (amount === 0n) return 'neutral'
  return overspendKind === 'credit' ? 'underfunded' : 'negative'
}

const TONE_CLASS: Record<MoneyTone, string> = {
  positive: 'text-positive',
  negative: 'text-negative',
  underfunded: 'text-underfunded',
  neutral: 'text-neutral-money',
}

export function Money({
  amount,
  tone,
  currency,
  className,
}: {
  amount: bigint
  tone?: MoneyTone
  currency?: string
  className?: string
}) {
  const resolved = tone ?? toneFor(amount)
  return (
    // No aria-label: the visible text is already the formatted amount, and a label that
    // duplicates the content makes a screen reader announce it twice.
    <span className={cn('tabular', TONE_CLASS[resolved], className)}>
      {formatMoney(amount, currency ? { currency } : {})}
    </span>
  )
}
