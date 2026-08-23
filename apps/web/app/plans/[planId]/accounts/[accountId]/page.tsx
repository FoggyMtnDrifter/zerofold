import { accountTotals, authorizePlan, listTransactions } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { and, eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { Money } from '@/components/money'
import { Register } from '@/components/register/register'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** The first page only. Later pages are fetched client-side as the user scrolls. */
const FIRST_PAGE = 150

export default async function AccountRegister({
  params,
}: {
  params: Promise<{ planId: string; accountId: string }>
}) {
  const { planId, accountId } = await params
  const user = await requireUser()
  try {
    authorizePlan(db, planId, user.id)
  } catch {
    notFound()
  }

  const account = db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, accountId), eq(schema.account.planId, planId)))
    .get()
  if (!account || account.deleted) notFound()

  const { rows } = listTransactions(db, { planId, accountId, limit: FIRST_PAGE })
  const totals = accountTotals(db, planId, accountId)

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">{account.name}</h1>
        <div className="mt-1 flex items-center gap-4 text-xs text-ink-muted">
          <span>
            Cleared <Money amount={totals?.clearedBalance ?? 0n} tone="neutral" />
          </span>
          <span aria-hidden>+</span>
          <span>
            Uncleared <Money amount={totals?.unclearedBalance ?? 0n} tone="neutral" />
          </span>
          <span aria-hidden>=</span>
          <span className="font-medium text-ink">
            Working <Money amount={totals?.balance ?? 0n} />
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Register rows={rows} />
      </div>
    </div>
  )
}
