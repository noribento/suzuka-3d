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
    // the lights-out banner is a broadcast event with a short lifetime: check it first
    await expect(page.locator('.banner', { hasText: 'LIGHTS OUT' })).toBeVisible()

    const before = await readClock(page)
    await page.waitForTimeout(3000)
    const after = await readClock(page)
    expect(after).not.toBe(before)

    // leader shows LEADER/INTERVAL, everyone else a numeric gap
    await expect(page.locator('.tower .row .gap.leader')).toHaveText(/LEADER|INTERVAL/)
    const gaps = await page.locator('.tower .row .gap:not(.leader)').allTextContents()
    expect(gaps).toHaveLength(21)
    for (const g of gaps) expect(g).toMatch(/^\+\d+\.\d{3}$|^\+\d LAPS?$|^IN PIT$/)
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
    // the tv camera swaps the classic HUD for the world-feed package
    await page.keyboard.press('5')
    await expect(page.locator('.bc-tower .row')).toHaveCount(22)
    await expect(page.locator('.telemetry')).toBeHidden()
    await expect(page.locator('.tower')).toHaveCount(0)

    // Escape → back to the overview with nothing selected and the classic HUD restored
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'OVERVIEW', exact: true })).toHaveClass(/on/)
    await expect(page.locator('.telemetry')).toBeHidden()
    await expect(page.locator('.bc-tower')).toHaveCount(0)
    await expect(page.locator('.tower .row')).toHaveCount(22)
  })

  test('the tv camera shows the world-feed package and hides the operator chrome', async ({ page }) => {
    const issues = await openRace(page)
    await startRace(page)
    await page.keyboard.press('5')
    await expect(page.locator('.hud')).toHaveClass(/broadcast/)
    await expect(page.locator('.bc-tower .lap-value')).toHaveText(/^\d+/)
    await expect(page.locator('.bc-tower .row')).toHaveCount(22)
    const codes = await page.locator('.bc-tower .row .code').allTextContents()
    expect(new Set(codes).size).toBe(22)
    for (const code of codes) expect(code).toMatch(/^[A-Z]{3}$/)
    // the classic chrome is gone: header, weather strip, map, hint, telemetry card
    await expect(page.locator('.header')).toHaveCount(0)
    await expect(page.locator('.weather')).toHaveCount(0)
    await expect(page.locator('.map')).toHaveCount(0)
    await expect(page.locator('.hint')).toHaveCount(0)

    // pin the tower to INTERVAL mode (dev hook) → one-decimal, truncated gaps
    await page.evaluate(() => {
      const dbg = (window as unknown as { __suzuka: { store: { bc: { towerLock: string | null } } } }).__suzuka
      dbg.store.bc.towerLock = 'interval'
    })
    await expect(page.locator('.bc-tower')).toHaveAttribute('data-mode', 'interval')
    await expect(page.locator('.bc-tower .row .gap.label')).toHaveText('INTERVAL')
    const gaps = await page.locator('.bc-tower .row .gap:not(.label)').allTextContents()
    expect(gaps).toHaveLength(21)
    for (const g of gaps) expect(g).toMatch(/^\+\d+\.\d$|^\+\d LAPS?$|^PIT$|^OUT$/)
    // the control bar is operator chrome: shown right after an input, hidden ~3 s later, back on a pointer move
    await expect(page.locator('.controls')).toBeVisible()
    await expect(page.locator('.controls')).toBeHidden({ timeout: 10_000 })
    await page.mouse.move(640, 360)
    await page.mouse.move(660, 380)
    await expect(page.locator('.controls')).toBeVisible()

    // a manual selection identifies the driver with the name strap
    const row2 = page.locator('.bc-tower .row', { has: page.locator('.num', { hasText: /^2$/ }) })
    const code2 = (await row2.locator('.code').textContent())?.trim()
    await row2.click()
    await expect(page.locator('.bc-name')).toBeVisible()
    await expect(page.locator('.bc-name .pos')).toHaveText('2')
    const last = (await page.locator('.bc-name .last').textContent())?.trim() ?? ''
    expect(code2 && last.startsWith(code2.slice(0, 2))).toBeTruthy()

    // AUTO is the same package; the overview brings the classic HUD back
    await page.keyboard.press('6')
    await expect(page.getByRole('button', { name: 'AUTO', exact: true })).toHaveClass(/on/)
    await expect(page.locator('.hud')).toHaveClass(/broadcast/)
    await page.keyboard.press('1')
    await expect(page.locator('.header .gp')).toHaveText('JAPANESE GRAND PRIX')
    await expect(page.locator('.bc-tower')).toHaveCount(0)
    expect(issues.errors, issues.errors.join('\n')).toEqual([])
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
