import { schema } from '@zerofold/db'
import type { CommandContext } from '../context.ts'

export interface CreatePlanInput {
  readonly name: string
  readonly timezone: string
  readonly currency?: Partial<schema.CurrencyFormat>
  readonly dateFormat?: string
  readonly firstDayOfWeek?: number
}

const USD: schema.CurrencyFormat = {
  iso_code: 'USD',
  example_format: '123,456.78',
  decimal_digits: 2,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: '$',
  display_symbol: true,
}

/**
 * The starter category set.
 *
 * Written for Zerofold — deliberately not a copy of any other product's defaults. These are a
 * scaffold to edit, not a prescription; the grouping exists mainly so a new plan is not an
 * intimidating blank grid.
 */
const STARTER_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Monthly Bills', ['Housing', 'Electricity', 'Water', 'Internet', 'Phone']],
  ['Essentials', ['Groceries', 'Transport', 'Health']],
  ['Discretionary', ['Eating Out', 'Hobbies', 'Subscriptions']],
  ['Set Aside', ['Emergency Fund', 'Annual Expenses']],
]

export interface CreatePlanResult {
  readonly planId: string
  readonly inflowCategoryId: string
  readonly uncategorizedCategoryId: string
  readonly creditCardPaymentsGroupId: string
}

/**
 * Create a plan, seeded with the structure the budgeting model requires.
 *
 * Three groups are system-owned and marked internal (R48):
 *
 *   Internal Master Category   holds `Inflow: Ready to Assign` and `Uncategorized`
 *   Credit Card Payments       populated automatically as credit accounts are added
 *   Hidden Categories          legacy in the oracle; created for wire fidelity
 *
 * Note the internal *categories* are exactly two. A credit-card payment category is **not**
 * one of them — it reports `internal: false` on the wire despite living in an internal group,
 * which is why our `internalKind` is a richer classification than the boolean we emit.
 */
export function createPlan(ctx: CommandContext, input: CreatePlanInput): CreatePlanResult {
  return ctx.db.transaction((tx) => {
    const planId = ctx.newId()

    tx.insert(schema.plan)
      .values({
        id: planId,
        name: input.name,
        currencyFormat: { ...USD, ...input.currency },
        dateFormat: input.dateFormat ?? 'MM/DD/YYYY',
        firstDayOfWeek: input.firstDayOfWeek ?? 0,
        timezone: input.timezone,
        firstMonth: null,
        lastMonth: null,
        serverKnowledge: 0,
        deleted: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run()

    tx.insert(schema.planMembership)
      .values({ planId, userId: ctx.userId, role: 'owner', createdAt: ctx.now, updatedAt: ctx.now })
      .run()

    tx.insert(schema.planRecalc)
      .values({ planId, dirtyFromMonth: null, epoch: 0, lastRunAt: null, runningBy: null })
      .run()

    const group = (name: string, internalKind: schema.GroupKind | null, sortOrder: number) => {
      const id = ctx.newId()
      tx.insert(schema.categoryGroup)
        .values({
          id,
          planId,
          name,
          hidden: false,
          sortOrder,
          internalKind,
          knowledgeAtChange: 0,
          deleted: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run()
      return id
    }

    const category = (
      groupId: string,
      name: string,
      internalKind: schema.CategoryKind | null,
      sortOrder: number,
    ) => {
      const id = ctx.newId()
      tx.insert(schema.category)
        .values({
          id,
          planId,
          categoryGroupId: groupId,
          name,
          note: null,
          hidden: false,
          sortOrder,
          internalKind,
          creditAccountId: null,
          originalCategoryGroupId: null,
          knowledgeAtChange: 0,
          deleted: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run()
      return id
    }

    const internalMaster = group('Internal Master Category', 'internal_master', -100)
    const inflowCategoryId = category(internalMaster, 'Inflow: Ready to Assign', 'inflow_rta', 0)
    const uncategorizedCategoryId = category(internalMaster, 'Uncategorized', 'uncategorized', 1)

    const creditCardPaymentsGroupId = group('Credit Card Payments', 'credit_card_payments', -50)
    group('Hidden Categories', 'hidden', 1000)

    STARTER_GROUPS.forEach(([groupName, categories], groupIndex) => {
      const groupId = group(groupName, null, groupIndex)
      categories.forEach((name, i) => {
        category(groupId, name, null, i)
      })
    })

    return { planId, inflowCategoryId, uncategorizedCategoryId, creditCardPaymentsGroupId }
  })
}
