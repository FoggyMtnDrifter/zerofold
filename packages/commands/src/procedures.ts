import type { Db } from '@zerofold/db'
import type { CalendarDate } from '@zerofold/shared/date'
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

const milliunits = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v) => BigInt(v) as unknown as bigint)

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
        balance: input.balance as never,
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
