import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './env.ts'

let cached: string | undefined

/**
 * The session signing secret.
 *
 * Supplied via `ZEROFOLD_SECRET`, or generated once and persisted into the data directory.
 * Generating it means `docker run` with no configuration produces a secure instance rather
 * than one with a well-known default key — the failure mode where every deployment of a
 * self-hosted app shares the same signing secret.
 *
 * Persisting it means sessions survive a restart. A secret regenerated on boot would log
 * everyone out on every deploy.
 */
export function sessionSecret(): string {
  if (cached) return cached

  const fromEnv = process.env.ZEROFOLD_SECRET?.trim()
  if (fromEnv) {
    cached = fromEnv
    return cached
  }

  mkdirSync(env.dataDir, { recursive: true })
  const file = join(env.dataDir, '.session-secret')
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 })
  }
  cached = readFileSync(file, 'utf8').trim()
  return cached
}
