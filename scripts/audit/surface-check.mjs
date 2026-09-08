#!/usr/bin/env node
/**
 * Offline guard for the ground-surface stack (guard G1 of the 2026-09-07 surface plan).
 *
 * The ground is a stack of overlapping OPAQUE sheets separated by 1–10 cm, and which one is
 * visible at a pixel is decided by the depth buffer alone. Four things break that, and each has a
 * check here — all of them run in ~10 s with no GPU, no network and no dev server, which is the
 * property that makes them worth running after every data edit.
 *
 *   A1  coverage   a RUNOFF_ZONES band wider than the ribbon can sweep, with no patch to cover it
 *   A1b clearance  the drawn terrain coming up through a sheet
 *   A1c max edge   a sheet sampled too coarsely to resolve the terrain grid it is draped on
 *   A4a lint       a new ground sheet that nobody registered for the clamp
 *   A6  ladder     two layers of the stack closer than LAYER_MIN_STEP
 *   B1  stacking   a sheet drawn THROUGH the sheet above it (SHEET_LAYER says which is which)
 *   B2  quality    zero-area triangles, zero normals, near-vertical faces on a horizontal sheet
 *
 *   node scripts/audit/surface-check.mjs                # report
 *   node scripts/audit/surface-check.mjs --strict       # non-zero exit on a regression
 *   node scripts/audit/surface-check.mjs --tier low     # the 17.7 m terrain grid the e2e run uses
 *   node scripts/audit/surface-check.mjs --rebaseline   # accept the current numbers
 *
 * The baseline lives in scripts/audit/surface-baseline.json and may shrink, never grow.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const STRICT = args.includes('--strict')
const REBASELINE = args.includes('--rebaseline')
const TIER = flag('--tier', 'high')
const BASELINE_PATH = path.join(ROOT, 'scripts/audit/surface-baseline.json')

const errors = []
const warnings = []
const fail = (msg, soft = false) => (soft ? warnings : errors).push(msg)
const fmt = (n, d = 1) => Number(n).toFixed(d)

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))
const tmMod = await import(path.join(ROOT, 'app/three/track-mesh.ts'))
const { forwardDelta, signedDelta } = await import(path.join(ROOT, 'app/sim/track.ts'))

const t0 = Date.now()
const { track, terrain, ground, root } = await buildScene({ tier: TIER })
const L = track.length
const L2 = L
const built = Date.now() - t0
const baseline = REBASELINE ? {} : JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const out = {}

// ================================================================ A1 — coverage
/**
 * Every metre of band RUNOFF_ZONES declares must actually be drawn, by a swept ribbon or by a
 * SURFACE_PATCHES polygon. Where it is not, the bare terrain (dormant grass) shows through — that
 * is "asphalt where the aerial says asphalt, dirt in the app".
 *
 * The binding cap is reported per run, because it says how to fix it: WIDTH means the band is
 * simply wider than RUNOFF_WIDTH and the constant has to become per-zone; FOLD means the swept
 * frame inverts there (ground.ts FOLD_SAFE) and only a polygon can cover it; BRIDGE is the
 * crossover deck deliberately narrowing and is exempt.
 */
{
  const rings = spec.SURFACE_PATCHES.map((p) => trackside.patchOutline(track, p, 2))
  const inRing = (x, z, r) => {
    let c = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j]
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c
    }
    return c
  }
  const zoneAt = (s) => spec.RUNOFF_ZONES.find((z) => forwardDelta(z.sRange[0], s, L) <= forwardDelta(z.sRange[0], z.sRange[1], L))
  const sOver = track.crossing.sOver
  const sUnder = track.crossing.sUnder
  const DS = 0.5, DL = 0.5
  const v = new THREE.Vector3()
  const cells = []
  for (let s = 0; s < L; s += DS) {
    // the deck genuinely narrows the verge here (ground.ts crossover()), so it is not a defect
    if (Math.abs(signedDelta(sOver, s, L)) < 115) continue
    const z = zoneAt(s)
    if (!z) continue
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const b = side > 0 ? z.left : z.right
      const want = Math.max(b.asphalt?.[1] ?? 0, b.grass?.[1] ?? 0, b.gravel?.[1] ?? 0)
      const rw = ground.runoffWidth(s, side)
      let have = hw + rw
      // a gravel bed may reach further than the grass ribbon (track-mesh.ts gravelAt)
      if (b.gravel) have = Math.max(have, Math.min(b.gravel[1], hw + (rw * tmMod.RUNOFF_MAX_LAT) / groundMod.RUNOFF_WIDTH))
      if (want <= have + 0.5) continue
      const cap = rw >= groundMod.RUNOFF_WIDTH - 0.01 ? 'WIDTH' : 'FOLD'
      for (let off = have + 0.5; off < want; off += DL) {
        track.pointAt(s, side * off, v, 0)
        if (!rings.some((r) => inRing(v.x, v.z, r))) cells.push({ s, side, cap, zone: z.name, want, have })
      }
    }
  }
  const runs = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last && last.side === c.side && last.zone === c.zone && forwardDelta(last.to, c.s, L) <= 2) {
      last.to = c.s
      last.m2 += DS * DL
      last.want = Math.max(last.want, c.want)
      last.have = Math.min(last.have, c.have)
    } else runs.push({ from: c.s, to: c.s, side: c.side, cap: c.cap, zone: c.zone, want: c.want, have: c.have, m2: DS * DL })
  }
  const area = runs.reduce((a, r) => a + r.m2, 0)
  const metres = new Set(cells.map((c) => Math.round(c.s))).size
  out.coverage = { area: Math.round(area), metres, runs: runs.length }
  console.log('\nA1  coverage — declared band that no ribbon or patch can draw')
  console.log('    s-range        side cap    want   have      m2  zone')
  for (const r of runs.filter((r) => r.m2 >= 20).sort((a, b) => b.m2 - a.m2)) {
    console.log(`    ${String(Math.round(r.from)).padStart(4)}-${String(Math.round(r.to)).padEnd(5)}  ${r.side > 0 ? 'L' : 'R'}    ${r.cap.padEnd(5)} ${fmt(r.want).padStart(5)}  ${fmt(r.have).padStart(5)}  ${String(Math.round(r.m2)).padStart(6)}  ${r.zone}`)
  }
  console.log(`    total ${Math.round(area)} m2 over ${metres} lap metres in ${runs.length} runs`)
  const base = baseline.coverage
  if (base) {
    if (area > base.area + 5) fail(`A1: uncovered declared band grew ${Math.round(area - base.area)} m2 (baseline ${base.area} m2)`)
    // a fold run is a ribbon that is inside out, not merely short — the chicane failure mode
    for (const r of runs) {
      if (r.cap === 'FOLD' && forwardDelta(r.from, r.to, L) >= 20 && r.m2 > 250) fail(`A1: ${r.zone} [${r.side > 0 ? 'L' : 'R'}] has ${Math.round(r.m2)} m2 uncovered behind a FOLD cap over ${Math.round(forwardDelta(r.from, r.to, L))} m`, true)
      if (r.m2 >= 300 && !base.knownRuns?.some((k) => k.zone === r.zone && k.side === r.side)) fail(`A1: new ${Math.round(r.m2)} m2 uncovered run in "${r.zone}" [${r.side > 0 ? 'L' : 'R'}]`)
    }
  }
  out.coverage.knownRuns = runs.filter((r) => r.m2 >= 300).map((r) => ({ zone: r.zone, side: r.side, m2: Math.round(r.m2) }))
}

// ================================================================ A1b / A1c — the built sheets
/**
 * A1b: does the DRAWN terrain come up through a sheet? The sheet is sampled on a barycentric grid
 * of each of its triangles and compared against `meshHeightAt`, which is exactly the triangle the
 * terrain draws. This is independent of the clamp's own arithmetic, so it verifies the clamp
 * rather than restating it.
 *
 * A1c: the longest XZ edge of a sheet triangle must stay under half the terrain step, or the
 * sheet is a chord over ground it cannot see. That is what let the terrain through the paddock
 * apron (12 m lateral gaps), the offset lanes (2 rails across 9 m) and the secondary paving
 * (raw OSM vertices up to 97.7 m apart).
 */
{
  // walk the REGISTRY, not the scene: a sheet may be registered before it is merged into a mesh
  // (the pit apron ends up inside the `concrete` mesh), and the registry is what the clamp used
  const sheets = terrain.groundSheets
  const maxEdgeLimit = (TIER === 'low' ? 18.056 : 13.542) / 2
  const rows = []
  const N = 4 // barycentric subdivisions per triangle
  for (const reg of sheets) {
    const geo = reg.geo
    const pos = geo.attributes.position
    const index = geo.getIndex()
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3)
    let samples = 0, under = 0, worst = 0, maxEdge = 0
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia)
      const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib)
      const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic)
      const e0 = Math.hypot(bx - ax, bz - az), e1 = Math.hypot(cx - bx, cz - bz), e2 = Math.hypot(ax - cx, az - cz)
      const longest = Math.max(e0, e1, e2)
      if (longest > maxEdge) maxEdge = longest
      if (longest < 1e-6) continue
      for (let i = 0; i <= N; i++) {
        for (let j = 0; i + j <= N; j++) {
          const u = i / N, v = j / N, w = 1 - u - v
          const x = ax * w + bx * u + cx * v
          const z = az * w + bz * u + cz * v
          const y = ay * w + by * u + cy * v
          const clearance = y - terrain.meshHeightAt(x, z)
          samples++
          if (clearance < 0) {
            under++
            if (-clearance > worst) worst = -clearance
          }
        }
      }
    }
    rows.push({ name: reg.name, tris: triCount, samples, pct: samples ? (100 * under) / samples : 0, worst, maxEdge, flat: reg.flat })
  }
  rows.sort((a, b) => b.pct - a.pct || b.maxEdge - a.maxEdge)
  console.log('\nA1b/A1c — registered ground sheets: does the drawn terrain come through, and are they dense enough?')
  console.log('    sheet                tris   terrain above   worst      longest XZ edge')
  for (const r of rows) {
    const edgeFlag = r.maxEdge > maxEdgeLimit ? ' <<' : ''
    console.log(`    ${r.name.padEnd(18)} ${String(r.tris).padStart(7)}   ${fmt(r.pct, 2).padStart(8)} %   ${fmt(r.worst, 3).padStart(6)} m   ${fmt(r.maxEdge, 1).padStart(6)} m${edgeFlag}`)
  }
  out.sheets = rows.map((r) => ({ name: r.name, pct: Number(fmt(r.pct, 2)), worst: Number(fmt(r.worst, 3)), maxEdge: Number(fmt(r.maxEdge, 1)) }))
  const allow = baseline.maxEdgeAllow ?? {}
  const basePct = Object.fromEntries((baseline.sheets ?? []).map((s) => [s.name, s.pct]))
  for (const r of rows) {
    // the sheets Phase 1 set out to fix must stay at exactly zero; the rest may not get worse
    const cap = Math.max(basePct[r.name] ?? 0, 0)
    if (r.pct > cap + 0.01) fail(`A1b: the terrain comes through "${r.name}" over ${fmt(r.pct, 2)} % of its area (worst ${fmt(r.worst, 3)} m, baseline ${fmt(cap, 2)} %)`)
    if (r.flat) continue
    const edgeCap = allow[r.name] ?? maxEdgeLimit
    if (r.maxEdge > edgeCap + 0.05) fail(`A1c: "${r.name}" has a ${fmt(r.maxEdge)} m XZ edge — over ${fmt(edgeCap)} m it cannot resolve the ${fmt(maxEdgeLimit * 2)} m terrain grid`)
  }
  out.maxEdgeAllow = Object.fromEntries(rows.filter((r) => !r.flat && r.maxEdge > maxEdgeLimit).map((r) => [r.name, Math.ceil(r.maxEdge * 10) / 10]))
  console.log(`    ${sheets.length} sheets registered, ${terrain.clamped.size} clamped; settle() took ${fmt(terrain.settleMs)} ms`)
  if (sheets.length !== terrain.clamped.size) fail(`A1b: ${sheets.length} sheets registered but ${terrain.clamped.size} clamped`)

  // no silent caps: a cut refused by maxDrop leaves terrain above the sheet on purpose, and the
  // reader has to be told where. Every one of these is a sheet running into a stand's platform.
  const capped = {}
  for (const c of terrain.clampCapped) {
    const d = terrain.distanceToTrack(c.x, c.z, 400)
    const cur = capped[c.name]
    if (!cur || c.needed > cur.needed) capped[c.name] = { needed: c.needed, s: d.s, lat: d.lateral, n: (cur?.n ?? 0) + 1 }
    else cur.n++
  }
  const cappedRows = Object.entries(capped)
  if (cappedRows.length) {
    console.log('    cuts refused by maxDrop (the terrain stays above the sheet there, deliberately):')
    for (const [name, c] of cappedRows.sort((a, b) => b[1].needed - a[1].needed)) {
      console.log(`      ${name.padEnd(18)} deepest ${fmt(c.needed, 2).padStart(6)} m at s≈${fmt(c.s, 0)} lat ${fmt(c.lat, 0)}`)
    }
  }
  out.cappedSheets = cappedRows.map(([name, c]) => ({ name, needed: Number(fmt(c.needed, 2)) }))
  for (const [name, c] of cappedRows) {
    if (!(baseline.cappedSheets ?? []).some((b) => b.name === name)) fail(`A1b: "${name}" now needs a ${fmt(c.needed, 2)} m cut at s≈${fmt(c.s, 0)} that maxDrop refuses — a sheet is running into a raised platform`, true)
  }
}

// ================================================================ B1 — sheet vs sheet stacking
/**
 * The check that was missing.
 *
 * A1b only ever compares a sheet against the terrain, and reported 0 % while the chicane's turf
 * island was visibly mottled — because what was drawn through it was the asphalt apron and the
 * grass verge, not the terrain. Here every pair of sheets that `SHEET_LAYER` puts in the same
 * frame is checked: sample the upper sheet's triangles, evaluate the lower sheet there, and count
 * the places the lower one comes out on top.
 */
{
  const { SHEET_LAYER, LAYER } = groundMod
  const CELL = 20
  const sheets = new Map()
  root.traverse((o) => {
    if (!o.isMesh || !o.name || !o.geometry?.attributes?.position) return
    if (!SHEET_LAYER[o.name]) return
    const pos = o.geometry.attributes.position
    const index = o.geometry.getIndex()
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3)
    let e = sheets.get(o.name)
    if (!e) { e = { name: o.name, grid: new Map(), tris: [] }; sheets.set(o.name, e) }
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const T = [pos.getX(ia), pos.getY(ia), pos.getZ(ia), pos.getX(ib), pos.getY(ib), pos.getZ(ib), pos.getX(ic), pos.getY(ic), pos.getZ(ic)]
      // the ribbons collapse edges onto each other by design; those quads carry no surface
      if (Math.abs((T[3] - T[0]) * (T[8] - T[2]) - (T[5] - T[2]) * (T[6] - T[0])) / 2 < 1e-4) continue
      const k = e.tris.length
      e.tris.push(T)
      const i0 = Math.floor(Math.min(T[0], T[3], T[6]) / CELL), i1 = Math.floor(Math.max(T[0], T[3], T[6]) / CELL)
      const j0 = Math.floor(Math.min(T[2], T[5], T[8]) / CELL), j1 = Math.floor(Math.max(T[2], T[5], T[8]) / CELL)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const kk = `${i},${j}`
        let arr = e.grid.get(kk)
        if (!arr) { arr = []; e.grid.set(kk, arr) }
        arr.push(k)
      }
    }
  })
  const yOn = (e, x, z) => {
    const arr = e.grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)
    if (!arr) return null
    let best = null
    for (const k of arr) {
      const T = e.tris[k]
      const d = (T[5] - T[8]) * (T[0] - T[6]) + (T[6] - T[3]) * (T[2] - T[8])
      if (Math.abs(d) < 1e-12) continue
      const u = ((T[5] - T[8]) * (x - T[6]) + (T[6] - T[3]) * (z - T[8])) / d
      const v = ((T[8] - T[2]) * (x - T[6]) + (T[0] - T[6]) * (z - T[8])) / d
      const w = 1 - u - v
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue
      const y = T[1] * u + T[4] * v + T[7] * w
      if (best === null || y > best) best = y
    }
    return best
  }
  const rung = (name) => { const [stack, key] = SHEET_LAYER[name]; return { stack, y: LAYER[stack][key] } }
  const sOver = track.crossing.sOver
  const sUnder = track.crossing.sUnder
  const names = [...sheets.keys()].sort((a, b) => rung(a).y - rung(b).y)
  const rows = []
  for (const up of names) {
    const U = sheets.get(up)
    const ru = rung(up)
    const pts = []
    for (const T of U.tris) {
      pts.push([(T[0] + T[3] + T[6]) / 3, (T[2] + T[5] + T[8]) / 3, (T[1] + T[4] + T[7]) / 3])
      pts.push([(T[0] + T[3]) / 2, (T[2] + T[5]) / 2, (T[1] + T[4]) / 2])
    }
    for (const lo of names) {
      const rl = rung(lo)
      // only sheets in the same frame are comparable: `verge` is above the analytic terrain,
      // `mesh` above the drawn grid, `road`/`pit` on the road plane
      if (rl.stack !== ru.stack || rl.y >= ru.y) continue
      const L = sheets.get(lo)
      let n = 0, bad = 0, worst = 0, worstAt = null
      for (const [x, z, y] of pts) {
        const yl = yOn(L, x, z)
        if (yl === null) continue
        const d = yl - y
        // the crossover stacks two roads 6.5 m apart: a metre-scale gap there is the bridge, not a
        // defect, and it shows from BOTH ends (the deck at sOver and the road under it at sUnder).
        // Both conditions must hold, so this cannot hide a real 1 m fault elsewhere.
        if (Math.abs(d) > 1) {
          const near = terrain.distanceToTrack(x, z, 400)
          if (Math.abs(signedDelta(sOver, near.s, L2)) < 115 || Math.abs(signedDelta(sUnder, near.s, L2)) < 115) continue
        }
        n++
        if (d > 0.002) { bad++; if (d > worst) { worst = d; worstAt = [x, z] } }
      }
      if (n < 50) continue
      const at = worstAt ? terrain.distanceToTrack(worstAt[0], worstAt[1], 400) : null
      rows.push({ up, lo, n, bad, pct: (100 * bad) / n, worst, s: at ? at.s : 0 })
    }
  }
  rows.sort((a, b) => b.pct - a.pct)
  console.log('\nB1  stacking — is a sheet drawn through the one above it?')
  console.log('    upper              lower              samples  violations      worst   at s')
  for (const r of rows) {
    if (r.bad === 0 && r.pct === 0) continue
    console.log(`    ${r.up.padEnd(18)} ${r.lo.padEnd(18)} ${String(r.n).padStart(7)}  ${String(r.bad).padStart(6)} (${fmt(r.pct, 2).padStart(5)} %)  +${fmt(r.worst * 1000, 0).padStart(4)} mm  ${fmt(r.s, 0)}`)
  }
  const clean = rows.filter((r) => r.bad === 0).length
  console.log(`    ${rows.length} comparable pairs, ${clean} with no violation at all`)
  out.pairs = rows.map((r) => ({ up: r.up, lo: r.lo, pct: Number(fmt(r.pct, 2)), worst: Number(fmt(r.worst, 3)) }))
  const base = Object.fromEntries((baseline.pairs ?? []).map((b) => [`${b.up}|${b.lo}`, b.pct]))
  for (const r of rows) {
    const cap = base[`${r.up}|${r.lo}`]
    if (cap === undefined) {
      if (r.pct > 0.5) fail(`B1: new pair "${r.lo}" drawn through "${r.up}" over ${fmt(r.pct, 2)} % of it (worst ${fmt(r.worst * 1000, 0)} mm at s≈${fmt(r.s, 0)})`)
      // +1 pp, not tighter: the two tiers build on different terrain grids (13.3 vs 17.7 m), so a
      // pre-existing pair's rate moves by a few tenths between them and one baseline serves both
    } else if (r.pct > cap + 1) {
      fail(`B1: "${r.lo}" through "${r.up}" grew to ${fmt(r.pct, 2)} % (baseline ${fmt(cap, 2)} %)`)
    }
  }
}

// ================================================================ B2 — mesh quality
/**
 * Defects that are not a depth fight at all.
 *
 * A zero-area triangle contributes no face normal, so a vertex that only touches such triangles
 * ends up with a (0,0,0) normal and shades BLACK, and a triangle that is degenerate in XZ but
 * extended vertically is a wall standing in a flat sheet. Both were present on the chicane's turf
 * island — 45 and 84 of 1164 — and neither is visible to any depth-based check.
 */
{
  console.log('\nB2  mesh quality of the ground sheets')
  console.log('    sheet                tris   zero-area   zero-normal   faces >15°   worst tilt')
  const bad = []
  root.traverse((o) => {
    if (!o.isMesh || !o.name || !groundMod.SHEET_LAYER[o.name]) return
    const pos = o.geometry.attributes.position
    const nrm = o.geometry.attributes.normal
    const index = o.geometry.getIndex()
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3)
    let deg = 0, steep = 0, worst = 0
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia)
      const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib)
      const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic)
      const xz = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2
      if (xz < 1e-6) { deg++; continue }
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      const len = Math.hypot(nx, ny, nz) || 1
      const tilt = (Math.acos(Math.min(1, Math.abs(ny) / len)) * 180) / Math.PI
      if (tilt > worst) worst = tilt
      if (tilt > 15) steep++
    }
    // A vertex only reached by collapsed quads is never drawn, and the ribbons collapse edges by
    // design (`aOut`, `vergeCut`). Only a zero normal on a vertex that a LIVE triangle uses can
    // shade black — that is what happened on the turf island.
    const live = new Set()
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const xz = Math.abs((pos.getX(ib) - pos.getX(ia)) * (pos.getZ(ic) - pos.getZ(ia)) - (pos.getZ(ib) - pos.getZ(ia)) * (pos.getX(ic) - pos.getX(ia))) / 2
      if (xz < 1e-6) continue
      live.add(ia); live.add(ib); live.add(ic)
    }
    let zero = 0
    if (nrm) for (const i of live) if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 1e-6) zero++
    console.log(`    ${o.name.padEnd(18)} ${String(triCount).padStart(7)}   ${String(deg).padStart(9)}   ${String(zero).padStart(11)}   ${String(steep).padStart(10)}   ${fmt(worst, 1).padStart(7)}°`)
    bad.push({ name: o.name, deg, zero, steep, worst: Number(fmt(worst, 1)) })
  })
  out.quality = bad
  const baseQ = Object.fromEntries((baseline.quality ?? []).map((b) => [b.name, b]))
  for (const b of bad) {
    if (b.zero > 0) fail(`B2: "${b.name}" has ${b.zero} drawn vertices with a zero normal — they shade black`)
    // collapsed quads are how the ribbons yield to the asphalt band and to a patch, so these are
    // baselined rather than banned; they may not grow
    const degCap = Math.max(5, Math.round((baseQ[b.name]?.deg ?? 0) * 1.15))
    if (b.deg > degCap) fail(`B2: "${b.name}" has ${b.deg} zero-area triangles (baseline ${baseQ[b.name]?.deg ?? 0})`)
    // the tilt count is a shape heuristic and the two tiers build on different terrain grids, so
    // it is held to a band rather than an exact number; the hard rules above are exact
    const cap = Math.max(5, Math.round((baseQ[b.name]?.steep ?? 0) * 1.15))
    if (b.steep > cap) fail(`B2: "${b.name}" has ${b.steep} faces tilted over 15° (baseline ${baseQ[b.name]?.steep ?? 0}); worst ${fmt(b.worst, 1)}°`)
  }
}

// ================================================================ A4a — registration lint
/**
 * A source-level tripwire, not a proof: the runtime proof is the dev sweep in RaceViewport
 * (`assertGroundRegistered`). This catches the case where a builder gains a new horizontal sheet
 * and nobody wires it — the mesh name is there, the registration is not.
 */
{
  const files = ['track-mesh', 'surfaces', 'lanes', 'props', 'pit-complex', 'stands', 'environment']
  // any quoted name in a builder that reads as a horizontal surface: `.name =` misses the ones
  // handed to a local add(geos, mat, name) helper, which is how lanes.ts and pit-complex.ts do it
  const groundLike = /^(asphalt|runoff[A-Za-z]*|gravel|surface-[a-z]+|pitLane|pitApron|lanePaving|laneKerbs|secondaryPaving|paddockAsphalt|helipad)$/
  const declared = new Set(out.sheets.map((s) => s.name))
  const found = new Set()
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, `app/three/${f}.ts`), 'utf8')
    for (const m of src.matchAll(/'([A-Za-z][A-Za-z0-9-]*)'/g)) if (groundLike.test(m[1])) found.add(m[1])
  }
  const unregistered = [...found].filter((n) => !declared.has(n) && n !== 'surfacePatches')
  console.log('\nA4a registration lint')
  console.log(`    ${found.size} ground-looking mesh names in the builders, ${declared.size} registered sheets`)
  for (const n of unregistered) fail(`A4a: mesh "${n}" looks like a ground sheet but never reaches Terrain.addGroundSurface`)
  const gone = [...declared].filter((n) => n !== 'surfacePatches' && !found.has(n))
  for (const n of gone) fail(`A4a: registered sheet "${n}" no longer appears in the builders — the guard has gone blind`, true)
}

// ================================================================ A6 — the layer ladder
/**
 * Every stack of LAYER must be strictly ascending, and consecutive entries at least
 * LAYER_MIN_STEP apart. 8 mm is the floor because the low tier and every SwiftShader run use
 * logarithmicDepthBuffer, which writes gl_FragDepth and therefore makes polygonOffset a no-op:
 * the geometric separation is all there is on the tier the audit shots are taken on.
 */
{
  const { LAYER, LAYER_MIN_STEP, LAYER_SOFT, LAYER_KNOWN_TIGHT } = groundMod
  const known = new Set(LAYER_KNOWN_TIGHT.map(([a, b]) => `${a}|${b}`))
  const tight = []
  console.log('\nA6  layer ladder')
  for (const [stack, entries] of Object.entries(LAYER)) {
    const list = Object.entries(entries)
    console.log(`    ${stack}: ${list.map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ')}`)
    for (let i = 0; i < list.length - 1; i++) {
      const [ka, va] = list[i], [kb, vb] = list[i + 1]
      const a = `${stack}.${ka}`, b = `${stack}.${kb}`
      if (vb <= va) fail(`A6: ${b} (${vb}) is not above ${a} (${va}) — the ladder must be written in ascending order`)
      // a transparent decal with depthWrite:false never writes depth, so nothing can fight it
      if (LAYER_SOFT.has(a) || LAYER_SOFT.has(b)) continue
      if (vb - va < LAYER_MIN_STEP - 1e-9) {
        tight.push(`${a} → ${b} (${((vb - va) * 1000).toFixed(0)} mm)`)
        if (!known.has(`${a}|${b}`)) fail(`A6: ${a} → ${b} is ${((vb - va) * 1000).toFixed(0)} mm apart, under the ${LAYER_MIN_STEP * 1000} mm floor`)
      }
    }
  }
  console.log(`    ${tight.length} pair(s) under ${LAYER_MIN_STEP * 1000} mm, ${LAYER_KNOWN_TIGHT.length} of them declared in LAYER_KNOWN_TIGHT`)
  out.tightPairs = tight.length
}

// ================================================================ report
if (REBASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`\nbaseline written to ${path.relative(ROOT, BASELINE_PATH)}`)
}
console.log(`\nscene built in ${built} ms (tier ${TIER}, terrain grid ${TIER === 'low' ? '17.7' : '13.3'} m)`)
if (warnings.length) console.log(`\n${warnings.length} warning(s):\n  - ${warnings.join('\n  - ')}`)
if (errors.length) {
  console.log(`\n${errors.length} error(s):\n  - ${errors.join('\n  - ')}`)
  if (STRICT) process.exit(1)
}
console.log(`\nsurface-check: ${errors.length ? 'FAILED' : 'OK'}${STRICT ? ' (strict)' : ''}`)
