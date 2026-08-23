#!/usr/bin/env node
/**
 * Container entrypoint.
 *
 * The runtime image is distroless and has no shell, so this is a Node script rather than the
 * usual bash. It does three things before handing over to the server, all of them idempotent
 * so an unconditional run on every start is safe:
 *
 *   1. ensure the data directory exists
 *   2. generate and persist a session secret if one was not supplied
 *   3. apply pending migrations
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.env.ZEROFOLD_DATA_DIR ?? '/data'
mkdirSync(dataDir, { recursive: true })

// ── warn about network filesystems ───────────────────────────────────────────────────
// SQLite's locking is unreliable over NFS and SMB, and this is a realistic mistake for the
// NAS-owning audience. We cannot refuse to start — the detection is advisory — but silence
// would be worse. See ADR-0003.
try {
  const NETWORK_FS_MAGIC = new Map([
    [0x6969, 'NFS'],
    [0xff534d42, 'CIFS/SMB'],
    [0x517b, 'SMB'],
    [0xfe534d42, 'SMB2'],
  ])
  const kind = NETWORK_FS_MAGIC.get(Number(statfsSync(dataDir).type))
  if (kind) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: `${dataDir} appears to be on a ${kind} mount. SQLite locking is unreliable over network filesystems and the database can be corrupted. Use local storage for ZEROFOLD_DATA_DIR.`,
      }),
    )
  }
} catch {
  // statfs is unavailable on some platforms; the check is best-effort.
}

// ── session secret ───────────────────────────────────────────────────────────────────
if (!process.env.ZEROFOLD_SECRET) {
  const secretFile = join(dataDir, '.session-secret')
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 })
    console.log(JSON.stringify({ level: 'info', msg: 'generated a new session secret' }))
  }
  process.env.ZEROFOLD_SECRET = readFileSync(secretFile, 'utf8').trim()
}

// ── migrations ───────────────────────────────────────────────────────────────────────
const { createClient, migrate } = await import('@zerofold/db')
const { db, close } = createClient({ file: join(dataDir, 'zerofold.sqlite') })
migrate(db, process.env.ZEROFOLD_MIGRATIONS_DIR ?? '/app/migrations')
close()
console.log(JSON.stringify({ level: 'info', msg: 'migrations applied' }))

await import('/app/apps/web/server.js')
