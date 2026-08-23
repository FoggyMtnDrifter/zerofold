import { budgetMonth } from '@zerofold/shared/date'
import { type Milliunits, milli, ZERO } from '@zerofold/shared/money'
import { describe, expect, it } from 'vitest'
import { advance, emptyCarry, totalBudgeted } from './advance.ts'
import { run } from './run.ts'
import type { CellInput, EngineInput, MonthInput } from './types.ts'

/**
 * The engine, checked against what the oracle actually did.
 *
 * The five-step table in `docs/behavior/P0-A-ready-to-assign-formula.md` is a measured
 * sequence, not an invented one, and it is reproduced here step for step. A test written from
 * the formula alone would agree with whatever the formula says; this one can disagree with it.
 */

const AUG = budgetMonth('2026-08-01')
const SEP = budgetMonth('2026-09-01')
const OCT = budgetMonth('2026-10-01')

const CATEGORIES = ['C1', 'C2', 'C3']

const cell = (
  categoryId: string,
  budgeted: number,
  activity = 0,
  creditActivity = 0,
): CellInput => ({
  categoryId,
  budgeted: milli(budgeted),
  activity: milli(activity),
  creditActivity: milli(creditActivity),
})

/** August carries the 1000000 starting balance as income; nothing else earns. */
const plan = (
  aug: readonly CellInput[],
  sep: readonly CellInput[] = [],
  oct: readonly CellInput[] = [],
): EngineInput => ({
  categories: CATEGORIES,
  months: [
    { month: AUG, income: milli(1_000_000), cells: aug },
    { month: SEP, income: ZERO, cells: sep },
    { month: OCT, income: ZERO, cells: oct },
  ] satisfies MonthInput[],
})

const rta = (input: EngineInput) => run(input).months.map((m) => m.toBeBudgeted)

const balanceOf = (input: EngineInput, month: number, categoryId: string) =>
  run(input).months[month]?.cells.find((c) => c.categoryId === categoryId)?.balance

describe('P0-A, step by step', () => {
  it('step 0 — baseline: every month reports the whole income', () => {
    expect(rta(plan([]))).toEqual([milli(1_000_000), milli(1_000_000), milli(1_000_000)])
  })

  it('step 1 — an assignment in September reduces August (R9)', () => {
    const input = plan([], [cell('C2', 300_000)])
    expect(rta(input)).toEqual([milli(700_000), milli(700_000), milli(700_000)])
  })

  it('step 3 — a positive balance carries forward untouched (R11)', () => {
    const input = plan([cell('C1', 100_000)])
    expect(rta(input)).toEqual([milli(900_000), milli(900_000), milli(900_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(100_000))
    expect(balanceOf(input, 1, 'C1')).toBe(milli(100_000))
  })

  it('step 4 — cash overspending zeroes the category and charges the *next* month (R10)', () => {
    const input = plan([cell('C1', 100_000, -140_000)])

    // August's own RTA is untouched; only September onward pays for it.
    expect(rta(input)).toEqual([milli(900_000), milli(860_000), milli(860_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(-40_000))
    expect(balanceOf(input, 1, 'C1')).toBe(ZERO)
  })

  it('step 5 — Ready to Assign goes negative and is not clamped (R12)', () => {
    const input = plan([cell('C1', 100_000, -140_000), cell('C3', 5_000_000)])
    expect(rta(input)).toEqual([milli(-4_100_000), milli(-4_140_000), milli(-4_140_000)])
  })

  it('re-confirmation — a future assignment and a past overspend at the same time', () => {
    // From the doc's independent re-run, where both terms are exercised together.
    const input = plan([cell('C1', 100_000, -140_000)], [cell('C2', 250_000)])
    expect(rta(input)).toEqual([milli(650_000), milli(610_000), milli(610_000)])
  })
})

describe('credit overspending', () => {
  it('zeroes the category next month but leaves Ready to Assign alone (R61)', () => {
    const input = plan([cell('C1', 0, -30_000, -30_000)])

    expect(rta(input)).toEqual([milli(1_000_000), milli(1_000_000), milli(1_000_000)])
    expect(balanceOf(input, 0, 'C1')).toBe(milli(-30_000))
    expect(balanceOf(input, 1, 'C1')).toBe(ZERO)
  })

  it('spends cash before it covers credit (R2)', () => {
    // 100000 assigned, 60000 spent in cash and 80000 on the card. Cash goes first, leaving
    // 40000 to cover the card, so 40000 of the card charge is uncovered — and none of it is
    // cash overspending, because the cash spending was fully funded.
    const input = plan([cell('C1', 100_000, -140_000, -80_000)])
    const c1 = run(input).months[0]?.cells.find((c) => c.categoryId === 'C1')

    expect(c1?.cashOverspend).toBe(ZERO)
    expect(c1?.creditOverspend).toBe(milli(40_000))
    expect(c1?.overspendKind).toBe('credit')
    // Nothing left the budget, so next month is unaffected.
    expect(rta(input)[1]).toBe(milli(1_000_000 - 100_000))
  })

  it('reports both kinds when a category is overspent twice over', () => {
    // Nothing assigned: the 20000 of cash spending is unfunded, and the whole card charge is
    // uncovered on top of it.
    const input = plan([cell('C1', 0, -50_000, -30_000)])
    const c1 = run(input).months[0]?.cells.find((c) => c.categoryId === 'C1')

    expect(c1?.cashOverspend).toBe(milli(20_000))
    expect(c1?.creditOverspend).toBe(milli(30_000))
    // Cash wins the label, because cash is the half the budget has to absorb.
    expect(c1?.overspendKind).toBe('cash')
    expect(rta(input)[1]).toBe(milli(980_000))
  })
})

describe('month totals', () => {
  it('sums assignments and activity across categories', () => {
    const input = plan([cell('C1', 100_000, -40_000), cell('C2', 50_000, -10_000)])
    const august = run(input).months[0]

    expect(august?.budgeted).toBe(milli(150_000))
    expect(august?.activity).toBe(milli(-50_000))
    expect(august?.income).toBe(milli(1_000_000))
  })
})

describe('the closed form and the fold agree', () => {
  /**
   * R8 as written, computed independently of the fold.
   *
   * The point is not to check the arithmetic twice — it is that the fold carries state and the
   * closed form does not, so the two disagree the moment a window term is wrong.
   */
  const closedForm = (input: EngineInput, index: number): Milliunits => {
    let income = 0n
    for (const [i, month] of input.months.entries()) {
      if (i <= index) income += month.income
    }
    let budgeted = 0n
    for (const month of input.months) {
      for (const c of month.cells) budgeted += c.budgeted
    }
    let overspend = 0n
    const folded = run(input).months
    for (const [i, month] of folded.entries()) {
      if (i >= index) break
      for (const c of month.cells) overspend += c.cashOverspend
    }
    return (income - budgeted - overspend) as Milliunits
  }

  const CASES: readonly EngineInput[] = [
    plan([]),
    plan([cell('C1', 100_000)]),
    plan([cell('C1', 100_000, -140_000)]),
    plan([cell('C1', 100_000, -140_000)], [cell('C2', 250_000)]),
    plan([cell('C1', 100_000, -140_000), cell('C3', 5_000_000)], [cell('C2', 250_000)]),
    plan([cell('C1', 0, -50_000, -30_000)], [cell('C2', 10_000, -90_000)]),
    plan([cell('C1', 33_333, -1)], [cell('C2', 7)], [cell('C3', 999_999_999)]),
  ]

  it.each(CASES.map((input, i) => [i, input] as const))('case %i', (_i, input) => {
    const folded = run(input).months
    for (const [index, month] of folded.entries()) {
      expect(month.toBeBudgeted).toBe(closedForm(input, index))
    }
  })
})

describe('the fold can be resumed', () => {
  it('picking up mid-plan gives the same answer as running the whole thing', () => {
    const input = plan([cell('C1', 100_000, -140_000)], [cell('C2', 250_000)], [cell('C1', 5_000)])
    const whole = run(input)

    // Re-run the tail from the state the first month left behind.
    let state = emptyCarry(totalBudgeted(input.months))
    const first = input.months[0]
    if (!first) throw new Error('unreachable')
    state = advance(state, first, input.categories).next

    const tail = input.months.slice(1).map((month) => {
      const step = advance(state, month, input.categories)
      state = step.next
      return step.result
    })

    expect(tail).toEqual(whole.months.slice(1))
  })
})
