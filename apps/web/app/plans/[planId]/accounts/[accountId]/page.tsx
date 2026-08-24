import {
  accountTotals,
  authorizePlan,
  listTransactions,
  makeContext,
  undoState,
} from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { and, eq, isNull, or } from 'drizzle-orm'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Money } from '@/components/money'
import type { PickerOption } from '@/components/register/picker'
import { ReconcileDialog } from '@/components/register/reconcile-dialog'
import { RegisterView } from '@/components/register/register-view'
import { Button } from '@/components/ui/button'
import { catchUp } from '@/lib/catch-up'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

/** The first page only. Later pages load as the user scrolls. */
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

  const plan = db.select().from(schema.plan).where(eq(schema.plan.id, planId)).get()
  const account = db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, accountId), eq(schema.account.planId, planId)))
    .get()
  if (!plan || !account || account.deleted) notFound()

  /*
   * Before the read, deliberately: a schedule that has come due must appear in the register it
   * was entered into, on the load that entered it.
   */
  catchUp(makeContext(db, user.id, todayIn(plan.timezone)), planId)

  const { rows } = listTransactions(db, { planId, accountId, limit: FIRST_PAGE })
  const totals = accountTotals(db, planId, accountId)
  const undo = undoState(makeContext(db, user.id, todayIn(plan.timezone)), planId)

  /**
   * Payees, with transfer payees grouped separately.
   *
   * A transfer payee is how a transfer is expressed (selecting one *is* the instruction), so
   * it belongs in the same picker — but under its own heading, because "move money to savings"
   * and "pay the electricity company" are different intents that happen to share a control.
   */
  const payees: PickerOption[] = db
    .select({
      id: schema.payee.id,
      label: schema.payee.name,
      transferAccountId: schema.payee.transferAccountId,
    })
    .from(schema.payee)
    .where(and(eq(schema.payee.planId, planId), eq(schema.payee.deleted, false)))
    .orderBy(schema.payee.name)
    .all()
    .filter((p) => p.transferAccountId !== accountId) // an account cannot transfer to itself
    .map((p) => ({
      id: p.id,
      label: p.label,
      ...(p.transferAccountId ? { group: 'Transfer to' } : { group: 'Payees' }),
    }))

  const categories: PickerOption[] = db
    .select({
      id: schema.category.id,
      label: schema.category.name,
      group: schema.categoryGroup.name,
      internalKind: schema.category.internalKind,
    })
    .from(schema.category)
    .innerJoin(schema.categoryGroup, eq(schema.categoryGroup.id, schema.category.categoryGroupId))
    .where(
      and(
        eq(schema.category.planId, planId),
        eq(schema.category.deleted, false),
        eq(schema.category.hidden, false),
        // Inflow is selectable — income has to go somewhere. Uncategorized and credit-card
        // payment categories are not: the first is an absence, and the second is maintained by
        // the engine rather than chosen (R38, R60').
        or(isNull(schema.category.internalKind), eq(schema.category.internalKind, 'inflow_rta')),
      ),
    )
    .orderBy(schema.categoryGroup.sortOrder, schema.category.sortOrder)
    .all()
    .map(({ id, label, group }) => ({ id, label, group }))

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-start justify-between border-b px-6 py-3">
        <div>
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
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/plans/${planId}/accounts/${accountId}/import`}>Import</Link>
        </Button>
        <ReconcileDialog
          planId={planId}
          accountId={accountId}
          clearedBalance={totals?.clearedBalance ?? 0n}
          unclearedBalance={totals?.unclearedBalance ?? 0n}
        />
      </header>
      <div className="min-h-0 flex-1">
        <RegisterView
          planId={planId}
          accountId={accountId}
          today={todayIn(plan.timezone)}
          rows={rows}
          payees={payees}
          categories={categories}
          undo={undo}
        />
      </div>
    </div>
  )
}
