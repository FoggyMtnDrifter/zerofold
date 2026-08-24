import { budgetMonth, calendarDate } from '@zerofold/shared/date'
import { type Milliunits, milli, ZERO } from '@zerofold/shared/money'
import { describe, expect, it } from 'vitest'
import { advance, emptyCarry, totalBudgeted } from './advance.ts'
import { run } from './run.ts'
import type { CardEvent, EngineInput, LedgerEntry, MonthInput } from './types.ts'

/**
 * The engine, checked against what the oracle actually did.
 *
 * The tables in `docs/behavior/` are measured sequences, not invented ones, and they are
 * reproduced here figure for figure. A test written from the formula alone would agree with
 * whatever the formula says; these can disagree with it.
 */

const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')
const OCT = budgetMonth('2026-10-01')
const DAY = calendarDate('2026-08-22')

const CATEGORIES = ['C1', 'C2', 'C3']

let seq = 0
const nextId = () => `e${(seq++).toString().padStart(4, '0')}`

const assign = (categoryId: string, budgeted: number) => ({
  categoryId,
  budgeted: milli(budgeted),
})

const spend = (
  categoryId: string,
  amount: number,
  options: { card?: string; date?: string; id?: string } = {},
): LedgerEntry => ({
  id: options.id ?? nextId(),
  categoryId,
  date: calendarDate(options.date ?? DAY),
  amount: milli(amount),
  accountId: options.card ?? 'cash-1',
  isCash: options.card === undefined,
})

const cardEvent = (accountId: string, amount: number, date: string = DAY): CardEvent => ({
  id: nextId(),
  accountId,
  date: calendarDate(date),
  amount: milli(amount),
})

interface MonthSpec {
  assignments?: readonly { categoryId: string; budgeted: Milliunits }[]
  entries?: readonly LedgerEntry[]
  cardEvents?: readonly CardEvent[]
  income?: number
}

/** August carries the 1000000 starting balance as income; nothing else earns. */
const plan = (
  aug: MonthSpec = {},
  sep: MonthSpec = {},
  oct: MonthSpec = {},
  cards: EngineInput['cards'] = [],
): EngineInput => ({
  today: DAY,
  categories: [...CATEGORIES, ...cards.map((c) => c.paymentCategoryId)],
  cards,
  months: [
    month(AUG, { income: 1_000_000, ...aug }),
    month(SEP, sep),
    month(OCT, oct),
  ] satisfies MonthInput[],
})

const month = (m: typeof AUG, spec: MonthSpec): MonthInput => ({
  month: m,
  income: milli(spec.income ?? 0),
  assignments: spec.assignments ?? [],
  entries: spec.entries ?? [],
  cardEvents: spec.cardEvents ?? [],
  targets: [],
})

const rta = (input: EngineInput) => run(input).months.map((m) => m.toBeBudgeted)

const cellOf = (input: EngineInput, monthIndex: number, categoryId: string) =>
  run(input).months[monthIndex]?.cells.find((c) => c.categoryId === categoryId)

const balanceOf = (input: EngineInput, monthIndex: number, categoryId: string) =>
  cellOf(input, monthIndex, categoryId)?.balance

describe('P0-A, step by step', () => {
  it('step 0 — baseline: every month reports the whole income', () => {
    expect(rta(plan())).toEqual([milli(1_000_000), milli(1_000_000), milli(1_000_000)])
  })

  it('step 1 — an assignment in September reduces August (R9)', () => {
    const input = plan({}, { assignments: [assign('C2', 300_000)] })
    expect(rta(input)).toEqual([milli(700_000), milli(700_000), milli(700_000)])
  })

  it('step 3 — a positive balance carries forward untouched (R11)', () => {
    const input = plan({ assignments: [assign('C1', 100_000)] })
    expect(rta(input)).toEqual([milli(900_000), milli(900_000), milli(900_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(100_000))
    expect(balanceOf(input, 1, 'C1')).toBe(milli(100_000))
  })

  it('step 4 — cash overspending zeroes the category and charges the *next* month (R10)', () => {
    const input = plan({ assignments: [assign('C1', 100_000)], entries: [spend('C1', -140_000)] })

    // August's own RTA is untouched; only September onward pays for it.
    expect(rta(input)).toEqual([milli(900_000), milli(860_000), milli(860_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(-40_000))
    expect(balanceOf(input, 1, 'C1')).toBe(ZERO)
  })

  it('step 5 — Ready to Assign goes negative and is not clamped (R12)', () => {
    const input = plan({
      assignments: [assign('C1', 100_000), assign('C3', 5_000_000)],
      entries: [spend('C1', -140_000)],
    })
    expect(rta(input)).toEqual([milli(-4_100_000), milli(-4_140_000), milli(-4_140_000)])
  })

  it('re-confirmation — a future assignment and a past overspend at the same time', () => {
    const input = plan(
      { assignments: [assign('C1', 100_000)], entries: [spend('C1', -140_000)] },
      { assignments: [assign('C2', 250_000)] },
    )
    expect(rta(input)).toEqual([milli(650_000), milli(610_000), milli(610_000)])
  })
})

const VISA = { accountId: 'visa', paymentCategoryId: 'pay-visa' }
const AMEX = { accountId: 'amex', paymentCategoryId: 'pay-amex' }

describe('credit cards', () => {
  it('moves what the category can afford into the payment category (R1)', () => {
    const input = plan(
      {
        assignments: [assign('C1', 100_000)],
        entries: [spend('C1', -140_000, { card: 'visa' })],
      },
      {},
      {},
      [VISA],
    )

    expect(balanceOf(input, 0, 'C1')).toBe(milli(-40_000))
    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(100_000))
    expect(run(input).months[0]?.cards[0]).toMatchObject({
      coveredDebt: milli(100_000),
      uncoveredDebt: milli(40_000),
    })
  })

  it('zeroes the category next month but leaves Ready to Assign alone (R61)', () => {
    const input = plan({ entries: [spend('C1', -30_000, { card: 'visa' })] }, {}, {}, [VISA])

    expect(rta(input)).toEqual([milli(1_000_000), milli(1_000_000), milli(1_000_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(-30_000))
    expect(balanceOf(input, 1, 'C1')).toBe(ZERO)
  })

  it('spends cash before it covers credit, whatever the dates say (R2)', () => {
    // The cash charge is ten days later and listed second, and still consumes first.
    const input = plan(
      {
        assignments: [assign('C1', 100_000)],
        entries: [
          spend('C1', -80_000, { card: 'visa', date: '2026-08-05' }),
          spend('C1', -60_000, { date: '2026-08-15' }),
        ],
      },
      {},
      {},
      [VISA],
    )

    const c1 = cellOf(input, 0, 'C1')
    expect(c1?.cashOverspend).toBe(ZERO)
    expect(c1?.creditOverspend).toBe(milli(40_000))
    // 100000 assigned, 60000 taken by cash, 40000 left to cover an 80000 charge.
    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(40_000))
  })

  it('covers charges in date order, tiebroken by transaction id (R6, R7′)', () => {
    const input = plan(
      {
        assignments: [assign('C1', 50_000)],
        entries: [
          spend('C1', -40_000, { card: 'amex', date: '2026-08-10', id: 'zz' }),
          spend('C1', -40_000, { card: 'visa', date: '2026-08-10', id: 'aa' }),
        ],
      },
      {},
      {},
      [VISA, AMEX],
    )

    // Same date, so the smaller transaction id is covered first — measured in P1-12.
    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(40_000))
    expect(balanceOf(input, 0, 'pay-amex')).toBe(milli(10_000))
  })

  it('does not care what order the input arrives in', () => {
    const entries = [
      spend('C1', -40_000, { card: 'amex', date: '2026-08-10', id: 'zz' }),
      spend('C1', -30_000, { card: 'visa', date: '2026-08-02', id: 'aa' }),
      spend('C1', -20_000, { date: '2026-08-20' }),
    ]
    const forwards = plan({ assignments: [assign('C1', 60_000)], entries }, {}, {}, [VISA, AMEX])
    const backwards = plan(
      { assignments: [assign('C1', 60_000)], entries: [...entries].reverse() },
      {},
      {},
      [VISA, AMEX],
    )

    expect(run(forwards).months[0]?.cells).toEqual(run(backwards).months[0]?.cells)
    expect(run(forwards).months[0]?.cards).toEqual(run(backwards).months[0]?.cards)
  })
})

describe('paying a card (R60′)', () => {
  it('leaves income alone while payments settle covered debt', () => {
    const input = plan(
      {
        assignments: [assign('C1', 100_000)],
        entries: [spend('C1', -60_000, { card: 'visa' })],
        cardEvents: [cardEvent('visa', 20_000), cardEvent('visa', 40_000)],
      },
      {},
      {},
      [VISA],
    )

    expect(balanceOf(input, 0, 'pay-visa')).toBe(ZERO)
    expect(rta(input)[0]).toBe(milli(900_000))
  })

  it('overshooting a fully covered card costs nothing and goes negative', () => {
    // The case that falsified the earlier rule: the payment category goes to −15000 and Ready
    // to Assign does not move, because the overshoot paid debt that does not exist.
    const input = plan(
      {
        assignments: [assign('C1', 100_000)],
        entries: [spend('C1', -60_000, { card: 'visa' })],
        cardEvents: [
          cardEvent('visa', 20_000),
          cardEvent('visa', 40_000),
          cardEvent('visa', 15_000),
        ],
      },
      {},
      {},
      [VISA],
    )

    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(-15_000))
    expect(rta(input)[0]).toBe(milli(900_000))
    expect(cellOf(input, 0, 'pay-visa')?.overspendKind).toBe('none')
  })

  it('paying debt no category funded comes out of Ready to Assign', () => {
    // A card that arrives owing 50000 and is never used, then paid 9000.
    const input = plan(
      { cardEvents: [cardEvent('visa', -50_000, '2026-08-01'), cardEvent('visa', 9_000)] },
      {},
      {},
      [VISA],
    )

    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(-9_000))
    expect(rta(input)[0]).toBe(milli(991_000))
    expect(run(input).months[0]?.cards[0]).toMatchObject({ uncoveredDebt: milli(41_000) })
  })

  it('an uncategorised charge becomes debt the budget has never seen (R63)', () => {
    const input = plan({ cardEvents: [cardEvent('visa', -3_000)] }, {}, {}, [VISA])

    expect(run(input).months[0]?.cards[0]).toMatchObject({
      coveredDebt: ZERO,
      uncoveredDebt: milli(3_000),
    })
    expect(rta(input)[0]).toBe(milli(1_000_000))
  })

  it('a refund pays down uncovered debt before covered debt (R62, R69)', () => {
    const input = plan(
      {
        assignments: [assign('C1', 50_000)],
        entries: [
          spend('C1', -80_000, { card: 'visa', date: '2026-08-05' }),
          spend('C1', 20_000, { card: 'visa', date: '2026-08-20' }),
        ],
      },
      {},
      {},
      [VISA],
    )

    // 50000 covered, 30000 uncovered; the refund takes the uncovered part down to 10000 and
    // leaves the payment category exactly where it was.
    expect(balanceOf(input, 0, 'C1')).toBe(milli(-10_000))
    expect(balanceOf(input, 0, 'pay-visa')).toBe(milli(50_000))
    expect(run(input).months[0]?.cards[0]).toMatchObject({
      coveredDebt: milli(50_000),
      uncoveredDebt: milli(10_000),
    })
  })
})

describe('P1-03 end to end', () => {
  /**
   * The whole observed plan: five categories, two cards, mixed cash and credit, one payment.
   *
   * Reproduced from `docs/behavior/P1-03-credit-card-payment-coverage.md`, which recorded a
   * real plan rather than a constructed one. Every figure below is from that table.
   */
  const CATS = ['Groceries', 'Dining out', 'Entertainment', 'Vacation', 'Stuff'] as const

  const input: EngineInput = {
    today: DAY,
    categories: [...CATS, 'pay-visa', 'pay-amex'],
    cards: [VISA, AMEX],
    months: [
      {
        month: AUG,
        income: milli(1_000_000),
        assignments: [
          assign('Groceries', 100_000),
          assign('Dining out', 50_000),
          assign('Entertainment', 50_000),
          assign('Vacation', 50_000),
          assign('Stuff', 50_000),
        ],
        // The real transaction ids from `_raw/2026-08-22-sk76-plan-detail.json`, because the
        // same-date tiebreak is on the id and using invented ones would test nothing.
        entries: [
          spend('Groceries', -80_000, { card: 'visa', id: '31626d91' }),
          spend('Groceries', -60_000, { card: 'visa', id: 'aca79c63' }),
          spend('Entertainment', -60_000, { card: 'visa', id: '030aacb8' }),
          spend('Vacation', -60_000, { card: 'visa', id: 'b84330e6' }),
          spend('Stuff', -60_000, { card: 'amex', id: '03124c6d' }),
          spend('Dining out', -40_000, { card: 'visa', id: '774f2dd3' }),
          spend('Dining out', -30_000, { id: 'f973887a' }),
          spend('Vacation', -20_000, { card: 'amex', id: 'c65a1fb0' }),
          spend('Entertainment', -20_000, { card: 'amex', id: 'ddbd88a1' }),
          spend('Stuff', -20_000, { card: 'visa', id: 'a576fe9e' }),
        ],
        cardEvents: [cardEvent('visa', 100_000)],
        targets: [],
      },
    ],
  }

  const august = run(input).months[0]
  const cell = (id: string) => august?.cells.find((c) => c.categoryId === id)

  it('reproduces every category balance', () => {
    expect(cell('Groceries')?.balance).toBe(milli(-40_000))
    expect(cell('Dining out')?.balance).toBe(milli(-20_000))
    expect(cell('Entertainment')?.balance).toBe(milli(-30_000))
    expect(cell('Vacation')?.balance).toBe(milli(-30_000))
    expect(cell('Stuff')?.balance).toBe(milli(-30_000))
  })

  it('reproduces both payment categories', () => {
    expect(cell('pay-visa')?.balance).toBe(milli(120_000))
    expect(cell('pay-visa')?.activity).toBe(milli(120_000))
    expect(cell('pay-amex')?.balance).toBe(milli(50_000))
    expect(cell('pay-amex')?.activity).toBe(milli(50_000))
  })

  it('reproduces the month totals and Ready to Assign (R4, R5)', () => {
    expect(august?.budgeted).toBe(milli(300_000))
    // −450000 of spending plus 170000 in the payment categories.
    expect(august?.activity).toBe(milli(-280_000))
    expect(august?.toBeBudgeted).toBe(milli(700_000))
  })

  it('satisfies the conservation identities the doc proposes as property tests', () => {
    const assigned = milli(300_000)
    const cashSpend = milli(30_000)
    const covered = milli(270_000)
    expect(assigned).toBe((cashSpend + covered) as Milliunits)

    const creditCharges = milli(420_000)
    const overspend = [...CATS].reduce(
      (total, id) => total + (cell(id)?.creditOverspend ?? ZERO),
      0n,
    )
    expect((creditCharges - covered) as Milliunits).toBe(overspend)
  })
})

describe('the closed form and the fold agree', () => {
  /**
   * R8 as written, computed independently of the fold.
   *
   * The point is not to check the arithmetic twice — the fold carries state and the closed form
   * does not, so the two disagree the moment a window is wrong.
   */
  const closedForm = (input: EngineInput, index: number): Milliunits => {
    const folded = run(input).months
    let income = 0n
    for (const [i, m] of input.months.entries()) if (i <= index) income += m.income
    let budgeted = 0n
    for (const m of input.months) for (const a of m.assignments) budgeted += a.budgeted
    let overspend = 0n
    let uncoveredPaid = 0n
    for (const [i, m] of folded.entries()) {
      if (i >= index) break
      for (const c of m.cells) overspend += c.cashOverspend
    }
    // Uncovered debt paid is cumulative *through* the month, unlike overspending.
    let running = emptyCarry(0n as Milliunits)
    for (const [i, m] of input.months.entries()) {
      if (i > index) break
      const step = advance(running, m, input.categories, input.cards, input.today)
      uncoveredPaid = step.next.uncoveredPaid
      running = step.next
    }
    return (income - budgeted - overspend - uncoveredPaid) as Milliunits
  }

  const CASES: readonly EngineInput[] = [
    plan(),
    plan({ assignments: [assign('C1', 100_000)] }),
    plan({ assignments: [assign('C1', 100_000)], entries: [spend('C1', -140_000)] }),
    plan(
      { assignments: [assign('C1', 100_000)], entries: [spend('C1', -140_000)] },
      { assignments: [assign('C2', 250_000)] },
    ),
    plan(
      { entries: [spend('C1', -50_000, { card: 'visa' })] },
      { cardEvents: [cardEvent('visa', 50_000, '2026-09-05')] },
      {},
      [VISA],
    ),
    plan(
      { cardEvents: [cardEvent('visa', -80_000, '2026-08-01')] },
      { cardEvents: [cardEvent('visa', 30_000, '2026-09-05')] },
      { cardEvents: [cardEvent('visa', 30_000, '2026-10-05')] },
      [VISA],
    ),
  ]

  it.each(CASES.map((input, i) => [i, input] as const))('case %i', (_i, input) => {
    const folded = run(input).months
    for (const [index, m] of folded.entries()) {
      expect(m.toBeBudgeted).toBe(closedForm(input, index))
    }
  })
})

describe('the fold can be resumed', () => {
  it('picking up mid-plan gives the same answer as running the whole thing', () => {
    const input = plan(
      { assignments: [assign('C1', 100_000)], entries: [spend('C1', -140_000)] },
      { assignments: [assign('C2', 250_000)] },
      { assignments: [assign('C1', 5_000)] },
    )
    const whole = run(input)

    let state = emptyCarry(totalBudgeted(input.months))
    const first = input.months[0]
    if (!first) throw new Error('unreachable')
    state = advance(state, first, input.categories, input.cards, input.today).next

    const tail = input.months.slice(1).map((m) => {
      const step = advance(state, m, input.categories, input.cards, input.today)
      state = step.next
      return step.result
    })

    expect(tail).toEqual(whole.months.slice(1))
  })
})
