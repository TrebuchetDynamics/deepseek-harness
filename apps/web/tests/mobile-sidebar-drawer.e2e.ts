// Web e2e scenario: the narrow sidebar overlays a full-size conversation
// instead of moving the center grid item into an implicit row.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(
  new URL('./snapshots/mobile-sidebar-drawer', import.meta.url),
)
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
const VIEWPORT = { width: 390, height: 844 }

interface DrawerMetrics {
  frame: { x: number; y: number; width: number; height: number }
  sidebar: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number; width: number; height: number }
  scrim: {
    x: number
    y: number
    width: number
    height: number
    opacity: string
  }
}

function measureDrawer(page: Page): Promise<DrawerMetrics> {
  return page.locator('[data-drawer]').evaluate((frame) => {
    const sidebar = frame.querySelector<HTMLElement>('[class*="sidebarCol"]')
    const center = frame.querySelector<HTMLElement>('[class*="centerCol"]')
    const scrim = frame.querySelector<HTMLElement>('[class*="scrim"]')
    if (sidebar === null || center === null || scrim === null)
      throw new Error('drawer layout nodes are missing')
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    return {
      frame: rect(frame),
      sidebar: rect(sidebar),
      center: rect(center),
      scrim: { ...rect(scrim), opacity: getComputedStyle(scrim).opacity },
    }
  })
}

function renderGeometry(metrics: DrawerMetrics): string {
  const row = (
    name: string,
    value: DrawerMetrics[keyof DrawerMetrics],
  ): string =>
    `| ${name} | ${String(value.x)} | ${String(value.y)} | ${String(value.width)} | ${String(value.height)} |`
  return [
    '# Mobile sidebar drawer geometry',
    '',
    '| surface | x | y | width | height |',
    '| --- | ---: | ---: | ---: | ---: |',
    row('frame', metrics.frame),
    row('sidebar', metrics.sidebar),
    row('conversation center', metrics.center),
    row('backdrop', metrics.scrim),
    '',
    `Backdrop opacity: ${metrics.scrim.opacity}`,
  ].join('\n')
}

describe('web e2e: mobile sidebar drawer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser, VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.setViewportSize(VIEWPORT)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page
      .locator('[data-sidebar-collapsed="true"]')
      .waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the conversation in the first row behind the drawer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-mobile-sidebar-drawer'))
    const opener = page.getByRole('button', { name: 'Open sidebar' })
    await opener.waitFor({ timeout: 10_000 })
    expect(
      await page.locator('[class*="sidebarCol"]').evaluate((sidebar) => {
        const element = sidebar as HTMLElement
        return {
          inert: element.inert,
          ariaHidden: element.getAttribute('aria-hidden'),
        }
      }),
    ).toEqual({ inert: true, ariaHidden: 'true' })
    await opener.click()
    await page.locator('[data-drawer]').waitFor({ timeout: 10_000 })
    await expect
      .poll(
        async () => {
          const width = await page
            .locator('[data-drawer] [class*="sidebarCol"]')
            .evaluate(sidebar => sidebar.getBoundingClientRect().width)
          return Math.abs(width - 280)
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(0.01)
    const metrics = await measureDrawer(page)
    expect(metrics.center).toEqual(metrics.frame)
    expect(metrics.sidebar).toEqual({ ...metrics.frame, width: 280 })
    expect(metrics.scrim).toEqual({ ...metrics.frame, opacity: '1' })
    await compareOrRefreshGolden(
      GEOMETRY_EXPECTED,
      renderGeometry(metrics),
      MODE,
    )
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-drawer]').count()).toBe(0)
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
    ).toBe('Open sidebar')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('commits exactly the fixture it reads', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })
})
