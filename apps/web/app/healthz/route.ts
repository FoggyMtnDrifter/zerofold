import { client } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Liveness and readiness in one endpoint.
 *
 * It actually queries the database rather than merely reporting that the process is up — a
 * health check that cannot fail is not a health check. Returns 503 on failure so an
 * orchestrator restarts or holds traffic.
 */
export function GET(): Response {
  const startedAt = performance.now()
  try {
    const row = client.sqlite.prepare('SELECT 1 AS ok').get() as { ok: bigint | number }
    if (Number(row.ok) !== 1) throw new Error('unexpected result from database probe')

    return Response.json(
      {
        status: 'ok',
        database: 'ok',
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        database: 'unreachable',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}
