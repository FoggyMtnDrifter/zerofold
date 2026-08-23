import { authorizePlan, budgetView } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { budgetMonth } from '@zerofold/shared/date'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { BudgetGrid } from '@/components/budget/budget-grid'
import { MonthNav } from '@/components/budget/month-nav'
import { ReadyToAssign } from '@/components/budget/ready-to-assign'
import { Money } from '@/components/money'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

export default async function PlanBudget({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { planId } = await params
  const { month: requested } = await searchParams
  const user = await requireUser()
  try {
    authorizePlan(db, planId, user.id)
  } catch {
    notFound()
  }

  const plan = db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
  if (!plan) notFound()

  const today = todayIn(plan.timezone)
  const currentMonth = budgetMonth(`${today.slice(0, 7)}-01`)

  /*
   * An unparseable or unmaterialised month falls back to this one rather than erroring.
   * A URL is a thing people edit and share, and the failure mode of a bad `?month=` should be
   * "you are looking at August" rather than a page that will not load.
   */
  let view: ReturnType<typeof budgetView>
  try {
    view = budgetView(db, planId, requested ? budgetMonth(requested) : currentMonth, currentMonth)
  } catch {
    view = budgetView(db, planId, currentMonth, currentMonth)
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-4 py-3">
        <MonthNav planId={planId} month={view.month} months={view.months} />
        <ReadyToAssign amount={view.readyToAssign} />
        <dl className="flex items-center gap-4 text-xs text-ink-muted">
          <div>
            <dt className="text-2xs uppercase tracking-wide">Income</dt>
            <dd>
              <Money amount={view.income} tone="neutral" />
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide">Assigned</dt>
            <dd>
              <Money amount={view.budgeted} tone="neutral" />
            </dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide">Activity</dt>
            <dd>
              <Money amount={view.activity} tone="neutral" />
            </dd>
          </div>
        </dl>
      </header>

      <div className="min-h-0 flex-1">
        <BudgetGrid planId={planId} view={view} />
      </div>
    </div>
  )
}
