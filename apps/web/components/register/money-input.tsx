'use client'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Currency units in, milliunits out. The conversion happens once, at the boundary. */
export function toMilliunits(input: string): bigint {
  const cleaned = input.replace(/[^0-9.-]/g, '').trim()
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0n
  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  // Pad rather than round: "1.5" is 1500 milliunits, and truncating past three digits is the
  // only lossy step, which is deliberate — a fourth decimal of a currency unit is not money.
  const milli = BigInt(whole || '0') * 1000n + BigInt((fraction.padEnd(3, '0') || '0').slice(0, 3))
  return negative ? -milli : milli
}

export function fromMilliunits(value: bigint): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 1000n
  const cents = (abs % 1000n) / 10n
  return `${negative ? '-' : ''}${whole}.${cents.toString().padStart(2, '0')}`
}

/**
 * Amount entry.
 *
 * `inputMode="decimal"` gets the numeric keypad on a phone without rejecting a pasted "1,234.56"
 * the way `type="number"` would. Right-aligned and tabular so a column of figures lines up
 * while it is being typed, not only once saved.
 */
export function MoneyInput({
  defaultValue,
  name,
  className,
  ...props
}: React.ComponentProps<typeof Input> & { defaultValue?: string }) {
  return (
    <Input
      {...props}
      name={name}
      defaultValue={defaultValue}
      inputMode="decimal"
      className={cn('tabular h-8 text-right', className)}
    />
  )
}
