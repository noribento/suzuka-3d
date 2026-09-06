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

  test('the trackside data drives the barriers, the painted lines and the stands', async ({ page }) => {
    const issues = await openRace(page)
    await page.waitForFunction(() => !!(window as any).__suzuka, null, { timeout: 60_000 })
    const built = await page.evaluate(() => {
      const d = (window as any).__suzuka
      const names: string[] = []
      d.ctx.scene.traverse((o: any) => { if (o.name) names.push(o.name) })
      const stands: string[] = []
      d.env.group.traverse((o: any) => { if (typeof o.name === 'string' && o.name.startsWith('stand-')) stands.push(o.name) })
      const lines = d.ctx.scene.getObjectByName('whiteLines')
      return {
        names,
        stands,
        lineTris: lines ? (lines.geometry.index ? lines.geometry.index.count / 3 : 0) : 0,
        lineAttrs: lines ? Object.keys(lines.geometry.attributes) : [],
      }
    })
    // barriers, the painted-line layer and the offset lanes are all built from the data tables
    for (const name of ['barriers', 'whiteLines', 'lanes']) expect(built.names).toContain(name)
    // the barrier runs produce every kind of trackside furniture
    for (const name of ['barrierWalls', 'tyreWalls', 'guardrails', 'railPosts-0']) {
      expect(built.names.some((n) => n.startsWith(name.split('-')[0]!))).toBe(true)
    }
    // the white lines carry the screen-width attributes and cover the whole lap
    expect(built.lineAttrs).toContain('aAcross')
    expect(built.lineAttrs).toContain('aHalf')
    expect(built.lineTris).toBeGreaterThan(5000)
    // E is two blocks on one hillside, C follows its front edge — neither is a chord slab any more
    expect(built.stands).toContain('stand-E1')
    expect(built.stands).toContain('stand-E2')
    expect(built.stands).toContain('stand-C')
    expect(issues.errors).toEqual([])
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
    // (the 3 s timer plus the leave transition has to land on a software rasteriser running 7-12 fps)
    await expect(page.locator('.controls')).toBeVisible()
    await expect(page.locator('.controls')).toBeHidden({ timeout: 25_000 })
    await page.mouse.move(640, 360)
    await page.mouse.move(660, 380)
    await expect(page.locator('.controls')).toBeVisible()

    // A manual selection identifies the driver with the name strap. Pause around it: the tower is
    // re-sorted continuously and startRace runs at 8×, so reading the row at position 2, clicking
    // it, and reading the strap's own position chip would otherwise be three different moments of
    // the race — one overtake in between and the strap legitimately shows a different position.
    await page.keyboard.press(' ')
    const row2 = page.locator('.bc-tower .row', { has: page.locator('.num', { hasText: /^2$/ }) })
    const code2 = (await row2.locator('.code').textContent())?.trim()
    await row2.click()
    await expect(page.locator('.bc-name')).toBeVisible()
    await expect(page.locator('.bc-name .pos')).toHaveText('2')
    const last = (await page.locator('.bc-name .last').textContent())?.trim() ?? ''
    expect(code2 && last.startsWith(code2.slice(0, 2))).toBeTruthy()
    await page.keyboard.press(' ')

    // AUTO is the same package; the overview brings the classic HUD back
    await page.keyboard.press('6')
    await expect(page.getByRole('button', { name: 'AUTO', exact: true })).toHaveClass(/on/)
    await expect(page.locator('.hud')).toHaveClass(/broadcast/)
    await page.keyboard.press('1')
    await expect(page.locator('.header .gp')).toHaveText('JAPANESE GRAND PRIX')
    await expect(page.locator('.bc-tower')).toHaveCount(0)
    expect(issues.errors, issues.errors.join('\n')).toEqual([])
  })

  test('WASD flies the overview camera over the ground plane', async ({ page }) => {
    const issues = await openRace(page)
    type V = { x: number; y: number; z: number }
    type Dbg = { rig: { camera: { position: V }; controls: { target: V } }; ctx: { renderer: { info: { render: { frame: number } } } } }
    const read = () =>
      page.evaluate(() => {
        const { rig, ctx } = (window as unknown as { __suzuka: Dbg }).__suzuka
        const pick = (v: V) => ({ x: v.x, y: v.y, z: v.z })
        return { cam: pick(rig.camera.position), target: pick(rig.controls.target), frame: ctx.renderer.info.render.frame }
      })
    const flat = (a: V, b: V) => ({ x: b.x - a.x, z: b.z - a.z })
    const len = (d: { x: number; z: number }) => Math.hypot(d.x, d.z)
    const dot = (a: { x: number; z: number }, b: { x: number; z: number }) => (a.x * b.x + a.z * b.z) / (len(a) * len(b))
    // SwiftShader renders only a few frames a second and the key state is sampled once per frame,
    // so every step below is counted in rendered frames rather than in wall-clock time
    const waitFrames = async (n: number, from?: number) => {
      const start = from ?? (await read()).frame
      let cur = await read()
      for (let i = 0; i < 200 && cur.frame < start + n; i++) {
        await page.waitForTimeout(100)
        cur = await read()
      }
      expect(cur.frame).toBeGreaterThanOrEqual(start + n)
      return cur
    }
    const hold = async (key: string) => {
      const from = (await read()).frame
      await page.keyboard.down(key)
      await waitFrames(6, from)
      await page.keyboard.up(key)
    }
    /** The released velocity is smoothed out over a few frames: wait until two frames agree. */
    const settle = async () => {
      let prev = await read()
      for (let i = 0; i < 100; i++) {
        const cur = await waitFrames(2, prev.frame)
        if (len(flat(prev.cam, cur.cam)) < 0.005) return cur
        prev = cur
      }
      throw new Error('the overview camera did not come to rest')
    }

    const start = await read()
    // W: forward = the ground-plane view direction (camera → pivot)
    const view = flat(start.cam, start.target)
    await hold('w')
    const afterW = await settle()
    const movedW = flat(start.cam, afterW.cam)
    expect(len(movedW)).toBeGreaterThan(50)
    expect(dot(movedW, view)).toBeGreaterThan(0.99)
    // the pivot rides along and the camera stays at its height
    const pivotW = flat(start.target, afterW.target)
    expect(Math.abs(pivotW.x - movedW.x)).toBeLessThan(0.05)
    expect(Math.abs(pivotW.z - movedW.z)).toBeLessThan(0.05)
    expect(Math.abs(afterW.cam.y - start.cam.y)).toBeLessThan(0.01)
    expect(Math.abs(afterW.target.y - start.target.y)).toBeLessThan(0.01)

    // D: sideways, at right angles to the view, to screen-right
    await hold('d')
    const afterD = await settle()
    const movedD = flat(afterW.cam, afterD.cam)
    expect(len(movedD)).toBeGreaterThan(50)
    expect(Math.abs(dot(movedD, view))).toBeLessThan(0.05)
    // screen-right is the view direction turned clockwise seen from above: (x, z) → (-z, x)
    expect(dot(movedD, { x: -view.z, z: view.x })).toBeGreaterThan(0.99)

    // released keys: no drift
    const still = await waitFrames(4, afterD.frame)
    expect(len(flat(afterD.cam, still.cam))).toBeLessThan(0.02)

    // a follow camera ignores the keys: the orbit pivot is left where the overview parked it
    await page.keyboard.press('2')
    await expect(page.getByRole('button', { name: 'HELI', exact: true })).toHaveClass(/on/)
    await hold('w')
    const heli = await read()
    expect(len(flat(afterD.target, heli.target))).toBeLessThan(0.01)
    expect(heli.target.y).toBeCloseTo(afterD.target.y, 3)

    // back in the overview the framing is reset and the keys work again
    await page.keyboard.press('1')
    await expect(page.getByRole('button', { name: 'OVERVIEW', exact: true })).toHaveClass(/on/)
    const reset = await read()
    await hold('s')
    const afterS = await settle()
    expect(len(flat(reset.cam, afterS.cam))).toBeGreaterThan(50)
    expect(dot(flat(reset.cam, afterS.cam), view)).toBeLessThan(-0.99)
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
