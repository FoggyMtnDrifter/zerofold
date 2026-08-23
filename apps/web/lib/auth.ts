import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { completeRegistration, mayRegister } from '@zerofold/commands'
import { schema } from '@zerofold/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { db } from './db.ts'
import { env } from './env.ts'
import { sessionSecret } from './secret.ts'

/**
 * Argon2id parameters.
 *
 * OWASP's second recommended configuration (19 MiB, t=2, p=1). Chosen over the higher-memory
 * variants because this software runs on Raspberry Pis and mini-PCs, where a 64 MiB-per-login
 * cost is a denial-of-service vector against the owner rather than a defence.
 */
const ARGON2ID = { memoryCost: 19_456, timeCost: 2, parallelism: 1, algorithm: 2 as const }

export const auth = betterAuth({
  appName: 'Zerofold',
  baseURL: env.baseUrl,
  secret: sessionSecret(),

  database: drizzleAdapter(db, {
    provider: 'sqlite',
    // Our tables carry an `auth_` prefix so Better Auth's `account` model does not collide
    // with the budget `account` table. Renaming later would invalidate every live session.
    schema: {
      user: schema.authUser,
      session: schema.authSession,
      account: schema.authAccount,
      verification: schema.authVerification,
    },
  }),

  emailAndPassword: {
    enabled: true,
    // Better Auth defaults to scrypt; ADR-0001 specifies Argon2id.
    password: {
      hash: (password) => argonHash(password, ARGON2ID),
      verify: ({ hash, password }) => argonVerify(hash, password, ARGON2ID),
    },
  },

  user: {
    additionalFields: {
      isAdmin: { type: 'boolean', defaultValue: false, input: false },
    },
  },

  session: {
    // Sessions live in the database (ADR-0001), so revocation is immediate rather than
    // waiting for a token to expire.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * The registration gate.
         *
         * Enforced here rather than in the sign-up route so that every path into user
         * creation goes through it — including OIDC, and any future one. A policy checked at
         * one entrance is a policy with an unguarded side door.
         */
        before: async (user) => {
          const decision = mayRegister(db, user.email, {
            allowOpenRegistration: env.allowOpenRegistration,
            now: new Date().toISOString(),
          })
          if (!decision.allowed) {
            throw new APIError('FORBIDDEN', { message: decision.reason, code: decision.code })
          }
          // The first account on an empty instance is the admin. Set here rather than after
          // creation so there is no window in which the row exists without it.
          return { data: { ...user, isAdmin: decision.asAdmin } }
        },
        after: async (user) => {
          // Burn the invite. Re-derived rather than threaded through, because by now the
          // instance is non-empty and only the invite branch can still match.
          const decision = mayRegister(db, user.email, {
            allowOpenRegistration: env.allowOpenRegistration,
            now: new Date().toISOString(),
          })
          if (decision.allowed && decision.inviteId) {
            completeRegistration(db, user.id, decision, new Date().toISOString())
          }
        },
      },
    },
  },

  advanced: {
    // Behind a reverse proxy the app is usually the only thing on its origin.
    defaultCookieAttributes: { sameSite: 'lax', secure: env.baseUrl.startsWith('https://') },
  },
})

export type Session = typeof auth.$Infer.Session
