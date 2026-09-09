#!/usr/bin/env node
/**
 * Offline guard set for the ground (v3 — the plan's §4, phase P3a: the ground is a partition).
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
 *   G1  census        visible face kind from above vs plan.ownerAt
 *   G2  overlap       any two faces — the same one included — covering one XZ point
 *   G3  deviation     face centroid vs its declared frame (road plane / height field)
 *   G4  quality       zero-area triangles, zero normals on drawn vertices, off-field tilt
 *   G5  continuity    Terrain.heightAt jumps along s and across the verge
 *   G6  terrain       the drawn grid coming up through a registered face (per tier)
 *   G7  max edge      a face too coarse to resolve the grid it is draped on (per tier)
 *   G8  registration  horizontal geometry at ground level that is not a registered face; R13 imports
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
 *   app/three/ground.ts            LAYER, LAYER_MIN_STEP, LAYER_SOFT
 *   app/three/ground-plan.ts       RULE_OF, PRECEDENCE, kerbAt, kerbProfileHeight, FLAT_STRIP, STRIP_DROP
 *   app/three/trackside.ts         (nothing today; kept for ring diagnostics)
 *   app/sim/track.ts               forwardDelta, signedDelta
 *   scripts/audit/app-runtime.mjs  buildScene, ROOT, THREE — the built scene: ground.plan, ground.field, groundMeshes
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'

const ALLOWED_IMPORTS = [
  'app/data/suzuka.ts',
  'app/data/suzuka-facilities-spec.ts',
  'app/data/suzuka-barriers-spec.ts',
  'app/three/ground.ts',
  'app/three/ground-plan.ts',
  'app/three/trackside.ts',
  'app/sim/track.ts',
  './app-runtime.mjs',
  'scripts/audit/sections.json',
]

// ================================================================ phases and allowances
const PHASE = 'P3a'
const PHASES = ['P0', 'P1', 'P2', 'P3a', 'P3b', 'P4', 'P5', 'P6']
const phaseIdx = (p) => PHASES.indexOf(p)

/**
 * Every non-zero the run tolerates, typed: { guard, key, bound, why, until }. `until` is the
 * phase that removes the cause; once PHASE reaches it the entry fails the run. Bounds cover both
 * tiers (they build on different terrain grids).
 */
const WHY = {
  objects: 'the offset-lane kerbs still stand on the ground as swept ribbons over the lane face (a bounded footprint); they become placed objects with the G3-object rule in P4',
  reliefEdge: 'facilityRelief (stands.ts) has hard edges: the chord-zone vRange cut, the basin polygon edge, its own 2 m sample sawtooth; ramps are stands.ts work outside the ground modules (plan §6.6)',
  residue: 'declared band cut by the swept frame (FOLD) that no ring fills; OSM_SAND rows fill it in P6',
  unregistered: 'horizontal geometry at ground level outside the face registry (the pit interior floor); typed as furniture in P4',
  untraced: 'ground the plan gives an owner that no face draws, or a stitch triangle whose centroid decides for its whole 4 m: a ring part beyond the covered ground the tracing could not close (the pit-in slip lane straddling three rasters), a strip triangle straddling a lane edge, a pocket at a triple junction; P3b hardens the stitch and the tracing (a strip split by the rings it runs through)',
  overlapSeam: 'double cover at the seams of the stitch strips and the world parts: a lane crossing an apron, the helipad in the paddock, a strip triangle over a raster corner, two parts of one owner meeting at a crossing point — the tracing does not yet cut one owner\'s part by another\'s ring; P3b',
  roadTwist: 'a road-frame cell 2-4 m wide and up to 2 m long chords the cambered road plane where the roll changes (24 mm at T1) and the kerb taper (36 mm at the chicane); P5 adds lateral interpolation points',
  fieldChord: 'a field-frame triangle ≤ 4 m across chords the field: the basin banks (9 m for 3 m), the GP Square platform ramp (7 m over 8 m), the stand relief cuts, the fold-cap ramps; P3b refines towards relief edges and P6 gives the relief ramps',
  residual: 'ring tracks whose interval splits between two stations (the chicane apron\'s self-crossing loop, a lane mouth) leave a column inversion in a sub-metre row; snapped to a zero-width cell, counted here; P3b',
}
const ALLOWANCES = [
  { guard: 'G1', key: "asphaltArea>turf", bound: 2, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "grass>asphaltBand", bound: 2, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "helipad>terrain", bound: 5, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "lane>asphaltArea", bound: 5, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "lane>grass", bound: 33, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "lane>gravelBand", bound: 3, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "paddock>terrain", bound: 16, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "terrain>asphaltArea", bound: 3, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "turf>asphaltArea", bound: 19, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "turf>terrain", bound: 5, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "water>grass", bound: 3, why: WHY.untraced, until: 'P3b' },
  { guard: 'G1', key: "water>terrain", bound: 12, why: WHY.untraced, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltArea|ground:asphaltArea", bound: 39, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltArea|ground:grass", bound: 5, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltArea|ground:lane", bound: 19, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:asphaltArea", bound: 2, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:asphaltBand", bound: 13, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:grass", bound: 4, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:kerb", bound: 2, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:lane", bound: 6, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:asphaltBand|ground:pitLane", bound: 3, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:asphaltArea", bound: 2, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:asphaltBand", bound: 6, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:grass", bound: 195, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:gravelBand", bound: 19, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:lane", bound: 13, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:paddock", bound: 11, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:grass|ground:water", bound: 12, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:gravelBand|ground:grass", bound: 5, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:gravelBand|ground:gravelBand", bound: 47, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:helipad|ground:paddock", bound: 35, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:kerb|ground:grass", bound: 6, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:kerb|ground:kerb", bound: 48, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:lane|ground:asphaltArea", bound: 36, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:lane|ground:asphaltBand", bound: 3, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:lane|ground:grass", bound: 8, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:lane|ground:lane", bound: 98, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:paddock|ground:grass", bound: 6, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:paddock|ground:gravelBand", bound: 2, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:paddock|ground:helipad", bound: 27, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:paddock|ground:paddock", bound: 19, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:pitLane|ground:asphaltBand", bound: 9, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:pitLane|ground:pitLane", bound: 8, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:turf|ground:asphaltArea", bound: 3, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:turf|ground:turf", bound: 7, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:water|ground:grass", bound: 14, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "ground:water|ground:water", bound: 7, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G2', key: "laneKerbs|ground:asphaltArea", bound: 258, why: WHY.objects, until: 'P4' },
  { guard: 'G2', key: "laneKerbs|ground:grass", bound: 955, why: WHY.objects, until: 'P4' },
  { guard: 'G2', key: "laneKerbs|ground:lane", bound: 49, why: WHY.objects, until: 'P4' },
  { guard: 'G2', key: "laneKerbs|ground:turf", bound: 359, why: WHY.objects, until: 'P4' },
  { guard: 'G2', key: "laneKerbs|laneKerbs", bound: 41, why: WHY.objects, until: 'P4' },
  { guard: 'G3', key: "ground:asphaltArea", bound: 1.29, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:asphaltBand", bound: 0.66, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:grass", bound: 7.12, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:gravelBand", bound: 1.26, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:helipad", bound: 12.41, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:kerb", bound: 1.24, why: WHY.roadTwist, until: 'P5' },
  { guard: 'G3', key: "ground:lane", bound: 0.6, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:paddock", bound: 6.06, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G3', key: "ground:pitLane", bound: 1.91, why: WHY.roadTwist, until: 'P5' },
  { guard: 'G3', key: "ground:road", bound: 0.56, why: WHY.roadTwist, until: 'P5' },
  { guard: 'G3', key: "ground:water", bound: 18.04, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:asphaltArea.steep", bound: 98, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:asphaltBand.steep", bound: 365, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:grass.steep", bound: 2430, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:gravelBand.steep", bound: 37, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:helipad.steep", bound: 36, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:lane.steep", bound: 172, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:paddock.steep", bound: 1365, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:turf.steep", bound: 4, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G4', key: "ground:water.steep", bound: 745, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G5', key: "jumps", bound: 591, why: WHY.reliefEdge, until: 'P6' },
  { guard: 'G7', key: "ground:asphaltArea", bound: 12, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G7', key: "ground:grass", bound: 118, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G7', key: "ground:lane", bound: 12, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G8', key: "pitInterior", bound: 5664, why: WHY.unregistered, until: 'P4' },
  { guard: 'G9', key: "crackNormal", bound: 2, why: WHY.overlapSeam, until: 'P3b' },
  { guard: 'G10', key: "chicane approach|R", bound: 3, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "chicane T16–T17|R", bound: 208, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 1 → 2|R", bound: 13, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 1|R", bound: 210, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 2|R", bound: 230, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Dunlop exit → Degner|R", bound: 92, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "hairpin|L", bound: 191, why: WHY.residue, until: 'P6' },
  { guard: 'G11', key: "ground:grass", bound: 54, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G11', key: "ground:water", bound: 72, why: WHY.fieldChord, until: 'P3b' },
  { guard: 'G12', key: "residual", bound: 14, why: WHY.residual, until: 'P3b' },
  { guard: 'G12', key: "untracedArcs", bound: 2, why: WHY.untraced, until: 'P3b' },
]

// ================================================================ CLI
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const STRICT = args.includes('--strict')
const SUGGEST = args.includes('--suggest')
const TIER = flag('--tier', 'high')
const JSON_OUT = flag('--json', null)
const ONLY = flag('--only', null)?.split(',').map((s) => s.trim())
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
const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
const { forwardDelta, signedDelta } = await import(path.join(ROOT, 'app/sim/track.ts'))
const sections = JSON.parse(readFileSync(path.join(ROOT, 'scripts/audit/sections.json'), 'utf8'))
const { LAYER, LAYER_MIN_STEP, LAYER_SOFT } = groundMod
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
 * A FACE is a registered ground surface: the `ground:<kind>` meshes of ground-mesh.ts (the
 * partition) and, until P4, the offset-lane kerbs (an OBJECT standing on the lane face). Decals
 * are never faces.
 */
const DECAL_NAMES = new Set(['paintedAprons', 'whiteLines', 'drsLines', 'brakingRubber', 'parkingLines'])
const meshByGeo = new Map()
root.traverse((o) => { if (o.isMesh && o.geometry) meshByGeo.set(o.geometry.uuid, o) })
const faces = []
{
  const seen = new Set()
  for (const reg of terrain.groundSheets) {
    if (reg.geo.userData.groundReg?.decal) continue
    const mesh = meshByGeo.get(reg.geo.uuid)
    const name = mesh?.name || reg.name
    if (seen.has(name)) { fail(`faces: two registered geometries resolve to the name "${name}"`); continue }
    seen.add(name)
    const kind = name.startsWith('ground:') ? name.slice(7) : null
    const frame = kind ? (RULE_OF[kind]?.frame ?? null) : 'object'
    if (kind && !frame) fail(`faces: "${name}" is not a kind of the plan`)
    faces.push({ name, kind, frame, geo: reg.geo, reg, mesh, registered: true })
  }
}
const faceIdx = Object.fromEntries(faces.map((f, i) => [f.name, i]))
const groundFaceSet = new Set(faces.map((f, i) => (f.kind ? i : -1)).filter((i) => i >= 0))

const triCountOf = (geo) => { const idx = geo.getIndex(); return idx ? Math.floor(idx.count / 3) : Math.floor(geo.attributes.position.count / 3) }
const vertexOf = (geo, t, k) => { const idx = geo.getIndex(); return idx ? idx.getX(t * 3 + k) : t * 3 + k }

// live triangles of every face as flat arrays, and one XZ hash over all of them
const CELL = 8
const cells = new Map()
const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768)
const LIVE_AREA = 1e-6
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
 * +1e-6 demands the interior (the overlap count: a shared edge is not double cover).
 */
const hits = []
function hitsAt(x, z, tol, skipF = -1, skipT = -1) {
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
    hits.push({ f, t, y: ay * u + by * v + cy * w })
  }
  return hits
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
  for (let it = 0; it < 3; it++) {
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
  /** expected owner kind at (s, side, off): the plan's, read at the point's own stretch */
  const expectedSL = (s, side, off) => plan.ownerAtSL(s, side, off).kind
  const sampleSL = (s, side, off, x, z, fromRing) => {
    if (inCross(s)) { stats.cross++; return }
    stats.total++
    if (fromRing) stats.ring++; else stats.lattice++
    const exp = expectedSL(s, side, off)
    // seam band: the owner changes within SEAM along s or across, so the boundary itself is not judged
    let seam = false
    for (const ds of [-SEAM, SEAM]) {
      const s2 = track.wrap(s + ds)
      if (expectedSL(s2, side, off) !== exp) { seam = true; break }
    }
    if (!seam) for (const doff of [-SEAM, SEAM]) { if (off + doff >= 0 && expectedSL(s, side, off + doff) !== exp) { seam = true; break } }
    if (seam) { stats.seam++; return }
    const got = gotAt(x, z)
    if (got.name === exp) { stats.match++; return }
    stats.mismatch++
    const mk = `${exp}>${got.name}`
    matrix.set(mk, (matrix.get(mk) ?? 0) + 1)
    records.push({ s, side, off, exp, got: got.name })
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
  out.guards.G1 = { ...stats, matrix: Object.fromEntries(rows), clusters: clusters.slice(0, 25) }
  for (const [k, n] of rows) check('G1', k, n)
  guardEnd('G1')
}

// ================================================================ G2 — overlap: any two faces over one point (the same face included)
if (runs('G2')) {
  guardStart('G2', 'overlap — faces covering the same XZ point, the same face included; upper = the one on top at the sample')
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
        const h = hitsAt(x, z, 1e-6, f, t)
        if (!h.length) continue
        const d = sOf(x, z)
        if (!d) { far++; continue }
        if (inCross(d.s)) { crossSkipped++; continue }
        overlapSamples++
        for (const r of h) {
          const other = faces[r.f].name
          const dy = r.y - y
          const top = dy > 0 ? other : face.name
          const bottom = dy > 0 ? face.name : other
          const key = `${top}|${bottom}`
          let p = pairs.get(key)
          if (!p) { p = { top, bottom, n: 0, area: 0, gap: 0, bins: new Map() }; pairs.set(key, p) }
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
  guardEnd('G2')
}

// ================================================================ G3 — deviation from the declared frame
if (runs('G3')) {
  guardStart('G3', 'deviation — face centroid vs its declared frame (road plane ≤ 2 mm, height field ≤ 40 mm)')
  const rows = []
  console.log('    face                   frame   n        p50 mm  p99 mm   max mm   beyond    skipped  worst (one per 20 m)')
  for (const face of faces) {
    const T = face.T
    if (face.frame === 'object') { console.log(`    ${padE(face.name, 22)} object (judged by the object rule from P4 — skipped)`); continue }
    const frame = face.frame
    const limit = frame === 'road' ? 0.002 : 0.04
    const rule = RULE_OF[face.kind]
    const devs = []
    const worst = []
    let skipped = 0
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      const o = t * 9
      const x = (T[o] + T[o + 3] + T[o + 6]) / 3, z = (T[o + 2] + T[o + 5] + T[o + 8]) / 3, y = (T[o + 1] + T[o + 4] + T[o + 7]) / 3
      const d = sOf(x, z)
      if (!d) { skipped++; continue }
      if (inCross(d.s)) { skipped++; continue }
      let expected
      if (frame === 'road') {
        const c = roadProject(x, z, d)
        track.pointAt(c.s, c.lateral, _v, 0)
        if ('profile' in rule) {
          const side = c.lateral >= 0 ? 1 : -1
          const kb = kerbAt(plan.kerbs, track, c.s, side)
          expected = _v.y + kerbProfileHeight(kb.width, kb.taper, Math.abs(c.lateral) - track.halfWidthAt(c.s))
        } else expected = _v.y + rule.dy
      } else expected = ground.field.y(x, z)
      const dev = Math.abs(y - expected)
      devs.push(dev)
      if (dev > limit) {
        const bin = Math.floor(d.s / 20)
        const same = worst.find((w) => w.bin === bin)
        if (same) { if (dev > same.dev) Object.assign(same, { dev, s: d.s, lat: d.lateral }) }
        else { worst.push({ bin, dev, s: d.s, lat: d.lateral }); worst.sort((a, b) => b.dev - a.dev); if (worst.length > 3) worst.pop() }
      }
    }
    devs.sort((a, b) => a - b)
    const n = devs.length
    const q = (p) => (n ? devs[Math.min(n - 1, Math.floor(p * n))] : 0)
    const beyond = devs.filter((v) => v > limit).length
    const pct = n ? (100 * beyond) / n : 0
    rows.push({ name: face.name, frame, n, p50: q(0.5), p99: q(0.99), max: n ? devs[n - 1] : 0, pct, beyond, skipped, worst })
    console.log(`    ${padE(face.name, 22)} ${padE(frame, 6)} ${pad(n, 8)}  ${pad(fmt(q(0.5) * 1000, 1), 7)} ${pad(fmt(q(0.99) * 1000, 1), 7)}  ${pad(fmt((n ? devs[n - 1] : 0) * 1000, 0), 7)}  ${pad(fmt(pct, 2), 6)} %  ${pad(skipped, 7)}  ${worst.map((w) => `s${Math.round(w.s)} lat${Math.round(w.lat)} ${Math.round(w.dev * 1000)}mm·${secShort(w.s)}`).join(' ')}`)
  }
  out.guards.G3 = rows.map((r) => ({ ...r, p50: Math.round(r.p50 * 1000), p99: Math.round(r.p99 * 1000), max: Math.round(r.max * 1000) }))
  for (const r of rows) check('G3', r.name, Number(fmt(r.pct, 2)), 0, `(${r.frame} frame, p99 ${fmt(r.p99 * 1000, 0)} mm, max ${fmt(r.max * 1000, 0)} mm)`, 'pct')
  guardEnd('G3')
}

// ================================================================ G4 — mesh quality
if (runs('G4')) {
  guardStart('G4', 'quality — zero-area triangles, zero normals on drawn vertices, field-frame faces tilted > 10° away from the field')
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
    rows.push({ name: face.name, tris: face.tris, pct: samples ? (100 * under) / samples : 0, worst, maxEdge, over, flat: face.reg.flat, longEdges: longEdges.slice(0, 4) })
  }
  rows.sort((a, b) => b.pct - a.pct || b.maxEdge - a.maxEdge)
  console.log('    face                    tris   terrain above   worst      longest XZ edge   edges over   where (n, longest, s/lat, source 0 raster 1 world 2 stitch)')
  for (const r of rows) console.log(`    ${padE(r.name, 22)} ${pad(r.tris, 7)}   ${pad(fmt(r.pct, 2), 8)} %   ${pad(fmt(r.worst, 3), 6)} m   ${pad(fmt(r.maxEdge, 1), 6)} m${r.maxEdge > maxEdgeLimit && !r.flat ? ' <<' : '   '}   ${pad(r.over, 8)}   ${r.longEdges.map((e) => `${e.n}×${e.len.toFixed(1)}m s${Math.round(e.s)}/${Math.round(e.lat)}·${secShort(e.s)}·src${e.src} [${e.ends}]`).join('  ')}`)
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
  if (runs('G7')) for (const r of rows) if (!r.flat) check('G7', r.name, r.over, 0, `(longest ${fmt(r.maxEdge, 1)} m, half the ${fmt(maxEdgeLimit * 2, 1)} m grid)`)
  guardEnd('G6')
  if (runs('G7')) out.ms.G7 = 0 // shares G6's pass; recorded so its allowances are audited as "ran"
}

// ================================================================ G8 — registration, from the geometry; R13 imports
if (runs('G8')) {
  guardStart('G8', 'registration — horizontal geometry at ground level that is not a registered face')
  const FURNITURE = ['stand', 'terrace', 'furniture', 'props', 'concrete', 'pitRails', 'terrain']
  const allowListed = (o) => { for (let p = o; p; p = p.parent) if (p.name && FURNITURE.some((pre) => p.name.startsWith(pre))) return true; return false }
  root.updateMatrixWorld(true)
  const rows = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes?.position) return
    if (o.geometry.userData.groundReg || o.userData.decal || DECAL_NAMES.has(o.name)) return
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
        const fa = ground.field.y(T[o + ka], T[o + ka + 2]), fb = ground.field.y(T[o + kb], T[o + kb + 2])
        if (Math.abs(fa - fb) > 0.4) { relief++; continue }
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
  console.log(`    stations ${plan.stations.length} (base ${st.base}, endpoints ${st.endpoints}, kinks ${st.kinks}, tips ${st.tips}, chord ${st.chord}, crossings ${st.crossings}; passes ${st.passes.join('/')})`)
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
