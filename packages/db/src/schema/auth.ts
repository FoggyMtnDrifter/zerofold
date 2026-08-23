/**
 * Better Auth tables.
 *
 * Prefixed `auth_` because Better Auth's default `account` table would otherwise collide with
 * the budget `account` table. Renaming later would invalidate every live session, so the
 * prefix is set on day one.
 */
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, ref, timestamp, timestamps } from './columns.ts'

export const authUser = sqliteTable(
  'auth_user',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name'),
    emailVerified: bool('email_verified').notNull().default(false),
    image: text('image'),
    /** The first account created on an empty instance becomes the admin. */
    isAdmin: bool('is_admin').notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('auth_user_email').on(t.email)],
)

export const authSession = sqliteTable(
  'auth_session',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [uniqueIndex('auth_session_token').on(t.token), index('auth_session_user').on(t.userId)],
)

/** Credential and OIDC links. `password` is an Argon2id hash — ADR-0001. */
export const authAccount = sqliteTable(
  'auth_account',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    scope: text('scope'),
    ...timestamps,
  },
  (t) => [uniqueIndex('auth_account_provider').on(t.providerId, t.accountId)],
)

export const authVerification = sqliteTable(
  'auth_verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    ...timestamps,
  },
  (t) => [index('auth_verification_identifier').on(t.identifier)],
)

export const authPasskey = sqliteTable(
  'auth_passkey',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    credentialId: text('credential_id').notNull(),
    counter: text('counter').notNull(),
    deviceType: text('device_type'),
    backedUp: bool('backed_up').notNull().default(false),
    transports: text('transports'),
    ...timestamps,
  },
  (t) => [uniqueIndex('auth_passkey_credential').on(t.credentialId)],
)
