import { join } from 'node:path'

/**
 * Configuration, read once.
 *
 * Every value has a working default except where noted, so `docker run` with no flags starts a
 * usable instance. Nothing here is baked into the image.
 */
export const env = {
  dataDir: process.env.ZEROFOLD_DATA_DIR ?? './data',
  baseUrl: process.env.ZEROFOLD_BASE_URL ?? 'http://localhost:3000',
  logLevel: (process.env.ZEROFOLD_LOG_LEVEL ?? 'info') as 'error' | 'warn' | 'info' | 'debug',
  allowOpenRegistration: process.env.ZEROFOLD_ALLOW_OPEN_REGISTRATION === 'true',
} as const

export const databaseFile = (): string => join(env.dataDir, 'zerofold.sqlite')
