import { createClient, migrate } from '@zerofold/db'
import { calendarDate } from '@zerofold/shared/date'
import { makeContext } from './context.ts'

/** A migrated in-memory database and a context pinned to a fixed date. */
export function testHarness(today = '2026-08-22', userId = 'user-1') {
  const { db, sqlite, close } = createClient({ file: ':memory:' })
  migrate(db)
  return {
    db,
    sqlite,
    close,
    ctx: makeContext(db, userId, calendarDate(today), `${today}T12:00:00.000Z`),
  }
}
