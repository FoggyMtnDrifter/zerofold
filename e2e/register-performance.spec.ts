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
  frameMs: 16.7,
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
        domRows: document.querySelectorAll('[role="row"][aria-rowindex]').length,
        scrolled: el.scrollTop,
      }
    })

    // eslint-disable-next-line no-console
    console.log(
      `    frames — median ${result.median.toFixed(1)}ms, p95 ${result.p95.toFixed(1)}ms; ` +
        `${result.domRows} DOM rows after scrolling to ${result.scrolled}px`,
    )

    // p95 rather than the worst frame: a single long frame is usually the harness or GC, and a
    // budget that fails on one outlier is a budget people learn to ignore.
    expect(result.p95).toBeLessThan(BUDGET.frameMs * 2)
    expect(result.median).toBeLessThan(BUDGET.frameMs)
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
