import { expect, type Page } from '@playwright/test'

export interface Issues {
  errors: string[]
}

/** Collect page errors and console errors (deprecation warnings are ignored). */
export function collectIssues(page: Page): Issues {
  const issues: Issues = { errors: [] }
  page.on('pageerror', (e) => issues.errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') issues.errors.push(`[console] ${m.text()}`)
  })
  return issues
}

/** Open the site and wait until the 3D scene is built and the grid is populated. */
export async function openRace(page: Page): Promise<Issues> {
  const issues = collectIssues(page)
  await page.goto('/')
  await expect(page.locator('.loading')).toBeHidden({ timeout: 120_000 })
  await expect(page.locator('.tower .row')).toHaveCount(22)
  return issues
}

/** Speed the simulation up and wait for the start lights to go out. */
export async function startRace(page: Page, speed: '1×' | '2×' | '4×' | '8×' = '8×') {
  await page.getByRole('button', { name: speed, exact: true }).click()
  await expect(page.locator('.lights')).toBeHidden({ timeout: 90_000 })
}

export async function readClock(page: Page): Promise<string> {
  return (await page.locator('.header .clock').textContent())?.trim() ?? ''
}
