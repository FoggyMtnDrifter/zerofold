/**
 * Shared column builders.
 *
 * Every logical type in the domain has exactly one physical representation, defined here, so
 * that no table can accidentally store money as a float or a date as a timestamp. See
 * ADR-0004, ADR-0005 and ADR-0006.
 */

import type { Milliunits } from '@zerofold/shared/money'
import { sql } from 'drizzle-orm'
import { customType, integer, text } from 'drizzle-orm/sqlite-core'

/**
 * Money, as an integer number of milliunits in a 64-bit SQLite INTEGER.
 *
 * Drizzle's `integer()` offers no bigint mode on SQLite (it is a Postgres-only option), so this
 * is a custom type. `fromDriver` tolerates a plain number because better-sqlite3 only returns
 * BigInt when the connection has `safeIntegers(true)` — which `createClient` sets, but a value
 * arriving as a number must still be converted rather than silently flowing on as a float.
 */
const milliunits = customType<{ data: Milliunits; driverData: bigint | number }>({
  dataType: () => 'integer',
  fromDriver: (value) => (typeof value === 'bigint' ? value : BigInt(value)) as Milliunits,
  toDriver: (value) => value,
})

export const money = (name: string) => milliunits(name)

/** A calendar date, `YYYY-MM-DD`. Never a timestamp — ADR-0005. */
export const calendarDate = (name: string) => text(name)

/** A budget month, `YYYY-MM-01`. */
export const budgetMonth = (name: string) => text(name)

/** An instant, ISO-8601 UTC. Used for audit metadata, never for transaction dates. */
export const timestamp = (name: string) => text(name)

export const bool = (name: string) => integer(name, { mode: 'boolean' })

/**
 * JSON stored and read whole. Never queried into, so it stays portable to Postgres — ADR-0003.
 */
export const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

/** A UUIDv7, generated in the application so the engine stays deterministic — ADR-0006. */
export const id = (name = 'id') => text(name).primaryKey()

/** A reference to a UUIDv7 elsewhere. */
export const ref = (name: string) => text(name)

/**
 * Columns carried by every row in a plan.
 *
 * `planId` is denormalised onto every table deliberately: it turns per-plan authorisation into
 * a single `WHERE plan_id = ?` predicate rather than a join chain, and makes delta requests a
 * single-table index scan.
 *
 * `knowledgeAtChange` is the delta-request counter. Every row touched in a write transaction
 * gets the plan's new `server_knowledge`, so `WHERE knowledge_at_change > ?` returns exactly
 * what a syncing client has not seen — **including soft-deleted rows**, which is why nothing
 * here is ever hard-deleted (R24).
 */
export const planScoped = {
  planId: ref('plan_id').notNull(),
  knowledgeAtChange: integer('knowledge_at_change').notNull().default(0),
  deleted: bool('deleted').notNull().default(false),
}

export const timestamps = {
  createdAt: timestamp('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: timestamp('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}
