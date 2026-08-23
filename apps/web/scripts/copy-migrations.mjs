#!/usr/bin/env node
/**
 * Complete the standalone output.
 *
 * `next build --output standalone` deliberately emits only the server bundle. Two things it
 * leaves behind are needed to actually run:
 *
 *   .next/static  — compiled CSS and client chunks. Without these the app serves unstyled
 *                   HTML, which looks like a broken stylesheet rather than a missing copy step.
 *   migrations    — SQL the server applies at startup. It is data, not code, so Next's tracing
 *                   does not see it, and the bundled `import.meta.url` points into
 *                   .next/server/chunks, nowhere near the package.
 *
 * The container Dockerfile does the same copies. Doing them here as well means a local
 * standalone run behaves identically, so "works in the container, broken locally" cannot
 * happen — which is exactly how the missing stylesheet was found.
 */
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = dirname(dirname(fileURLToPath(import.meta.url)))
const standalone = join(webDir, '.next/standalone/apps/web')

if (!existsSync(standalone)) process.exit(0) // not a standalone build

const copies = [
  { from: join(webDir, '../../packages/db/migrations'), to: join(standalone, 'migrations') },
  { from: join(webDir, '.next/static'), to: join(standalone, '.next/static') },
  { from: join(webDir, 'public'), to: join(standalone, 'public') },
]

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.error(`missing build input: ${from}`)
    process.exit(1)
  }
  cpSync(from, to, { recursive: true })
  console.log(`copied → ${to.replace(webDir, 'apps/web')}`)
}
