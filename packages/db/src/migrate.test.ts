import { describe, expect, it } from 'vitest'
import { createClient } from './client.ts'
import { migrate } from './migrate.ts'

const tableNames = (sqlite: ReturnType<typeof createClient>['sqlite']): string[] =>
  (
    sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name)

describe('migrations', () => {
  it('applies to an empty database', () => {
    const { db, sqlite, close } = createClient({ file: ':memory:' })
    migrate(db)
    const tables = tableNames(sqlite)
    expect(tables).toContain('plan')
    expect(tables).toContain('month_category')
    expect(tables).toContain('money_movement')
    expect(tables).toContain('transaction')
    expect(tables).toContain('auth_user')
    expect(tables.length).toBeGreaterThanOrEqual(30)
    close()
  })

  it('is idempotent — running twice is a no-op, not an error', () => {
    // The container entrypoint runs migrations unconditionally on every start, so this is
    // the property that makes a restart safe.
    const { db, sqlite, close } = createClient({ file: ':memory:' })
    migrate(db)
    const before = tableNames(sqlite)
    expect(() => migrate(db)).not.toThrow()
    expect(tableNames(sqlite)).toEqual(before)
    close()
  })

  it('stores money as INTEGER and dates as TEXT, per ADR-0004 and ADR-0005', () => {
    const { db, sqlite, close } = createClient({ file: ':memory:' })
    migrate(db)
    const cols = sqlite.prepare('PRAGMA table_info(`transaction`)').all() as {
      name: string
      type: string
    }[]
    const typeOf = (n: string) => cols.find((c) => c.name === n)?.type
    expect(typeOf('amount')).toBe('INTEGER')
    // A date must never be stored as a numeric timestamp — that is the whole point of ADR-0005.
    expect(typeOf('date')).toBe('TEXT')
    close()
  })

  it('enforces the import_id uniqueness that guarantees no duplicate imports', () => {
    const { db, sqlite, close } = createClient({ file: ':memory:' })
    migrate(db)
    const idx = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get('transaction_import_unique') as { sql: string } | undefined
    expect(idx?.sql).toContain('WHERE')
    expect(idx?.sql).toContain('import_id')
    close()
  })
})
