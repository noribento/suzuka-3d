#!/usr/bin/env node
/**
 * Bake the parked-car impostor atlas from the project's own low-poly bodies.
 *
 * Serves the repo root on a local port — TypeScript included, transpiled on the fly the way
 * scripts/audit/app-runtime.mjs does for Node, so the page draws exactly the geometry
 * app/three/car-bodies.ts gives the runtime — drives scripts/assets/bake/car-impostor.html in
 * headless Chromium (SwiftShader is fine: 128 px cells, no post) and writes
 *   misc/dl/tex/car_atlas/car_atlas_diff.png   (1024×1024 RGBA, sRGB — lit bodies, paintwork white)
 *   misc/dl/tex/car_atlas/car_atlas_mask.png   (RGB, linear — R = the paintwork the runtime tints)
 *   misc/dl/tex/car_atlas/layout.json          (row → body id, dimensions, cell geometry)
 * import-misc.mjs then encodes them like any other texture (source 'tex/car_atlas'), and the
 * layout is mirrored as CAR_LAYOUT in app/data/impostor-atlas.ts so the runtime needs no fetch.
 *
 *   node scripts/assets/bake-car-atlas.mjs             # bake
 *   node scripts/assets/bake-car-atlas.mjs --port 3112
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const port = Number(flag('--port', 3112))
const OUT = join(ROOT, 'misc/dl/tex/car_atlas')
const require = createRequire(join(ROOT, 'package.json'))
const ts = require('typescript')

/** the atlas geometry — keep in step with CAR_LAYOUT in app/data/impostor-atlas.ts */
const LAYOUT = { cell: 128, cellM: 16, padM: 0.15, yaws: 8, elev: 14, w: 1024, h: 1024 }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' }
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const f = join(ROOT, p)
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' })
  if (extname(f) === '.ts') {
    // the browser needs JavaScript; strip the types and keep the ES modules as they are (the
    // page's import map resolves 'three' and 'three/addons/')
    const out = ts.transpileModule(readFileSync(f, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: false },
    })
    res.end(out.outputText)
    return
  }
  createReadStream(f).pipe(res)
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage({ viewport: { width: LAYOUT.w, height: LAYOUT.h } })
  page.on('pageerror', (e) => { console.error('[page]', e.message) })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()) })
  const query = new URLSearchParams(Object.entries(LAYOUT).map(([k, v]) => [k, String(v)])).toString()
  await page.goto(`http://127.0.0.1:${port}/scripts/assets/bake/car-impostor.html?${query}`)
  await page.waitForFunction(() => window.bakeReady === true, null, { timeout: 60000 })
  mkdirSync(OUT, { recursive: true })
  let result = null
  for (const pass of ['colour', 'mask']) {
    const t0 = Date.now()
    result = await page.evaluate((p) => window.bakeCars(p), pass)
    const png = Buffer.from(result.dataUrl.split(',')[1], 'base64')
    const out = join(OUT, pass === 'colour' ? 'car_atlas_diff.png' : 'car_atlas_mask.png')
    writeFileSync(out, png)
    console.log(`${pass}: ${png.length} bytes → ${out} (${Date.now() - t0} ms)`)
  }
  const meta = {
    cell: result.cell, cellM: result.cellM, padM: result.padM, yaws: result.yaws, elevs: result.elevs,
    cols: result.cols, rows: result.rows, width: result.width, height: result.height, bodies: result.layout,
  }
  writeFileSync(join(OUT, 'layout.json'), JSON.stringify(meta, null, 2))
  console.table(meta.bodies)
} finally {
  await browser.close()
  server.close()
}
