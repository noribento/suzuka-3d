#!/usr/bin/env node
/**
 * Bake the parked-car impostor atlas from the project's own low-poly bodies — and, with `--glb`,
 * from the pack's GLB vehicles for the rows that have one.
 *
 * Drives scripts/assets/bake/car-impostor.html on the shared harness (bake/serve.mjs: the repo
 * served with app/**\/*.ts transpiled the way scripts/audit/app-runtime.mjs feeds Node, headless
 * Chromium on SwiftShader — 128 px cells, no post) so the page draws exactly the geometry
 * app/three/car-bodies.ts gives the runtime, and with `--glb` the geometry app/three/car-glb.ts
 * extracts from the imported vehicle GLBs (public/assets-manifest.json) for the hero level.
 * Writes
 *   misc/dl/tex/car_atlas/car_atlas_diff.png   (1024×1024 RGBA, sRGB — lit bodies, procedural paintwork white)
 *   misc/dl/tex/car_atlas/car_atlas_mask.png   (RGB, linear — R = the paintwork the runtime tints)
 *   misc/dl/tex/car_atlas/layout.json          (row → body id, dimensions, cell geometry, `source` per row)
 * import-misc.mjs then encodes them like any other texture (source 'tex/car_atlas'), and the
 * layout is mirrored as CAR_LAYOUT in app/data/impostor-atlas.ts so the runtime needs no fetch.
 *
 *   node scripts/assets/bake-car-atlas.mjs             # bake, procedural bodies only
 *   node scripts/assets/bake-car-atlas.mjs --glb       # the CAR_GLB rows from the imported GLBs
 *   node scripts/assets/bake-car-atlas.mjs --port 3112
 * Order with the pack: import-misc.mjs --only 'model/vehicles/*' → this --glb → import-misc.mjs --only tex/car_atlas
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, serveAndBake } from './bake/serve.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const port = Number(flag('--port', 3112))
const glb = args.includes('--glb')
const OUT = join(ROOT, 'misc/dl/tex/car_atlas')

/** the atlas geometry — keep in step with CAR_LAYOUT in app/data/impostor-atlas.ts */
const LAYOUT = { cell: 128, cellM: 16, padM: 0.15, yaws: 8, elev: 14, w: 1024, h: 1024 }

const result = await serveAndBake({
  page: 'scripts/assets/bake/car-impostor.html',
  query: { ...LAYOUT, glb: glb ? 1 : 0 },
  out: OUT,
  port,
  viewport: { width: LAYOUT.w, height: LAYOUT.h },
  timeout: 120000,
  run: async (page) => {
    let last = null
    for (const pass of ['colour', 'mask']) {
      const t0 = Date.now()
      last = await page.evaluate((p) => window.bakeCars(p), pass)
      const png = Buffer.from(last.dataUrl.split(',')[1], 'base64')
      const out = join(OUT, pass === 'colour' ? 'car_atlas_diff.png' : 'car_atlas_mask.png')
      writeFileSync(out, png)
      console.log(`${pass}: ${png.length} bytes → ${out} (${Date.now() - t0} ms)`)
    }
    return last
  },
})

const meta = {
  cell: result.cell, cellM: result.cellM, padM: result.padM, yaws: result.yaws, elevs: result.elevs,
  cols: result.cols, rows: result.rows, width: result.width, height: result.height, glb: result.glb, bodies: result.layout,
}
writeFileSync(join(OUT, 'layout.json'), JSON.stringify(meta, null, 2))
console.table(meta.bodies.map(({ id, row, length, width, height, tris, source, key, drawn }) => ({ id, row, length, width, height, tris, source, key: key ?? '', drawnW: drawn.width, drawnH: drawn.height })))
if (glb) {
  const fell = meta.bodies.filter((b) => b.source === 'procedural' && ['minivan', 'kei', 'coach', 'keitruck'].includes(b.id))
  if (fell.length) console.warn(`\n--glb: ${fell.length} row(s) fell back to the procedural shell (GLB missing from the manifest or not extractable): ${fell.map((b) => b.id).join(', ')}`)
}
