import { createClient } from '@zerofold/db'
import { databaseFile } from './env.ts'

/**
 * One connection per process.
 *
 * SQLite serialises writers itself and this is a single-replica deployment (ADR-0003), so a
 * pool would add contention without adding throughput.
 *
 * Cached on `globalThis` because Next's dev server re-evaluates modules on every change, and a
 * fresh native handle per reload leaks file descriptors until the process is restarted.
 */
const globalForDb = globalThis as unknown as {
  zerofoldDb?: ReturnType<typeof createClient>
}

function getClient(): ReturnType<typeof createClient> {
  const existing = globalForDb.zerofoldDb
  if (existing) return existing
  const created = createClient({ file: databaseFile() })
  globalForDb.zerofoldDb = created
  return created
}

export const client = getClient()
export const db = client.db
