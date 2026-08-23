import { expect, test } from '@playwright/test'

/**
 * The render half of the §6 performance budget.
 *
 * The query half is covered by a unit benchmark; this measures what that one deliberately
 * cannot — paint and scroll in a real browser at the same 50,000-row volume.
 *
 * Playwright is the right home for it because it runs a genuinely visible viewport. Measuring
 * paint in a hidden or backgrounded page reports numbers in the seconds regardless of how fast
 * the page is, because the browser simply does not paint one.
 */
const BUDGET = {
  interactiveMs: 500,
  /** 60Hz vsync. A frame INTERVAL can never be shorter than this. */
  vsyncMs: 16.7,
  /** An interval longer than this means at least one frame was missed. */
  droppedFrameMs: 16.7 * 1.5,
  /** Tolerated share of dropped frames — GC and the harness itself cost a few. */
  maxDroppedShare: 0.1,
  domRowCap: 80,
}

test.describe('register at 50,000 rows', () => {
  test('becomes interactive within budget and virtualises the DOM', async ({ page }) => {
    await page.goto('/dev-register')
    await page.getByRole('grid', { name: 'Transactions' }).waitFor()

    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      return {
        domInteractive: nav.domInteractive,
        firstContentfulPaint: fcp?.startTime ?? null,
        visibility: document.visibilityState,
      }
    })

    // If this is not 'visible' the paint numbers below mean nothing, so assert it rather than
    // reporting a figure that looks like a measurement and is not.
    expect(timing.visibility).toBe('visible')
    expect(timing.domInteractive).toBeLessThan(BUDGET.interactiveMs)
    if (timing.firstContentfulPaint !== null) {
      expect(timing.firstContentfulPaint).toBeLessThan(BUDGET.interactiveMs)
    }

    // The whole point of virtualising: the DOM holds a screenful, not the dataset.
    const domRows = await page.locator('[role="row"][aria-rowindex]').count()
    expect(domRows).toBeGreaterThan(0)
    expect(domRows).toBeLessThan(BUDGET.domRowCap)
    await expect(page.getByText('50,000 transactions')).toBeVisible()
  })

  test('holds frame budget while scrolling, and keeps the DOM bounded', async ({ page }) => {
    await page.goto('/dev-register')
    const grid = page.getByRole('grid', { name: 'Transactions' })
    await grid.waitFor()

    const result = await page.evaluate(async () => {
      const el = document.querySelector('[role="grid"]') as HTMLElement
      const frames: number[] = []
      el.scrollTop = 0
      await new Promise(requestAnimationFrame)
      let last = performance.now()
      for (let i = 0; i < 120; i++) {
        el.scrollTop += 320 // ten rows a frame
        await new Promise(requestAnimationFrame)
        const now = performance.now()
        frames.push(now - last)
        last = now
      }
      frames.sort((a, b) => a - b)
      return {
        median: frames[Math.floor(frames.length / 2)] as number,
        p95: frames[Math.floor(frames.length * 0.95)] as number,
        dropped: frames.filter((f) => f > 16.7 * 1.5).length,
        total: frames.length,
        domRows: document.querySelectorAll('[role="row"][aria-rowindex]').length,
        scrolled: el.scrollTop,
      }
    })

    console.log(
      `    frames — median ${result.median.toFixed(1)}ms, p95 ${result.p95.toFixed(1)}ms, ` +
        `${result.dropped}/${result.total} dropped; ${result.domRows} DOM rows ` +
        `after scrolling to ${result.scrolled}px`,
    )

    /**
     * Measure dropped frames, not raw interval.
     *
     * A rAF interval cannot be shorter than the vsync period, so asserting `median < 16.7`
     * is asking the browser to beat its own refresh rate — it passes only by floating-point
     * luck and fails the moment the machine is busy. That is a flaky test dressed as a
     * performance budget. What actually matters is whether frames were *missed*.
     */
    expect(
      result.dropped / result.total,
      `${result.dropped} of ${result.total} frames exceeded 1.5x vsync`,
    ).toBeLessThanOrEqual(BUDGET.maxDroppedShare)
    // The median should sit at vsync, meaning the work fits in a frame with room to spare.
    expect(result.median).toBeLessThan(BUDGET.droppedFrameMs)
    expect(result.domRows).toBeLessThan(BUDGET.domRowCap)
    expect(result.scrolled).toBeGreaterThan(30_000)
  })

  test('is operable from the keyboard alone', async ({ page }) => {
    // §5 requires everything reachable by mouse to be reachable by keyboard. Power users live
    // in the register, and reaching for a mouse to move one row is the difference between a
    // tool and a form.
    await page.goto('/dev-register')
    const grid = page.getByRole('grid', { name: 'Transactions' })
    await grid.waitFor()
    await grid.focus()

    await page.keyboard.press('End')
    await expect
      .poll(() =>
        page.evaluate(() => (document.querySelector('[role="grid"]') as HTMLElement).scrollTop),
      )
      .toBeGreaterThan(1_000_000)

    await page.keyboard.press('Home')
    await expect
      .poll(() =>
        page.evaluate(() => (document.querySelector('[role="grid"]') as HTMLElement).scrollTop),
      )
      .toBe(0)

    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press(' ')
    await expect(page.getByText('1 selected')).toBeVisible()
  })
})
