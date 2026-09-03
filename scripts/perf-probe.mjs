#!/usr/bin/env node
/**
 * Render-cost probe: drives the running dev server in Playwright's Chromium, walks the camera
 * modes on both quality tiers and samples renderer.info (draw calls, triangles), memory, the
 * program count and the dev-only per-section frame timings exposed on window.__suzuka.perf.
 *
 *   pnpm dev --port 3100          # in another shell (or reuse the e2e server)
 *   node scripts/perf-probe.mjs   # SwiftShader, like the e2e suite
 *   node scripts/perf-probe.mjs --gpu   # use the machine's GPU
 *   node scripts/perf-probe.mjs --tiers 1 --modes 4,5 --frames 120 --label after-C04
 *
 * Prints a markdown table and writes .perf/<label>-<timestamp>.json (outside Playwright's
 * test-results/, which the e2e suite wipes on every run).
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def
}
const gpu = args.includes('--gpu')
const port = Number(process.env.E2E_PORT ?? 3100)
const base = process.env.PROBE_URL ?? `http://localhost:${port}`
const tiers = flag('--tiers', '1,0').split(',')
const modes = flag('--modes', '1,2,3,4,5').split(',')
const frames = Number(flag('--frames', '90'))
const label = flag('--label', 'probe')
const outDir = join(process.cwd(), '.perf')

const launchArgs = gpu
  ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

const browser = await chromium.launch({ args: launchArgs })
const results = []
try {
  for (const tier of tiers) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
    })
    const t0 = Date.now()
    await page.goto(`${base}/?fx=${tier}`)
    await page.locator('.loading').waitFor({ state: 'hidden', timeout: 180_000 })
    await page.locator('.tower .row').nth(21).waitFor({ timeout: 60_000 })
    const loadMs = Date.now() - t0
    await page.getByRole('button', { name: '8×', exact: true }).click()
    // wait for the race to be under way (the start sequence runs at most 4× real time) so the
    // samples measure a moving field, not the grid; then let the first corners spread the cars out
    await page.waitForFunction(() => { const d = window.__suzuka; return !!d && d.race.status === 'racing' && d.race.time > 20 }, null, { timeout: 240_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    for (const mode of modes) {
      await page.keyboard.press(mode)
      await page.waitForTimeout(2500)
      const sample = await page.evaluate(async (n) => {
        const dbg = window.__suzuka
        if (!dbg) return null
        const calls = []
        const tris = []
        await new Promise((resolve) => {
          let i = 0
          const tick = () => {
            const r = dbg.ctx.renderer.info.render
            calls.push(r.calls)
            tris.push(r.triangles)
            if (++i < n) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
        const stat = (a) => ({ min: Math.min(...a), max: Math.max(...a), mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length) })
        const info = dbg.ctx.renderer.info
        const perf = dbg.perf ? { ...dbg.perf } : null
        const perfMax = dbg.perfMax ? { ...dbg.perfMax } : null
        return {
          calls: stat(calls),
          triangles: stat(tris),
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs ? info.programs.length : -1,
          pixelRatio: dbg.ctx.renderer.getPixelRatio(),
          depthMode: dbg.ctx.depthMode ?? (dbg.ctx.renderer.capabilities.logarithmicDepthBuffer ? 'log' : 'standard'),
          tier: dbg.ctx.tier,
          mode: dbg.rig.mode,
          fps: dbg.store ? dbg.store.fps : undefined,
          setupMs: dbg.setupMs,
          perf,
          perfMax,
        }
      }, frames)
      results.push({ tierParam: tier, modeKey: mode, loadMs, errors: errors.slice(), ...sample })
    }
    await page.close()
  }
} finally {
  await browser.close()
}

const fmt = (v) => (v === undefined || v === null ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v))
const perfKeys = ['sim', 'place', 'fx', 'cam', 'audio', 'render', 'labels', 'hud']
console.log(`| tier | mode | calls (min/mean/max) | triangles (mean) | programs | tex | DPR | depth | ${perfKeys.map((k) => `${k} ms`).join(' | ')} |`)
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | ${perfKeys.map(() => '---').join(' | ')} |`)
for (const r of results) {
  if (!r.calls) {
    console.log(`| ${r.tierParam} | ${r.modeKey} | (no __suzuka hook — dev server?) |`)
    continue
  }
  const perf = r.perf ?? {}
  console.log(
    `| ${r.tier} | ${r.mode} | ${r.calls.min}/${r.calls.mean}/${r.calls.max} | ${r.triangles.mean} | ${r.programs} | ${r.textures} | ${fmt(r.pixelRatio)} | ${r.depthMode} | ${perfKeys.map((k) => fmt(perf[k])).join(' | ')} |`,
  )
}
for (const r of results) if (r.errors.length) console.log(`errors (${r.tierParam}/${r.modeKey}):\n  ${r.errors.join('\n  ')}`)
console.log(`load: ${results.map((r) => `${r.tierParam}=${r.loadMs} ms`).join(', ')}; setupMs: ${results.map((r) => fmt(r.setupMs)).join(', ')}`)

mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ gpu, base, frames, results }, null, 2))
console.log(`written ${file}`)
