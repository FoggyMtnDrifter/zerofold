import { Money } from '@/components/money'
import { cn } from '@/lib/utils'

/**
 * The number the whole method is about.
 *
 * Three states, and they are not decoration: zero is the goal, positive means there is work to
 * do, and negative means the budget is describing money that does not exist. Colour alone does
 * not carry that — each state says what it means in words, because a red number tells someone
 * something is wrong without telling them what.
 */
export function ReadyToAssign({ amount }: { amount: bigint }) {
  const state = amount === 0n ? 'balanced' : amount > 0n ? 'unassigned' : 'over'

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset implies a form; this is a readout
    <div
      role="group"
      aria-label="Ready to assign"
      className={cn(
        'flex items-baseline gap-3 rounded-lg border px-4 py-2.5',
        state === 'balanced' && 'border-positive/30 bg-positive-wash',
        state === 'unassigned' && 'border-brand/30 bg-brand-wash',
        state === 'over' && 'border-negative/40 bg-negative-wash',
      )}
    >
      <Money
        amount={amount}
        className="text-xl font-semibold tabular-nums"
        {...(state === 'balanced' ? { tone: 'neutral' as const } : {})}
      />
      <div className="text-xs leading-tight">
        <div className="font-medium">Ready to assign</div>
        <div className="text-ink-muted">
          {state === 'balanced' && 'Every dollar has a job.'}
          {state === 'unassigned' && 'Give this a job before you spend it.'}
          {state === 'over' && 'You have assigned more than you have.'}
        </div>
      </div>
    </div>
  )
}
