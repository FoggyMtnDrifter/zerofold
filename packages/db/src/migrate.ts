import { fileURLToPath } from 'node:url'
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Db } from './client.ts'

/** Migrations live beside the schema and are applied on container start — ADR-0003. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Apply all pending migrations.
 *
 * Forward-only and idempotent: drizzle records applied migrations in `__drizzle_migrations`,
 * so a second run is a no-op. That property is what makes it safe to run unconditionally at
 * container start.
 */
export function migrate(db: Db): void {
  drizzleMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
