import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests run against a **real built server** with a **fresh database**.
 *
 * Several acceptance criteria concern the behaviour of an *empty* instance — first user
 * becomes the admin cannot be tested against a database that already has one — so the data
 * directory is removed before each run.
 *
 * The removal happens here, at config module scope, rather than in `globalSetup`: Playwright
 * starts `webServer` before global setup runs, so a setup hook would delete the database out
 * from under a server that had already opened it, and the previous run's users would still be
 * there. Found by a 422 "user already exists" on the second run.
 */
const PORT = 3399

/**
 * An absolute path, deliberately.
 *
 * Next's standalone `server.js` calls `process.chdir` to its own directory, so a relative
 * ZEROFOLD_DATA_DIR resolves against `.next/standalone/apps/web` rather than the repo root —
 * and the wipe below would then clean a directory the server never used. That is exactly how
 * the first run's users survived into the second.
 */
const DATA_DIR = resolve(import.meta.dirname, '.playwright-data')

rmSync(DATA_DIR, { recursive: true, force: true })

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // one instance, one database, ordered acceptance criteria
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: 'node .next/standalone/apps/web/server.js',
    cwd: 'apps/web',
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      ZEROFOLD_DATA_DIR: DATA_DIR,
      ZEROFOLD_BASE_URL: `http://127.0.0.1:${PORT}`,
    },
  },
})
