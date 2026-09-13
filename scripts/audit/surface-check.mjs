#!/usr/bin/env node
/**
 * Offline guard set for the ground (v3 — the plan's §4; from P4 the objects and decals on the ground are judged too).
 *
 * The scene is built in plain Node (`app-runtime.mjs`) and MEASURED: which face is visible from
 * above against the owner the plan declares, where two faces cover the same ground, how far every
 * face sits from the frame it claims, whether the height field is continuous, whether shared
 * vertices are shared. Nothing here restates a builder's arithmetic — that is how the previous
 * guard reported 0 % on a mottled island — and nothing here is a numeric baseline (R13): every
 * non-zero number the run tolerates is a typed ALLOWANCE below, with the phase that removes it,
 * and an allowance whose phase has come fails the run.
 *
 *   G0  ladder        LAYER stacks (decals / objects) ascending, ≥ LAYER_MIN_STEP apart
 *   G1  census        visible face kind from above vs plan.ownerAt; and the runtime census (ground-census.ts, the
 *                     e2e's own measure) on its own point set
 *   G2  overlap       any two faces — the same one included — covering one XZ point; an object's footprint width vs its rule
 *   G3  deviation     face centroid vs its declared frame (road plane / height field); an object's edges sunk and crown
 *                     proud of the face it stands on; a decal never under the face it lies on
 *   G4  quality       zero-area triangles, zero normals on drawn vertices, off-field tilt
 *   G5  continuity    Terrain.heightAt jumps along s and across the verge
 *   G6  terrain       the drawn grid coming up through a registered face (per tier)
 *   G7  max edge      a face too coarse to resolve the grid it is draped on (per tier)
 *   G8  registration  horizontal geometry at ground level that is not a registered face, a marked object or a marked
 *                     decal; R13 imports; R3 — nothing outside the ground modules samples the terrain
 *   G9  seams         a vertex shared by two faces is bit-identical in both (position and normal)
 *   G10 residue       declared RUNOFF_ZONES band the fold cap removes and no ring fills (m²)
 *   G11 drops         a face edge dropping > 0.5 m where the field does not
 *   G12 plan          plan integrity: residual inversions, build errors, untraced ring parts
 *
 *   node scripts/audit/surface-check.mjs [--strict] [--tier high|low] [--only G1,G5] [--json out.json] [--suggest]
 *
 * --suggest prints, for every failing key, the ALLOWANCES entry that would cover it (rounded up:
 * counts / m² +5 %, mm +2, edges to 0.1 m). It never writes anything — the author still has to
 * paste the entry with a `why` and an `until`.
 *
 * Imports (R13 — checked by G8 against this list; nothing else under app/ may be imported):
 *   app/data/suzuka.ts, app/data/suzuka-facilities-spec.ts, app/data/suzuka-barriers-spec.ts
 *   app/three/ground.ts            LAYER, LAYER_MIN_STEP, LAYER_SOFT, GROUND_OBJECTS
 *   app/three/ground-plan.ts       RULE_OF, PRECEDENCE, kerbAt, kerbProfileHeight, FLAT_STRIP, STRIP_DROP, DECK_ZONE, VERGE_MIN
 *   app/three/ground-census.ts     groundCensus — the browser's census (window.__suzuka.groundCensus()), run here on the same points
 *   app/three/trackside.ts         (nothing today; kept for ring diagnostics)
 *   app/sim/track.ts               forwardDelta, signedDelta
 *   scripts/audit/app-runtime.mjs  buildScene, ROOT, THREE — the built scene: ground.plan, ground.field, groundMeshes
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'

const ALLOWED_IMPORTS = [
  'app/data/suzuka.ts',
  'app/data/suzuka-facilities-spec.ts',
  'app/data/suzuka-barriers-spec.ts',
  'app/three/ground.ts',
  'app/three/ground-plan.ts',
  'app/three/ground-census.ts',
  'app/three/trackside.ts',
  'app/sim/track.ts',
  './app-runtime.mjs',
  'scripts/audit/sections.json',
]

// ================================================================ phases and allowances
const PHASE = 'P6i'
const PHASES = ['P0', 'P1', 'P2', 'P3a', 'P3b', 'P4', 'P5', 'P6', 'P6s', 'P6i', 'P7']
const phaseIdx = (p) => PHASES.indexOf(p)

/**
 * Every non-zero the run tolerates, typed: { guard, key, bound, why, until }. `until` is the
 * phase that removes the cause; once PHASE reaches it the entry fails the run. Bounds cover both
 * tiers (they build on different terrain grids).
 */
const WHY = {
  fieldCells:
    'field-frame faces on ground that curves — the DEM\'s own slopes, the crease where a fill cap meets the natural ground (a hard min, FILL_SLOPE 0.35), the basin banks, the GP Square ramp (7 m over 8 m) — are 2 m raster rows × fill columns and 1 m world triangles: their centroids chord the field by 40–230 mm and their planes tilt > 10° from it. Walls and terrace steps (slope > 45°) are already left out as cliffs. The fix is refining the raster where the field curves (1 m rows and fills there, +triangles), P7. Rounding the cap crease over ±2 m was tried in P6 and reverted (the fillet chorded worse)',
  reliefJoin:
    'facilityRelief (stands.ts) joins two zones\' claims where their frames meet. P6 gave the chord zones v-fades, the basins banks from the local ground and the sample zones along-s interpolation (G11 water 90 → 0, grass 48 → 0, G5 564 → 306); P6s landed every zone\'s outer fade on the DEM (G11 paddock 1 → 0, G5 307). C4 measured the end fade along the end TANGENT (it was radial, which counted the ground behind a chord as ground past it), made the 13.2 m stair notch between E-2 and E-1 ONE claim — E-2\'s profile ramps across it onto E-1\'s first section and hands over on the line where E-1\'s own zone starts, which moves with lateral (28 m out at the road, 0.5 m at 160 m behind it) — and blends same-rank same-mode claims by weight ALWAYS instead of taking the nearer: the E1 / E2 step went 11.54 m → gone, cliffs over 0.5 m 72 → 66, and the count 307 → 313 as the remaining steps spread into smaller ones. What is left, all of it a join between two claims of DIFFERENT mode (nearest-neighbour, no blend) or between a claim and the DEM: the D_temp plateau against the D tiers at s 1284–1285 L 33 (4.40 m, the worst on the lap), the D tier-1 / tier-2 seam at s 1492–1536 L 12–22 (≈ 2.2 m), one D tier-1 row (s 1315, lateral > 80 falls between the samples of the 逆バンク bend) ending its claim mid-ramp, and the pit-building paddock platform ending on the bisector with the NIPPO stretch (1.6 m, G11 paddock). E-2\'s own chord also has a medial axis 50 m behind its curving front, where project() jumps 21 m in u for a 0.25 m move and the analytic field steps 0.84 m (the drawn terrain mesh smooths it to 0.03 m). Mixed-mode joins and the medial axis are P7',
  demCurvature:
    'P6s: the far term of Terrain.heightAt is the real DEM (dem.ts, bicubic on the 30 m grid) from DEM_BLEND [60, 140] m out, and the relief zones\' outer fades land on it. Where a face reaches that far — the paddock apron behind the pit building (lateral −90…−130, past the line where the nearest centreline stretch flips and the flat zone stops), the two ponds\' banks (basin caps from the local ground) — the 2 m raster rows chord the DEM\'s own curvature: measured with --suggest on both tiers, paddock 0.2 → 3.23 % (625 mm max at the flip line, which was 2.9 m tall before and is 1.6 m now), water 4.2 → 8.82 %, paddock.steep 2000 → 2001, water.steep 711 → 986. At DEM_BLEND[0] = 45 the paddock read 4.29 % and a parking-line decal sat 4.5 mm over its face, so the blend starts at 60. The remedy is the same P7 raster refinement',
  infieldRings:
    'P6i (the I phase, inside the fences): the hard-standing, car-park and pond rows the infield adds as GROUND_AREAS rings lie beyond DEM_BLEND [60, 140] m, where Terrain.heightAt is the real DEM — the 4 m ring triangles chord the DEM\'s own curvature the way the paddock apron and the pond banks already do (WHY.demCurvature), so their field-frame kinds (asphaltArea / paddock / water) read a few per cent of centroids beyond 40 mm and a few steep triangles on the banks. I2-a measured the paddock rows (A / B / E car parks, the S lot, the E-paddock join across the relief\'s 25 m in-fade at s 5511–5536): paddock 1.54 → 7.71 % (max 458 mm at s 5525 lateral −67, the in-fade\'s crease), paddock.steep 136 → 257. The rings also insert stations on the S-curve / NIPPO leg they back onto (every station whose ray reaches a ring\'s box is a candidate), which subdivides that leg\'s right-side grass on the same IDW banks: +12 k grass triangles at s 1000–1700, and the absolute count of steep ones there rose with them (grass.steep 1200 → 1553, nothing steeper than before). The remedy is the same P7 raster refinement (1 m rows where the field curves); nothing is tuned per ring',
  cutWalls:
    'P6i (I6, the cuttings and tunnels): a CUT corridor lowers the field between its walls, and the 0.6 m foot where the wall meets the floor is a band steeper than 10° but flatter than the 45° cliff threshold — it is neither a walkable face nor a cliff to the guards, so it counts as steep on the kinds it crosses (grass / asphaltArea / lane). A vertical wall face (P7: a true cliff row in the field, or the foot drawn as the wall\'s own geometry) removes it',
  osmGap:
    'beside the lower road at the crossover (s 2352–2355 L, 30 m out) a few square metres between the OSM sand and grass polygons are nobody\'s ground beyond both roads\' rasters; the same class of gap inside Degner 2 was closed in P6 with a strip ring on the two polygons\' own edges (GROUND_AREAS デグナー2内側の帯) — this one wants the same look at the aerial, P7',
}

/**
 * Non-zero allowances. Each names its guard and key, the bound the run must stay within, why the
 * ground is allowed to measure that way and the phase by which it must be gone: once PHASE
 * reaches `until` the entry fails the run. There are no numeric baselines (R13).
 */
const ALLOWANCES = [
  // --- 2 m cells on curved ground (P7: refine where the field curves) ---------------------------
  { guard: 'G3', key: "ground:asphaltBand", bound: 0.65, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G3', key: "ground:grass", bound: 4.4, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G3', key: "ground:grassArea", bound: 1.25, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G3', key: "ground:gravelArea", bound: 7.5, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G3', key: "ground:gravelBand", bound: 1.55, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G3', key: "ground:asphaltArea", bound: 4.07, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 3.87 high (--suggest), was 0 — the service road along the foot of the D / E terraces (OSM 467945733) and the Dunlop inner road chord the terrace relief and the DEM
  { guard: 'G3', key: "ground:paddock", bound: 8.1, why: `${WHY.fieldCells} ${WHY.demCurvature} ${WHY.infieldRings}`, until: 'P7' }, // I2-a: measured 7.71 on both tiers (--suggest), was 3.4
  { guard: 'G3', key: "ground:water", bound: 11.41, why: `${WHY.fieldCells} ${WHY.demCurvature} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 10.86 high (--suggest), was 9.3 — the C paddock lot and the D paddock ring the T1 pond and the T1–T2 basin and re-station their banks
  { guard: 'G4', key: "ground:asphaltArea.steep", bound: 1994, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 1899 high (--suggest), was 70 — the E-stand service road under the D1–4 / E terraces, the Dunlop inner road on the E hill, the Spoon outside road on the M site
  { guard: 'G4', key: "ground:asphaltBand.steep", bound: 338, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 321 high (--suggest), was 280 — the new rings' stations subdivide the bands beside them
  { guard: 'G4', key: "ground:grass.steep", bound: 1890, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 1800 high (--suggest), was 1631 (I2-a 1553)
  { guard: 'G4', key: "ground:grassArea.steep", bound: 35, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G4', key: "ground:gravelArea.steep", bound: 161, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 153 high (--suggest), was 65 — the 130R gravel's world part beyond the west straight's end re-triangulated (+476 triangles) when the 南コース ribbon beside it went from 10 to 8 m; nothing steeper than before (worst 65.4°)
  { guard: 'G4', key: "ground:gravelBand.steep", bound: 56, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 53 high (--suggest), was 50
  { guard: 'G4', key: "ground:helipad.steep", bound: 3, why: WHY.infieldRings, until: 'P7' }, // I5-a: measured 2 high (--suggest), was 0 — the second helipad's disc on the Dunlop-loop apron's slope (worst 31.5°)
  { guard: 'G4', key: "ground:lane.steep", bound: 54, why: `${WHY.fieldCells} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 51 high (--suggest), was 50
  { guard: 'G4', key: "ground:paddock.steep", bound: 3137, why: `${WHY.fieldCells} ${WHY.demCurvature} ${WHY.infieldRings}`, until: 'P7' }, // I5-a: measured 2987 high (--suggest), was 2110 — the D rear apron on the D plateau's edge, the Dunlop-loop apron, the L yard, the Spoon and west-course lots on the DEM
  { guard: 'G4', key: "ground:turf.steep", bound: 8, why: WHY.fieldCells, until: 'P7' },
  { guard: 'G4', key: "ground:water.steep", bound: 1040, why: `${WHY.fieldCells} ${WHY.demCurvature}`, until: 'P7' },
  // --- relief joins (P7: stands.ts) ---------------------------------------------------------------
  { guard: 'G5', key: "jumps", bound: 313, why: WHY.reliefJoin, until: 'P7' }, // C4: measured 313 on both tiers (--suggest), was 330
  // --- an OSM gap at the crossover (P7: a strip ring) --------------------------------------------
  { guard: 'G1', key: "crossoverBare", bound: 12, why: WHY.osmGap, until: 'P7' },
]

// ================================================================ CLI
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const STRICT = args.includes('--strict')
const SUGGEST = args.includes('--suggest')
const TIER = flag('--tier', 'high')
const JSON_OUT = flag('--json', null)
const ONLY = flag('--only', null)?.split(',').map((s) => s.trim())
/** GM_DEBUG_PAIR="ground:grass|ground:grass": G2 prints the first samples of that pair with their lap coordinates */
const DEBUG_PAIR = process.env.GM_DEBUG_PAIR ?? null
/** GM_DEBUG_DECAL=whiteLines: G3 prints the first samples of that decal that find no face */
const DEBUG_DECAL = process.env.GM_DEBUG_DECAL ?? null
const runs = (g) => !ONLY || ONLY.includes(g)
const fmt = (n, d = 1) => Number(n).toFixed(d)
const pad = (s, n) => String(s).padStart(n)
const padE = (s, n) => String(s).padEnd(n)

// ================================================================ app modules (R13)
const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const barriersSpec = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
const { CIRCUIT } = await import(path.join(ROOT, 'app/data/suzuka.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))
const planMod = await import(path.join(ROOT, 'app/three/ground-plan.ts'))
const { groundCensus } = await import(path.join(ROOT, 'app/three/ground-census.ts'))
const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
const { forwardDelta, signedDelta } = await import(path.join(ROOT, 'app/sim/track.ts'))
const sections = JSON.parse(readFileSync(path.join(ROOT, 'scripts/audit/sections.json'), 'utf8'))
const { LAYER, LAYER_MIN_STEP, LAYER_SOFT, GROUND_OBJECTS } = groundMod
const { RULE_OF, PRECEDENCE, kerbAt, kerbProfileHeight, FLAT_STRIP, STRIP_DROP } = planMod
void spec; void barriersSpec; void trackside; void CIRCUIT

// ================================================================ build
const tBuild = Date.now()
const { track, terrain, ground, plan, groundMeshes, root } = await buildScene({ tier: TIER })
const built = Date.now() - tBuild
const L = track.length
const sOver = track.crossing.sOver
const sUnder = track.crossing.sUnder

// ================================================================ failures and the check() helper
const errors = []
const notes = []
const fail = (m) => errors.push(m)
const out = { tier: TIER, phase: PHASE, built, measured: {}, ms: {}, guards: {} }
const usedAllowance = new Set()
const suggestions = []
const roundUp = (v, unit) => {
  if (unit === 'mm') return Math.ceil(v + 2)
  if (unit === 'pct') return Math.min(100, Math.ceil(v * 1.05 * 100) / 100)
  if (unit === 'm') return Math.ceil(v * 10) / 10
  return Math.ceil(v * 1.05)
}
/**
 * The one gate every guard goes through. `measured ≤ bound` passes; anything else needs an
 * ALLOWANCES entry for (guard, key) that is still in force and whose bound holds.
 */
function check(guard, key, measured, bound = 0, where = '', unit = 'n') {
  ;(out.measured[guard] ??= {})[key] = measured
  if (measured <= bound + 1e-9) return true
  const a = ALLOWANCES.find((e) => e.guard === guard && e.key === key)
  const at = where ? ` ${where}` : ''
  if (!a) fail(`${guard} ${key}: ${fmtUnit(measured, unit)} > ${fmtUnit(bound, unit)} with no allowance${at}`)
  else if (phaseIdx(a.until) <= phaseIdx(PHASE)) fail(`${guard} ${key}: allowance expired (until ${a.until}, phase ${PHASE}) — ${fmtUnit(measured, unit)}${at}`)
  else if (measured > a.bound + 1e-9) fail(`${guard} ${key}: ${fmtUnit(measured, unit)} above the allowance ${fmtUnit(a.bound, unit)} (${a.why})${at}`)
  else { usedAllowance.add(a); return true }
  suggestions.push({ guard, key, bound: roundUp(measured, unit), measured, unit })
  return false
}
const fmtUnit = (v, unit) => (unit === 'pct' ? `${fmt(v, 2)} %` : unit === 'mm' ? `${fmt(v, 0)} mm` : unit === 'm' ? `${fmt(v, 1)} m` : unit === 'm2' ? `${Math.round(v)} m²` : String(Math.round(v)))
const timers = {}
const guardStart = (g, title) => { timers[g] = Date.now(); console.log(`\n${g}  ${title}`) }
const guardEnd = (g) => { out.ms[g] = Date.now() - timers[g]; console.log(`    [${g} ${out.ms[g]} ms]`) }

// ================================================================ shared geometry: faces + XZ index
/**
 * A FACE is a registered ground face: the `ground:<kind>` meshes of ground-mesh.ts (the
 * partition) and nothing else. OBJECTS (ground.ts GROUND_OBJECTS, tagged by markObject) stand on
 * the faces within a typed width; DECALS (tagged by markDecal) lie on them. Neither is a face;
 * G2 measures an object's width, G3 an object's sink and crown and a decal's clearance.
 */
const meshByGeo = new Map()
root.traverse((o) => { if (o.isMesh && o.geometry) meshByGeo.set(o.geometry.uuid, o) })
const faces = []
{
  const seen = new Set()
  for (const reg of terrain.groundSheets) {
    const mesh = meshByGeo.get(reg.geo.uuid)
    const name = mesh?.name || reg.name
    if (seen.has(name)) { fail(`faces: two registered geometries resolve to the name "${name}"`); continue }
    seen.add(name)
    const kind = name.startsWith('ground:') ? name.slice(7) : null
    const frame = kind ? (RULE_OF[kind]?.frame ?? null) : null
    if (!frame) { fail(`faces: "${name}" is registered but is not a ground:<kind> face of the plan`); continue }
    faces.push({ name, kind, frame, geo: reg.geo, reg, mesh, registered: true })
  }
}
const objects = []
const decals = []
root.updateMatrixWorld(true)
root.traverse((o) => {
  if (!o.isMesh) return
  if (o.userData.groundObject) objects.push(o)
  if (o.userData.decal) decals.push(o)
})
const faceIdx = Object.fromEntries(faces.map((f, i) => [f.name, i]))
const groundFaceSet = new Set(faces.map((f, i) => (f.kind ? i : -1)).filter((i) => i >= 0))

const triCountOf = (geo) => { const idx = geo.getIndex(); return idx ? Math.floor(idx.count / 3) : Math.floor(geo.attributes.position.count / 3) }
const vertexOf = (geo, t, k) => { const idx = geo.getIndex(); return idx ? idx.getX(t * 3 + k) : t * 3 + k }

// live triangles of every face as flat arrays, and one XZ hash over all of them
const CELL = 8
const cells = new Map()
const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768)
/** a triangle under this XZ area (1 mm²) is degenerate: not drawn to any purpose, not in the hash; anything larger is */
const LIVE_AREA = 1e-9
for (let f = 0; f < faces.length; f++) {
  const face = faces[f]
  const pos = face.geo.attributes.position
  const n = triCountOf(face.geo)
  const T = new Float64Array(n * 9)
  const area = new Float64Array(n)
  const live = new Uint8Array(n)
  const vidx = new Int32Array(n * 3)
  let liveCount = 0
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(face.geo, t, k)
      vidx[t * 3 + k] = v
      T[t * 9 + k * 3] = pos.getX(v)
      T[t * 9 + k * 3 + 1] = pos.getY(v)
      T[t * 9 + k * 3 + 2] = pos.getZ(v)
    }
    const o = t * 9
    const a = Math.abs((T[o + 3] - T[o]) * (T[o + 8] - T[o + 2]) - (T[o + 5] - T[o + 2]) * (T[o + 6] - T[o])) / 2
    area[t] = a
    if (a < LIVE_AREA) continue
    live[t] = 1
    liveCount++
    const i0 = Math.floor(Math.min(T[o], T[o + 3], T[o + 6]) / CELL), i1 = Math.floor(Math.max(T[o], T[o + 3], T[o + 6]) / CELL)
    const j0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / CELL), j1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / CELL)
    const id = f * 4194304 + t
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = cellKey(i, j)
      let arr = cells.get(k)
      if (!arr) { arr = []; cells.set(k, arr) }
      arr.push(id)
    }
  }
  Object.assign(face, { T, area, live, vidx, tris: n, liveCount })
}
/**
 * Every live triangle of every face containing (x, z), as {f, t, y}. `tol` is the barycentric
 * tolerance: -1e-6 admits a point on a triangle's boundary (the census: what is visible there),
 * +1e-6 demands the interior (the overlap count: a shared edge is not double cover). `inset`
 * (metres) demands the point be that far inside every edge: the overlap count uses OVERLAP_TOL,
 * so a seam whose two triangulations disagree by millimetres — a world part's contour vertex
 * 5 mm inside a stitch sliver — is not double cover; nothing on the ground is drawn at that scale.
 */
const OVERLAP_TOL = 0.02
const hits = []
function hitsAt(x, z, tol, skipF = -1, skipT = -1, inset = 0) {
  hits.length = 0
  const arr = cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
  if (!arr) return hits
  for (const id of arr) {
    const f = Math.floor(id / 4194304), t = id - f * 4194304
    if (f === skipF && t === skipT) continue
    const T = faces[f].T
    const o = t * 9
    const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (Math.abs(d) < 1e-12) continue
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
    const w = 1 - u - v
    if (u < tol || v < tol || w < tol) continue
    if (inset > 0) {
      // the point's distance to each edge: the barycentric coordinate of the opposite vertex times that vertex's height over the edge (2·area / edge length)
      const area2 = Math.abs(d)
      if (u * area2 / Math.hypot(bx - cx, bz - cz) < inset || v * area2 / Math.hypot(cx - ax, cz - az) < inset || w * area2 / Math.hypot(bx - ax, bz - az) < inset) continue
    }
    hits.push({ f, t, y: ay * u + by * v + cy * w })
  }
  return hits
}
/** every triangle (live or not) of every face whose XZ box contains (x, z) and that contains it with a loose tolerance — diagnostics */
function hitsAtAny(x, z) {
  const out = []
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f], T = face.T
    for (let t = 0; t < face.tris; t++) {
      const o = t * 9
      if (Math.min(T[o], T[o + 3], T[o + 6]) > x + 0.05 || Math.max(T[o], T[o + 3], T[o + 6]) < x - 0.05 || Math.min(T[o + 2], T[o + 5], T[o + 8]) > z + 0.05 || Math.max(T[o + 2], T[o + 5], T[o + 8]) < z - 0.05) continue
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8]
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-14) { out.push({ f, t }); continue }
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      if (u > -0.01 && v > -0.01 && 1 - u - v > -0.01) out.push({ f, t })
    }
  }
  return out
}
/** the topmost face at (x, z) among `set` (a Set of face indices, or null for all), or null */
function topAt(x, z, set = null, tol = -1e-6) {
  const h = hitsAt(x, z, tol)
  let best = null
  for (const r of h) {
    if (set && !set.has(r.f)) continue
    if (!best || r.y > best.y) best = r
  }
  return best
}

/** a decal's bare quads grouped by 20 m of s: "m² s-range·section lat" strings, largest first */
function bareClusters(bareAt) {
  const bins = new Map()
  for (const [x, z, m2] of bareAt) {
    const d = sOf(x, z)
    const b = d ? Math.floor(d.s / 20) : -1
    const c = bins.get(b) ?? { s0: Infinity, s1: -Infinity, lat: 0, m2: 0, n: 0 }
    if (d) { c.s0 = Math.min(c.s0, d.s); c.s1 = Math.max(c.s1, d.s); c.lat += d.lateral }
    c.m2 += m2; c.n++
    bins.set(b, c)
  }
  return [...bins.values()].sort((a, b) => b.m2 - a.m2).map((c) => (c.n && c.s0 < Infinity ? `${fmt(c.m2, 1)}m² s${Math.round(c.s0)}-${Math.round(c.s1)}·${secShort(c.s0)} lat${Math.round(c.lat / c.n)}` : `${fmt(c.m2, 1)}m² far`))
}
/** what an object stands on at (x, z): the top drawn face, or the settled terrain mesh where none is drawn */
const standBase = (x, z) => { const top = topAt(x, z, groundFaceSet); return top ? top.y : terrain.meshHeightAt(x, z) }
const _m4 = new THREE.Matrix4()
const _v3 = new THREE.Vector3()
/** the eight corners of a geometry's bounding box (local) */
function bboxCorners(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox()
  const { min, max } = geo.boundingBox
  const out = []
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) out.push(new THREE.Vector3(x, y, z))
  return out
}
/** top-view (XZ) area of a mesh's upward-facing triangles, world space; an instanced mesh counts every instance */
function topViewArea(o) {
  const pos = o.geometry.attributes.position
  const n = triCountOf(o.geometry)
  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const one = (m) => {
    let area = 0
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pos, vertexOf(o.geometry, t, k)).applyMatrix4(m)
      const [a, b, c] = P
      // twice the signed XZ area, = −n.y of the triangle: negative when it faces up
      const s2 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
      if (s2 < 0) area += -s2 / 2
    }
    return area
  }
  if (!o.isInstancedMesh) return one(o.matrixWorld)
  let area = 0
  for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, _m4); area += one(_m4.premultiply(o.matrixWorld)) }
  return area
}

// ---- lap coordinates -------------------------------------------------------------------------
/** nearest centreline sample (discrete s); null far from every stretch of road */
const sOf = (x, z) => {
  let d = terrain.distanceToTrack(x, z, 120)
  if (d.i < 0) d = terrain.distanceToTrack(x, z, 400)
  return d.i < 0 ? null : d
}
/** continuous (s, lateral) refined on the segments around the nearest sample */
const contOf = (x, z, d) => track.nearestOnRange(x, z, d.s - 6, d.s + 6, 0)
/**
 * (s, lateral) such that `track.pointAt(s, lateral)` lands ON (x, z): `nearestOnRange` projects
 * onto the chord with the interpolated normal, which is not pointAt's inverse — on a cambered
 * bend the residual is centimetres, and a road-frame height read there is off by slope × error.
 */
function roadProject(x, z, d) {
  const c = contOf(x, z, d)
  let s = c.s, lat = c.lateral
  // Newton on (s, lateral) converges by a factor of about lateral × curvature per step: 0.45 at
  // the chicane's edge, so three steps left 1 cm of lateral (5 mm of kerb profile) — twelve
  // reach the 0.1 mm break everywhere
  for (let it = 0; it < 12; it++) {
    track.pointAt(s, lat, _v, 0)
    const rx = x - _v.x, rz = z - _v.z
    if (rx * rx + rz * rz < 1e-8) break
    const h = track.headingAt(s)
    s = track.wrap(s + rx * h.tx + rz * h.tz)
    lat += rx * h.tz - rz * h.tx // the track's left normal is (tz, −tx)
  }
  return { s, lateral: lat }
}
/** the double crossover window: excluded from every XZ guard unconditionally */
const inCross = (s) => Math.abs(signedDelta(sOver, s, L)) < 115 || Math.abs(signedDelta(sUnder, s, L)) < 115
const inFwd = (from, to, s) => forwardDelta(from, s, L) <= forwardDelta(from, to, L)
const sectionOf = (s) => sections.find((sec) => inFwd(sec.s[0], sec.s[1], s))?.id ?? '-'
const secShort = (s) => sectionOf(s).slice(0, 2)
const sideCh = (side) => (side > 0 ? 'L' : 'R')
const _v = new THREE.Vector3()

console.log(`surface-check v3 — phase ${PHASE}, tier ${TIER}, scene built in ${built} ms; ${faces.length} faces (${faces.map((f) => f.name).join(', ')})`)
console.log(`    plan: ${plan.stations.length} stations, ${plan.stats.buildMs.toFixed(0)} ms; mesh: ${groundMeshes.stats.triangles} triangles, ${groundMeshes.stats.buildMs.toFixed(0)} ms`)

// ================================================================ G0 — the layer ladder (decals and objects)
if (runs('G0')) {
  guardStart('G0', 'layer ladder — every LAYER stack ascending, ≥ LAYER_MIN_STEP apart')
  let tight = 0, unordered = 0
  for (const [stack, entries] of Object.entries(LAYER)) {
    const list = Object.entries(entries)
    console.log(`    ${stack}: ${list.map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ')}`)
    for (let i = 0; i < list.length - 1; i++) {
      const [ka, va] = list[i], [kb, vb] = list[i + 1]
      const a = `${stack}.${ka}`, b = `${stack}.${kb}`
      if (vb <= va) { unordered++; notes.push(`G0: ${b} (${vb}) is not above ${a} (${va})`) }
      if (LAYER_SOFT.has(a) || LAYER_SOFT.has(b)) continue
      if (vb - va < LAYER_MIN_STEP - 1e-9) { tight++; notes.push(`G0: ${a} → ${b} is ${((vb - va) * 1000).toFixed(0)} mm apart`) }
    }
  }
  console.log(`    ${tight} pair(s) under ${LAYER_MIN_STEP * 1000} mm, ${unordered} out of order`)
  check('G0', 'unordered', unordered)
  check('G0', 'tightPairs', tight)
  // the objects' rules: an edge that sinks and a crown that stands clear of a face are what keep
  // an object from z-fighting the face (rule R8); the tags on the scene must carry the same rule
  let badRules = 0, badTags = 0
  for (const [kind, r] of Object.entries(GROUND_OBJECTS)) {
    console.log(`    object ${kind}: width ≤ ${r.maxWidth} m, edges ${(r.sink * 1000).toFixed(0)} mm under, crown ${(r.crown * 1000).toFixed(0)} mm over`)
    if (!(r.sink >= 0.01 && r.crown >= 0.02 && r.maxWidth > 0)) { badRules++; notes.push(`G0: GROUND_OBJECTS.${kind} needs sink ≥ 10 mm, crown ≥ 20 mm, a width`) }
  }
  for (const o of objects) {
    const tag = o.userData.groundObject
    const r = GROUND_OBJECTS[tag.kind]
    if (!r || r.sink !== tag.sink || r.crown !== tag.crown || r.maxWidth !== tag.maxWidth || !(tag.length > 0)) { badTags++; notes.push(`G0: object '${o.name}' carries a tag that is not GROUND_OBJECTS.${tag.kind}`) }
  }
  console.log(`    ${objects.length} object mesh(es) [${objects.map((o) => o.name).join(', ')}], ${decals.length} decal mesh(es) [${decals.map((o) => o.name).join(', ')}]`)
  check('G0', 'objectRules', badRules)
  check('G0', 'objectTags', badTags)
  guardEnd('G0')
}

// ================================================================ G1 — census: visible kind vs the plan's owner
if (runs('G1')) {
  guardStart('G1', 'census — the face visible from above vs the owner the plan declares (plan.ownerAt)')
  const gotAt = (x, z) => {
    const top = topAt(x, z, groundFaceSet)
    const tY = terrain.meshHeightAt(x, z)
    if (!top || top.y < tY) return { name: 'terrain', y: tY }
    return { name: faces[top.f].kind, y: top.y }
  }
  const stats = { total: 0, lattice: 0, ring: 0, seam: 0, match: 0, mismatch: 0, cross: 0, far: 0 }
  const matrix = new Map()
  const records = []
  const SEAM = 0.5
  const SEAM_D = SEAM / Math.SQRT2
  /** expected owner kind at (s, side, off): the plan's, read at the point's own stretch */
  const expectedSL = (s, side, off) => plan.ownerAtSL(s, side, off).kind
  const sampleSL = (s, side, off, x, z, fromRing) => {
    if (inCross(s)) { stats.cross++; return }
    stats.total++
    if (fromRing) stats.ring++; else stats.lattice++
    // a ring-interior sample is judged on its own point: (s, off) → point is centimetres off 180 m out
    const exp = fromRing ? plan.ownerAtSL(s, side, off, false, { x, z }).kind : expectedSL(s, side, off)
    // seam band: the owner changes within SEAM along s or across, so the boundary itself is not judged
    let seam = false
    for (const ds of [-SEAM, SEAM]) {
      const s2 = track.wrap(s + ds)
      if (expectedSL(s2, side, off) !== exp) { seam = true; break }
    }
    if (!seam) for (const doff of [-SEAM, SEAM]) { if (off + doff >= 0 && expectedSL(s, side, off + doff) !== exp) { seam = true; break } }
    // ...and diagonally, so the band is a disc rather than a cross (an oblique ring edge 0.43 m
    // away passed the four axis tests)
    if (!seam) for (const [ds, doff] of [[-SEAM_D, -SEAM_D], [-SEAM_D, SEAM_D], [SEAM_D, -SEAM_D], [SEAM_D, SEAM_D]]) { if (off + doff >= 0 && expectedSL(track.wrap(s + ds), side, off + doff) !== exp) { seam = true; break } }
    if (seam) { stats.seam++; return }
    const got = gotAt(x, z)
    if (got.name === exp) { stats.match++; return }
    stats.mismatch++
    const mk = `${exp}>${got.name}`
    matrix.set(mk, (matrix.get(mk) ?? 0) + 1)
    records.push({ s, side, off, exp, got: got.name, x, z })
    if (process.env.GM_DUMP_CENSUS) console.log(`      census mismatch: ${exp} > ${got.name} at s${s.toFixed(1)} ${sideCh(side)} off${off.toFixed(2)} xz (${x.toFixed(2)}, ${z.toFixed(2)})`)
  }
  // the verge lattice: every metre of s, both sides, 0.5 m across up to the drawn extent, never
  // exactly on the road edge or the extent
  for (let s = 0; s < L; s += 1) {
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const W = plan.extentDrawn(s, side)
      for (let off = 0.05; off <= W - SEAM; off += 0.5) {
        track.pointAt(s, side * (hw + off), _v, 0)
        sampleSL(s, side, off, _v.x, _v.z, false)
      }
    }
  }
  // the interior of every ring on a 1 m grid, beyond the lattice (an area reaches past the extent)
  for (const r of plan.rings) {
    const b = r.ring.box
    for (let x = Math.ceil(b[0]); x <= b[1]; x += 1) for (let z = Math.ceil(b[2]); z <= b[3]; z += 1) {
      if (!planMod.inWorldRing(x, z, r.ring)) continue
      const p = plan.project(x, z)
      if (p.d > 200) { stats.far++; continue }
      const hw = track.halfWidthAt(p.s)
      const side = p.lateral >= 0 ? 1 : -1
      const off = Math.abs(p.lateral) - hw
      if (off <= plan.extentDrawn(p.s, side) - SEAM) continue // the lattice has it
      if (off < 0) continue
      sampleSL(p.s, side, off, x, z, true)
    }
  }
  // the crossover: beyond each road's drawn extent, within its declared minimum verge, every
  // point must still have a face — the lower road's raster stops at the upper road's edge and the
  // upper road's verge ramps out beyond its deck zone (ground-plan DECK_ZONE); a point with no
  // face there is a wedge of bare terrain between the two rasters. The upper road's deck zone
  // itself (the embankment) is bare by design and skipped — with the ramps on either side of it,
  // where the raster narrows to the deck shoulder at EXTENT_SLOPE: the ground beside the ramp is
  // the embankment's slope, and the two rasters' boundaries cross each other in XZ there, so no
  // ring's part can be traced round it (a band on the upper road's frame was tried: untraced)
  let crossBare = 0
  const crossBareAt = []
  for (const [sc, isUpper] of [[sOver, true], [sUnder, false]]) {
    for (let d = -115; d <= 115; d += 1) {
      const s = track.wrap(sc + d)
      if (isUpper && Math.abs(d) < planMod.DECK_ZONE + (planMod.VERGE_MIN - planMod.DECK_SHOULDER) / planMod.EXTENT_SLOPE) continue
      const hw = track.halfWidthAt(s)
      for (const side of [1, -1]) {
        const W = plan.extentDrawn(s, side)
        for (let off = Math.max(W + 0.5, 1); off <= planMod.VERGE_MIN - 0.5; off += 1) {
          track.pointAt(s, side * (hw + off), _v, 0)
          // the other road may own this ground: skip points within its own drawn raster or beyond both roads' reach
          if (topAt(_v.x, _v.z, groundFaceSet)) continue
          const other = terrain.distanceToTrack(_v.x, _v.z, 60)
          if (other.i < 0) continue
          crossBare++
          if (crossBareAt.length < 6) crossBareAt.push(`s${Math.round(s)} ${sideCh(side)} off${off.toFixed(0)}`)
        }
      }
    }
  }
  console.log(`    crossover: ${crossBare} bare lattice point(s) within the declared verge beyond the drawn extent${crossBareAt.length ? ` (${crossBareAt.join(', ')}…)` : ''}`)
  const judged = stats.total - stats.seam
  console.log(`    ${stats.total} samples (${stats.lattice} lattice + ${stats.ring} ring interior; ${stats.cross} more in the crossover window, ${stats.far} far from the lap), ${stats.seam} in a seam band`)
  console.log(`    judged ${judged}: match ${stats.match} (${fmt((100 * stats.match) / Math.max(1, judged), 3)} %), mismatch ${stats.mismatch}`)
  const rows = [...matrix.entries()].sort((a, b) => b[1] - a[1])
  console.log('    expected > got                      samples')
  for (const [k, n] of rows) console.log(`    ${padE(k, 34)} ${pad(n, 7)}`)
  records.sort((a, b) => a.side - b.side || a.exp.localeCompare(b.exp) || a.got.localeCompare(b.got) || a.s - b.s)
  const clusters = []
  for (const r of records) {
    const c = clusters[clusters.length - 1]
    if (c && c.side === r.side && c.exp === r.exp && c.got === r.got && r.s - c.to <= 3) { c.to = r.s; c.n++; c.off0 = Math.min(c.off0, r.off); c.off1 = Math.max(c.off1, r.off) }
    else clusters.push({ from: r.s, to: r.s, side: r.side, exp: r.exp, got: r.got, n: 1, off0: r.off, off1: r.off })
  }
  clusters.sort((a, b) => b.n - a.n)
  console.log('    top clusters:  s-range      side  off-range   samples  sec  expected > got')
  for (const c of clusters.slice(0, 25)) console.log(`      ${pad(Math.round(c.from), 5)}-${padE(Math.round(c.to), 5)}   ${sideCh(c.side)}   ${pad(fmt(c.off0, 1), 5)}-${padE(fmt(c.off1, 1), 5)} ${pad(c.n, 7)}  ${secShort(c.from)}   ${c.exp} > ${c.got}`)
  console.log(`    ${clusters.length} clusters in all`)
  // The runtime census — ground-census.ts, what the e2e suite reads from window.__suzuka.groundCensus()
  // — on ITS point set (a 4 m × 2 m verge lattice and a 2 m grid inside every ring), judged by
  // plan.ownerAt(x, z): the WORLD lookup (project, then the rings on the point), where the
  // lattice above asks the plan in the frame. The two disagreed where the frame's round trip is
  // not pointAt's inverse (I5-a: the T3 lot's tip and the T1 pond's shore, 40–70 m out on the T3
  // bend, read grass over drawn paddock / water in the browser and passed here). Once on the
  // mesh's own index (the browser's number, to the sample) and once on this guard's face index.
  const runtime = groundCensus(track, plan, groundMeshes)
  const runtimeFaces = groundCensus(track, plan, { yAt: (x, z) => { const g = gotAt(x, z); return { y: g.y, kind: g.name, src: -1 } } })
  const worstOf = (c) => c.worst.slice(0, 6).map((w) => { const p = plan.project(w.x, w.z); return `${w.expected} > ${w.got} at s${p.s.toFixed(1)} lat${p.lateral.toFixed(1)} xz (${w.x.toFixed(2)}, ${w.z.toFixed(2)})` }).join('; ')
  console.log(`    runtime census (ground-census.ts): ${runtime.samples} samples, ${runtime.seam} in a seam band, match ${runtime.match}, mismatch ${runtime.mismatch} on the mesh index (${runtime.ms.toFixed(0)} ms)${runtime.mismatch ? ` — ${worstOf(runtime)}` : ''}`)
  console.log(`    runtime census on this guard's faces: match ${runtimeFaces.match}, mismatch ${runtimeFaces.mismatch}${runtimeFaces.mismatch ? ` — ${worstOf(runtimeFaces)}` : ''}`)
  out.guards.G1 = { ...stats, matrix: Object.fromEntries(rows), clusters: clusters.slice(0, 25), runtime: { samples: runtime.samples, seam: runtime.seam, match: runtime.match, mismatch: runtime.mismatch, worst: runtime.worst }, runtimeFaces: { match: runtimeFaces.match, mismatch: runtimeFaces.mismatch, worst: runtimeFaces.worst } }
  for (const [k, n] of rows) check('G1', k, n)
  check('G1', 'crossoverBare', crossBare, 0, crossBareAt.join(', '))
  check('G1', 'runtime.mismatch', runtime.mismatch, 0, worstOf(runtime))
  check('G1', 'runtime.faces', runtimeFaces.mismatch, 0, worstOf(runtimeFaces))
  guardEnd('G1')
}

// ================================================================ G2 — overlap: any two faces over one point (the same face included)
if (runs('G2')) {
  guardStart('G2', `overlap — faces covering the same XZ point (${OVERLAP_TOL * 1000} mm inside both), the same face included; upper = the one on top at the sample`)
  const pairs = new Map()
  let samplesTotal = 0, overlapSamples = 0, crossSkipped = 0, far = 0
  const BIN = 20
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]
    const T = face.T
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      const o = t * 9
      const P = [
        [(T[o] + T[o + 3] + T[o + 6]) / 3, (T[o + 2] + T[o + 5] + T[o + 8]) / 3, (T[o + 1] + T[o + 4] + T[o + 7]) / 3],
        [(T[o] + T[o + 3]) / 2, (T[o + 2] + T[o + 5]) / 2, (T[o + 1] + T[o + 4]) / 2],
        [(T[o + 3] + T[o + 6]) / 2, (T[o + 5] + T[o + 8]) / 2, (T[o + 4] + T[o + 7]) / 2],
        [(T[o + 6] + T[o]) / 2, (T[o + 8] + T[o + 2]) / 2, (T[o + 7] + T[o + 1]) / 2],
      ]
      const a4 = face.area[t] / 4
      for (const [x, z, y] of P) {
        samplesTotal++
        const h = hitsAt(x, z, 1e-6, f, t, OVERLAP_TOL)
        if (!h.length) continue
        const d = sOf(x, z)
        if (!d) { far++; continue }
        if (inCross(d.s)) { crossSkipped++; continue }
        overlapSamples++
        if (process.env.GM_DUMP_OVERLAP && overlapSamples <= 16) console.log(`      overlap sample at (${x.toFixed(2)}, ${z.toFixed(2)}) s${d.s.toFixed(1)} lat${d.lateral.toFixed(1)}: ${face.name} tri ${t} src${face.mesh?.userData?.triSource?.[t] ?? '-'} y ${y.toFixed(3)} vs ${h.map((r) => `${faces[r.f].name} tri ${r.t} src${faces[r.f].mesh?.userData?.triSource?.[r.t] ?? '-'} y ${r.y.toFixed(3)}`).join(', ')}`)
        for (const r of h) {
          const other = faces[r.f].name
          const dy = r.y - y
          const top = dy > 0 ? other : face.name
          const bottom = dy > 0 ? face.name : other
          const key = `${top}|${bottom}`
          let p = pairs.get(key)
          if (!p) { p = { top, bottom, n: 0, area: 0, gap: 0, bins: new Map() }; pairs.set(key, p) }
          if (DEBUG_PAIR === key && p.n < 40) {
            const T2 = faces[r.f].T, o2 = r.t * 9
            const tri = (TT, oo) => [0, 3, 6].map((k) => `(${TT[oo + k].toFixed(2)},${TT[oo + k + 2].toFixed(2)},y${TT[oo + k + 1].toFixed(3)})`).join(' ')
            console.log(`      [pair] ${key} at (${x.toFixed(1)}, ${z.toFixed(1)}) s ${d.s.toFixed(1)} lat ${d.lateral.toFixed(1)} gap ${(dy * 1000).toFixed(0)} mm — ${face.name} tri ${t} src ${face.mesh?.userData?.triSource?.[t] ?? '-'} [${tri(T, o)}] vs ${other} tri ${r.t} src ${faces[r.f].mesh?.userData?.triSource?.[r.t] ?? '-'} [${tri(T2, o2)}]`)
          }
          p.n++
          p.area += a4
          const g = Math.abs(dy)
          if (g > p.gap) p.gap = g
          const b = Math.floor(d.s / BIN)
          p.bins.set(b, (p.bins.get(b) ?? 0) + 1)
        }
      }
    }
  }
  const rows = [...pairs.values()].sort((a, b) => b.n - a.n)
  console.log(`    ${samplesTotal} samples on ${faces.reduce((a, f) => a + f.liveCount, 0)} live triangles; ${overlapSamples} covered by another triangle (${crossSkipped} skipped in the crossover window, ${far} far from the lap)`)
  console.log('    upper                  lower                   samples      m²  gap mm  runs (s-range·section)')
  for (const p of rows) {
    const bins = [...p.bins.keys()].sort((a, b) => a - b)
    const runsOf = []
    for (const b of bins) {
      const r = runsOf[runsOf.length - 1]
      if (r && b - r.b1 <= 1) { r.b1 = b; r.n += p.bins.get(b) } else runsOf.push({ b0: b, b1: b, n: p.bins.get(b) })
    }
    runsOf.sort((a, b) => b.n - a.n)
    const runTxt = runsOf.slice(0, 3).map((r) => `${r.b0 * BIN}-${(r.b1 + 1) * BIN}·${secShort(r.b0 * BIN)}`).join(' ') + (runsOf.length > 3 ? ` +${runsOf.length - 3}` : '')
    console.log(`    ${padE(p.top, 22)} ${padE(p.bottom, 22)} ${pad(p.n, 8)} ${pad(Math.round(p.area / 2), 7)}  ${pad(fmt(p.gap * 1000, 0), 6)}  ${runTxt}`)
  }
  console.log(`    ${rows.length} ordered pairs`)
  out.guards.G2 = rows.map((p) => ({ pair: `${p.top}|${p.bottom}`, samples: p.n, m2: Math.round(p.area / 2), gapMm: Math.round(p.gap * 1000) }))
  for (const p of rows) check('G2', `${p.top}|${p.bottom}`, p.n, 0, `(${Math.round(p.area / 2)} m², gap ${Math.round(p.gap * 1000)} mm)`)
  // objects: the footprint an object covers is bounded by its rule's width — measured as the
  // top-view area of its upward triangles over the length of its run (rule R8)
  const widths = []
  for (const o of objects) {
    const tag = o.userData.groundObject
    const area = topViewArea(o)
    const width = area / Math.max(1e-6, tag.length)
    widths.push({ name: o.name, kind: tag.kind, area, length: tag.length, width, maxWidth: tag.maxWidth })
    console.log(`    object ${padE(o.name, 16)} ${tag.kind}: ${fmt(area, 1)} m² over ${fmt(tag.length, 0)} m = ${fmt(width, 2)} m wide (rule ${tag.maxWidth} m)`)
  }
  out.guards.G2objects = widths
  for (const w of widths) check('G2', `object.${w.name}.width`, Number(fmt(Math.max(0, w.width - w.maxWidth), 2)), 0, `(${fmt(w.width, 2)} m mean over ${Math.round(w.length)} m, rule ${w.maxWidth} m)`, 'm')
  guardEnd('G2')
}

// ================================================================ G3 — deviation from the declared frame
if (runs('G3')) {
  guardStart('G3', 'deviation — face centroid vs its declared frame (road plane ≤ 2 mm, height field ≤ 40 mm where the field is walkable: a wall or a step in the relief, slope > 45°, is a cliff and not judged)')
  const rows = []
  /**
   * whether a triangle stands on a cliff: the field read at its three corners and its centroid
   * spans more than its longest edge (slope > 45°). A triangle straddling a retaining wall or a
   * terrace step deviates by the step, not by a chord; read at the centroid alone, a wall 0.3 m
   * from the centroid went unseen
   */
  const onCliff = (T, o) => {
    const ys = [ground.field.y(T[o], T[o + 2]), ground.field.y(T[o + 3], T[o + 5]), ground.field.y(T[o + 6], T[o + 8]), ground.field.y((T[o] + T[o + 3] + T[o + 6]) / 3, (T[o + 2] + T[o + 5] + T[o + 8]) / 3)]
    const longest = Math.max(Math.hypot(T[o + 3] - T[o], T[o + 5] - T[o + 2]), Math.hypot(T[o + 6] - T[o + 3], T[o + 8] - T[o + 5]), Math.hypot(T[o] - T[o + 6], T[o + 2] - T[o + 8]))
    return Math.max(...ys) - Math.min(...ys) > Math.max(0.25, longest)
  }
  console.log('    face                   frame   n        p50 mm  p99 mm   max mm   beyond    skipped  cliff   worst (one per 20 m)')
  for (const face of faces) {
    const T = face.T
    const frame = face.frame
    const limit = frame === 'road' ? 0.002 : 0.04
    const rule = RULE_OF[face.kind]
    const devs = []
    const worst = []
    const dumpRows = []
    let skipped = 0, cliff = 0
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      const o = t * 9
      const x = (T[o] + T[o + 3] + T[o + 6]) / 3, z = (T[o + 2] + T[o + 5] + T[o + 8]) / 3, y = (T[o + 1] + T[o + 4] + T[o + 7]) / 3
      const d = sOf(x, z)
      if (!d) { skipped++; continue }
      if (inCross(d.s)) { skipped++; continue }
      if (frame !== 'road' && onCliff(T, o)) { cliff++; continue }
      let expected
      if (frame === 'road') {
        const c = roadProject(x, z, d)
        track.pointAt(c.s, c.lateral, _v, 0)
        if ('profile' in rule) {
          const side = c.lateral >= 0 ? 1 : -1
          const kb = kerbAt(plan.kerbs, track, c.s, side)
          expected = _v.y + kerbProfileHeight(kb.width, kb.taper, kb.spread, Math.abs(c.lateral) - track.halfWidthAt(c.s))
        } else expected = _v.y + rule.dy
      } else expected = ground.field.y(x, z)
      const dev = Math.abs(y - expected)
      if (process.env.GM_DUMP_G3 === face.kind && dev > limit) {
        const c = frame === 'road' ? roadProject(x, z, d) : null
        dumpRows.push({ dev, line: `      G3 ${face.kind} tri ${t}: dev ${(dev * 1000).toFixed(1)} mm at (${x.toFixed(3)}, ${z.toFixed(3)}) y ${y.toFixed(4)} exp ${expected.toFixed(4)}${c ? ` s ${c.s.toFixed(3)} lat ${c.lateral.toFixed(3)} off ${(Math.abs(c.lateral) - track.halfWidthAt(c.s)).toFixed(3)} roll ${((track.rollAt(c.s) * 180) / Math.PI).toFixed(2)}° kerb ${JSON.stringify(kerbAt(plan.kerbs, track, c.s, c.lateral >= 0 ? 1 : -1))}` : ''} verts ${[0, 3, 6].map((k) => `(${T[o + k].toFixed(3)}, ${T[o + k + 1].toFixed(4)}, ${T[o + k + 2].toFixed(3)})`).join(' ')}` })
      }
      devs.push(dev)
      if (dev > limit) {
        const bin = Math.floor(d.s / 20)
        const same = worst.find((w) => w.bin === bin)
        if (same) { if (dev > same.dev) Object.assign(same, { dev, s: d.s, lat: d.lateral }) }
        else { worst.push({ bin, dev, s: d.s, lat: d.lateral }); worst.sort((a, b) => b.dev - a.dev); if (worst.length > 3) worst.pop() }
      }
    }
    if (dumpRows.length) { dumpRows.sort((a, b) => b.dev - a.dev); for (const r of dumpRows.slice(0, 10)) console.log(r.line) }
    devs.sort((a, b) => a - b)
    const n = devs.length
    const q = (p) => (n ? devs[Math.min(n - 1, Math.floor(p * n))] : 0)
    const beyond = devs.filter((v) => v > limit).length
    const pct = n ? (100 * beyond) / n : 0
    rows.push({ name: face.name, frame, n, p50: q(0.5), p99: q(0.99), max: n ? devs[n - 1] : 0, pct, beyond, skipped, cliff, worst })
    console.log(`    ${padE(face.name, 22)} ${padE(frame, 6)} ${pad(n, 8)}  ${pad(fmt(q(0.5) * 1000, 1), 7)} ${pad(fmt(q(0.99) * 1000, 1), 7)}  ${pad(fmt((n ? devs[n - 1] : 0) * 1000, 0), 7)}  ${pad(fmt(pct, 2), 6)} %  ${pad(skipped, 7)} ${pad(cliff, 6)}  ${worst.map((w) => `s${Math.round(w.s)} lat${Math.round(w.lat)} ${Math.round(w.dev * 1000)}mm·${secShort(w.s)}`).join(' ')}`)
  }
  out.guards.G3 = rows.map((r) => ({ ...r, p50: Math.round(r.p50 * 1000), p99: Math.round(r.p99 * 1000), max: Math.round(r.max * 1000) }))
  for (const r of rows) check('G3', r.name, Number(fmt(r.pct, 2)), 0, `(${r.frame} frame, p99 ${fmt(r.p99 * 1000, 0)} mm, max ${fmt(r.max * 1000, 0)} mm)`, 'pct')

  // --- objects (R8): every vertex is either SUNK (≤ face − 10 mm) or PROUD (≥ face + 20 mm);
  // a vertex on the face z-fights it. For an instanced object each instance's lowest corner must
  // be sunk and its highest proud.
  console.log('    object                 kind      vertices   sunk     proud    on-face   min mm  max mm')
  const objRows = []
  for (const o of objects) {
    const tag = o.userData.groundObject
    const st = { name: o.name, kind: tag.kind, n: 0, sunk: 0, proud: 0, onFace: 0, min: Infinity, max: -Infinity, worst: [] }
    const judge = (x, z, y, what) => {
      const d = sOf(x, z)
      if (d && inCross(d.s)) return
      const dy = y - standBase(x, z)
      st.n++
      if (dy < st.min) st.min = dy
      if (dy > st.max) st.max = dy
      if (dy <= -0.01) st.sunk++
      else if (dy >= 0.02) st.proud++
      else { st.onFace++; if (st.worst.length < 3) st.worst.push(`${what} ${(dy * 1000).toFixed(0)}mm s${d ? Math.round(d.s) : '?'}·${d ? secShort(d.s) : ''}`) }
    }
    if (o.isInstancedMesh) {
      const corners = bboxCorners(o.geometry)
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _m4)
        _m4.premultiply(o.matrixWorld)
        let lo = Infinity, hi = -Infinity, cx = 0, cz = 0
        for (const c of corners) { _v3.copy(c).applyMatrix4(_m4); lo = Math.min(lo, _v3.y); hi = Math.max(hi, _v3.y); cx += _v3.x / 8; cz += _v3.z / 8 }
        judge(cx, cz, lo, 'base')
        judge(cx, cz, hi, 'crown')
      }
    } else {
      const pos = o.geometry.attributes.position
      for (let v = 0; v < pos.count; v++) {
        _v3.fromBufferAttribute(pos, v).applyMatrix4(o.matrixWorld)
        judge(_v3.x, _v3.z, _v3.y, `v${v}`)
      }
    }
    objRows.push(st)
    console.log(`    ${padE(st.name, 22)} ${padE(st.kind, 9)} ${pad(st.n, 8)} ${pad(st.sunk, 7)} ${pad(st.proud, 8)} ${pad(st.onFace, 8)}  ${pad(st.n ? fmt(st.min * 1000, 0) : '-', 6)} ${pad(st.n ? fmt(st.max * 1000, 0) : '-', 7)}  ${st.worst.join(' ')}`)
  }
  out.guards.G3objects = objRows.map((r) => ({ name: r.name, n: r.n, sunk: r.sunk, proud: r.proud, onFace: r.onFace, minMm: Math.round(r.min * 1000), maxMm: Math.round(r.max * 1000) }))
  for (const r of objRows) check('G3', `object.${r.name}.onFace`, r.onFace, 0, `(min ${fmt(r.min * 1000, 0)} mm, max ${fmt(r.max * 1000, 0)} mm)`)

  // --- decals (R9): every sample (vertices, edge midpoints, centroid of every live triangle) lies
  // ≥ 6 mm over the drawn face under it — a soft decal (no depth write) merely over it — and
  // there IS a face under it (a decal on bare terrain has nothing to lie on)
  console.log('    decal                  rung   soft  samples   no-face  buried   min mm   p50 mm   bare m²  worst (one per 20 m)')
  const decRows = []
  for (const dm of decals) {
    const tag = dm.userData.decal
    const limit = tag.soft ? 0 : 0.006
    const st = { name: dm.name, rung: tag.rung, soft: tag.soft, n: 0, noFace: 0, noFaceBins: new Map(), buried: 0, min: Infinity, dys: [], worst: [], uncovered: tag.uncovered ?? 0, area: tag.area ?? 0, bareAt: bareClusters(tag.bareAt ?? []) }
    const sample = (x, z, y) => {
      const d = sOf(x, z)
      if (!d || inCross(d.s)) return
      // a decal vertex lies ON a face edge (it was clipped from the face), so the boundary test
      // tolerates float32: 1e-4 barycentric (0.4 mm on a 4 m triangle), and 1e-2 as a last
      // resort — a decal clipped from a millimetre sliver cannot be placed inside it in float32
      const top = topAt(x, z, groundFaceSet) ?? topAt(x, z, groundFaceSet, -1e-4) ?? topAt(x, z, groundFaceSet, -1e-2)
      st.n++
      if (!top) {
        st.noFace++
        const b = Math.floor(d.s / 20)
        st.noFaceBins.set(b, (st.noFaceBins.get(b) ?? 0) + 1)
        if (DEBUG_DECAL === dm.name && st.noFace <= 12) console.log(`      [decal] ${dm.name} no face at (${x.toFixed(3)}, ${z.toFixed(3)}) s ${d.s.toFixed(1)} lat ${d.lateral.toFixed(2)} y ${y.toFixed(3)}; hits ignoring live: ${hitsAtAny(x, z).map((h) => `${faces[h.f].name}#${h.t} area ${faces[h.f].area[h.t].toExponential(1)}`).join(', ') || 'none'}`)
        return
      }
      const dy = y - top.y
      st.dys.push(dy)
      if (dy < st.min) st.min = dy
      if (dy < limit) {
        st.buried++
        const bin = Math.floor(d.s / 20)
        const same = st.worst.find((w) => w.bin === bin)
        if (same) { if (dy < same.dy) Object.assign(same, { dy, s: d.s, lat: d.lateral }) }
        else { st.worst.push({ bin, dy, s: d.s, lat: d.lateral }); st.worst.sort((a, b) => a.dy - b.dy); if (st.worst.length > 4) st.worst.pop() }
      }
    }
    if (dm.isInstancedMesh) {
      const corners = bboxCorners(dm.geometry)
      for (let i = 0; i < dm.count; i++) {
        dm.getMatrixAt(i, _m4)
        _m4.premultiply(dm.matrixWorld)
        // the four lowest corners: the underside of the slab
        const ws = corners.map((c) => _v3.copy(c).applyMatrix4(_m4).clone()).sort((a, b) => a.y - b.y).slice(0, 4)
        for (const w of ws) sample(w.x, w.z, w.y)
      }
    } else {
      const pos = dm.geometry.attributes.position
      const n = triCountOf(dm.geometry)
      const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
      for (let tI = 0; tI < n; tI++) {
        for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pos, vertexOf(dm.geometry, tI, k)).applyMatrix4(dm.matrixWorld)
        const [a, b, c] = P
        const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x))
        if (area2 < 2 * LIVE_AREA) continue
        sample(a.x, a.z, a.y); sample(b.x, b.z, b.y); sample(c.x, c.z, c.y)
        sample((a.x + b.x) / 2, (a.z + b.z) / 2, (a.y + b.y) / 2)
        sample((b.x + c.x) / 2, (b.z + c.z) / 2, (b.y + c.y) / 2)
        sample((c.x + a.x) / 2, (c.z + a.z) / 2, (c.y + a.y) / 2)
        sample((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, (a.y + b.y + c.y) / 3)
      }
    }
    st.dys.sort((a, b) => a - b)
    st.p50 = st.dys.length ? st.dys[Math.floor(st.dys.length / 2)] : 0
    decRows.push(st)
    console.log(`    ${padE(st.name, 22)} ${pad(fmt(st.rung * 1000, 0), 4)}   ${st.soft ? 'yes ' : 'no  '} ${pad(st.n, 8)} ${pad(st.noFace, 8)} ${pad(st.buried, 7)}  ${pad(st.dys.length ? fmt(st.min * 1000, 1) : '-', 7)}  ${pad(fmt(st.p50 * 1000, 1), 7)}  ${pad(fmt(st.uncovered, 1), 7)}  ${st.worst.map((w) => `${(w.dy * 1000).toFixed(0)}mm s${Math.round(w.s)} lat${Math.round(w.lat)}·${secShort(w.s)}`).join(' ')}`)
  }
  out.guards.G3decals = decRows.map((r) => ({ name: r.name, rungMm: Math.round(r.rung * 1000), soft: r.soft, n: r.n, noFace: r.noFace, buried: r.buried, minMm: Number(fmt(r.min * 1000, 1)), p50Mm: Number(fmt(r.p50 * 1000, 1)), bareM2: Number(fmt(r.uncovered, 1)) }))
  for (const r of decRows) {
    check('G3', `decal.${r.name}.noFace`, r.noFace, 0, [...r.noFaceBins.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([b, n]) => `${n}×s${b * 20}-${b * 20 + 20}·${secShort(b * 20)}`).join(' '))
    check('G3', `decal.${r.name}.buried`, r.buried, 0, `(min ${fmt(r.min * 1000, 1)} mm over the face, rung ${fmt(r.rung * 1000, 0)} mm)`)
    // the outline the builder declared but could not draw: no face under it (bare terrain)
    check('G3', `decal.${r.name}.bare`, Number(fmt(r.uncovered, 1)), 0, `(of ${fmt(r.area, 0)} m² declared; ${r.bareAt.join(' ')})`, 'm2')
  }
  guardEnd('G3')
}

// ================================================================ G4 — mesh quality
if (runs('G4')) {
  guardStart('G4', 'quality — zero-area triangles, zero normals on drawn vertices, field-frame faces tilted > 10° away from the field (on walkable field: a cliff\'s normal is not the ground\'s)')
  const onCliffAt = (T, o) => {
    const ys = [ground.field.y(T[o], T[o + 2]), ground.field.y(T[o + 3], T[o + 5]), ground.field.y(T[o + 6], T[o + 8]), ground.field.y((T[o] + T[o + 3] + T[o + 6]) / 3, (T[o + 2] + T[o + 5] + T[o + 8]) / 3)]
    const longest = Math.max(Math.hypot(T[o + 3] - T[o], T[o + 5] - T[o + 2]), Math.hypot(T[o + 6] - T[o + 3], T[o + 8] - T[o + 5]), Math.hypot(T[o] - T[o + 6], T[o + 2] - T[o + 8]))
    return Math.max(...ys) - Math.min(...ys) > Math.max(0.25, longest)
  }
  console.log('    face                    tris   zero-area   zero-normal   off-field>10°  worst   slivers<0.01m²')
  const rows = []
  const normalMemo = new Map()
  const fieldNormal = (x, z) => {
    const key = ((Math.round(x) & 0xffff) << 16) ^ (Math.round(z) & 0xffff)
    let n = normalMemo.get(key)
    if (n) return n
    const cx = Math.round(x), cz = Math.round(z)
    const dx = ground.field.y(cx + 0.5, cz) - ground.field.y(cx - 0.5, cz)
    const dz = ground.field.y(cx, cz + 0.5) - ground.field.y(cx, cz - 0.5)
    const l = Math.hypot(dx, 1, dz)
    n = [-dx / l, 1 / l, -dz / l]
    normalMemo.set(key, n)
    return n
  }
  for (const face of faces) {
    const T = face.T
    const nrm = face.geo.attributes.normal
    let deg = 0, steep = 0, worst = 0, slivers = 0
    const live = new Set()
    const judged = face.frame === 'field'
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) { deg++; continue }
      const o = t * 9
      const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      const len = Math.hypot(nx, ny, nz) || 1
      live.add(face.vidx[t * 3]); live.add(face.vidx[t * 3 + 1]); live.add(face.vidx[t * 3 + 2])
      if (Math.abs(ny) / 2 < 0.01) { slivers++; continue }
      if (!judged) continue
      const d = sOf((ax + bx + cx) / 3, (az + bz + cz) / 3)
      if (d && inCross(d.s)) continue
      if (onCliffAt(T, o)) continue
      const fn = fieldNormal((ax + bx + cx) / 3, (az + bz + cz) / 3)
      const dot = Math.abs((nx * fn[0] + ny * fn[1] + nz * fn[2]) / len)
      const tilt = (Math.acos(Math.min(1, dot)) * 180) / Math.PI
      if (tilt > worst) worst = tilt
      if (tilt > 10) steep++
    }
    let zero = 0
    if (nrm) for (const i of live) if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 1e-6) zero++
    console.log(`    ${padE(face.name, 22)} ${pad(face.tris, 7)}   ${pad(deg, 9)}   ${pad(zero, 11)}   ${pad(steep, 12)}   ${pad(fmt(worst, 1), 6)}°   ${pad(slivers, 8)}`)
    rows.push({ name: face.name, tris: face.tris, zeroArea: deg, zeroNormal: zero, steep, worst: Number(fmt(worst, 1)), slivers, judged })
  }
  out.guards.G4 = rows
  for (const r of rows) {
    check('G4', `${r.name}.zeroNormal`, r.zeroNormal)
    check('G4', `${r.name}.zeroArea`, r.zeroArea)
    if (r.judged) check('G4', `${r.name}.steep`, r.steep, 0, `(worst ${r.worst}°)`)
  }
  guardEnd('G4')
}

// ================================================================ G5 — field continuity
if (runs('G5')) {
  guardStart('G5', 'field continuity — Terrain.heightAt jumps (> 8 mm and > 3× the neighbouring steps), crossover excluded')
  const jumps = []
  let series = 0, points = 0
  const scan = (pts, label) => {
    series++
    points += pts.length
    const steps = []
    for (let i = 0; i < pts.length - 1; i++) steps.push(Math.abs(pts[i + 1].h - pts[i].h))
    for (let i = 1; i < pts.length - 2; i++) {
      const d = pts[i + 1].h - pts[i].h
      const a = Math.abs(d)
      if (a <= 0.008) continue
      const nb = Math.max(steps[i - 1], steps[i + 1])
      if (a <= 3 * nb) continue
      const win = steps.slice(Math.max(0, i - 8), Math.min(steps.length, i + 9)).sort((p, q) => p - q)
      const med = win[Math.floor(win.length / 2)]
      if (a <= Math.max(3 * med, 0.008) || (a < 0.05 && a < 4 * med)) continue
      jumps.push({ s: pts[i].s, side: pts[i].side, off: pts[i].off, mm: d * 1000, dir: label })
    }
  }
  for (const side of [1, -1]) {
    for (const offSpec of [3, 12, 'W-1']) {
      let cur = []
      for (let s = 0; s < L; s += 0.125) {
        const W = Math.min(34, plan.extentDrawn(s, side))
        const off = offSpec === 'W-1' ? W - 1 : offSpec
        if (off > W || off < 0.5 || inCross(s)) { if (cur.length) scan(cur, `s@${offSpec}`); cur = []; continue }
        track.pointAt(s, side * (track.halfWidthAt(s) + off), _v, 0)
        cur.push({ s, side, off, h: terrain.heightAt(_v.x, _v.z) })
      }
      if (cur.length) scan(cur, `s@${offSpec}`)
    }
  }
  const alongN = points
  for (let s = 0; s < L; s += 4) {
    if (inCross(s)) continue
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const W = Math.min(34, plan.extentDrawn(s, side))
      const cur = []
      for (let off = 0.05; off <= W; off += 0.25) {
        track.pointAt(s, side * (hw + off), _v, 0)
        cur.push({ s, side, off, h: terrain.heightAt(_v.x, _v.z) })
      }
      if (cur.length) scan(cur, 'lat')
    }
  }
  jumps.sort((a, b) => Math.abs(b.mm) - Math.abs(a.mm))
  const cliffs = jumps.filter((j) => Math.abs(j.mm) > 500).length
  console.log(`    ${points} field samples in ${series} series (${alongN} along s, ${points - alongN} across); ${jumps.length} jumps, ${cliffs} of them over 0.5 m`)
  console.log('    worst:   s       side  off     mm   series   section')
  for (const j of jumps.slice(0, 10)) console.log(`      ${pad(fmt(j.s, 1), 7)}   ${sideCh(j.side)}   ${pad(fmt(j.off, 1), 5)} ${pad(fmt(j.mm, 0), 6)}   ${padE(j.dir, 7)}  ${sectionOf(j.s)}`)
  out.guards.G5 = { points, jumps: jumps.length, cliffs, worst: jumps.slice(0, 10) }
  check('G5', 'jumps', jumps.length)
  guardEnd('G5')
}

// ================================================================ G6 / G7 — the terrain through a face, and max edge (per tier)
if (runs('G6') || runs('G7')) {
  guardStart('G6', `terrain through a registered face (G6) and longest XZ edge (G7) — tier ${TIER}`)
  const maxEdgeLimit = (TIER === 'low' ? 18.056 : 13.542) / 2
  const N = 4
  const rows = []
  for (const face of faces) {
    const T = face.T
    let samples = 0, under = 0, worst = 0, maxEdge = 0, over = 0
    const longEdges = []
    for (let t = 0; t < face.tris; t++) {
      const o = t * 9
      const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
      if (!face.live[t]) continue
      const longest = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz))
      if (longest > maxEdge) maxEdge = longest
      if (longest > maxEdgeLimit) {
        over++
        const d = sOf((ax + bx + cx) / 3, (az + bz + cz) / 3)
        const bin = d ? Math.floor(d.s / 20) : -1
        const same = longEdges.find((e) => e.bin === bin)
        const ends = () => {
          const P = [[ax, az], [bx, bz], [cx, cz]]
          const E = [[0, 1], [1, 2], [2, 0]].map(([p, q]) => ({ p, q, l: Math.hypot(P[p][0] - P[q][0], P[p][1] - P[q][1]) })).sort((u, v) => v.l - u.l)[0]
          return [P[E.p], P[E.q]].map(([x, z]) => { const c = d ? contOf(x, z, d) : null; return c ? `s${c.s.toFixed(1)}/${(Math.abs(c.lateral) - track.halfWidthAt(c.s)).toFixed(1)}` : '?' }).join('→')
        }
        if (same) { same.n++; if (longest > same.len) { same.len = longest; same.ends = ends() } }
        else longEdges.push({ bin, n: 1, len: longest, s: d?.s ?? -1, lat: d?.lateral ?? 0, src: face.mesh?.userData?.triSource?.[t] ?? '-', ends: ends() })
      }
      for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
        const u = i / N, v = j / N, w = 1 - u - v
        const clearance = ay * w + by * u + cy * v - terrain.meshHeightAt(ax * w + bx * u + cx * v, az * w + bz * u + cz * v)
        samples++
        if (clearance < 0) { under++; if (-clearance > worst) worst = -clearance }
      }
    }
    longEdges.sort((a, b) => b.n - a.n)
    rows.push({ name: face.name, tris: face.tris, pct: samples ? (100 * under) / samples : 0, worst, maxEdge, over, longEdges: longEdges.slice(0, 4) })
  }
  rows.sort((a, b) => b.pct - a.pct || b.maxEdge - a.maxEdge)
  console.log('    face                    tris   terrain above   worst      longest XZ edge   edges over   where (n, longest, s/lat, source 0 raster 1 world 2 stitch)')
  for (const r of rows) console.log(`    ${padE(r.name, 22)} ${pad(r.tris, 7)}   ${pad(fmt(r.pct, 2), 8)} %   ${pad(fmt(r.worst, 3), 6)} m   ${pad(fmt(r.maxEdge, 1), 6)} m${r.maxEdge > maxEdgeLimit ? ' <<' : '   '}   ${pad(r.over, 8)}   ${r.longEdges.map((e) => `${e.n}×${e.len.toFixed(1)}m s${Math.round(e.s)}/${Math.round(e.lat)}·${secShort(e.s)}·src${e.src} [${e.ends}]`).join('  ')}`)
  console.log(`    ${terrain.groundSheets.length} faces registered, ${terrain.clamped.size} clamped; settle() took ${fmt(terrain.settleMs)} ms; edge limit ${fmt(maxEdgeLimit, 2)} m`)
  const capped = {}
  for (const c of terrain.clampCapped) {
    const d = terrain.distanceToTrack(c.x, c.z, 400)
    const cur = capped[c.name]
    if (!cur || c.needed > cur.needed) capped[c.name] = { needed: c.needed, s: d.s, lat: d.lateral, n: (cur?.n ?? 0) + 1 }
    else cur.n++
  }
  for (const [name, c] of Object.entries(capped).sort((a, b) => b[1].needed - a[1].needed)) console.log(`      maxDrop refused a ${fmt(c.needed, 2)} m cut under ${name} at s≈${fmt(c.s, 0)} lat ${fmt(c.lat, 0)} (${c.n} nodes) — G6 says whether it shows`)
  out.guards.G6 = rows.map((r) => ({ name: r.name, pct: Number(fmt(r.pct, 2)), worst: Number(fmt(r.worst, 3)), maxEdge: Number(fmt(r.maxEdge, 1)), over: r.over }))
  if (runs('G6')) {
    for (const r of rows) check('G6', r.name, Number(fmt(r.pct, 2)), 0, `(worst ${fmt(r.worst, 3)} m)`, 'pct')
    check('G6', 'unclamped', terrain.groundSheets.length - terrain.clamped.size)
  }
  if (runs('G7')) for (const r of rows) check('G7', r.name, r.over, 0, `(longest ${fmt(r.maxEdge, 1)} m, half the ${fmt(maxEdgeLimit * 2, 1)} m grid)`)
  guardEnd('G6')
  if (runs('G7')) out.ms.G7 = 0 // shares G6's pass; recorded so its allowances are audited as "ran"
}

// ================================================================ G8 — registration, from the geometry; R13 imports
if (runs('G8')) {
  guardStart('G8', 'registration — horizontal geometry at ground level that is not a registered face, a marked object or a marked decal')
  // furniture by name prefix: structures whose floors are at ground level by design (the stands'
  // terraces, the garage floors inside the pit building, the props' plinths, the concrete slabs)
  const FURNITURE = ['stand', 'terrace', 'furniture', 'props', 'concrete', 'pitRails', 'pitInterior', 'terrain']
  const allowListed = (o) => { for (let p = o; p; p = p.parent) if (p.name && FURNITURE.some((pre) => p.name.startsWith(pre))) return true; return false }
  const rows = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes?.position) return
    if (o.geometry.userData.groundReg || o.userData.decal || o.userData.groundObject) return
    if (o.material?.transparent && o.material?.depthWrite === false) return
    if (allowListed(o)) return
    const pos = o.geometry.attributes.position
    const n = triCountOf(o.geometry)
    let flat = 0, near = 0
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(pos, vertexOf(o.geometry, t, 0)).applyMatrix4(o.matrixWorld)
      b.fromBufferAttribute(pos, vertexOf(o.geometry, t, 1)).applyMatrix4(o.matrixWorld)
      c.fromBufferAttribute(pos, vertexOf(o.geometry, t, 2)).applyMatrix4(o.matrixWorld)
      const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
      const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)
      const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const len = Math.hypot(nx, ny, nz)
      if (len < 1e-9 || ny / len < 0.9) continue
      const area = len / 2
      flat += area
      const x = (a.x + b.x + c.x) / 3, z = (a.z + b.z + c.z) / 3, y = (a.y + b.y + c.y) / 3
      if (terrain.distanceToTrack(x, z, 75).i < 0) continue
      const top = topAt(x, z)
      const g = Math.max(top ? top.y : -Infinity, terrain.meshHeightAt(x, z))
      if (Math.abs(y - g) <= 0.3) near += area
    }
    if (near > 0.5) rows.push({ name: o.name || `(unnamed ${n} tris in ${o.parent?.name || 'root'})`, tris: n, flat, near })
  })
  rows.sort((a, b) => b.near - a.near)
  console.log('    mesh                                    tris   horizontal m²   at ground m²')
  for (const r of rows) console.log(`    ${padE(r.name, 38)} ${pad(r.tris, 7)}   ${pad(Math.round(r.flat), 13)}   ${pad(fmt(r.near, 1), 12)}${r.near >= 5 ? ' <<' : ''}`)
  out.guards.G8 = rows.map((r) => ({ name: r.name, near: Number(fmt(r.near, 1)) }))
  for (const r of rows) if (r.near >= 5) check('G8', r.name, Number(fmt(r.near, 1)), 0, '', 'm2')
  // the kinds of the plan and the faces that exist for them
  const kinds = PRECEDENCE.filter((k) => k !== 'terrain')
  const missing = kinds.filter((k) => !faces.some((f) => f.kind === k))
  console.log(`    kinds with a face: ${kinds.filter((k) => !missing.includes(k)).join(', ')}${missing.length ? `; no triangles for: ${missing.join(', ')}` : ''}`)
  // R13: this file's own imports against ALLOWED_IMPORTS (the patterns are built from strings so they do not match themselves)
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const imported = new Set()
  for (const m of self.matchAll(new RegExp(String.raw`import\(path\.join\(ROOT, '([^']+)'\)\)`, 'g'))) imported.add(m[1])
  for (const m of self.matchAll(new RegExp(String.raw`^import .* from '([^']+)'`, 'gm'))) if (!m[1].startsWith('node:')) imported.add(m[1])
  for (const m of self.matchAll(new RegExp(String.raw`readFileSync\(path\.join\(ROOT, '([^']+)'\)`, 'g'))) if (m[1].endsWith('.json')) imported.add(m[1])
  const foreign = [...imported].filter((i) => !ALLOWED_IMPORTS.includes(i))
  console.log(`    R13 imports: ${imported.size} modules, foreign [${foreign.join(', ')}]`)
  check('G8', 'imports.foreign', foreign.length, 0, `[${foreign.join(', ')}] — R13: the guard reads data, ground.ts, ground-plan.ts, trackside.ts and the built scene only`)
  // R3: outside the ground modules nothing samples the terrain (analytic or mesh) or the old
  // (s, lateral) ground views — everything stands on Ground.standY / lies on Ground.decalY
  const GROUND_MODULES = new Set(['ground.ts', 'ground-plan.ts', 'ground-field.ts', 'ground-mesh.ts', 'environment.ts'])
  const sources = [
    ...readdirSync(path.join(ROOT, 'app/three')).filter((n) => n.endsWith('.ts') && !GROUND_MODULES.has(n)).map((n) => `app/three/${n}`),
    ...readdirSync(path.join(ROOT, 'app/components')).filter((n) => n.endsWith('.vue')).map((n) => `app/components/${n}`),
  ]
  // ...nor the terrain's sample-based projection (distanceToTrack): the plan's project() is the
  // one (s, lateral) view, continuous and crossover-aware
  const offenders = []
  for (const rel of sources) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8')
    for (const m of src.matchAll(/\b(?:terrain|\.terrain)\.(?:meshHeightAt|heightAt|distanceToTrack)\(|ground\.(?:yAt|worldY)\(/g)) offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length} ${m[0]}`)
  }
  console.log(`    R3 sources: ${sources.length} files outside the ground modules, ${offenders.length} terrain sample(s) / projections [${offenders.join(', ')}]`)
  check('G8', 'source.terrainSamples', offenders.length, 0, `[${offenders.join(', ')}] — R3: place on ground.standY / standAt, lie on ground.decalY, project with ground.plan.project`)
  guardEnd('G8')
}

// ================================================================ G9 — seams: shared vertices bit-identical
if (runs('G9')) {
  guardStart('G9', 'seams — a vertex at the same XZ in two ground faces has the same y and the same normal, bit for bit')
  const byXZ = new Map()
  for (const f of groundFaceSet) {
    const face = faces[f]
    const pos = face.geo.attributes.position, nrm = face.geo.attributes.normal
    // only vertices of live triangles
    const live = new Set()
    for (let t = 0; t < face.tris; t++) if (face.live[t]) { live.add(face.vidx[t * 3]); live.add(face.vidx[t * 3 + 1]); live.add(face.vidx[t * 3 + 2]) }
    for (const v of live) {
      const key = `${Math.round(pos.getX(v) * 1e4)}|${Math.round(pos.getZ(v) * 1e4)}`
      let arr = byXZ.get(key)
      if (!arr) { arr = []; byXZ.set(key, arr) }
      arr.push({ f, v, y: pos.getY(v), nx: nrm.getX(v), ny: nrm.getY(v), nz: nrm.getZ(v) })
    }
  }
  let shared = 0, crackY = 0, crackN = 0, worst = 0
  const samples = []
  for (const [key, arr] of byXZ) {
    if (arr.length < 2) continue
    shared++
    const a = arr[0]
    let badY = false, badN = false
    for (let i = 1; i < arr.length; i++) {
      const b = arr[i]
      if (b.y !== a.y) { badY = true; worst = Math.max(worst, Math.abs(b.y - a.y)) }
      if (b.nx !== a.nx || b.ny !== a.ny || b.nz !== a.nz) badN = true
    }
    if (badY) { crackY++; if (samples.length < 6) samples.push(`${faces[a.f].name}/${faces[arr[1].f].name} at ${key.replace('|', ', ').replace(/(\d+)/g, (m) => (Number(m) / 1e4).toFixed(1))}: Δy ${((arr[1].y - a.y) * 1000).toFixed(1)} mm`) }
    if (badN && !badY) crackN++
  }
  console.log(`    ${shared} XZ positions shared by two or more faces: ${crackY} with a different y (worst ${(worst * 1000).toFixed(1)} mm), ${crackN} with a different normal only`)
  for (const s of samples) console.log(`      ${s}`)
  out.guards.G9 = { shared, crackY, crackN, worstMm: Math.round(worst * 1000) }
  check('G9', 'crackY', crackY, 0, `(worst ${(worst * 1000).toFixed(1)} mm)`)
  check('G9', 'crackNormal', crackN)
  guardEnd('G9')
}

// ================================================================ G10 — residue (the plan's)
if (runs('G10')) {
  guardStart('G10', 'residue — declared RUNOFF_ZONES band beyond the raster extent that no ring covers (m² per zone|side, by cap)')
  console.log('    zone|side                       cap        m²   s-range')
  for (const e of plan.residue) console.log(`    ${padE(`${e.zone}|${sideCh(e.side)}`, 30)} ${padE(e.cap, 9)} ${pad(e.m2, 5)}   ${Math.round(e.from)}-${Math.round(e.to)}`)
  const fold = plan.residue.filter((e) => e.cap === 'FOLD')
  const other = plan.residue.filter((e) => e.cap !== 'FOLD').reduce((a, e) => a + e.m2, 0)
  console.log(`    FOLD residue is bare ground inside a corner (OSM_SAND rows in P6); BISECTOR / BRIDGE residue (${other} m²) is drawn by the facing road's raster or the lower road`)
  out.guards.G10 = Object.fromEntries(plan.residue.map((e) => [`${e.zone}|${sideCh(e.side)}|${e.cap}`, e.m2]))
  for (const e of fold) check('G10', `${e.zone}|${sideCh(e.side)}`, e.m2, 0, '(FOLD)', 'm2')
  guardEnd('G10')
}

// ================================================================ G11 — drops
if (runs('G11')) {
  guardStart('G11', 'drops — a ground-face edge under 4.5 m in XZ dropping > 0.5 m where the field does not')
  const rows = []
  for (const f of groundFaceSet) {
    const face = faces[f]
    const T = face.T
    let drops = 0, relief = 0
    const worst = []
    const seen = new Set()
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = face.vidx[t * 3 + k], b = face.vidx[t * 3 + ((k + 1) % 3)]
        const key = a < b ? a * 4194304 + b : b * 4194304 + a
        if (seen.has(key)) continue
        seen.add(key)
        const o = t * 9
        const ka = k * 3, kb = ((k + 1) % 3) * 3
        const dy = Math.abs(T[o + ka + 1] - T[o + kb + 1])
        if (dy <= 0.5) continue
        if (Math.hypot(T[o + ka] - T[o + kb], T[o + ka + 2] - T[o + kb + 2]) > 4.5) continue
        const d = sOf(T[o + ka], T[o + ka + 2])
        if (d && inCross(d.s)) continue
        // the field read along the edge, not only at its ends: a relief edge that passes THROUGH a
        // vertex (the paddock platform's far edge on the bisector) reads the same side at both
        // float32-rounded ends and the mesh's drop looked unexplained
        const ax = T[o + ka], az = T[o + ka + 2], bx = T[o + kb], bz = T[o + kb + 2]
        const fa = ground.field.y(ax, az), fb = ground.field.y(bx, bz)
        let fieldDrop = Math.abs(fa - fb), prev = fa
        for (const tt of [0.02, 0.5, 0.98, 1]) { const fy = ground.field.y(ax + (bx - ax) * tt, az + (bz - az) * tt); fieldDrop = Math.max(fieldDrop, Math.abs(fy - prev)); prev = fy }
        if (fieldDrop > 0.4) { relief++; continue }
        drops++
        worst.push({ s: d?.s ?? -1, lat: d?.lateral ?? 0, mm: dy * 1000 })
      }
    }
    worst.sort((a, b) => b.mm - a.mm)
    rows.push({ name: face.name, drops, relief, worst: worst.slice(0, 5) })
    if (drops || relief) console.log(`    ${padE(face.name, 22)} drops ${pad(drops, 5)}  (field drops ${pad(relief, 4)})  ${worst.slice(0, 5).map((w) => `s${Math.round(w.s)} lat${Math.round(w.lat)} ${Math.round(w.mm)}mm·${secShort(w.s)}`).join('  ')}`)
  }
  out.guards.G11 = rows
  for (const r of rows) check('G11', r.name, r.drops)
  guardEnd('G11')
}

// ================================================================ G12 — plan integrity
if (runs('G12')) {
  guardStart('G12', 'plan integrity — residual column inversions, build errors, untraced ring parts, the covered-ground boundary')
  const st = plan.stats, ms = groundMeshes.stats
  console.log(`    stations ${plan.stations.length} (base ${st.base}, endpoints ${st.endpoints}, kinks ${st.kinks}, rows ${st.rows}, tips ${st.tips}, chord ${st.chord}, crossings ${st.crossings}, snapped ${st.snapped}; passes ${st.passes.join('/')})`)
  console.log(`    residual inversions ${st.residual} (worst ${(st.residualMax * 1000).toFixed(0)} mm, snapped); rings ${st.rings} (${st.worldOnly} world-only)`)
  console.log(`    mesh: ${ms.cells} cells, ${ms.triangles} triangles (world ${ms.worldTris}, stitch ${ms.stitchTris}), ${ms.dropped} degenerate dropped; errors ${ms.errors.length}; untraced ring parts ${ms.uncoveredArcs}`)
  console.log(`    boundary loops ${ms.boundary.loops.length} (${ms.boundary.loops.join(', ')} vertices), ${ms.boundary.skipped} skipped; strips ${ms.strips.length}`)
  for (const s of ms.strips) console.log(`      stitch side ${s.sideA} s ${Math.round(s.aFrom)}-${Math.round(s.aTo)} ↔ side ${s.sideB} s ${Math.round(s.bFrom)}-${Math.round(s.bTo)}`)
  for (const e of ms.errors) console.log(`      error: ${e}`)
  out.guards.G12 = { stations: plan.stations.length, residual: st.residual, residualMaxMm: Math.round(st.residualMax * 1000), errors: ms.errors, untraced: ms.uncoveredArcs, loops: ms.boundary.loops, skipped: ms.boundary.skipped }
  check('G12', 'residual', st.residual)
  check('G12', 'buildErrors', ms.errors.length)
  check('G12', 'untracedArcs', ms.uncoveredArcs)
  check('G12', 'boundarySkipped', ms.boundary.skipped)
  guardEnd('G12')
}

// ================================================================ allowance hygiene and the report
{
  const seenKeys = new Set()
  for (const a of ALLOWANCES) {
    const k = `${a.guard}|${a.key}`
    if (seenKeys.has(k)) fail(`ALLOWANCES: duplicate entry ${k}`)
    seenKeys.add(k)
    if (!PHASES.includes(a.until)) fail(`ALLOWANCES: ${k} has an unknown phase "${a.until}"`)
    else if (phaseIdx(a.until) <= phaseIdx(PHASE)) fail(`ALLOWANCES: ${k} expired (until ${a.until}, phase ${PHASE}) — remove the cause or the entry`)
    if (typeof a.bound !== 'number' || !a.why) fail(`ALLOWANCES: ${k} needs a numeric bound and a why`)
  }
  const ranGuards = new Set(Object.keys(out.ms))
  const unused = ALLOWANCES.filter((a) => ranGuards.has(a.guard) && !usedAllowance.has(a))
  if (unused.length) console.log(`\n${unused.length} allowance(s) not needed on this tier (may be removable once both tiers agree): ${unused.map((a) => `${a.guard} ${a.key}`).join(', ')}`)
  const perGuard = {}
  for (const a of ALLOWANCES) perGuard[a.guard] = (perGuard[a.guard] ?? 0) + 1
  console.log(`\nallowances: ${ALLOWANCES.length} (${Object.entries(perGuard).map(([g, n]) => `${g} ${n}`).join(', ')}), ${usedAllowance.size} used`)
  console.log(`guard ms: ${Object.entries(out.ms).map(([g, ms]) => `${g} ${ms}`).join('  ')}  (build ${built}, total ${Date.now() - tBuild})`)
  if (SUGGEST && suggestions.length) {
    console.log('\n--suggest: entries that would cover the failing keys (add a why and an until):')
    for (const s of suggestions) console.log(`  { guard: '${s.guard}', key: ${JSON.stringify(s.key)}, bound: ${s.bound}, why: WHY.?, until: '?' }, // measured ${s.measured}`)
  }
  out.suggestions = suggestions
  out.allowances = { total: ALLOWANCES.length, perGuard, used: usedAllowance.size, unused: unused.map((a) => `${a.guard} ${a.key}`) }
  if (JSON_OUT) { writeFileSync(JSON_OUT, `${JSON.stringify(out, null, 2)}\n`); console.log(`measured numbers written to ${JSON_OUT}`) }
  if (notes.length) console.log(`\n${notes.length} note(s):\n  - ${notes.join('\n  - ')}`)
  if (errors.length) {
    console.log(`\n${errors.length} error(s):\n  - ${errors.join('\n  - ')}`)
    if (STRICT) process.exit(1)
  }
  console.log(`\nsurface-check: ${errors.length ? 'FAILED' : 'OK'}${STRICT ? ' (strict)' : ''}`)
}
