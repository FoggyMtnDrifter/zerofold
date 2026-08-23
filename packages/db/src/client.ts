import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema/index.ts'

export type Db = ReturnType<typeof createClient>['db']

export interface ClientOptions {
  /** Path to the database file, or `:memory:` for tests. */
  readonly file: string
  /** Emit every statement. Off by default; very loud. */
  readonly verbose?: boolean
}

/**
 * Pragmas applied on every connection — ADR-0006.
 *
 * `foreign_keys` is OFF by default in SQLite, which surprises people, and `synchronous=NORMAL`
 * is the correct pairing with WAL: FULL costs throughput for durability we do not need between
 * checkpoints.
 */
const PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'cache_size = -64000',
  'wal_autocheckpoint = 1000',
] as const

/**
 * Open the database.
 *
 * `safeIntegers(true)` is not optional: without it better-sqlite3 returns 64-bit columns as JS
 * numbers, which silently loses precision above 2^53 and — more importantly — puts a float type
 * in a money position. See ADR-0004.
 */
export function createClient(options: ClientOptions) {
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true })

  const sqlite = new Database(options.file, options.verbose ? { verbose: console.log } : {})
  sqlite.defaultSafeIntegers(true)
  for (const pragma of PRAGMAS) sqlite.pragma(pragma)

  const db = drizzle(sqlite, { schema })
  return { db, sqlite, close: () => sqlite.close() }
}

/**
 * Take a consistent, online snapshot of the database.
 *
 * `VACUUM INTO` is why SQLite was chosen (ADR-0003): one statement, no downtime, readers never
 * blocked, and the result is a single file the user can copy anywhere. This is what makes
 * "your data is yours" a property rather than a claim.
 */
export function backupTo(sqlite: Database.Database, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  sqlite.prepare('VACUUM INTO ?').run(destination)
}
