#!/usr/bin/env node
/**
 * Container entrypoint.
 *
 * The runtime image is distroless and has no shell, so this is a Node script rather than the
 * usual bash. It prepares the environment and hands over to the server:
 *
 *   1. ensure the data directory exists and is writable, and warn if it looks like a network
 *      mount
 *   2. generate and persist a session secret if one was not supplied
 *
 * Migrations deliberately do **not** run here. This file executes outside the Next bundle and
 * cannot resolve workspace packages; they run in `apps/web/instrumentation.ts` instead, which
 * also makes `next dev` and the container behave identically.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.env.ZEROFOLD_DATA_DIR ?? '/data'

/**
 * Fail on an unwritable data directory with an explanation rather than a stack trace.
 *
 * This is the first thing a self-hoster hits when they bind-mount a host directory: the image
 * runs as a non-root user, the host directory belongs to them, and the mount arrives read-only
 * to the container. It is not a bug and it is not obvious, and `EACCES: permission denied,
 * open '/data/.session-secret'` tells them nothing about how to proceed.
 */
function ensureWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-probe')
    writeFileSync(probe, '')
    rmSync(probe)
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM' && error?.code !== 'EROFS') throw error
    console.error(
      JSON.stringify({
        level: 'error',
        msg: `Cannot write to ${dir}. Zerofold runs as an unprivileged user (uid ${process.getuid?.() ?? 'unknown'}), so a bind-mounted host directory must be owned by it — or use a Docker named volume, which is what docker/compose.yml does and needs no setup. To keep a host directory: chown -R ${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532} <that directory>.`,
        dataDir: dir,
        code: error.code,
      }),
    )
    process.exit(1)
  }
}

ensureWritable(dataDir)

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

await import('/app/apps/web/server.js')
