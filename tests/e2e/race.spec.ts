import { expect, test } from '@playwright/test'
import { openRace, readClock, startRace } from './helpers'

test.describe('Suzuka 3D broadcast', () => {
  test('loads the 3D scene and the broadcast HUD without errors', async ({ page }) => {
    const issues = await openRace(page)

    await expect(page.locator('.header .gp')).toHaveText('JAPANESE GRAND PRIX')
    await expect(page.locator('.tower .lap-value')).toContainText('1')
    await expect(page.locator('.lights .lamp')).toHaveCount(10)
    await expect(page.locator('.map svg g.car')).toHaveCount(22)

    // every grid row has a position, a three-letter code and a tyre compound
    const codes = await page.locator('.tower .row .code').allTextContents()
    expect(new Set(codes).size).toBe(22)
    for (const code of codes) expect(code).toMatch(/^[A-Z]{3}$/)
    const tyres = await page.locator('.tower .row .tyre').allTextContents()
    for (const t of tyres) expect(['S', 'M', 'H']).toContain(t)

    // the WebGL renderer is actually drawing the scene (dev-only debug hook)
    const stats = await page.evaluate(() => {
      const dbg = (window as unknown as { __suzuka?: { ctx: { renderer: { info: { render: { calls: number; triangles: number } } } }; models: unknown[] } }).__suzuka
      return dbg ? { calls: dbg.ctx.renderer.info.render.calls, triangles: dbg.ctx.renderer.info.render.triangles, cars: dbg.models.length } : null
    })
    expect(stats).not.toBeNull()
    expect(stats!.cars).toBe(22)
    expect(stats!.calls).toBeGreaterThan(50)
    expect(stats!.triangles).toBeGreaterThan(10_000)

    expect(issues.errors, issues.errors.join('\n')).toEqual([])
  })

  test('runs the start sequence and the race gets under way', async ({ page }) => {
    const issues = await openRace(page)
    await startRace(page)

    const before = await readClock(page)
    await page.waitForTimeout(3000)
    const after = await readClock(page)
    expect(after).not.toBe(before)

    // leader shows LEADER/INTERVAL, everyone else a numeric gap
    await expect(page.locator('.tower .row .gap.leader')).toHaveText(/LEADER|INTERVAL/)
    const gaps = await page.locator('.tower .row .gap:not(.leader)').allTextContents()
    expect(gaps).toHaveLength(21)
    for (const g of gaps) expect(g).toMatch(/^\+\d+\.\d{3}$|^\+\d LAPS?$|^IN PIT$/)

    // the lights-out banner is a broadcast event
    await expect(page.locator('.banner', { hasText: 'LIGHTS OUT' })).toBeVisible()
    expect(issues.errors, issues.errors.join('\n')).toEqual([])
  })

  test('selecting a driver shows telemetry and camera modes switch', async ({ page }) => {
    await openRace(page)
    await startRace(page)

    // no telemetry until a driver is selected
    await expect(page.locator('.telemetry')).toBeHidden()

    // click the P3 row → telemetry follows that driver
    const row3 = page.locator('.tower .row', { has: page.locator('.pos', { hasText: /^3$/ }) })
    const code3 = (await row3.locator('.code').textContent())?.trim()
    await row3.click()
    await expect(page.locator('.telemetry .posbadge')).toHaveText('P3')
    const lastName = (await page.locator('.telemetry .last').textContent())?.trim() ?? ''
    expect(code3 && lastName.startsWith(code3.slice(0, 2))).toBeTruthy()
    await expect(page.locator('.telemetry .speed .value')).toHaveText(/^\d+$/)
    await expect(page.locator('.telemetry .gear .value')).toHaveText(/^[N1-8]$/)

    // keyboard camera switching mirrors the control bar
    for (const [key, label] of [['2', 'HELI'], ['3', 'CHASE'], ['4', 'ONBOARD'], ['5', 'TV'], ['1', 'OVERVIEW']] as const) {
      await page.keyboard.press(key)
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveClass(/on/)
    }
    await page.keyboard.press('5')
    await expect(page.locator('.telemetry .cam')).toContainText('CAM')

    // Escape → back to the overview with nothing selected
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'OVERVIEW', exact: true })).toHaveClass(/on/)
    await expect(page.locator('.telemetry')).toBeHidden()
  })

  test('pause, driver tags and restart shortcuts work', async ({ page }) => {
    await openRace(page)
    await startRace(page)

    await page.keyboard.press(' ')
    const paused = await readClock(page)
    await page.waitForTimeout(2500)
    expect(await readClock(page)).toBe(paused)
    await page.keyboard.press(' ')
    await page.waitForTimeout(2500)
    expect(await readClock(page)).not.toBe(paused)

    await expect(page.locator('.car-label:visible').first()).toBeVisible()
    await page.keyboard.press('l')
    await expect(page.getByRole('button', { name: 'TAGS', exact: true })).not.toHaveClass(/on/)
    await expect(page.locator('.car-label:visible')).toHaveCount(0)
    await page.keyboard.press('l')

    await page.getByRole('button', { name: 'Restart the race' }).click()
    await expect(page.locator('.lights')).toBeVisible()
    await expect(page.locator('.header .clock')).toHaveText('0:00:00')
  })
})
