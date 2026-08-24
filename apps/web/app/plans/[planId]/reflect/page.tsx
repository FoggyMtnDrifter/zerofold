import { authorizePlan, incomeReport, netWorthReport, spendingReport } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { addMonths, budgetMonth } from '@zerofold/shared/date'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { formatMonth } from '@/components/budget/month-nav'
import { Money } from '@/components/money'
import { Bars } from '@/components/reports/bars'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

/** Twelve months back, which is the span that makes a seasonal bill visible. */
const WINDOW_MONTHS = 11

export default async function ReflectPage({ params }: { params: Promise<{ planId: string }> }) {
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
  const through = budgetMonth(`${today.slice(0, 7)}-01`)
  const period = { from: addMonths(through, -WINDOW_MONTHS), through }

  const spending = spendingReport(db, planId, period)
  const income = incomeReport(db, planId, period)
  const netWorth = netWorthReport(db, planId, period)

  const latest = netWorth.at(-1)

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Reflect</h1>
        <p className="mt-1 text-xs text-ink-muted">
          {formatMonth(period.from)} to {formatMonth(period.through)}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="text-sm font-medium">Where the money went</h2>
            {spending.byCategory.length === 0 ? (
              <p className="mt-2 text-sm text-ink-subtle">Nothing spent in this period.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {spending.byCategory.slice(0, 12).map((category) => (
                  <li key={category.categoryId} className="flex items-center gap-3 text-sm">
                    <span
                      className="w-40 truncate"
                      title={`${category.groupName} · ${category.name}`}
                    >
                      {category.name}
                    </span>
                    <Bars
                      value={Number(-category.amount)}
                      max={Number(-(spending.byCategory[0]?.amount ?? -1n))}
                    />
                    <Money amount={category.amount} className="w-24 text-right" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-sm font-medium">Earned against spent</h2>
            <ul className="mt-3 space-y-1.5">
              {income.byMonth.map((month) => (
                <li key={month.month} className="flex items-center gap-3 text-sm">
                  <span className="w-28 text-ink-muted">{formatMonth(month.month)}</span>
                  <Money amount={month.income} className="w-24 text-right" tone="positive" />
                  <Money amount={month.spending} className="w-24 text-right" />
                  <Money amount={month.net} className="w-24 text-right" />
                </li>
              ))}
            </ul>
          </section>

          <section className="lg:col-span-2">
            <h2 className="text-sm font-medium">What you are worth</h2>
            {latest && (
              <p className="mt-1 text-sm">
                <Money amount={latest.net} className="text-lg font-semibold" /> as of{' '}
                {formatMonth(latest.month)}
              </p>
            )}
            <ul className="mt-3 space-y-1">
              {netWorth.map((point) => (
                <li key={point.month} className="flex items-center gap-3 text-xs">
                  <span className="w-28 text-ink-muted">{formatMonth(point.month)}</span>
                  <Money amount={point.assets} className="w-28 text-right" tone="positive" />
                  <Money amount={point.liabilities} className="w-28 text-right" />
                  <Money amount={point.net} className="w-28 text-right" />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
