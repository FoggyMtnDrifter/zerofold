import { authorizePlan, listUpcoming, makeContext } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { addDays } from '@zerofold/shared/date'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { Money } from '@/components/money'
import { catchUp } from '@/lib/catch-up'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

/** Far enough to plan a month around, near enough that the list stays readable. */
const HORIZON_DAYS = 35

export default async function ScheduledPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params
  const user = await requireUser()
  try {
    authorizePlan(db, planId, user.id)
  } catch {
    notFound()
  }

  const plan = db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
  if (!plan) notFound()

  const today = todayIn(plan.timezone)
  const ctx = makeContext(db, user.id, today)
  catchUp(ctx, planId)
  const upcoming = listUpcoming(ctx, planId, addDays(today, HORIZON_DAYS))

  const names = new Map(
    db
      .select({ id: schema.payee.id, name: schema.payee.name })
      .from(schema.payee)
      .where(eq(schema.payee.planId, planId))
      .all()
      .map((p) => [p.id, p.name]),
  )
  const accounts = new Map(
    db
      .select({ id: schema.account.id, name: schema.account.name })
      .from(schema.account)
      .where(eq(schema.account.planId, planId))
      .all()
      .map((a) => [a.id, a.name]),
  )

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Upcoming</h1>
        <p className="mt-1 text-xs text-ink-muted">
          The next {HORIZON_DAYS} days. Nothing here has happened yet — a scheduled transaction
          changes no balance and no budget until the day it is entered.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {upcoming.length === 0 ? (
          <p className="px-6 py-8 text-sm text-ink-subtle">
            Nothing scheduled in the next {HORIZON_DAYS} days.
          </p>
        ) : (
          <ul className="divide-y divide-hairline/60">
            {upcoming.map((occurrence) => (
              <li
                key={`${occurrence.scheduledTransactionId}-${occurrence.date}`}
                className="flex items-center gap-4 px-6 py-2 text-sm"
              >
                <span className="w-28 tabular-nums text-ink-muted">{occurrence.date}</span>
                <span className="flex-1 truncate">
                  {occurrence.payeeId ? names.get(occurrence.payeeId) : (occurrence.memo ?? '—')}
                </span>
                <span className="w-40 truncate text-xs text-ink-subtle">
                  {accounts.get(occurrence.accountId)}
                </span>
                <span className="w-24 text-xs text-ink-subtle">{occurrence.frequency}</span>
                <Money amount={occurrence.amount} className="w-28 text-right" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
