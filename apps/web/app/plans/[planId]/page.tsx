import { AddAccountForm } from './add-account-form'

export default async function PlanHome({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">Plan</h1>
      <p className="mt-1 text-xs text-ink-subtle">
        The budget view arrives in M3. Until then, add accounts and record transactions.
      </p>
      <div className="mt-6 max-w-md">
        <AddAccountForm planId={planId} />
      </div>
    </div>
  )
}
