import { createClient } from '@zerofold/db'
import { databaseFile } from './env.ts'

/**
 * One connection per process.
 *
 * SQLite serialises writers itself and this is a single-replica deployment (ADR-0003), so a
 * pool would add contention without adding throughput. Cached on `globalThis` because Next's
 * dev server re-evaluates modules on every change, and a new native handle per reload leaks
 * file descriptors.
 */
const globalForDb = globalThis as unknown as { zerofoldDb?: ReturnType<typeof createClient> }

export const client = (globalForDb.zerofoldDb ??= createClient({ file: databaseFile() }))
export const db = client.db
