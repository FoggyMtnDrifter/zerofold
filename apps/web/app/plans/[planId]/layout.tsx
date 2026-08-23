import { authorizePlan, listOpenAccounts, makeContext } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

export default async function PlanLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ planId: string }>
}) {
  const { planId } = await params
  const user = await requireUser()

  // The same choke point the RPC layer uses. A page that queried the plan directly and only
  // then checked access would have already leaked its existence through timing.
  try {
    authorizePlan(db, planId, user.id)
  } catch {
    notFound()
  }

  const plan = db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
  if (!plan) notFound()

  const ctx = makeContext(db, user.id, todayIn(plan.timezone))
  const accounts = listOpenAccounts(ctx, planId).map((a) => ({
    id: a.id,
    name: a.name,
    balance: a.balance,
    onBudget: a.onBudget,
    type: a.type,
    planId,
  }))

  return (
    <AppShell accounts={accounts} planName={plan.name}>
      {children}
    </AppShell>
  )
}
