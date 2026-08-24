import { authorizePlan } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { and, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ImportFlow } from '@/components/import/import-flow'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function ImportPage({
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

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Import into {account.name}</h1>
        <p className="mt-1 text-xs text-ink-muted">
          Nothing is written until you say so.{' '}
          <Link
            href={`/plans/${planId}/accounts/${accountId}`}
            className="underline underline-offset-2"
          >
            Back to the register
          </Link>
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <ImportFlow planId={planId} accountId={accountId} />
      </div>
    </div>
  )
}
