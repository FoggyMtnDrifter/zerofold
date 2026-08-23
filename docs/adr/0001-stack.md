# ADR-0001 — Stack

- **Status:** Accepted (2026-08-22)

## Decision

TypeScript `strict` throughout. Next.js (App Router, `output: "standalone"`). shadcn/ui on
Tailwind v4. Drizzle ORM with checked-in forward-only SQL migrations. Better Auth. Zod as the
single source of types. TanStack Query / Table / Virtual. react-hook-form. Biome for lint and
format. Vitest and Playwright.

## Notable choices, with reasons

**Typed RPC, not server actions.** Mutations are plain `Command` objects — a Zod input schema
plus an async function over a transaction context — living in `packages/commands`. The RPC
route, the YNAB-compatible REST API, the CLI, and the importers all invoke the same commands.
Server actions would give us none of that reuse, are awkward to unit-test, and provide no typed
client for TanStack Query's optimistic paths. RSC still renders the shell and initial payloads;
the budget grid and register are client components, because fighting RSC for a 60fps optimistic
grid is a losing trade.

**Biome over ESLint + Prettier.** One binary, one config, roughly 20× faster. We lose
`eslint-plugin-react-hooks`' exhaustive-deps and compensate with review attention on
effect-heavy files.

**Argon2id via `@node-rs/argon2`.** Better Auth defaults to scrypt; we configure Argon2id
explicitly. This is a native module, which is why the final image is glibc-based
(see [ADR-0006](0006-sqlite-runtime.md)) and why CI asserts that both architectures can
actually hash — a silently broken native module on arm64 would be a Raspberry-Pi-only bug.

## Consequences

- No `any` in committed code; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on,
  which is stricter than most projects and will occasionally be irritating. It is worth it in a
  codebase whose whole value proposition is arithmetic being right.
- Recharts will not survive five years of daily net-worth points; series are downsampled
  server-side to ~400 points before reaching a chart. Noted now rather than discovered in M8.
