#!/usr/bin/env node
/**
 * Zerofold maintenance CLI.
 *
 * Ships in the same image as the server, so there is no second artefact to install or keep in
 * step. Runs outside the Next bundle and talks to SQLite directly — backup and restore are
 * file-level operations and need nothing from the application.
 *
 *   docker compose exec zerofold /nodejs/bin/node /app/cli.mjs backup
 *   docker compose exec zerofold /nodejs/bin/node /app/cli.mjs verify
 *   docker compose run --rm zerofold /app/cli.mjs restore /data/backups/<file>.sqlite
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'

const dataDir = process.env.ZEROFOLD_DATA_DIR ?? '/data'
const dbFile = join(dataDir, 'zerofold.sqlite')
const backupDir = join(dataDir, 'backups')

const log = (msg, extra = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }))
const fail = (msg) => {
  console.error(JSON.stringify({ level: 'error', msg }))
  process.exit(1)
}

const humanBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

/** ISO-ish, filesystem-safe, and sorts chronologically as a plain string. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')

function openDb(readonly = false) {
  if (!existsSync(dbFile)) fail(`no database at ${dbFile}`)
  const db = new Database(dbFile, { readonly })
  db.pragma('busy_timeout = 10000')
  return db
}

/**
 * `VACUUM INTO` — an online, consistent snapshot.
 *
 * The server can keep serving throughout: readers are never blocked, and the result is a
 * single defragmented file with no WAL sidecar to remember to copy alongside it.
 */
function backup(outPath) {
  const destination = outPath ?? join(backupDir, `zerofold-${stamp()}.sqlite`)
  mkdirSync(join(destination, '..'), { recursive: true })
  if (existsSync(destination)) fail(`refusing to overwrite ${destination}`)

  const db = openDb(true)
  const startedAt = Date.now()
  db.prepare('VACUUM INTO ?').run(destination)
  db.close()

  const { size } = statSync(destination)
  log('backup complete', {
    path: destination,
    size: humanBytes(size),
    durationMs: Date.now() - startedAt,
  })
}

/**
 * Replace the live database with a backup.
 *
 * The existing database is moved aside rather than deleted — a restore that turns out to be
 * the wrong file should not also destroy the thing it replaced.
 *
 * Run this with the server stopped. SQLite will not stop you from swapping the file underneath
 * a running process, and the result is a corrupt page cache rather than an error.
 */
function restore(sourcePath) {
  if (!sourcePath) fail('usage: cli.mjs restore <path-to-backup>')
  if (!existsSync(sourcePath)) fail(`no such file: ${sourcePath}`)

  // Verify the candidate before touching anything.
  const candidate = new Database(sourcePath, { readonly: true })
  const integrity = candidate.pragma('integrity_check', { simple: true })
  const hasSchema = candidate
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='plan'")
    .get()
  candidate.close()

  if (integrity !== 'ok') fail(`backup failed integrity check: ${integrity}`)
  if (Number(hasSchema.n) !== 1) fail('that file is a valid SQLite database but not a Zerofold one')

  if (existsSync(dbFile)) {
    const suffix = stamp()
    const asideName = join(dataDir, `zerofold.replaced-${suffix}.sqlite`)
    renameSync(dbFile, asideName)
    log('existing database moved aside', { path: asideName })

    // The -wal and -shm sidecars belong to the database we just moved. Leaving them next to a
    // restored file invites SQLite to replay one database's write-ahead log against another's
    // pages. A VACUUM INTO snapshot never has a WAL of its own, so there is nothing to keep.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(dbFile + ext)) {
        renameSync(dbFile + ext, `${asideName}${ext}`)
        log('moved stale sidecar aside', { path: `${asideName}${ext}` })
      }
    }
  }
  copyFileSync(sourcePath, dbFile)
  log('restore complete', { from: basename(sourcePath), to: dbFile })
  log('restart the container to pick up the restored database')
}

/** `PRAGMA integrity_check`, plus the counts a human actually wants to see. */
function verify() {
  const db = openDb(true)
  const integrity = db.pragma('integrity_check', { simple: true })
  const foreignKeys = db.pragma('foreign_key_check')
  const counts = {}
  for (const table of ['plan', 'account', 'category', 'transaction', 'money_movement']) {
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()
      counts[table] = Number(row.n)
    } catch {
      counts[table] = null
    }
  }
  db.close()

  log('integrity', { result: integrity, foreignKeyViolations: foreignKeys.length, counts })
  if (integrity !== 'ok' || foreignKeys.length > 0) process.exit(1)
}

function list() {
  if (!existsSync(backupDir)) return log('no backups yet', { dir: backupDir })
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.sqlite'))
    .sort()
    .reverse()
  if (files.length === 0) return log('no backups yet', { dir: backupDir })
  for (const f of files) {
    const { size, mtime } = statSync(join(backupDir, f))
    console.log(`${f}  ${humanBytes(size).padStart(8)}  ${mtime.toISOString()}`)
  }
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'backup':
    backup(rest[0])
    break
  case 'restore':
    restore(rest[0])
    break
  case 'verify':
    verify()
    break
  case 'list':
    list()
    break
  default:
    console.log(`zerofold maintenance CLI

  backup [path]      online snapshot via VACUUM INTO (default: /data/backups/)
  restore <path>     replace the database; run with the server stopped
  verify             integrity_check, foreign_key_check and row counts
  list               list available backups
`)
    process.exit(command ? 1 : 0)
}
