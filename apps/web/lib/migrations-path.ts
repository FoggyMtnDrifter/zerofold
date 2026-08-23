import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Locate the SQL migrations directory.
 *
 * `@zerofold/db` cannot resolve this itself once bundled: `import.meta.url` inside the server
 * bundle points into `.next/server/chunks`, nowhere near the package. So the *application*
 * owns the answer, and the container sets it explicitly.
 *
 * Candidates are tried in order, and failing to find one throws with the full list rather than
 * a bare "Can't find meta/_journal.json" from deep inside the migrator — which is what this
 * function exists to avoid.
 */
export function resolveMigrationsDir(cwd = process.cwd()): string {
  const configured = process.env.ZEROFOLD_MIGRATIONS_DIR
  const candidates = configured
    ? [isAbsolute(configured) ? configured : resolve(cwd, configured)]
    : [
        // Both the container and the standalone build place them here; see
        // apps/web/scripts/copy-migrations.mjs.
        join(cwd, 'migrations'),
        join(cwd, 'packages/db/migrations'), // repo root
        join(cwd, '../../packages/db/migrations'), // apps/web, under `next dev`
      ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta/_journal.json'))) return candidate
  }

  throw new Error(
    `Could not find the migrations directory. Tried:\n${candidates
      .map((c) => `  - ${c}`)
      .join('\n')}\nSet ZEROFOLD_MIGRATIONS_DIR to the directory containing meta/_journal.json.`,
  )
}
