/**
 * Runs once per server process, before any request is handled.
 *
 * Migrations live here rather than in the container entrypoint because the entrypoint runs
 * outside the bundle and cannot resolve workspace packages. Running them in-process also means
 * `next dev` and the container behave identically.
 *
 * Safe to run unconditionally on every start: migrations are forward-only and idempotent, and
 * this is a single-replica deployment (ADR-0003), so there is no second writer to race.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const [{ migrate }, { client }, { resolveMigrationsDir }] = await Promise.all([
    import('@zerofold/db'),
    import('./lib/db.ts'),
    import('./lib/migrations-path.ts'),
  ])

  const folder = resolveMigrationsDir()
  const startedAt = performance.now()
  migrate(client.db, folder)
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'migrations applied',
      folder,
      durationMs: Math.round(performance.now() - startedAt),
    }),
  )
}
