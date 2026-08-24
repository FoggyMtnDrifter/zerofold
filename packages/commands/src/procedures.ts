import { type Db, schema } from '@zerofold/db'
import {
  type BudgetMonth,
  budgetMonth,
  type CalendarDate,
  calendarDate,
} from '@zerofold/shared/date'
import { type Milliunits, milli } from '@zerofold/shared/money'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createAccount } from './account/create-account.ts'
import {
  closeAccount,
  deleteAccount,
  listOpenAccounts,
  reopenAccount,
} from './account/lifecycle.ts'
import { authorizePlan, type Role } from './authorize.ts'
import { assign, moveMoney } from './budget/assign.ts'
import { recompute, verify } from './budget/recompute.ts'
import { clearTarget, setTarget, snoozeTarget } from './budget/target.ts'
import { budgetView } from './budget/view.ts'
import { type CommandContext, CommandError, makeContext, replaying } from './context.ts'
import { commitImport, previewImport } from './import/import.ts'
import { incomeReport, netWorthReport, spendingReport } from './reports/reports.ts'
import { createPlan } from './plan/create-plan.ts'
import { reconcile } from './reconcile/reconcile.ts'
import {
  createScheduled,
  deleteScheduled,
  enterDueTransactions,
  listUpcoming,
  restoreScheduled,
} from './scheduled/scheduled.ts'
import { createTransaction } from './transaction/create-transaction.ts'
import { listTransactions } from './transaction/list.ts'
import { deleteTransaction, restoreTransaction, updateTransaction } from './transaction/mutate.ts'
import { markUndone, nextRedo, nextUndo, undoState } from './undo/undo.ts'

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
 * A budget month: the first day of it.
 *
 * Rejecting any other day rather than truncating, because "2026-08-15" from a caller means they
 * think months work differently than they do, and silently rounding it hides that.
 */
const monthSchema: z.ZodType<BudgetMonth, unknown> = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, 'expected the first of a month, YYYY-MM-01')
  .transform((v, ctx) => {
    try {
      return budgetMonth(v)
    } catch {
      ctx.addIssue({ code: 'custom', message: `${v} is not a real month` })
      return z.NEVER
    }
  })

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
      // Supplied by a caller performing one user action as several writes, so they undo as one.
      groupId: z.string().min(1).optional(),
      groupLabel: z.string().min(1).max(80).optional(),
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
      groupId: z.string().min(1).optional(),
      groupLabel: z.string().min(1).max(80).optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      deleteTransaction(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'transaction.restore': define({
    input: planScoped.extend({ transactionId: z.string().min(1) }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      restoreTransaction(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'undo.state': define({
    input: planScoped,
    plan: 'viewer',
    handler: ({ db, userId, today, input }) =>
      undoState(makeContext(db, userId, today), input.planId),
  }),

  'undo.perform': define({
    input: planScoped,
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      walk(makeContext(db, userId, today), input.planId, 'undo'),
  }),

  'undo.redo': define({
    input: planScoped,
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      walk(makeContext(db, userId, today), input.planId, 'redo'),
  }),

  'budget.view': define({
    input: planScoped.extend({ month: monthSchema }),
    plan: 'viewer',
    handler: ({ db, today, input }) =>
      budgetView(db, input.planId, input.month, monthOfToday(today)),
  }),

  'budget.assign': define({
    input: planScoped.extend({
      month: monthSchema,
      categoryId: z.string().min(1),
      budgeted: milliunits,
      note: z.string().max(500).optional(),
      groupId: z.string().min(1).optional(),
      groupLabel: z.string().min(1).max(80).optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      assign(makeContext(db, userId, today), input, monthOfToday(today))
      return { ok: true as const }
    },
  }),

  'budget.move': define({
    input: planScoped.extend({
      month: monthSchema,
      fromCategoryId: z.string().min(1).nullable(),
      toCategoryId: z.string().min(1).nullable(),
      amount: milliunits,
      note: z.string().max(500).optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      moveMoney(makeContext(db, userId, today), input, monthOfToday(today))
      return { ok: true as const }
    },
  }),

  'budget.recompute': define({
    input: planScoped,
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      recompute(makeContext(db, userId, today), input.planId, monthOfToday(today))
      return { ok: true as const }
    },
  }),

  /** Asserts the cache equals a from-scratch recompute; see `recompute.ts`. */
  'budget.verify': define({
    input: planScoped,
    plan: 'viewer',
    handler: ({ db, userId, today, input }) => {
      const discrepancies = verify(
        makeContext(db, userId, today),
        input.planId,
        monthOfToday(today),
      )
      /*
       * `dirtyFrom` travels with the answer because a plan edited since its last recompute is
       * *expected* to disagree. Without it, "the cache is stale" and "the cache is wrong" look
       * identical, and only the second is worth waking up for.
       */
      const dirty = db
        .select({ from: schema.planRecalc.dirtyFromMonth })
        .from(schema.planRecalc)
        .where(eq(schema.planRecalc.planId, input.planId))
        .get()

      return {
        ok: discrepancies.length === 0,
        dirtyFrom: dirty?.from ?? null,
        discrepancies: discrepancies.map((d) => ({
          ...d,
          cached: typeof d.cached === 'bigint' ? d.cached.toString() : d.cached,
          computed: typeof d.computed === 'bigint' ? d.computed.toString() : d.computed,
        })),
      }
    },
  }),

  'target.set': define({
    input: planScoped.extend({
      categoryId: z.string().min(1),
      effectiveFrom: monthSchema,
      goalType: z.enum(['NEED', 'TB', 'TBD', 'MF', 'DEBT']),
      goalTarget: milliunits,
      goalTargetMonth: monthSchema.nullish(),
      /** 0 = Sunday (R29). */
      goalDay: z.number().int().min(0).max(6).nullish(),
      /** 1 monthly, 2 weekly, 13 yearly (R31a). */
      goalCadence: z.union([z.literal(1), z.literal(2), z.literal(13)]).nullish(),
      /** `true` = set aside, `false` = fill up to (R25). */
      goalNeedsWholeAmount: z.boolean().nullish(),
      repeats: z.boolean().optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      setTarget(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'target.clear': define({
    input: planScoped.extend({
      categoryId: z.string().min(1),
      effectiveFrom: monthSchema,
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      clearTarget(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'target.snooze': define({
    input: planScoped.extend({
      categoryId: z.string().min(1),
      month: monthSchema,
      snoozed: z.boolean(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      snoozeTarget(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'scheduled.create': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      date: calendarDateSchema,
      frequency: z.enum([
        'never',
        'daily',
        'weekly',
        'everyOtherWeek',
        'twiceAMonth',
        'every4Weeks',
        'monthly',
        'everyOtherMonth',
        'every3Months',
        'every4Months',
        'twiceAYear',
        'yearly',
        'everyOtherYear',
      ]),
      amount: milliunits,
      payeeId: z.string().nullish(),
      categoryId: z.string().nullish(),
      memo: z.string().max(500).nullish(),
      /** Extensions D3 — in YNAB's UI, absent from its API. */
      endDate: calendarDateSchema.nullish(),
      endAfterOccurrences: z.number().int().positive().nullish(),
      autoEnter: z.boolean().optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      createScheduled(makeContext(db, userId, today), input),
  }),

  'scheduled.delete': define({
    input: planScoped.extend({ scheduledTransactionId: z.string().min(1) }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      deleteScheduled(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'scheduled.restore': define({
    input: planScoped.extend({ scheduledTransactionId: z.string().min(1) }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) => {
      restoreScheduled(makeContext(db, userId, today), input)
      return { ok: true as const }
    },
  }),

  'scheduled.upcoming': define({
    input: planScoped.extend({ through: calendarDateSchema }),
    plan: 'viewer',
    handler: ({ db, userId, today, input }) =>
      listUpcoming(makeContext(db, userId, today), input.planId, input.through),
  }),

  /** Enter everything that has come due. Idempotent, so calling it twice is harmless. */
  'scheduled.enterDue': define({
    input: planScoped,
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      enterDueTransactions(makeContext(db, userId, today), input.planId),
  }),

  /**
   * Read a file and report what it holds, without writing anything.
   *
   * The content arrives as text rather than as an upload because the file never needs to leave
   * the request: parsing costs less than storing, and a self-hosted instance has no business
   * keeping a copy of someone's bank statement on disk.
   */
  'import.preview': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      content: z.string().min(1).max(20_000_000),
      filename: z.string().max(255).optional(),
      columns: z
        .object({
          date: z.number().int().min(0),
          payee: z.number().int().min(0).optional(),
          memo: z.number().int().min(0).optional(),
          amount: z.number().int().min(0).optional(),
          outflow: z.number().int().min(0).optional(),
          inflow: z.number().int().min(0).optional(),
        })
        .optional(),
      dateOrder: z.enum(['dmy', 'mdy']).optional(),
    }),
    plan: 'viewer',
    handler: ({ db, input }) => {
      const preview = previewImport(db, {
        planId: input.planId,
        accountId: input.accountId,
        content: input.content,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        options: {
          ...(input.columns === undefined ? {} : { columns: input.columns }),
          ...(input.dateOrder === undefined ? {} : { dateOrder: input.dateOrder }),
        },
      })
      // Milliunits are bigint; JSON is not.
      return { ...preview, rows: preview.rows.map((r) => ({ ...r, amount: r.amount.toString() })) }
    },
  }),

  'import.commit': define({
    input: planScoped.extend({
      accountId: z.string().min(1),
      content: z.string().min(1).max(20_000_000),
      filename: z.string().max(255).optional(),
      acceptImportIds: z.array(z.string().min(1)).max(50_000),
      columns: z
        .object({
          date: z.number().int().min(0),
          payee: z.number().int().min(0).optional(),
          memo: z.number().int().min(0).optional(),
          amount: z.number().int().min(0).optional(),
          outflow: z.number().int().min(0).optional(),
          inflow: z.number().int().min(0).optional(),
        })
        .optional(),
      dateOrder: z.enum(['dmy', 'mdy']).optional(),
    }),
    plan: 'editor',
    handler: ({ db, userId, today, input }) =>
      commitImport(makeContext(db, userId, today), {
        planId: input.planId,
        accountId: input.accountId,
        content: input.content,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        acceptImportIds: input.acceptImportIds,
        options: {
          ...(input.columns === undefined ? {} : { columns: input.columns }),
          ...(input.dateOrder === undefined ? {} : { dateOrder: input.dateOrder }),
        },
      }),
  }),

  'report.spending': define({
    input: planScoped.extend({ from: monthSchema, through: monthSchema }),
    plan: 'viewer',
    handler: ({ db, input }) => {
      const report = spendingReport(db, input.planId, input)
      return {
        ...report,
        total: report.total.toString(),
        byCategory: report.byCategory.map((c) => ({ ...c, amount: c.amount.toString() })),
        byMonth: report.byMonth.map((m) => ({ ...m, amount: m.amount.toString() })),
      }
    },
  }),

  'report.income': define({
    input: planScoped.extend({ from: monthSchema, through: monthSchema }),
    plan: 'viewer',
    handler: ({ db, input }) => {
      const report = incomeReport(db, input.planId, input)
      return {
        period: report.period,
        totalIncome: report.totalIncome.toString(),
        totalSpending: report.totalSpending.toString(),
        byMonth: report.byMonth.map((m) => ({
          month: m.month,
          income: m.income.toString(),
          spending: m.spending.toString(),
          net: m.net.toString(),
        })),
      }
    },
  }),

  'report.netWorth': define({
    input: planScoped.extend({ from: monthSchema, through: monthSchema }),
    plan: 'viewer',
    handler: ({ db, input }) =>
      netWorthReport(db, input.planId, input).map((p) => ({
        month: p.month,
        assets: p.assets.toString(),
        liabilities: p.liabilities.toString(),
        net: p.net.toString(),
      })),
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

/**
 * The commands an undo entry is allowed to name.
 *
 * An explicit table rather than a lookup into `procedures`, because those two sets are not the
 * same one and should not silently become so: `plan.create` has no business being replayed by an
 * undo entry, and a stack entry naming something absent here fails loudly instead of quietly
 * doing nothing.
 */
const REPLAYABLE: Record<string, (ctx: CommandContext, input: unknown) => void> = {
  'transaction.update': (ctx, input) => {
    updateTransaction(ctx, procedures['transaction.update'].input.parse(input))
  },
  'transaction.delete': (ctx, input) => {
    deleteTransaction(ctx, procedures['transaction.delete'].input.parse(input))
  },
  'transaction.restore': (ctx, input) => {
    restoreTransaction(ctx, procedures['transaction.restore'].input.parse(input))
  },
  'scheduled.delete': (ctx, input) => {
    deleteScheduled(ctx, procedures['scheduled.delete'].input.parse(input))
  },
  'scheduled.restore': (ctx, input) => {
    restoreScheduled(ctx, procedures['scheduled.restore'].input.parse(input))
  },
  'budget.assign': (ctx, input) => {
    const parsed = procedures['budget.assign'].input.parse(input)
    assign(ctx, parsed, monthOfToday(ctx.today))
  },
}

/** The month `today` falls in. The engine works in months; the clock does not. */
const monthOfToday = (today: CalendarDate): BudgetMonth => budgetMonth(`${today.slice(0, 7)}-01`)

/**
 * Walk the stack one step.
 *
 * The whole group runs inside one database transaction: a bulk delete of eleven rows must come
 * back as eleven rows or as none, never as six. `replaying` keeps the replayed writes from
 * pushing entries of their own onto the stack being walked.
 */
function walk(ctx: CommandContext, planId: string, direction: 'undo' | 'redo') {
  const entries = direction === 'undo' ? nextUndo(ctx, planId) : nextRedo(ctx, planId)

  return ctx.db.transaction(() => {
    const replay = replaying(ctx)
    for (const entry of entries) {
      const run = REPLAYABLE[entry.command.procedure]
      if (!run) {
        throw new CommandError(
          `That change cannot be reversed automatically (${entry.command.procedure}).`,
          'undo.not_replayable',
        )
      }
      run(replay, entry.command.input)
    }
    markUndone(
      ctx,
      entries.map((e) => e.id),
      direction === 'undo',
    )
    return { label: entries[0]?.label ?? '', steps: entries.length }
  })
}

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
