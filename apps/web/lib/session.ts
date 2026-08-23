import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './auth.ts'

/**
 * The signed-in user, or a redirect to sign in.
 *
 * Every authenticated page goes through this rather than checking a session itself, for the
 * same reason `authorizePlan` is a single choke point: a check repeated in twenty places is a
 * check missing from one of them.
 */
export async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect('/sign-in')
  return session.user
}

export async function currentUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ?? null
}
