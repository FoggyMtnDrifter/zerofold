import { add, clampToZero, type Milliunits, min, neg, sub, ZERO } from '@zerofold/shared/money'
import type {
  CardEvent,
  CardInput,
  CardResult,
  CellResult,
  LedgerEntry,
  MonthInput,
  MonthResult,
} from './types.ts'

/**
 * Everything one month needs to know about every month before it — and one thing it needs to
 * know about the months *after* it.
 *
 * That last part is the awkward one. `totalBudgetedAllMonths` covers the whole plan, future
 * included, because money assigned in September reduces August's Ready to Assign (R9). Ready to
 * Assign is not a per-month bucket that later months draw from; every assignment anywhere
 * reduces it everywhere. So it cannot come out of a left-to-right fold, and it is carried here
 * as a constant rather than accumulated.
 */
export interface CarryState {
  /** Available carried into the month, per category. Absent means zero. */
  readonly balances: ReadonlyMap<string, Milliunits>
  /** Debt per card, split by whether a category ever funded it. See `CardResult`. */
  readonly cards: ReadonlyMap<string, CardDebt>
  /** Income of every month up to and including the previous one. */
  readonly cumulativeIncome: Milliunits
  /**
   * Money that has left Ready to Assign by paying debt the budget never funded (R60′).
   *
   * Cumulative through the previous month, and subtracted from income rather than from the
   * month's own figures, because the payment happened once and its cost does not recur.
   */
  readonly uncoveredPaid: Milliunits
  /** Cash overspending of every month strictly before this one. R8 uses `< M`, not `≤ M`. */
  readonly cashOverspendBefore: Milliunits
  /** Σ budgeted across every month of the plan. Constant through the fold. */
  readonly totalBudgetedAllMonths: Milliunits
}

export interface CardDebt {
  readonly covered: Milliunits
  readonly uncovered: Milliunits
}

const NO_DEBT: CardDebt = { covered: ZERO, uncovered: ZERO }

export const emptyCarry = (totalBudgetedAllMonths: Milliunits): CarryState => ({
  balances: new Map(),
  cards: new Map(),
  cumulativeIncome: ZERO,
  uncoveredPaid: ZERO,
  cashOverspendBefore: ZERO,
  totalBudgetedAllMonths,
})

/**
 * The order coverage is applied in, and it is not the order the rows were entered in.
 *
 * All cash spending consumes a category's available balance before any card charge is covered
 * (R2), then charges apply in date order (R6), and a same-date tie is broken by transaction id
 * ascending (R7′, measured in P1-12).
 *
 * R7 originally said the tie went to the account's own order. It does not: P1-12 put two cards
 * against each other on the same date with the same amount five times, and coverage followed
 * the smaller transaction id every time while account order was right twice — chance. The three
 * contested categories in the P1-03 plan agree, and account order explains none of them.
 *
 * Our ids are uuidv7 and therefore time-ordered, so in Zerofold this rule reads as "the charge
 * entered first is covered first". The oracle's ids are random, so the same rule produces an
 * arbitrary-looking order there. Same rule, different id generator — and this one is at least
 * explicable to the person it happens to.
 */
function coverageOrder(a: LedgerEntry, b: LedgerEntry): number {
  if (a.isCash !== b.isCash) return a.isCash ? -1 : 1
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

interface CategoryState {
  available: Milliunits
  activity: Milliunits
  cashOverspend: Milliunits
  creditOverspend: Milliunits
}

/**
 * Apply one category's transactions in coverage order.
 *
 * `available` follows the whole charge, covered or not — a category that spends 140 against 100
 * shows −40 (P1-03) — while coverage records only what the category could actually fund. The
 * two numbers answer different questions and neither is derivable from the other.
 */
function applyEntries(
  state: CategoryState,
  entries: readonly LedgerEntry[],
  cards: Map<string, CardDebt>,
  coverage: Map<string, Milliunits>,
): void {
  for (const entry of [...entries].sort(coverageOrder)) {
    state.activity = add(state.activity, entry.amount)

    if (entry.amount >= ZERO) {
      applyRefund(state, entry, cards, coverage)
      continue
    }

    const spend = neg(entry.amount) as Milliunits
    if (entry.isCash) {
      const funded = clampToZero(state.available)
      state.cashOverspend = add(state.cashOverspend, clampToZero(sub(spend, funded)))
      state.available = sub(state.available, spend)
      continue
    }

    const covered = min(clampToZero(state.available), spend)
    const uncovered = sub(spend, covered)
    state.available = sub(state.available, spend)
    state.creditOverspend = add(state.creditOverspend, uncovered)

    const debt = cards.get(entry.accountId) ?? NO_DEBT
    cards.set(entry.accountId, {
      covered: add(debt.covered, covered),
      uncovered: add(debt.uncovered, uncovered),
    })
    coverage.set(entry.accountId, add(coverage.get(entry.accountId) ?? ZERO, covered))
  }
}

/**
 * A refund.
 *
 * On a card it pays down the uncovered part of the debt first, then the covered part (R62,
 * R69) — the money the budget never set aside is the money the refund is most useful against.
 * The doc records one untested boundary: a refund large enough to push the category positive.
 */
function applyRefund(
  state: CategoryState,
  entry: LedgerEntry,
  cards: Map<string, CardDebt>,
  coverage: Map<string, Milliunits>,
): void {
  state.available = add(state.available, entry.amount)
  if (entry.isCash) return

  const debt = cards.get(entry.accountId) ?? NO_DEBT
  const againstUncovered = min(entry.amount, debt.uncovered)
  const againstCovered = min(sub(entry.amount, againstUncovered), debt.covered)
  cards.set(entry.accountId, {
    covered: sub(debt.covered, againstCovered),
    uncovered: sub(debt.uncovered, againstUncovered),
  })
  // Coverage that is no longer needed leaves the payment category with the debt it was for.
  coverage.set(entry.accountId, sub(coverage.get(entry.accountId) ?? ZERO, againstCovered))
}

/**
 * Payments and everything else on a card that no category funded.
 *
 * A payment reduces covered debt first and only then uncovered debt, and *only the uncovered
 * part costs Ready to Assign* (R60′). Overshooting a fully covered card drives the payment
 * category negative and costs nothing, which is the case that falsified the earlier rule.
 *
 * Returns what the payment categories did, and what income lost.
 */
function applyCardEvents(
  events: readonly CardEvent[],
  cards: Map<string, CardDebt>,
): { paymentActivity: Map<string, Milliunits>; uncoveredPaid: Milliunits } {
  const paymentActivity = new Map<string, Milliunits>()
  let uncoveredPaid = ZERO

  const ordered = [...events].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1,
  )

  for (const event of ordered) {
    const debt = cards.get(event.accountId) ?? NO_DEBT

    if (event.amount < ZERO) {
      // Interest, a fee, or the opening balance: debt the budget has never funded (R63, R37).
      cards.set(event.accountId, {
        covered: debt.covered,
        uncovered: add(debt.uncovered, neg(event.amount) as Milliunits),
      })
      continue
    }

    const againstCovered = min(event.amount, debt.covered)
    const remainder = sub(event.amount, againstCovered)
    const againstUncovered = min(remainder, debt.uncovered)

    cards.set(event.accountId, {
      covered: sub(debt.covered, againstCovered),
      uncovered: sub(debt.uncovered, againstUncovered),
    })
    uncoveredPaid = add(uncoveredPaid, againstUncovered)

    // The whole payment reduces the payment category, not only the covered part (R3). That is
    // what lets it go negative when a card is overpaid.
    paymentActivity.set(
      event.accountId,
      sub(paymentActivity.get(event.accountId) ?? ZERO, event.amount),
    )
  }

  return { paymentActivity, uncoveredPaid }
}

/**
 * One month.
 *
 * Kept separate from the fold so that `recalculate --from=YYYY-MM` can resume mid-plan from a
 * stored `CarryState` instead of replaying from the beginning, and so the fold has nothing in
 * it but iteration.
 */
export function advance(
  state: CarryState,
  input: MonthInput,
  categories: readonly string[],
  cardsInput: readonly CardInput[],
): { readonly result: MonthResult; readonly next: CarryState } {
  const assigned = new Map(input.assignments.map((a) => [a.categoryId, a.budgeted]))
  const byCategory = new Map<string, LedgerEntry[]>()
  for (const entry of input.entries) {
    const bucket = byCategory.get(entry.categoryId)
    if (bucket) bucket.push(entry)
    else byCategory.set(entry.categoryId, [entry])
  }

  const cards = new Map(state.cards)
  const paymentCategoryOf = new Map(cardsInput.map((c) => [c.paymentCategoryId, c.accountId]))

  /*
   * Card events run before category coverage.
   *
   * A payment settles debt that already exists; coverage in the same month creates new debt.
   * Applying the payment first is what makes "pay the card, then buy something on it" behave
   * like two separate acts rather than one netted figure.
   */
  const { paymentActivity, uncoveredPaid } = applyCardEvents(input.cardEvents, cards)

  /*
   * Two passes, because a payment category is funded by categories it may be listed before.
   *
   * The first pass spends and records what each card's coverage came to; the second turns that
   * into the payment categories' own figures. Doing it in one pass would make the answer depend
   * on the order categories happen to appear in, which is a bug waiting for someone to drag a
   * category up their sidebar.
   */
  const coverage = new Map<string, Milliunits>()
  const spending = new Map<string, CellResult>()

  for (const categoryId of categories) {
    if (paymentCategoryOf.has(categoryId)) continue

    const carriedForward = state.balances.get(categoryId) ?? ZERO
    const cell: CategoryState = {
      available: add(carriedForward, assigned.get(categoryId) ?? ZERO),
      activity: ZERO,
      cashOverspend: ZERO,
      creditOverspend: ZERO,
    }
    applyEntries(cell, byCategory.get(categoryId) ?? [], cards, coverage)

    spending.set(categoryId, {
      categoryId,
      budgeted: assigned.get(categoryId) ?? ZERO,
      activity: cell.activity,
      balance: cell.available,
      carriedForward,
      overspendKind:
        cell.cashOverspend > ZERO ? 'cash' : cell.creditOverspend > ZERO ? 'credit' : 'none',
      cashOverspend: cell.cashOverspend,
      creditOverspend: cell.creditOverspend,
    })
  }

  const cells: CellResult[] = []
  const balances = new Map<string, Milliunits>()
  let budgeted = ZERO
  let activity = ZERO
  let cashOverspentHere = ZERO

  for (const categoryId of categories) {
    const cardId = paymentCategoryOf.get(categoryId)
    let result = spending.get(categoryId)

    if (cardId !== undefined) {
      const carriedForward = state.balances.get(categoryId) ?? ZERO
      const cellBudgeted = assigned.get(categoryId) ?? ZERO
      // Coverage in, payments out. A payment category never holds spending of its own.
      const cellActivity = add(coverage.get(cardId) ?? ZERO, paymentActivity.get(cardId) ?? ZERO)
      result = {
        categoryId,
        budgeted: cellBudgeted,
        activity: cellActivity,
        balance: add(add(carriedForward, cellBudgeted), cellActivity),
        carriedForward,
        // Never overspent, however negative: an overpaid card is not a budgeting error (R60′).
        overspendKind: 'none',
        cashOverspend: ZERO,
        creditOverspend: ZERO,
      }
    }

    if (!result) continue

    cells.push(result)
    // Nothing negative crosses a month boundary for a spending category: both kinds of
    // overspending clamp it to zero, differing only in who pays (R10, R61). A payment category
    // carries its negative forward, because that negative is real debt, not an error.
    balances.set(categoryId, cardId === undefined ? clampToZero(result.balance) : result.balance)

    budgeted = add(budgeted, result.budgeted)
    activity = add(activity, result.activity)
    cashOverspentHere = add(cashOverspentHere, result.cashOverspend)
  }

  const cumulativeIncome = add(state.cumulativeIncome, input.income)
  const uncoveredPaidTotal = add(state.uncoveredPaid, uncoveredPaid)

  return {
    result: {
      month: input.month,
      income: input.income,
      budgeted,
      activity,
      // R8, plus R60′: money spent settling debt the budget never funded has left Ready to
      // Assign as surely as income never arriving would have.
      toBeBudgeted: sub(
        sub(sub(cumulativeIncome, state.totalBudgetedAllMonths), state.cashOverspendBefore),
        uncoveredPaidTotal,
      ),
      cells,
      cards: cardsInput.map((card): CardResult => {
        const debt = cards.get(card.accountId) ?? NO_DEBT
        return {
          accountId: card.accountId,
          paymentCategoryId: card.paymentCategoryId,
          coveredDebt: debt.covered,
          uncoveredDebt: debt.uncovered,
        }
      }),
    },
    next: {
      balances,
      cards,
      cumulativeIncome,
      uncoveredPaid: uncoveredPaidTotal,
      cashOverspendBefore: add(state.cashOverspendBefore, cashOverspentHere),
      totalBudgetedAllMonths: state.totalBudgetedAllMonths,
    },
  }
}

/** Σ budgeted over every month, which R8 needs before the first month can be evaluated. */
export function totalBudgeted(months: readonly MonthInput[]): Milliunits {
  let total = ZERO
  for (const month of months) {
    for (const assignment of month.assignments) total = add(total, assignment.budgeted)
  }
  return total
}
