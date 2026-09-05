#!/usr/bin/env node
/**
 * Deterministic screenshots of the circuit from fixed viewpoints, for comparing the scene with the
 * reference photos (plan §7.5) and for before/after checks of the environment work.
 *
 *   node scripts/shots.mjs                       # all presets, low tier, dev server on :3100
 *   node scripts/shots.mjs --preset t1-b-c,pit   # a subset
 *   node scripts/shots.mjs --tier 1 --url http://localhost:3100 --out .perf/shots
 *
 * Viewpoints are given in track coordinates (s along the lap, lateral +left, height above the
 * road) for both the camera and its look-at point; the page converts them with
 * window.__suzuka.track.pointAt so they follow the road wherever the profile moves. The overview
 * camera (OrbitControls) is driven directly; the race is paused so cars do not blur the compare.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const url = flag('--url', 'http://localhost:3100')
const tier = flag('--tier', '0')
const assets = flag('--assets', null) // '1' forces the external asset pack on (e.g. KTX2 checks on the low tier)
const out = flag('--out', '.perf/shots')
const only = flag('--preset', null)?.split(',')
// --custom "name:sCam,latCam,hCam:sLook,latLook,hLook[:fov]" (repeatable) adds ad-hoc viewpoints
const customs = args.flatMap((a, i) => (a === '--custom' && args[i + 1] ? [args[i + 1]] : [])).map((spec) => {
  const [name, cam, look, fov] = spec.split(':')
  const nums = (t) => t.split(',').map(Number)
  return [name, nums(cam), nums(look), fov ? Number(fov) : 45]
})
const width = Number(flag('--width', 1280))
const height = Number(flag('--height', 720))

/** [name, camera (s, lateral, h), look-at (s, lateral, h), fov] */
export const PRESETS = [
  ['main-grandstand', [5700, -14, 5], [5720, 40, 14], 45],
  ['main-grandstand-far', [5560, -60, 22], [5760, 40, 12], 40],
  ['pit-building', [5760, 30, 9], [5700, -45, 8], 45],
  ['pit-straight-onboard', [5880, -14, 1.4], [40, -12, 1], 65],
  ['leader-tower-t1', [5900, 12, 6], [130, -10, 12], 35],
  ['t1-b-c', [520, -25, 10], [640, 70, 12], 50],
  ['c-stand', [720, -18, 8], [820, 60, 14], 45],
  ['esses-d', [1150, -14, 8], [1280, 40, 12], 45],
  ['nippo-e', [1480, -18, 8], [1560, 45, 18], 45],
  ['degner', [2050, 30, 12], [2150, -20, 4], 45],
  ['hairpin', [2600, 20, 12], [2690, -25, 6], 45],
  ['spoon', [3620, 25, 14], [3740, -45, 8], 45],
  ['130r', [4700, -30, 10], [4830, 40, 8], 45],
  ['chicane', [5120, -18, 10], [5210, 40, 10], 45],
  ['final-corner', [5330, -20, 10], [5430, 45, 16], 45],
  ['overview', null, null, 45],
]

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()) })
  // the first load after a dependency change hits Vite's 504 "Outdated Optimize Dep" once
  for (let attempt = 0; ; attempt++) {
    errors.length = 0
    await page.goto(`${url}/?fx=${tier}&res=0${assets ? `&assets=${assets}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    try {
      await page.locator('.loading').waitFor({ state: 'hidden', timeout: attempt ? 240000 : 90000 })
      break
    } catch (err) {
      if (attempt >= 2) throw err
      console.log('retrying after', errors[0] ?? String(err).slice(0, 80))
    }
  }
  await page.locator('.tower .row').nth(21).waitFor({ timeout: 60000 })
  // the HUD would cover the compare; keep only the 3D view
  if (!args.includes('--hud')) await page.addStyleTag({ content: '.hud, .loading { display: none !important }' })
  // start the race so the grid clears the straight, then pause it
  await page.mouse.click(width / 2, height / 2)
  await page.waitForTimeout(1500)
  await page.keyboard.press('Space')
  for (const [name, cam, look, fov] of [...PRESETS.filter(([n]) => !only || only.includes(n)), ...customs]) {
    await page.evaluate(([cam, look, fov]) => {
      const d = window.__suzuka
      const T = d.THREE
      d.rig.setMode('overview')
      const c = d.rig.camera
      c.fov = fov
      c.updateProjectionMatrix()
      if (!cam) { d.rig.resetOverview?.(); return }
      const p = new T.Vector3(), t = new T.Vector3()
      d.track.pointAt(cam[0], cam[1], p, cam[2])
      d.track.pointAt(look[0], look[1], t, look[2])
      d.rig.controls.target.copy(t)
      c.position.copy(p)
      d.rig.controls.update()
    }, [cam, look, fov])
    // a few frames so the shadow cascades refit and the resolution scaler settles
    await page.waitForTimeout(tier === '1' ? 6000 : 2500)
    const file = join(out, `${name}.png`)
    await page.screenshot({ path: file })
    const info = await page.evaluate(() => ({ calls: window.__suzuka.ctx.renderer.info.render.calls, tris: window.__suzuka.ctx.renderer.info.render.triangles }))
    console.log(`${name.padEnd(22)} ${file}  calls ${info.calls}  tris ${info.tris}`)
  }
  if (errors.length) { console.log('ERRORS:', errors.slice(0, 5)); process.exitCode = 1 }
} finally {
  await browser.close()
}
