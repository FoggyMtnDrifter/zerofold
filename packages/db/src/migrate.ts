import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Db } from './client.ts'

/**
 * Migrations live beside the schema and are applied on container start — ADR-0003.
 *
 * Computed with `join` rather than `new URL('../migrations', import.meta.url)`: bundlers
 * statically analyse the latter as a module import and fail to resolve a directory of SQL.
 */
export function migrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
}

/**
 * Apply all pending migrations.
 *
 * Forward-only and idempotent: drizzle records applied migrations in `__drizzle_migrations`,
 * so a second run is a no-op. That property is what makes it safe to run unconditionally at
 * container start.
 */
export function migrate(db: Db, folder = migrationsFolder()): void {
  drizzleMigrate(db, { migrationsFolder: folder })
}
