#!/usr/bin/env node
/**
 * Deterministic screenshots of the circuit from fixed viewpoints, for comparing the scene with the
 * reference photos (plan §7.5) and for before/after checks of the environment work.
 *
 *   node scripts/shots.mjs                       # all presets, low tier, dev server on :3100
 *   node scripts/shots.mjs --preset t1-b-c,pit   # a subset
 *   node scripts/shots.mjs --tier 1 --url http://localhost:3100 --out .perf/shots
 *
 * Viewpoints (scripts/shot-presets.mjs PRESETS, shared with perf-probe --views) are given in
 * track coordinates (s along the lap, lateral +left, height above the road) for both the camera
 * and its look-at point; the page converts them with window.__suzuka.track.pointAt so they follow
 * the road wherever the profile moves. The overview camera (OrbitControls) is driven directly;
 * the race is paused so cars do not blur the compare.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { PRESETS } from './shot-presets.mjs'

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
  await page.locator('.tower .row').nth(21).waitFor({ timeout: 180000 })
  // the far field is built after loading in time slices; shoot only once it has drained
  const farFieldDrained = () => page.waitForFunction(() => { const d = window.__suzuka; return !!d && (!d.env?.farField || d.env.farField.pending === 0) }, null, { timeout: 120000 })
  await farFieldDrained()
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
    await farFieldDrained()
    const file = join(out, `${name}.png`)
    // the software rasteriser needs well over the 30 s default for a high-tier frame
    await page.screenshot({ path: file, timeout: tier === '1' ? 600000 : 60000 })
    const info = await page.evaluate(() => ({ calls: window.__suzuka.ctx.renderer.info.render.calls, tris: window.__suzuka.ctx.renderer.info.render.triangles }))
    console.log(`${name.padEnd(22)} ${file}  calls ${info.calls}  tris ${info.tris}`)
  }
  if (errors.length) { console.log('ERRORS:', errors.slice(0, 5)); process.exitCode = 1 }
} finally {
  await browser.close()
}
