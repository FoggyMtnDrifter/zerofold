import { schema } from '@zerofold/db'
import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { NewPlanForm } from './new-plan-form'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const user = await requireUser()

  const plans = db
    .select({ id: schema.plan.id, name: schema.plan.name })
    .from(schema.plan)
    .innerJoin(schema.planMembership, eq(schema.planMembership.planId, schema.plan.id))
    .where(and(eq(schema.planMembership.userId, user.id), eq(schema.plan.deleted, false)))
    .all()

  const first = plans[0]
  if (first) redirect(`/plans/${first.id}`)
  return <NewPlanForm />
}
