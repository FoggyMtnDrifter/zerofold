import { schema } from '@zerofold/db'
import { addDays, type CalendarDate, calendarDate, compare } from '@zerofold/shared/date'
import type { Milliunits } from '@zerofold/shared/money'
import { type Frequency, nextOccurrence, occurrencesBetween } from '@zerofold/shared/recurrence'
import { and, eq, lte } from 'drizzle-orm'
import { type CommandContext, CommandError, withPlanWrite } from '../context.ts'
import { createTransaction } from '../transaction/create-transaction.ts'

export interface CreateScheduledInput {
  readonly planId: string
  readonly accountId: string
  readonly date: CalendarDate
  readonly frequency: Frequency
  readonly amount: Milliunits
  readonly payeeId?: string | null | undefined
  readonly categoryId?: string | null | undefined
  readonly memo?: string | null | undefined
  /** Extension D3 — YNAB's UI has these, its API does not. */
  readonly endDate?: CalendarDate | null | undefined
  readonly endAfterOccurrences?: number | null | undefined
  readonly autoEnter?: boolean | undefined
}

/**
 * The date window a schedule may start in.
 *
 * The mirror image of a transaction's (R49): the past belongs to transactions, the future to
 * schedules, and the two overlap by one week so a just-missed occurrence can still be
 * scheduled rather than needing to be back-dated as a real one.
 */
const EARLIEST_START = (today: CalendarDate) => addDays(today, -7)

export function createScheduled(
  ctx: CommandContext,
  input: CreateScheduledInput,
): { readonly scheduledTransactionId: string } {
  if (compare(input.date, EARLIEST_START(ctx.today)) < 0) {
    throw new CommandError(
      'A schedule cannot start more than a week in the past. Record it as a transaction instead.',
      'scheduled.date_too_old',
    )
  }

  const account = ctx.db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.id, input.accountId), eq(schema.account.planId, input.planId)))
    .get()
  if (!account || account.deleted) throw new CommandError('No such account.', 'account.not_found')

  const id = ctx.newId()

  withPlanWrite(ctx, input.planId, (write) => {
    ctx.db
      .insert(schema.scheduledTransaction)
      .values({
        id,
        planId: input.planId,
        accountId: input.accountId,
        dateFirst: input.date,
        /*
         * Settled at creation, not left provisional.
         *
         * The oracle returns `date_next == date_first` from its POST even when that date is
         * already past, and advances it later (R50) — so a client that trusts the response
         * holds a stale pointer. Ours is correct the moment it is returned.
         */
        dateNext: input.date,
        frequency: input.frequency,
        amount: input.amount,
        memo: input.memo ?? null,
        payeeId: input.payeeId ?? null,
        categoryId: input.categoryId ?? null,
        endDate: input.endDate ?? null,
        endAfterOccurrences: input.endAfterOccurrences ?? null,
        autoEnter: input.autoEnter ?? true,
        lastEnteredDate: null,
        isSplit: false,
        knowledgeAtChange: write.knowledge,
      })
      .run()

    write.recordUndo({
      label: 'Schedule a transaction',
      inverse: {
        procedure: 'scheduled.delete',
        input: { planId: input.planId, scheduledTransactionId: id },
      },
      forward: {
        procedure: 'scheduled.restore',
        input: { planId: input.planId, scheduledTransactionId: id },
      },
    })
  })

  return { scheduledTransactionId: id }
}

export interface EnterDueResult {
  readonly entered: number
  readonly consumed: number
}

/**
 * Enter every occurrence that has come due, and advance the pointers.
 *
 * Back-filling covers *every* missed occurrence rather than only the latest (R53), because a
 * plan whose server was off for a fortnight should come back to a fortnight of transactions
 * waiting to be approved, not one. That makes idempotence the whole game: `lastEnteredDate` is
 * the high-water mark, and running this twice in a row must enter nothing the second time.
 *
 * Entered rows are unapproved and uncleared, which is what puts them in front of someone rather
 * than silently into the balance.
 */
export function enterDueTransactions(
  ctx: CommandContext,
  planId: string,
  through: CalendarDate = ctx.today,
): EnterDueResult {
  /*
   * The whole catch-up in one transaction.
   *
   * `lastEnteredDate` is what makes this idempotent, and it is read before it is written — so
   * two callers arriving at once would both see the same watermark and both enter the same
   * occurrences. This runs on page load, where simultaneous arrivals are ordinary rather than
   * exotic.
   */
  return ctx.db.transaction(() => enterDue(ctx, planId, through))
}

function enterDue(ctx: CommandContext, planId: string, through: CalendarDate): EnterDueResult {
  const due = ctx.db
    .select()
    .from(schema.scheduledTransaction)
    .where(
      and(
        eq(schema.scheduledTransaction.planId, planId),
        eq(schema.scheduledTransaction.deleted, false),
        eq(schema.scheduledTransaction.autoEnter, true),
        lte(schema.scheduledTransaction.dateNext, through),
      ),
    )
    .all()

  let entered = 0
  let consumed = 0

  for (const scheduled of due) {
    const horizon =
      scheduled.endDate && scheduled.endDate < through ? calendarDate(scheduled.endDate) : through

    const occurrences = occurrencesBetween(
      calendarDate(scheduled.dateFirst),
      scheduled.frequency,
      scheduled.lastEnteredDate ? calendarDate(scheduled.lastEnteredDate) : null,
      horizon,
    )

    const capped = scheduled.endAfterOccurrences
      ? occurrences.slice(0, remaining(scheduled))
      : occurrences

    for (const date of capped) {
      createTransaction(ctx, {
        planId,
        accountId: scheduled.accountId,
        date,
        amount: scheduled.amount,
        payeeId: scheduled.payeeId,
        categoryId: scheduled.categoryId,
        memo: scheduled.memo,
        // Unapproved, so it is offered rather than assumed (R53).
        approved: false,
        cleared: 'uncleared',
        scheduledTransactionId: scheduled.id,
      })
      entered++
    }

    const last =
      capped.at(-1) ??
      (scheduled.lastEnteredDate ? calendarDate(scheduled.lastEnteredDate) : null)
    const next = last ? nextOccurrence(last, scheduled.frequency) : calendarDate(scheduled.dateNext)

    withPlanWrite(ctx, planId, (write) => {
      if (!next || finished(scheduled, capped.length)) {
        /*
         * A one-off is consumed by its own entry (R54): the oracle simply removes the record,
         * with no tombstone, so a syncing client learns of it only by its absence. We soft
         * delete instead, which is the same behaviour to a user and an honest one to a client
         * reading deltas — divergence D12.
         */
        ctx.db
          .update(schema.scheduledTransaction)
          .set({ deleted: true, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
          .where(eq(schema.scheduledTransaction.id, scheduled.id))
          .run()
        consumed++
        return
      }

      ctx.db
        .update(schema.scheduledTransaction)
        .set({
          dateNext: next,
          lastEnteredDate: last,
          knowledgeAtChange: write.knowledge,
          updatedAt: ctx.now,
        })
        .where(eq(schema.scheduledTransaction.id, scheduled.id))
        .run()
    })
  }

  return { entered, consumed }
}

type Scheduled = typeof schema.scheduledTransaction.$inferSelect

/** How many occurrences a count-limited series has left. */
function remaining(scheduled: Scheduled): number {
  if (!scheduled.endAfterOccurrences) return Number.POSITIVE_INFINITY
  const already = scheduled.lastEnteredDate
    ? occurrencesBetween(
        calendarDate(scheduled.dateFirst),
        scheduled.frequency,
        null,
        calendarDate(scheduled.lastEnteredDate),
      ).length
    : 0
  return Math.max(0, scheduled.endAfterOccurrences - already)
}

function finished(scheduled: Scheduled, justEntered: number): boolean {
  if (scheduled.frequency === 'never') return true
  if (!scheduled.endAfterOccurrences) return false
  return remaining(scheduled) - justEntered <= 0
}

export function deleteScheduled(
  ctx: CommandContext,
  input: { planId: string; scheduledTransactionId: string },
): void {
  setDeleted(ctx, input, true)
}

export function restoreScheduled(
  ctx: CommandContext,
  input: { planId: string; scheduledTransactionId: string },
): void {
  setDeleted(ctx, input, false)
}

function setDeleted(
  ctx: CommandContext,
  input: { planId: string; scheduledTransactionId: string },
  deleted: boolean,
): void {
  withPlanWrite(ctx, input.planId, (write) => {
    const changed = ctx.db
      .update(schema.scheduledTransaction)
      .set({ deleted, knowledgeAtChange: write.knowledge, updatedAt: ctx.now })
      .where(
        and(
          eq(schema.scheduledTransaction.id, input.scheduledTransactionId),
          eq(schema.scheduledTransaction.planId, input.planId),
        ),
      )
      .run()

    if (changed.changes === 0) {
      throw new CommandError('No such scheduled transaction.', 'scheduled.not_found')
    }

    write.recordUndo({
      label: deleted ? 'Delete schedule' : 'Restore schedule',
      inverse: {
        procedure: deleted ? 'scheduled.restore' : 'scheduled.delete',
        input,
      },
      forward: {
        procedure: deleted ? 'scheduled.delete' : 'scheduled.restore',
        input,
      },
    })
  })
}

/** Upcoming occurrences, for the list a person actually looks at. */
export interface UpcomingOccurrence {
  readonly scheduledTransactionId: string
  readonly date: CalendarDate
  readonly accountId: string
  readonly amount: Milliunits
  readonly payeeId: string | null
  readonly categoryId: string | null
  readonly memo: string | null
  readonly frequency: Frequency
}

export function listUpcoming(
  ctx: CommandContext,
  planId: string,
  through: CalendarDate,
): readonly UpcomingOccurrence[] {
  const rows = ctx.db
    .select()
    .from(schema.scheduledTransaction)
    .where(
      and(
        eq(schema.scheduledTransaction.planId, planId),
        eq(schema.scheduledTransaction.deleted, false),
      ),
    )
    .all()

  const out: UpcomingOccurrence[] = []
  for (const row of rows) {
    const horizon = row.endDate && row.endDate < through ? calendarDate(row.endDate) : through
    for (const date of occurrencesBetween(
      calendarDate(row.dateFirst),
      row.frequency,
      calendarDate(row.lastEnteredDate ?? addDays(ctx.today, -1)),
      horizon,
    )) {
      out.push({
        scheduledTransactionId: row.id,
        date,
        accountId: row.accountId,
        amount: row.amount,
        payeeId: row.payeeId,
        categoryId: row.categoryId,
        memo: row.memo,
        frequency: row.frequency,
      })
    }
  }

  return out.sort((a, b) => compare(a.date, b.date))
}
