import {
  CommandError,
  isProcedureName,
  NotAuthorizedError,
  PlanNotFoundError,
  runProcedure,
} from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { ZodError } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { todayIn } from '@/lib/today'

export const dynamic = 'force-dynamic'

/** bigint has no JSON representation; milliunits travel as strings, never as lossy numbers. */
const serialise = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))

const json = (body: unknown, status: number): Response =>
  new Response(serialise(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ procedure: string }> },
): Promise<Response> {
  const { procedure } = await params
  if (!isProcedureName(procedure)) {
    return json({ error: { code: 'rpc.unknown_procedure', message: 'Unknown procedure.' } }, 404)
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return json({ error: { code: 'auth.required', message: 'Sign in to continue.' } }, 401)
  }

  let rawInput: unknown
  try {
    rawInput = await request.json()
  } catch {
    return json({ error: { code: 'rpc.bad_json', message: 'Body must be JSON.' } }, 400)
  }

  /**
   * Resolve "today" from the plan's timezone, before the procedure runs.
   *
   * Not the server's locale and not UTC. A plan in Auckland rolls over hours before one in
   * Los Angeles, and a transaction entered either side of that boundary belongs to a different
   * budget month.
   */
  const planId = (rawInput as { planId?: unknown } | null)?.planId
  let timezone = 'UTC'
  if (typeof planId === 'string') {
    const plan = db
      .select({ timezone: schema.plan.timezone })
      .from(schema.plan)
      .where(eq(schema.plan.id, planId))
      .get()
    if (plan) timezone = plan.timezone
  }

  try {
    const data = runProcedure(procedure, {
      db,
      userId: session.user.id,
      today: todayIn(timezone),
      rawInput,
    })
    return json({ data }, 200)
  } catch (error) {
    return json({ error: describe(error) }, statusFor(error))
  }
}

function statusFor(error: unknown): number {
  if (error instanceof ZodError) return 400
  if (error instanceof NotAuthorizedError) return 403
  if (error instanceof PlanNotFoundError) return 404
  if (error instanceof CommandError) return 409
  return 500
}

function describe(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof ZodError) {
    return {
      code: 'rpc.invalid_input',
      message: 'That input is not valid.',
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  if (error instanceof NotAuthorizedError) return { code: error.code, message: error.message }
  if (error instanceof CommandError) return { code: error.code, message: error.message }
  if (error instanceof PlanNotFoundError) {
    return { code: 'plan.not_found', message: error.message }
  }
  // Never leak an internal message to the client; log it instead.
  console.error(JSON.stringify({ level: 'error', msg: 'rpc failure', error: String(error) }))
  return { code: 'rpc.internal', message: 'Something went wrong.' }
}
