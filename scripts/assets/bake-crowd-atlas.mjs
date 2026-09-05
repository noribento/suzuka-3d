#!/usr/bin/env node
/**
 * Bake the spectator impostor atlas from the CC0 Quaternius / Eclair posed figures.
 *
 * Serves the repo root on a local port, drives scripts/assets/bake/impostor.html in headless
 * Chromium (SwiftShader is fine: 128 px cells, no post) and writes
 *   misc/dl/tex/crowd_atlas/crowd_atlas_diff.png   (2048×4096 RGBA, sRGB — lit figures, clothing white/grey)
 *   misc/dl/tex/crowd_atlas/crowd_atlas_mask.png   (RGB, linear — R shirt, G pants, B skin)
 *   misc/dl/tex/crowd_atlas/layout.json            (row → figure id, heights, cell geometry)
 * import-misc.mjs then encodes them like any other texture (source 'tex/crowd_atlas').
 * The layout (one row per figure, 8 yaws × 2 elevations) is also mirrored as constants in
 * app/data/crowd-atlas.ts so the runtime shader needs no JSON fetch.
 *
 *   node scripts/assets/bake-crowd-atlas.mjs            # bake
 *   node scripts/assets/bake-crowd-atlas.mjs --port 3111
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const port = Number(flag('--port', 3111))
const OUT = join(ROOT, 'misc/dl/tex/crowd_atlas')

/** Figures in atlas-row order. Pairs (a, b) are the two flipbook frames of one spectator. */
export const FIGURES = [
  { id: 'male_sitting', file: 'Male_Male Poses_OBJ_Male_Sitting.glb', pose: 'sit' },
  { id: 'male_sitting_cheering', file: 'Male_Male Poses_OBJ_Male_Sitting_Cheering.glb', pose: 'sit' },
  { id: 'female_sitting', file: 'Female_Female Poses_OBJ_Female_Sitting.glb', pose: 'sit' },
  { id: 'female_sitting_cheering', file: 'Female_Female Poses_OBJ_Female_Sitting_Cheering.glb', pose: 'sit' },
  { id: 'male_standing', file: 'Male_Male Poses_OBJ_Male_Standing.glb', pose: 'stand' },
  { id: 'male_standing_waving', file: 'Male_Male Poses_OBJ_Male_Standing_Waving.glb', pose: 'stand' },
  { id: 'female_standing', file: 'Female_Female Poses_OBJ_Female_Standing.glb', pose: 'stand' },
  { id: 'woman_standing_waving', file: 'Female_Female Poses_OBJ_Woman_Standing_Waving.glb', pose: 'stand' },
  { id: 'male_standing_hips', file: 'Male_Male Poses_OBJ_Male_Standing_Hips.glb', pose: 'stand' },
  { id: 'male_lookingup', file: 'Male_Male Poses_OBJ_Male_LookingUp.glb', pose: 'stand' },
  { id: 'female_standing_hips', file: 'Female_Female Poses_OBJ_Female_Standing_Hips.glb', pose: 'stand' },
  { id: 'female_lookingup', file: 'Female_Female Poses_OBJ_Female_LookingUp.glb', pose: 'stand' },
  { id: 'male_standing_coveringeyes', file: 'Male_Male Poses_OBJ_Male_Standing_CoveringEyes.glb', pose: 'stand' },
  { id: 'female_standing_coveringeyes', file: 'Female_Female Poses_OBJ_Female_Standing_CoveringEyes.glb', pose: 'stand' },
]

const MISC_ROOTS = ['misc/crowd/eclair/quaternius_background_posed_humans_glb_cc0_v1', 'misc/crowd/eclair', 'misc/quaternius_background_posed_humans_glb_cc0_v1']
const packRoot = MISC_ROOTS.map(r => join(ROOT, r)).find(r => existsSync(join(r, 'models_glb')))
if (!packRoot) { console.error('Eclair GLB pack not found under misc/ (see plan §1b)'); process.exit(1) }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const f = join(ROOT, p)
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' })
  createReadStream(f).pipe(res)
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: 2048, height: 4096 } })
  page.on('pageerror', (e) => { console.error('[page]', e.message) })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()) })
  await page.goto(`http://127.0.0.1:${port}/scripts/assets/bake/impostor.html`)
  await page.waitForFunction(() => window.bakeReady === true, null, { timeout: 60000 })
  const rel = packRoot.slice(ROOT.length)
  // rows 0..N-1 bare heads, rows N..2N-1 the same figures wearing a cap (team caps are the most
  // visible single feature of a Suzuka crowd; the runtime picks the variant per spectator)
  const figures = [
    ...FIGURES.map(f => ({ id: f.id, url: `${rel}/models_glb/${f.file}`, cap: false })),
    ...FIGURES.map(f => ({ id: `${f.id}_cap`, url: `${rel}/models_glb/${f.file}`, cap: true })),
  ]
  mkdirSync(OUT, { recursive: true })
  let layout = null
  for (const pass of ['colour', 'mask']) {
    const t0 = Date.now()
    const result = await page.evaluate(([figs, p]) => window.bakeFigures(figs, p), [figures, pass])
    const png = Buffer.from(result.dataUrl.split(',')[1], 'base64')
    const out = join(OUT, pass === 'colour' ? 'crowd_atlas_diff.png' : 'crowd_atlas_mask.png')
    writeFileSync(out, png)
    console.log(`${pass}: ${png.length} bytes → ${out} (${Date.now() - t0} ms)`)
    layout = result
  }
  const meta = { cell: layout.cell, cellM: layout.cellM, scale: layout.scale, width: layout.width, height: layout.height, padM: layout.padM, yaws: layout.yaws, elevs: layout.elevs, cols: layout.cols, size: layout.size, figures: layout.layout.map((l, i) => ({ ...l, pose: FIGURES[i % FIGURES.length].pose, cap: i >= FIGURES.length })) }
  writeFileSync(join(OUT, 'layout.json'), JSON.stringify(meta, null, 2))
  console.table(meta.figures)
} finally {
  await browser.close()
  server.close()
}
