import type { Db } from '@zerofold/db'
import { type CalendarDate, calendarDate } from '@zerofold/shared/date'
import { type Milliunits, milli } from '@zerofold/shared/money'
import { z } from 'zod'
import { createAccount } from './account/create-account.ts'
import {
  closeAccount,
  deleteAccount,
  listOpenAccounts,
  reopenAccount,
} from './account/lifecycle.ts'
import { authorizePlan, type Role } from './authorize.ts'
import { makeContext } from './context.ts'
import { createPlan } from './plan/create-plan.ts'
import { reconcile } from './reconcile/reconcile.ts'
import { createTransaction } from './transaction/create-transaction.ts'
import { listTransactions } from './transaction/list.ts'
import { deleteTransaction, updateTransaction } from './transaction/mutate.ts'

/**
 * Milliunits arrive as a string so JSON never carries a lossy number, and the brand is
 * **earned by validation** rather than asserted afterwards. A cast would let an unvalidated
 * value wear the type; a transform means the only way to hold a `Milliunits` is to have parsed
 * one.
 */
const milliunits: z.ZodType<Milliunits, unknown> = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v) => milli(BigInt(v)))

/**
 * A calendar date. The regex gates the shape; `calendarDate` rejects dates that do not exist,
 * so 2026-02-30 fails here rather than silently rolling into March somewhere downstream.
 */
const calendarDateSchema: z.ZodType<CalendarDate, unknown> = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .transform((v, ctx) => {
    try {
      return calendarDate(v)
    } catch {
      ctx.addIssue({ code: 'custom', message: `${v} is not a real date` })
      return z.NEVER
    }
  })

const planScoped = z.object({ planId: z.string().min(1) })

/**
 * A procedure.
 *
 * `plan` names the minimum role required, and its presence is what makes the authorization
 * check unavoidable: the dispatcher reads it from the definition, so a procedure cannot
 * accidentally skip the check by forgetting to call something.
 */
export interface Procedure<I, O> {
  readonly input: z.ZodType<I>
  readonly plan?: Role
  readonly handler: (args: {
    readonly db: Db
    readonly userId: string
    readonly today: CalendarDate
    readonly input: I
    readonly role: Role | null
  }) => O
}

const define = <I, O>(p: Procedure<I, O>): Procedure<I, O> => p

export const procedures = {
  'plan.create': define({
    input: z.object({
      name: z.string().min(1).max(100),
      timezone: z.string().min(1),
    }),
    // No plan yet, so nothing to authorize against beyond being signed in.
    handler: ({ db, userId, today, input }) => createPlan(makeContext(db, userId, today), input),
  }),

  'account.create': define({
    input: planScoped.extend({
      name: z.string().min(1).max(100),
      type: z.enum([
        'checking',
        'savings',
        'cash',
        'creditCard',
        'lineOfCredit',
        'otherAsset',
        'otherLiability',
        'mortgage',
        'autoLoan',
        'studentLoan',
        'personalLoan',
        'medicalDebt',
        'otherDebt',
      ]),
      balance: milliunits,
      note: z.string().max(1000).optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      createAccount(makeContext(db, userId, today), {
        planId: input.planId,
        name: input.name,
        type: input.type,
        balance: input.balance,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
  }),

  'account.list': define({
    input: planScoped,
    plan: 'viewer',
    handler: ({ db, userId, today, input }) =>
      listOpenAccounts(makeContext(db, userId, today), input.planId),
  }),

  'account.close': define({
    input: planScoped.extend({ accountId: z.string().min(1) }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      closeAccount(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'account.reopen': define({
    input: planScoped.extend({ accountId: z.string().min(1) }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      reopenAccount(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'account.delete': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      confirmName: z.string().min(1),
    }),
    // Destroying an account and its transactions is an owner-only act.
    plan: 'owner',
    handler: ({ db, userId, today, input }) => {
      deleteAccount(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  // ── register ──────────────────────────────────────────────────────────────────────

  'transaction.list': define({
    input: planScoped.extend({
      accountId: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      cursor: z.string().optional(),
      unapprovedOnly: z.boolean().optional(),
      uncategorizedOnly: z.boolean().optional(),
    }),
    plan: 'viewer',
    handler: ({ db, input }) => listTransactions(db, input),
  }),

  'transaction.create': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      date: calendarDateSchema,
      amount: milliunits,
      payeeId: z.string().nullish(),
      categoryId: z.string().nullish(),
      memo: z.string().max(500).nullish(),
      cleared: z.enum(['uncleared', 'cleared', 'reconciled']).optional(),
      approved: z.boolean().optional(),
      flagColor: z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']).nullish(),
      importId: z.string().nullish(),
      subtransactions: z
        .array(
          z.object({
            amount: milliunits,
            categoryId: z.string().nullish(),
            payeeId: z.string().nullish(),
            memo: z.string().max(500).nullish(),
          }),
        )
        .optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      createTransaction(makeContext(db, userId, today), input),
  }),

  'transaction.update': define({
    input: planScoped.extend({
      transactionId: z.string().min(1),
      date: calendarDateSchema.optional(),
      amount: milliunits.optional(),
      payeeId: z.string().nullish(),
      categoryId: z.string().nullish(),
      memo: z.string().max(500).nullish(),
      cleared: z.enum(['uncleared', 'cleared', 'reconciled']).optional(),
      approved: z.boolean().optional(),
      flagColor: z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']).nullish(),
      force: z.boolean().optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      updateTransaction(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'transaction.delete': define({
    input: planScoped.extend({
      transactionId: z.string().min(1),
      force: z.boolean().optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      deleteTransaction(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'account.reconcile': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      statementBalance: milliunits,
      statementDate: calendarDateSchema.optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => reconcile(makeContext(db, userId, today), input),
  }),
} as const

export type ProcedureName = keyof typeof procedures
export type ProcedureInput<N extends ProcedureName> = z.input<(typeof procedures)[N]['input']>
export type ProcedureOutput<N extends ProcedureName> = ReturnType<(typeof procedures)[N]['handler']>

export const isProcedureName = (name: string): name is ProcedureName =>
  Object.hasOwn(procedures, name)

/**
 * Run a procedure: validate, authorize, execute.
 *
 * Authorization is applied here from the procedure's own declaration, so it cannot be
 * forgotten in a handler. A handler never sees an unauthorized call.
 */
export function runProcedure<N extends ProcedureName>(
  name: N,
  args: { db: Db; userId: string; today: CalendarDate; rawInput: unknown },
): ProcedureOutput<N> {
  const procedure = procedures[name] as Procedure<unknown, unknown>
  const input = procedure.input.parse(args.rawInput)

  let role: Role | null = null
  if (procedure.plan) {
    const { planId } = input as { planId: string }
    role = authorizePlan(args.db, planId, args.userId, procedure.plan)
  }

  return procedure.handler({
    db: args.db,
    userId: args.userId,
    today: args.today,
    input,
    role,
  }) as ProcedureOutput<N>
}
