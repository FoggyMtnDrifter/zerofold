import { describe, expect, it } from 'vitest'
import { createClient } from './client.ts'

describe('createClient', () => {
  it('applies the ADR-0006 pragmas', () => {
    const { sqlite, close } = createClient({ file: ':memory:' })
    // :memory: databases report journal_mode 'memory'; WAL applies to file-backed ones.
    expect(String(sqlite.pragma('foreign_keys', { simple: true }))).toBe('1')
    expect(String(sqlite.pragma('busy_timeout', { simple: true }))).toBe('5000')
    close()
  })

  it('returns 64-bit integers as bigint, not lossy numbers', () => {
    const { sqlite, close } = createClient({ file: ':memory:' })
    sqlite.exec('CREATE TABLE t (v INTEGER)')
    // Beyond Number.MAX_SAFE_INTEGER: as a JS number this would round.
    sqlite.prepare('INSERT INTO t VALUES (?)').run(9007199254740993n)
    const row = sqlite.prepare('SELECT v FROM t').get() as { v: bigint }
    expect(typeof row.v).toBe('bigint')
    expect(row.v).toBe(9007199254740993n)
    close()
  })
})
