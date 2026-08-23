import type { NextConfig } from 'next'

const config: NextConfig = {
  // A self-contained server bundle, so the runtime image needs no node_modules — ADR-0006.
  output: 'standalone',
  // Workspace packages ship TypeScript source and are transpiled here rather than pre-built.
  transpilePackages: ['@zerofold/commands', '@zerofold/db', '@zerofold/shared'],
  // better-sqlite3 is a native module; it must be required at runtime, not bundled.
  serverExternalPackages: ['better-sqlite3', '@node-rs/argon2'],
  poweredByHeader: false,
  reactStrictMode: true,
}

export default config
