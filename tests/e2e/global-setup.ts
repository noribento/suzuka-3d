import { chromium, type FullConfig } from '@playwright/test'

/**
 * Warm the dev server once before the suite: the first page load after `nuxt dev` starts
 * triggers Vite's dependency optimisation, which answers the very first module requests with
 * 504 "Outdated Optimize Dep" — a startup artefact that would otherwise fail the zero-console-
 * error assertion of whichever test happens to run first.
 */
export default async function globalSetup(config: FullConfig) {
  const project = config.projects[0]
  const baseURL = project?.use.baseURL ?? 'http://localhost:3100'
  const args = (project?.use.launchOptions?.args as string[] | undefined) ?? []
  const browser = await chromium.launch({ args })
  try {
    const page = await browser.newPage()
    for (let attempt = 0; attempt < 3; attempt++) {
      let failed = false
      page.once('pageerror', () => (failed = true))
      await page.goto(baseURL, { waitUntil: 'load', timeout: 120_000 }).catch(() => (failed = true))
      await page.waitForTimeout(3000)
      await page.locator('.loading').waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => (failed = true))
      if (!failed) break
    }
  } finally {
    await browser.close()
  }
}
