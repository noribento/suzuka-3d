#!/usr/bin/env node
/**
 * Top-down (north-up) and oblique screenshots of the current scene for every audit section in
 * sections.json, from a dev server (default :3100, low tier, no HUD), for comparing against the
 * aerial overlays of scripts/audit/overlay.mjs and the reference photos in misc/ref/user/.
 *
 *   node scripts/audit/shoot.mjs [--url http://localhost:3100] [--out .cache/audit/shots] [--only 03-t2-b-c,10-200r-bike-chicane]
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { chromium } from 'playwright'

const HERE = dirname(new URL(import.meta.url).pathname)
const sections = JSON.parse(readFileSync(join(HERE, 'sections.json'), 'utf8'))
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const only = flag('--only', null)?.split(',') ?? null
const url = flag('--url', 'http://localhost:3100')
const out = flag('--out', join(HERE, '../../.cache/audit/shots'))
mkdirSync(out, { recursive: true })
const width = 1280, height = 720
const L = 5807
const wrap = (s) => ((s % L) + L) % L

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()) })
  for (let attempt = 0; ; attempt++) {
    errors.length = 0
    await page.goto(`${url}/?fx=0&res=0`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    try {
      await page.locator('.loading').waitFor({ state: 'hidden', timeout: attempt ? 240000 : 90000 })
      break
    } catch (err) {
      if (attempt >= 2) throw err
      console.log('retrying after', errors[0] ?? String(err).slice(0, 80))
    }
  }
  await page.locator('.tower .row').nth(21).waitFor({ timeout: 60000 })
  await page.addStyleTag({ content: '.hud, .loading { display: none !important }' })
  await page.mouse.click(width / 2, height / 2)
  await page.waitForTimeout(1500)
  await page.keyboard.press('Space')
  const shoot = async (name, cam, look, fov, topdown) => {
    await page.evaluate(([cam, look, fov, topdown]) => {
      const d = window.__suzuka
      const T = d.THREE
      d.rig.setMode('overview')
      const c = d.rig.camera
      c.fov = fov
      c.updateProjectionMatrix()
      const p = new T.Vector3(), t = new T.Vector3()
      d.track.pointAt(look[0], look[1], t, look[2])
      if (topdown) {
        // straight down, north up: the camera sits a few metres south of the target
        p.set(t.x, t.y + cam[2], t.z + 4)
      } else d.track.pointAt(cam[0], cam[1], p, cam[2])
      d.rig.controls.target.copy(t)
      c.position.copy(p)
      d.rig.controls.update()
    }, [cam, look, fov, topdown])
    await page.waitForTimeout(2500)
    const file = join(out, `${name}.png`)
    await page.screenshot({ path: file, timeout: 60000 })
    console.log(`${name.padEnd(36)} ${file}`)
  }
  for (const sec of sections) {
    if (only && !only.includes(sec.id)) continue
    const [a, b] = sec.s
    const len = wrap(b - a)
    const mid = wrap(a + len / 2)
    // top-down: height so the section's length fits the 16:9 frame diagonally with margin
    const h = Math.max(260, len * 1.05 + 120)
    await shoot(`${sec.id}-top`, [mid, 0, h], [mid, 0, 0], 45, true)
    // two half-section close-ups at 0.28 m/px
    for (const [k, sq] of [[1, wrap(a + len * 0.25)], [2, wrap(a + len * 0.75)]]) await shoot(`${sec.id}-top${k}`, [sq, 0, 230], [sq, 0, 0], 45, true)
    if (sec.oblique) await shoot(`${sec.id}-oblique`, sec.oblique[0], sec.oblique[1], 50, false)
  }
  if (errors.length) console.log('ERRORS:', errors.slice(0, 5))
} finally {
  await browser.close()
}
