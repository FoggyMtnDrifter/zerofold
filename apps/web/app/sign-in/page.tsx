import { instanceIsEmpty } from '@zerofold/commands'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { currentUser } from '@/lib/session'
import { SignInForm } from './form'

/**
 * Reads the database to decide what to show, so it cannot be prerendered — at build time
 * there is no database yet. Every page that touches data is dynamic for the same reason.
 */
export const dynamic = 'force-dynamic'

export default async function SignInPage() {
  if (await currentUser()) redirect('/')
  // An empty instance has nobody to sign in as, so send the first visitor to setup rather
  // than showing them a form that cannot succeed.
  if (instanceIsEmpty(db)) redirect('/setup')
  return <SignInForm />
}
