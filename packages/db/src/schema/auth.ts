/**
 * Better Auth tables.
 *
 * Prefixed `auth_` because Better Auth's default `account` table would otherwise collide with
 * the budget `account` table. Renaming later would invalidate every live session, so the
 * prefix is set on day one.
 *
 * Timestamps here are epoch integers rather than the ISO strings used elsewhere. Better Auth
 * binds `Date` objects, and this is the mapping its SQLite adapter expects. It does not
 * conflict with ADR-0005: that rule governs *calendar dates* — transaction dates and budget
 * months, which are dates on a calendar rather than instants. A session expiry genuinely is an
 * instant.
 */
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { authTime, bool, id, int, ref } from './columns.ts'

const authTimestamps = {
  createdAt: authTime('created_at').notNull(),
  updatedAt: authTime('updated_at').notNull(),
}

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
    ...authTimestamps,
  },
  (t) => [uniqueIndex('auth_user_email').on(t.email)],
)

export const authSession = sqliteTable(
  'auth_session',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    token: text('token').notNull(),
    expiresAt: authTime('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...authTimestamps,
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
    idToken: text('id_token'),
    /** Required by Better Auth's account model; identifies the OIDC issuer for SSO links. */
    issuer: text('issuer'),
    accessTokenExpiresAt: authTime('access_token_expires_at'),
    refreshTokenExpiresAt: authTime('refresh_token_expires_at'),
    scope: text('scope'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('auth_account_provider').on(t.providerId, t.accountId)],
)

export const authVerification = sqliteTable(
  'auth_verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: authTime('expires_at').notNull(),
    ...authTimestamps,
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
    credentialID: text('credential_id').notNull(),
    counter: int('counter').notNull().default(0),
    deviceType: text('device_type'),
    backedUp: bool('backed_up').notNull().default(false),
    transports: text('transports'),
    ...authTimestamps,
  },
  (t) => [uniqueIndex('auth_passkey_credential').on(t.credentialID)],
)
