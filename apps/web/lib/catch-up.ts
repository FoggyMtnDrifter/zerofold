import type { CommandContext } from '@zerofold/commands'
import { enterDueTransactions } from '@zerofold/commands'

/**
 * Bring a plan's schedules up to date before reading anything derived from them.
 *
 * There is no background worker: a self-hosted instance may be off for a fortnight and come
 * back to a fortnight of rent payments due. Catching up on the way in means the first screen
 * someone sees is already right, and it costs one indexed lookup on `date_next <= today` when
 * there is nothing to do.
 *
 * **It must be called by the component that reads the data, not by the layout.** Next renders
 * a layout and its page concurrently, so a catch-up in the layout can commit *after* the page
 * has already queried — which showed up as a register that was missing the rows it had just
 * created, on roughly one load in three. Called here, the write precedes the read that displays
 * it because they are the same function.
 *
 * Writing during a render is normally a smell. It is safe because the whole catch-up runs in
 * one transaction against a watermark, so two simultaneous loads produce the same result as
 * one — the property the scheduler needs anyway.
 */
export function catchUp(ctx: CommandContext, planId: string): void {
  enterDueTransactions(ctx, planId)
}
