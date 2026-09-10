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
 * test-results/, which the e2e suite wipes on every run). Sampling starts only after the far
 * field has drained (`__suzuka.env.farField.pending === 0`); every row carries min/max/mean/p90
 * of calls and triangles, `buildMs` (per builder) and `farField` (`stats()`), which
 * scripts/perf-gate.mjs compares against scripts/perf-budgets.json (`pnpm perf` runs both).
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
    // the far field (plan §0c) is built after loading in time slices; sample only once it has
    // drained so the walk measures the finished scene (a build without a far field passes at once)
    await page.waitForFunction(() => { const d = window.__suzuka; return !!d && (!d.env?.farField || d.env.farField.pending === 0) }, null, { timeout: 120_000 })
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
        const stat = (a) => {
          const sorted = [...a].sort((x, y) => x - y)
          const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]
          return { min: sorted[0], max: sorted[sorted.length - 1], mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length), p90 }
        }
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
          settleMs: dbg.settleMs,
          buildMs: dbg.buildMs ?? null,
          farField: dbg.env?.farField?.stats?.() ?? null,
          // what the spectator builders measured (stands.ts / banks.ts / crowd.ts): the seat
          // total and its capacity clamp, the roofs and path frames, the deck-normal check, the
          // banks and the crowd's own budget / rate. The figure count is a GPU cost, so the row
          // belongs beside the draw calls it explains.
          env: dbg.env?.stats
            ? {
                seats: dbg.env.stats.seats.total,
                capacity: dbg.env.stats.seats.capacity.map((c) => `${c.stands.join('+')} ${c.generated}→${c.kept}/${c.seats}`),
                roofs: dbg.env.stats.roofs,
                pathStands: dbg.env.stats.pathStands,
                deckDown: Object.entries(dbg.env.stats.deckUp).filter(([, up]) => !up).map(([id]) => id),
                banks: { people: dbg.env.stats.banks.people, seated: dbg.env.stats.banks.seated, sheets: dbg.env.stats.banks.sheets, tents: dbg.env.stats.banks.tents, bays: dbg.env.stats.banks.bays },
                crowd: dbg.env.stats.crowd,
              }
            : null,
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
console.log(`| tier | mode | calls (min/mean/p90/max) | triangles (mean/p90) | programs | tex | DPR | depth | ${perfKeys.map((k) => `${k} ms`).join(' | ')} |`)
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | ${perfKeys.map(() => '---').join(' | ')} |`)
for (const r of results) {
  if (!r.calls) {
    console.log(`| ${r.tierParam} | ${r.modeKey} | (no __suzuka hook — dev server?) |`)
    continue
  }
  const perf = r.perf ?? {}
  console.log(
    `| ${r.tier} | ${r.mode} | ${r.calls.min}/${r.calls.mean}/${r.calls.p90}/${r.calls.max} | ${r.triangles.mean}/${r.triangles.p90} | ${r.programs} | ${r.textures} | ${fmt(r.pixelRatio)} | ${r.depthMode} | ${perfKeys.map((k) => fmt(perf[k])).join(' | ')} |`,
  )
}
for (const r of results) if (r.farField) console.log(`farField (${r.tierParam}/${r.modeKey}): ${JSON.stringify(r.farField)}`)
for (const r of results) {
  if (!r.env) continue
  const e = r.env
  console.log(`spectators (${r.tierParam}/${r.modeKey}): ${e.seats} seat slots [${e.capacity.join(', ')}], roofs ${e.roofs.join('/')}, path frames ${e.pathStands.join('/')}, decks facing down ${e.deckDown.length ? e.deckDown.join('/') : 'none'}`)
  console.log(`  banks: ${e.banks.people} places (${e.banks.seated} seated), ${e.banks.sheets} sheets, ${e.banks.tents} tents, ${e.banks.bays} banks`)
  console.log(`  crowd: ${e.crowd.impostors} of ${e.crowd.expected} occupied at rate ${e.crowd.rate.toFixed(3)} (budget ${e.crowd.budget}), ${e.crowd.near3d} near 3D, ${e.crowd.bays} bays (${e.crowd.bankBays} on banks, ${e.crowd.bankPeople} people), ${e.crowd.atlas} atlas`)
}
for (const r of results) if (r.errors.length) console.log(`errors (${r.tierParam}/${r.modeKey}):\n  ${r.errors.join('\n  ')}`)
console.log(`load: ${results.map((r) => `${r.tierParam}=${r.loadMs} ms`).join(', ')}; setupMs: ${results.map((r) => fmt(r.setupMs)).join(', ')}; settleMs (terrain clamp): ${results.map((r) => fmt(r.settleMs)).join(', ')}`)

mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ gpu, base, frames, results }, null, 2))
console.log(`written ${file}`)
