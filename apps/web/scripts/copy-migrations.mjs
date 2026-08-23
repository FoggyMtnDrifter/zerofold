#!/usr/bin/env node
/**
 * Copy the SQL migrations into the standalone output.
 *
 * They are data the server needs at runtime, not code, so Next's tracing does not pick them up
 * — and the bundled `import.meta.url` points into `.next/server/chunks`, nowhere near the
 * package. Rather than guess at relative paths from whatever directory the server happens to
 * start in, put the files where the server will look: `<cwd>/migrations`, the same layout the
 * container uses.
 */
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(webDir, '../../packages/db/migrations')
const destination = join(webDir, '.next/standalone/apps/web/migrations')

if (!existsSync(join(source, 'meta/_journal.json'))) {
  console.error(`no migrations found at ${source}`)
  process.exit(1)
}
if (!existsSync(join(webDir, '.next/standalone'))) {
  process.exit(0) // not a standalone build; nothing to do
}
cpSync(source, destination, { recursive: true })
console.log(`copied migrations → ${destination}`)
