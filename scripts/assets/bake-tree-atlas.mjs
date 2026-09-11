#!/usr/bin/env node
/**
 * Bake the tree impostor atlas from the imported tree packs.
 *
 * Drives scripts/assets/bake/tree-impostor.html on the shared harness (bake/serve.mjs: the repo
 * served with app/**\/*.ts transpiled, headless Chromium on SwiftShader) — the page extracts the
 * first variant's LOD0 of every species in app/data/tree-species.ts with app/three/model-proto.ts,
 * exactly as app/three/trees.ts does at runtime, from the GLBs in public/assets-manifest.json —
 * and writes
 *   misc/dl/tex/tree_atlas/tree_atlas_diff.png   (4096², RGBA, sRGB — the lit trees)
 *   misc/dl/tex/tree_atlas/tree_atlas_mask.png   (RGB — R = the foliage the runtime tints)
 *   misc/dl/tex/tree_atlas/layout.json           (cell geometry, per row: role, variant, baked
 *                                                 height, triangles, mean foliage colour)
 * import-misc.mjs then encodes them like any other texture (source 'tex/tree_atlas'); the layout
 * is mirrored as TREE_LAYOUT / TREE_CARD_ROW_HEIGHT_M in app/data/impostor-atlas.ts and the
 * crown colours as TreeSpecies.crown — the script prints what to paste.
 *
 *   node scripts/assets/bake-tree-atlas.mjs                # bake every species
 *   node scripts/assets/bake-tree-atlas.mjs --only sugi,matsu
 *   node scripts/assets/bake-tree-atlas.mjs --port 3113
 * Then: node scripts/assets/import-misc.mjs --only tex/tree_atlas
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, serveAndBake } from './bake/serve.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const port = Number(flag('--port', 3113))
const only = flag('--only', null)
const OUT = join(ROOT, 'misc/dl/tex/tree_atlas')

/** the atlas geometry — keep in step with TREE_LAYOUT / TREE_CARD_BAKE_M in app/data/impostor-atlas.ts */
const LAYOUT = { cell: 256, cellM: 24, padM: 0.5, bakeM: 20, yaws: 8, elev0: 10, elev1: 45, w: 4096, h: 4096 }

const result = await serveAndBake({
  page: 'scripts/assets/bake/tree-impostor.html',
  query: only ? { ...LAYOUT, only } : LAYOUT,
  out: OUT,
  port,
  viewport: { width: 1024, height: 1024 },
  timeout: 180000,
  run: async (page) => {
    let last = null
    for (const pass of ['colour', 'mask']) {
      const t0 = Date.now()
      last = await page.evaluate((p) => window.bakeTrees(p), pass)
      const png = Buffer.from(last.dataUrl.split(',')[1], 'base64')
      const out = join(OUT, pass === 'colour' ? 'tree_atlas_diff.png' : 'tree_atlas_mask.png')
      writeFileSync(out, png)
      console.log(`${pass}: ${png.length} bytes → ${out} (${Date.now() - t0} ms)`)
    }
    return last
  },
})

const rows = result.rows
const meta = {
  cell: result.cell, cellM: result.cellM, padM: result.padM, bakeM: result.bakeM, yaws: result.yaws, elevs: result.elevs,
  cols: result.cols, rowCount: result.rowsN, width: result.width, height: result.height,
  bandAxis: 'cols', subjects: rows.filter((r) => !r.missing).length,
  rows: rows.map(({ role, row, variant, key, heightM, reachM, tris, bark, leaf, crown, foliagePx, missing }) => ({ role, row, variant, key, heightM, reachM, tris, bark, leaf, crown, foliagePx, missing })),
}
writeFileSync(join(OUT, 'layout.json'), JSON.stringify(meta, null, 2))
console.table(meta.rows.map(({ role, row, variant, heightM, reachM, tris, crown, missing }) => ({ role, row, variant, heightM, reachM, tris, crown, missing: missing ? 'MISSING' : '' })))

const missing = rows.filter((r) => r.missing)
if (missing.length) console.warn(`\n${missing.length} species without a pack prototype (their cards are empty; the runtime draws cones for them): ${missing.map((r) => r.role).join(', ')}`)
const byRow = new Map(rows.map((r) => [r.row, r]))
const maxRow = Math.max(...rows.map((r) => r.row))
const heights = []
for (let i = 0; i <= maxRow; i++) heights.push(byRow.get(i)?.heightM ?? result.bakeM)
if (heights.some((h) => Math.abs(h - result.bakeM) > 0.01)) {
  console.log(`\nrows shorter than the ${result.bakeM} m bake height (too wide for the cell) — paste into app/data/impostor-atlas.ts:`)
  console.log(`export const TREE_CARD_ROW_HEIGHT_M: readonly number[] = [${heights.map((h) => Number(h.toFixed(2))).join(', ')}]`)
} else console.log(`\nevery row is ${result.bakeM} m tall: TREE_CARD_ROW_HEIGHT_M stays [${heights.join(', ')}]`)
console.log('\nmean foliage colours (sRGB) for TreeSpecies.crown in app/data/tree-species.ts:')
for (const r of rows) if (!r.missing) console.log(`  ${r.role.padEnd(11)} crown: '${r.crown}'`)
