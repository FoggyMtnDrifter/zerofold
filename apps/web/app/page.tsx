import { AppShell, type SidebarAccount } from '@/components/app-shell'
import { Money } from '@/components/money'
import { Badge } from '@/components/ui/badge'

/**
 * A static preview of the shell.
 *
 * Real data arrives in M3 with the budget view. Until then this exists so the token system,
 * the density and both themes can be looked at rather than reasoned about.
 */
const DEMO: SidebarAccount[] = [
  { id: '1', name: 'Everyday', balance: 1_284_500n, onBudget: true, type: 'checking' },
  { id: '2', name: 'Savings', balance: 8_400_000n, onBudget: true, type: 'savings' },
  { id: '3', name: 'Visa', balance: -342_000n, onBudget: true, type: 'creditCard' },
  { id: '4', name: 'Mortgage', balance: -248_500_000n, onBudget: false, type: 'mortgage' },
]

const ROWS = [
  { name: 'Housing', assigned: 1_450_000n, activity: -1_450_000n, available: 0n, kind: 'none' },
  { name: 'Groceries', assigned: 600_000n, activity: -412_300n, available: 187_700n, kind: 'none' },
  {
    name: 'Eating Out',
    assigned: 150_000n,
    activity: -190_000n,
    available: -40_000n,
    kind: 'cash',
  },
  { name: 'Hobbies', assigned: 80_000n, activity: -125_000n, available: -45_000n, kind: 'credit' },
  { name: 'Emergency Fund', assigned: 500_000n, activity: 0n, available: 3_250_000n, kind: 'none' },
] as const

export default function Home() {
  return (
    <AppShell accounts={DEMO} planName="Household">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">August 2026</h1>
          <p className="text-xs text-ink-subtle">Pre-alpha preview — not yet wired to data</p>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-positive-wash px-3 py-1.5">
          <Money amount={412_500n} tone="positive" className="text-base font-semibold" />
          <span className="text-xs text-ink-muted">Ready to Assign</span>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-2xs uppercase tracking-wide text-ink-subtle">
            <th scope="col" className="px-6 py-2 text-left font-medium">
              Category
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Assigned
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Activity
            </th>
            <th scope="col" className="px-6 py-2 text-right font-medium">
              Available
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.name} className="h-8 border-b border-hairline/60 hover:bg-surface-sunken">
              <td className="px-6">{row.name}</td>
              <td className="px-3 text-right">
                <Money amount={row.assigned} tone="neutral" />
              </td>
              <td className="px-3 text-right">
                <Money amount={row.activity} tone="neutral" />
              </td>
              <td className="px-6 text-right">
                <Money
                  amount={row.available}
                  tone={
                    row.available > 0n
                      ? 'positive'
                      : row.available === 0n
                        ? 'neutral'
                        : row.kind === 'credit'
                          ? 'underfunded'
                          : 'negative'
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2 px-6 py-4 text-xs text-ink-subtle">
        <span>Overspending is not one thing:</span>
        <Badge variant="outline" className="text-negative">
          cash — billed to next month
        </Badge>
        <Badge variant="outline" className="text-underfunded">
          credit — debt, settled later
        </Badge>
      </div>
    </AppShell>
  )
}
