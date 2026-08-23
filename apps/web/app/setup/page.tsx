import { instanceIsEmpty } from '@zerofold/commands'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { SetupForm } from './form'

/**
 * Reads the database to decide what to show, so it cannot be prerendered — at build time
 * there is no database yet. Every page that touches data is dynamic for the same reason.
 */
export const dynamic = 'force-dynamic'

export default function SetupPage() {
  // Once an instance has a user, setup is over. Leaving this reachable would be an open
  // registration endpoint on an instance configured as invite-only.
  if (!instanceIsEmpty(db)) redirect('/sign-in')
  return <SetupForm />
}
