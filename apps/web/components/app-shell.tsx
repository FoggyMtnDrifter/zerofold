import { CalendarClock, Landmark, PieChart, Wallet } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AddAccountDialog } from '@/components/add-account-dialog'
import { Money } from '@/components/money'
import { ThemeToggle } from '@/components/theme-toggle'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export interface SidebarAccount {
  readonly id: string
  readonly name: string
  readonly balance: bigint
  readonly onBudget: boolean
  readonly type: string
  /** Present once the account has a register to link to. */
  readonly planId?: string
}

const GROUPS = [
  { key: 'cash', label: 'Cash', types: ['checking', 'savings', 'cash'] },
  { key: 'credit', label: 'Credit', types: ['creditCard', 'lineOfCredit'] },
] as const

/**
 * The application shell.
 *
 * Hairline rules rather than card borders: at register density, a card edge every few pixels
 * reads as noise. Cards are reserved for settings and reports, where the content is sparse
 * enough to earn them.
 */
export function AppShell({
  accounts,
  planName,
  planId,
  children,
}: {
  accounts: readonly SidebarAccount[]
  planName: string
  planId: string
  children: ReactNode
}) {
  const tracking = accounts.filter((a) => !a.onBudget)
  const grouped = GROUPS.map((g) => ({
    ...g,
    accounts: accounts.filter((a) => g.types.includes(a.type as never)),
  })).filter((g) => g.accounts.length > 0)

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{planName}</div>
            <div className="truncate text-2xs text-ink-subtle">Zerofold</div>
          </div>
          <ThemeToggle />
        </div>

        <Separator />

        <nav className="flex flex-col gap-0.5 p-2" aria-label="Main">
          <NavLink icon={<Wallet className="size-4" />} label="Plan" href={`/plans/${planId}`} />
          <NavLink
            icon={<CalendarClock className="size-4" />}
            label="Upcoming"
            href={`/plans/${planId}/scheduled`}
          />
          <NavLink icon={<PieChart className="size-4" />} label="Reflect" />
          <NavLink icon={<Landmark className="size-4" />} label="All Accounts" />
        </nav>

        <Separator />

        <ScrollArea className="flex-1">
          <div className="p-2">
            {grouped.map((group) => (
              <AccountGroup key={group.key} label={group.label} accounts={group.accounts} />
            ))}
            {tracking.length > 0 && <AccountGroup label="Tracking" accounts={tracking} />}
            {accounts.length === 0 && (
              <p className="px-2 pt-4 text-xs text-ink-subtle">
                No accounts yet. Add one to start budgeting.
              </p>
            )}
            {planId && (
              <div className="mt-2 px-1">
                <AddAccountDialog planId={planId} />
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}

/**
 * A real link where there is somewhere to go, a button where there is not yet.
 *
 * An anchor with `href="#"` lies: it breaks middle-click, offers a meaningless target to a
 * screen reader, and becomes a real bug the day someone assumes it navigates. Destinations
 * become links as their routes land — Plan did, with the budget view.
 */
function NavLink({
  icon,
  label,
  href,
  current = false,
}: {
  icon: ReactNode
  label: string
  href?: string
  current?: boolean
}) {
  const className = cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
    current
      ? 'bg-brand text-brand-contrast'
      : 'text-ink-muted hover:bg-sidebar-accent hover:text-ink',
  )

  if (!href) {
    return (
      <button type="button" className={className}>
        {icon}
        {label}
      </button>
    )
  }

  return (
    <Link href={href} aria-current={current ? 'page' : undefined} className={className}>
      {icon}
      {label}
    </Link>
  )
}

/**
 * A real link when there is somewhere to go, a button otherwise.
 *
 * An anchor whose href goes nowhere breaks middle-click, offers a meaningless target to a
 * screen reader, and silently becomes a bug the day someone assumes it navigates — so the
 * element follows the capability rather than the appearance.
 */
function AccountLink({ account }: { account: SidebarAccount }) {
  const className =
    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-ink'
  const content = (
    <>
      <span className="truncate">{account.name}</span>
      <Money amount={account.balance} className="shrink-0 text-xs" />
    </>
  )
  if (!account.planId) {
    return (
      <button type="button" className={className}>
        {content}
      </button>
    )
  }
  return (
    <Link href={`/plans/${account.planId}/accounts/${account.id}`} className={className}>
      {content}
    </Link>
  )
}

function AccountGroup({ label, accounts }: { label: string; accounts: readonly SidebarAccount[] }) {
  const total = accounts.reduce((sum, a) => sum + a.balance, 0n)
  return (
    <section className="mb-3">
      <header className="flex items-baseline justify-between px-2 py-1">
        <h2 className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">{label}</h2>
        <Money amount={total} className="text-2xs" />
      </header>
      <ul>
        {accounts.map((account) => (
          <li key={account.id}>
            <AccountLink account={account} />
          </li>
        ))}
      </ul>
    </section>
  )
}
