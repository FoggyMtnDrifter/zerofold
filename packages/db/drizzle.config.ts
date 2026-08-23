import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Forward-only. Migrations are checked in and applied on container start.
  strict: true,
  verbose: true,
})
