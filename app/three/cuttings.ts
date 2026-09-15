import * as THREE from 'three'
import { CUT_WALL_FOOT, FOOTBRIDGE, FOOTBRIDGES } from '~/data/suzuka-facilities-spec'
import type { EnvBuildContext } from './environment'
import type { CutCorridor, CutField } from './ground-field'
import type { Ground } from './ground'
import { assetAspect, pbrFromAssets, tileMetres } from './materials'
import { BARRIERS } from '~/data/suzuka-barriers-spec'
import { addMerged, pitMaterials } from './pit-geometry'
import { osmWay, resolveLineCached } from './trackside'

/**
 * The cuttings and tunnels (plan I6-b, P8): what STANDS in and over the CUT corridors the ground
 * field digs (ground-field.ts `CutField`, README 地面の契約 R6 as revised at I6) — nothing here
 * changes the ground, and nothing here draws an opaque ground face (R11).
 *
 * - Retaining walls (`furniture-cut-walls`): one vertical wall along each corridor edge, both
 *   sides of every corridor. The wall's visible face stands at the FOOT of the field's wall
 *   (`CUT_WALL_FOOT` inside the polygon edge, where the field reaches the floor) and its back
 *   at the edge, so the 0.6 m smoothstep ramp of the field is inside the concrete; bottom =
 *   floor − 0.3, top = `ground.standY` 0.5 m outside the edge + `PARAPET` (the wall stops where
 *   a daylighting corridor's ground is less than WALL_MIN over the floor). A 1.1 m handrail
 *   along the top (`props-cut-rails`, `Quality.infield.detail`).
 * - Portals (`furniture-cut-portals` concrete, `furniture-cut-copings` white): a headwall at a
 *   road cut's start cap (and at its end cap when the corridor ends at the next tunnel —
 *   `end === 'wayEnd'`, the 39 m county-road cut) and at a stair pit's start: the corridor width
 *   + 1 m wide, floor − 0.3 to floor + depth + 1 high, its back face ON the cap (the cap is
 *   already ≥ BARRIER_CLEAR outside the BARRIERS line the tunnel passes under), the front face
 *   PORTAL_T in; an opening the clear width between the walls × OPENING_H (4.5 m; a stair pit
 *   2.5 × 2.5), closed by a black bore (`furniture-cut-tunnelInterior`, plain dark, receives
 *   only) up to INTERIOR_D deep behind the opening — under the ground, which stays the field
 *   between two portals (the tunnel roof is never cut). The opening's height is clamped under
 *   the drawn ground over the bore so it never pokes through the verge, and the bore's FLOOR is
 *   draped on the drawn ground (`BORE_LIFT` over it, never under the sill, never over the
 *   soffit): the field cannot bore a tunnel, so the cut fades out over the last ≈ 2 m of the
 *   corridor and the ground climbs from the floor to the cap inside the headwall's own thickness
 *   (measured at all 21 portals: floor + 0.5…1.2 m at the front face, the cap 0.8 m behind it).
 *   A box hung flat under that ramp had the lit ramp standing in it — which is what showed in
 *   the openings instead of the black box (the I7 fix). The bore's back wall stands at the first
 *   station where the ground closes the opening, so it keeps its full depth only where the
 *   ground behind really is lower (a cut ending at the next tunnel's mouth).
 * - Pedestrian tunnels: the stair pits get the same headwall with a 2.5 × 2.5 opening and a
 *   flight of stairs at the far end (`props-cut-stairs`: STAIR_PIT.depth / FOOTBRIDGE.riser
 *   risers × FOOTBRIDGE.tread, the clear width of the pit) with a handrail either side.
 * - Footbridges (`FOOTBRIDGES`, `buildFootbridges`): a rigid deck between the way's two nodes
 *   (`structures-footbridge-<id>`, cast) at one height — the ground under the span +
 *   `FOOTBRIDGE.minGap`, or a cut floor / road face under it + `clearance` — on two abutments
 *   standing on `ground.standY`, steel rails (foot) or concrete parapets (road), stairs or 1 : 8
 *   ramps at the ends (`props-footbridge-steps`). 467219905 is the chicane service bridge over
 *   the chicaneLeft corridor (its soffit ≥ clearance over `field.cutAt`); the plan's oblique
 *   "(5095, +25) → (5120, −20)" crossing is not in OSM (a fold misread) and is not built.
 *
 * Ground contract: every wall, portal, stair and abutment reads `ground.standY` / `field.cutAt`
 * (never the terrain, R3); the corridor edges come from `CutField.corridor` (the same polygons
 * the `{ cut }` ground rows are drawn from), so a wall is exactly on the drawn wall foot. G8: the
 * only horizontal faces near the ground are the wall tops (`furniture-` prefix), the stair
 * treads (`props-`) and the ramps (`props-`); the decks are ≥ minGap + slab up. No new shader
 * program: the pit materials (concrete046 / white / dark / rails), `pbrFromAssets
 * ('preconcrete_wall_001_long')` as paddock.ts used it, plain-colour steel.
 *
 * Facts for the smokes (`group.userData.cuttings`): every wall run's inner polyline and its
 * height range, every portal's sill segment, every deck's soffit and its clearance over what
 * passes under it.
 */

// ---------------------------------------------------------------- constants (metres)

/** the retaining wall's top over the ground outside the corridor edge (the parapet) */
const PARAPET = 0.3
/** the wall's bottom below the cut floor */
const WALL_SINK = 0.3
/** the wall is drawn only where the ground outside stands at least this much over the floor (a daylighting corridor tapers out) */
const WALL_MIN = 0.5
/** the ground outside the edge is read this far beyond it */
const OUTSIDE = 0.5
/** wall polyline pitch (m): every second corridor sample */
const WALL_STEP = 1
/** handrail: height, post section, post pitch */
const RAIL_H = 1.1
const RAIL_POST = 0.05
const RAIL_PITCH = 2
/** the headwall's thickness from the cap (its back) into the corridor (its front), and its overhang beyond the corridor edge on each side */
const PORTAL_T = 0.8
const PORTAL_WING = 0.5
/** the headwall's top over the floor + depth */
const PORTAL_OVER = 1.0
/** the opening's height: a road tunnel, and a pedestrian one */
const OPENING_H = 4.5
const PED_OPENING = 2.5
/** the opening's soffit stays at least this far under the headwall's top (a lintel) */
const LINTEL_MIN = 0.5
/** the black tunnel interior behind the headwall: its depth (and the least it shrinks to), its ceiling's clearance under the drawn ground over it */
const INTERIOR_D = 8
const INTERIOR_MIN_D = 3
const INTERIOR_CLEAR = 0.45
/**
 * the bore behind the opening: how much wider / taller than the opening it is (so its walls and
 * ceiling are buried in the headwall instead of coplanar with the reveal), how far its floor is
 * lifted over the drawn ground it is draped on (≥ LAYER_MIN_STEP), and the stations it is
 * sampled at along the bore and across the opening
 */
const BORE_OUT = 0.03
const BORE_LIFT = 0.02
const BORE_STEP = 0.15
const BORE_COL = 0.6
/** a headwall (and every wall: O5) keeps this much from a BARRIERS resolved line — ground-field.ts's BARRIER_CLEAR, the corridor's own rule */
const BARRIER_CLEAR = 0.6
/** the white coping on the headwall: height, overhang */
const COPING_H = 0.25
const COPING_OVER = 0.1
/** a footbridge's deck bears this much onto each abutment; the abutment's length along the deck; its top under the deck */
const BEARING = 0.3
const ABUTMENT_L = 0.6
/** the footbridge deck's ground samples along the span */
const SPAN_STEP = 0.5
/** road parapets on a vehicle deck: thickness */
const PARAPET_T = 0.2

type Pt = { x: number; z: number }
type V3 = THREE.Vector3

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const _a = new THREE.Vector3(), _b = new THREE.Vector3()

// ---------------------------------------------------------------- geometry sink

/** Non-indexed triangle sink with position / normal / uv, for the hand-built walls and slabs. */
class Sink {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  /** a quad a → b → c → d; the winding is fixed so the normal agrees with `out` */
  quad(a: V3, b: V3, c: V3, d: V3, uvs: [number, number][], out: V3) {
    const n = _a.copy(b).sub(a).cross(_b.copy(c).sub(a))
    if (n.lengthSq() < 1e-12) n.copy(_a.copy(c).sub(a).cross(_b.copy(d).sub(a)))
    if (n.lengthSq() < 1e-12) return
    n.normalize()
    let pts = [a, b, c, d], tc = uvs
    if (n.dot(out) < 0) {
      n.negate()
      pts = [a, d, c, b]
      tc = [uvs[0]!, uvs[3]!, uvs[2]!, uvs[1]!]
    }
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i]!
      this.pos.push(p.x, p.y, p.z)
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(tc[i]![0], tc[i]![1])
    }
  }
  /** a vertical wall quad from p0 to p1 (world XZ), y0 → y1 at each end, metre uv over `tile`, facing `out` */
  wall(p0: Pt, p1: Pt, y00: number, y01: number, y10: number, y11: number, tile: [number, number], out: Pt, u0 = 0) {
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z)
    this.quad(V(p0.x, y00, p0.z), V(p1.x, y10, p1.z), V(p1.x, y11, p1.z), V(p0.x, y01, p0.z),
      [[u0 / tile[0], y00 / tile[1]], [(u0 + len) / tile[0], y10 / tile[1]], [(u0 + len) / tile[0], y11 / tile[1]], [u0 / tile[0], y01 / tile[1]]], V(out.x, 0, out.z))
  }
  get empty() { return this.pos.length === 0 }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    return g
  }
}

/** a box w (along x) × h × d (along z), base-centred at the origin, in the frame `m` */
function boxIn(w: number, h: number, d: number, m: THREE.Matrix4, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  g.translate(x, y + h / 2, z)
  g.applyMatrix4(m)
  return g
}

/** a frame whose x axis is the unit direction (dx, dz) in world XZ, y up, at (x, y, z) */
function frameOf(x: number, y: number, z: number, dx: number, dz: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(V(dx, 0, dz), V(0, 1, 0), V(-dz, 0, dx)).setPosition(x, y, z)
}

const unit = (dx: number, dz: number): Pt => { const l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l } }

const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dz = b.z - a.z
  const l2 = dx * dx + dz * dz || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2))
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
}
/** the least distance between the segment a–b and every polyline (endpoint-to-segment both ways: enough for a 1 m line against 2 m barrier samples) */
function barrierDistance(lines: Pt[][], a: Pt, b: Pt): number {
  let min = Infinity
  for (const line of lines) for (let i = 0; i + 1 < line.length; i++) {
    const p = line[i]!, q = line[i + 1]!
    if (Math.abs(p.x - a.x) > 60 || Math.abs(p.z - a.z) > 60) continue
    min = Math.min(min, segDist(a, p, q), segDist(b, p, q), segDist(p, a, b), segDist(q, a, b))
  }
  return min
}

// ---------------------------------------------------------------- what the smokes read

export interface CutWallFact {
  cut: string
  side: 'left' | 'right'
  /** the wall's inner (visible) face polyline, world XZ */
  inner: Pt[]
  /** the wall's height over the floor: min and max over the run */
  hMin: number
  hMax: number
}
export interface CutPortalFact {
  cut: string
  at: 'start' | 'end'
  /** the opening's sill: the two ends of the front face's opening at floor level, world XZ */
  sill: [Pt, Pt]
  /** the headwall's back face line (on the cap), world XZ */
  back: [Pt, Pt]
  /** the opening's height over the floor */
  openH: number
  /** the dark bore's depth behind the front face: where its back wall stands (the ground closed it, or PORTAL_T + the interior depth) */
  boreD: number
}
export interface FootbridgeFact {
  osmWay: number
  /** deck top and soffit (world y), the deck's ends (world XZ) */
  top: number
  soffit: number
  ends: [Pt, Pt]
  /** the least headroom of the soffit over what passes under the span, and what that was */
  headroom: number
  under: 'ground' | 'cut' | 'road'
  /** the abutments' and steps' footprints (world XZ rings) */
  footprints: Pt[][]
}
export interface CuttingsFacts {
  walls: CutWallFact[]
  portals: CutPortalFact[]
  stairs: string[]
  footbridges: FootbridgeFact[]
}

// ---------------------------------------------------------------- materials

interface CutMats {
  wall: THREE.Material
  wallTile: [number, number]
  concrete: THREE.Material
  concreteTile: number
  white: THREE.Material
  dark: THREE.Material
  steel: THREE.Material
}

function cutMaterials(ctx: EnvBuildContext): CutMats {
  const reg = ctx.assets
  const pm = pitMaterials(ctx)
  // the precast retaining panels of the crossover's abutments (structures.ts) and paddock v1's
  // stubs: preconcrete_wall_001_long, 4 m × 1.33 m per tile, tinted as the shaded masonry
  const tileU = tileMetres(reg, 'tex/preconcrete_wall_001_long/diff', 4)
  const wallTile: [number, number] = [tileU, tileU / assetAspect(reg, 'tex/preconcrete_wall_001_long/diff', 3)]
  const wallFallback = () => new THREE.MeshStandardMaterial({ color: 0x9a9894, roughness: 0.9 })
  const wall = reg ? pbrFromAssets(reg, 'preconcrete_wall_001_long', { fallback: wallFallback, handBuiltUv: true, normalScale: 0.8, extra: { color: 0x9a9894 } }) : wallFallback()
  // galvanised handrails: a plain colour (the program of every plain Standard material)
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.55, metalness: 0.6 })
  return { wall, wallTile, concrete: pm.concreteMat, concreteTile: pm.concreteTile, white: pm.whiteMat, dark: pm.interiorMat, steel }
}

// ---------------------------------------------------------------- the builder

export function buildCuttings(ctx: EnvBuildContext): void {
  const { ground, group, cuts, quality } = ctx
  const M = cutMaterials(ctx)
  const shadows = quality.infield.shadows
  const detail = quality.infield.detail
  const facts: CuttingsFacts = { walls: [], portals: [], stairs: [], footbridges: [] }
  const stat = (key: string, n: number) => { ctx.infieldStats[key] = (ctx.infieldStats[key] ?? 0) + n }

  const walls = new Sink(), portals = new Sink(), interiors = new Sink(), stairs = new Sink()
  const copings: THREE.BufferGeometry[] = []
  const rails: THREE.BufferGeometry[] = []
  // every BARRIERS run's resolved line (the cache ground-field.ts filled): a headwall keeps BARRIER_CLEAR from them
  const barriers: Pt[][] = []
  for (const run of BARRIERS) {
    const line = resolveLineCached(ctx.track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
    if (line.samples.length < 2) continue
    barriers.push(line.samples.map(([ss, lat]) => { ctx.track.pointAt(ss, lat, _a, 0); return { x: _a.x, z: _a.z } }))
  }

  for (const c of cuts.corridors) {
    const edges = corridorEdges(cuts, c)
    if (!edges) continue
    buildWalls(ground, c, edges, walls, rails, M, detail, facts)
    const isPit = c.def.kind === 'stairPit'
    buildPortal(ground, barriers, c, edges, 'start', isPit, portals, interiors, copings, M, facts)
    if (!isPit && c.end === 'wayEnd') buildPortal(ground, barriers, c, edges, 'end', false, portals, interiors, copings, M, facts)
    if (isPit) buildStairs(ground, c, edges, stairs, rails, M, detail, facts)
  }

  if (!walls.empty) addMerged(group, [walls.build()], M.wall, 'furniture-cut-walls', shadows)
  if (!portals.empty) addMerged(group, [portals.build()], M.concrete, 'furniture-cut-portals', shadows)
  addMerged(group, copings, M.white, 'furniture-cut-copings', false)
  if (!interiors.empty) addMerged(group, [interiors.build()], M.dark, 'furniture-cut-tunnelInterior', false)
  if (!stairs.empty) addMerged(group, [stairs.build()], M.concrete, 'props-cut-stairs', false)
  addMerged(group, rails, M.steel, 'props-cut-rails', false)

  buildFootbridges(ctx, M, facts)

  stat('cuttings-walls', facts.walls.length)
  stat('cuttings-portals', facts.portals.length)
  stat('cuttings-stairs', facts.stairs.length)
  stat('cuttings-footbridges', facts.footbridges.length)
  group.userData.cuttings = facts
}

// ---------------------------------------------------------------- corridor edges

interface CorridorEdges {
  /** the corridor's left and right edge points, one per sample (the polygon `CutField.corridor` draws) */
  left: Pt[]
  right: Pt[]
}

/**
 * The corridor polygon is the left edge forward then the right edge back (ground-field.ts
 * `polygonFrom`), one vertex per sample on each: split it back into the two edges so every edge
 * point pairs with its sample's floor and half-width.
 */
function corridorEdges(cuts: CutField, c: CutCorridor): CorridorEdges | null {
  const poly = cuts.corridor(c.id)
  const n = c.samples.length
  if (poly.length !== 2 * n || n < 2) return null
  return { left: poly.slice(0, n), right: poly.slice(n).reverse() }
}

/** the corridor's forward direction at sample k (unit, world XZ) */
function forwardAt(c: CutCorridor, k: number): Pt {
  const sm = c.samples
  const a = sm[Math.max(0, k - 1)]!, b = sm[Math.min(sm.length - 1, k + 1)]!
  return unit(b.x - a.x, b.z - a.z)
}

// ---------------------------------------------------------------- retaining walls

function buildWalls(ground: Ground, c: CutCorridor, edges: CorridorEdges, sink: Sink, rails: THREE.BufferGeometry[], M: CutMats, detail: boolean, facts: CuttingsFacts) {
  const sm = c.samples
  const step = Math.max(1, Math.round(WALL_STEP / (sm[1]!.d - sm[0]!.d)))
  for (const side of ['left', 'right'] as const) {
    const edge = side === 'left' ? edges.left : edges.right
    // the wall's stations: inner face point, outer (edge) point, floor, top — null where there is no wall
    type St = { inner: Pt; outer: Pt; out: Pt; floor: number; top: number }
    const sts: (St | null)[] = []
    const ks: number[] = []
    for (let k = 0; k < sm.length; k += step) ks.push(k)
    if (ks[ks.length - 1] !== sm.length - 1) ks.push(sm.length - 1)
    for (const k of ks) {
      const q = sm[k]!, e = edge[k]!
      const w = side === 'left' ? q.wl : q.wr
      if (w < CUT_WALL_FOOT + 0.2) { sts.push(null); continue }
      const out = unit(e.x - q.x, e.z - q.z)
      const inner = { x: q.x + out.x * (w - CUT_WALL_FOOT), z: q.z + out.z * (w - CUT_WALL_FOOT) }
      const top = ground.standY(e.x + out.x * OUTSIDE, e.z + out.z * OUTSIDE) + PARAPET
      if (top - q.floor < WALL_MIN) { sts.push(null); continue }
      sts.push({ inner, outer: e, out, floor: q.floor, top })
    }
    // runs of consecutive stations
    let run: St[] = [], runK: number[] = []
    const flush = () => {
      if (run.length >= 2) {
        let hMin = Infinity, hMax = -Infinity
        for (let i = 0; i + 1 < run.length; i++) {
          const a = run[i]!, b = run[i + 1]!
          const yb0 = a.floor - WALL_SINK, yb1 = b.floor - WALL_SINK
          // the inner face (toward the corridor), the top, the outer face (its buried part costs nothing to skip: from the outside ground − 0.2)
          sink.wall(a.inner, b.inner, yb0, a.top, yb1, b.top, M.wallTile, { x: -a.out.x, z: -a.out.z }, i * WALL_STEP)
          sink.quad(V(a.inner.x, a.top, a.inner.z), V(b.inner.x, b.top, b.inner.z), V(b.outer.x, b.top, b.outer.z), V(a.outer.x, a.top, a.outer.z),
            [[0, 0], [1, 0], [1, 0.15], [0, 0.15]], V(0, 1, 0))
          sink.wall(a.outer, b.outer, a.top - PARAPET - 0.2, a.top, b.top - PARAPET - 0.2, b.top, M.wallTile, a.out, i * WALL_STEP)
          hMin = Math.min(hMin, a.top - a.floor, b.top - b.floor)
          hMax = Math.max(hMax, a.top - a.floor, b.top - b.floor)
        }
        // end caps (the start one is inside the headwall; the end one shows where a corridor daylights)
        for (const [st, dir, k] of [[run[0]!, -1, runK[0]!], [run[run.length - 1]!, 1, runK[runK.length - 1]!]] as const) {
          const fwd = forwardAt(c, k)
          sink.wall(st.inner, st.outer, st.floor - WALL_SINK, st.top, st.floor - WALL_SINK, st.top, M.wallTile, { x: fwd.x * dir, z: fwd.z * dir })
        }
        if (detail) railAlong(run.map((s) => ({ x: (s.inner.x + s.outer.x) / 2, z: (s.inner.z + s.outer.z) / 2, y: s.top })), rails)
        facts.walls.push({ cut: c.id, side, inner: run.map((s) => s.inner), hMin, hMax })
      }
      run = []
      runK = []
    }
    sts.forEach((st, i) => { if (st) { run.push(st); runK.push(ks[i]!) } else flush() })
    flush()
  }
}

/** a handrail along a polyline of top points: posts every RAIL_PITCH, a top rail and a mid rail per segment */
function railAlong(pts: { x: number; y: number; z: number }[], rails: THREE.BufferGeometry[]) {
  let since = RAIL_PITCH
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 1e-6) continue
    const d = unit(b.x - a.x, b.z - a.z)
    const m = frameOf(a.x, a.y, a.z, d.x, d.z)
    const slope = (b.y - a.y) / len
    for (const h of [RAIL_H, RAIL_H * 0.55]) {
      const r = new THREE.BoxGeometry(Math.hypot(len, b.y - a.y), 0.04, 0.04).toNonIndexed()
      r.rotateZ(Math.atan(slope))
      r.translate(len / 2, h + (b.y - a.y) / 2, 0)
      r.applyMatrix4(m)
      rails.push(r)
    }
    if (since >= RAIL_PITCH) { rails.push(boxIn(RAIL_POST, RAIL_H, RAIL_POST, m)); since = 0 }
    since += len
  }
  const last = pts[pts.length - 1]!
  if (pts.length >= 2) rails.push(boxIn(RAIL_POST, RAIL_H, RAIL_POST, frameOf(last.x, last.y, last.z, 1, 0)))
}

// ---------------------------------------------------------------- portals

function buildPortal(ground: Ground, barriers: Pt[][], c: CutCorridor, edges: CorridorEdges, at: 'start' | 'end', isPit: boolean, portals: Sink, interiors: Sink, copings: THREE.BufferGeometry[], M: CutMats, facts: CuttingsFacts) {
  const sm = c.samples
  const k = at === 'start' ? 0 : sm.length - 1
  const q = sm[k]!
  // `u` points from the headwall into the corridor
  const f = forwardAt(c, k)
  const u = at === 'start' ? f : { x: -f.x, z: -f.z }
  const L = edges.left[k]!, R = edges.right[k]!
  const wl = q.wl, wr = q.wr
  if (wl < CUT_WALL_FOOT + 0.2 || wr < CUT_WALL_FOOT + 0.2) return
  const across = unit(L.x - R.x, L.z - R.z)
  const floor = q.floor
  const at2 = (along: number, side: number): Pt => ({ x: q.x + u.x * along + across.x * side, z: q.z + u.z * along + across.z * side })
  // the headwall's extent across: the corridor + a wing each side; its opening: the clear width between the walls' faces
  const eL = wl + PORTAL_WING, eR = -(wr + PORTAL_WING)
  // the clear width between the retaining walls' faces (cut643's end cap is pulled in on the
  // right where the way meets the chicane approach's strip: its opening is narrower there and
  // left of centre — the mouth the ground gives it); a stair pit's opening is PED_OPENING wide, centred
  const cL = wl - CUT_WALL_FOOT, cR = -(wr - CUT_WALL_FOOT)
  const openW = isPit ? Math.min(PED_OPENING, cL - cR) : cL - cR
  const oL = (cL + cR) / 2 + openW / 2, oR = oL - openW
  // the top: floor + depth + PORTAL_OVER, never under the ground behind the cap + 0.8
  const backGround = Math.max(ground.standY(at2(0, eL).x, at2(0, eL).z), ground.standY(at2(0, eR).x, at2(0, eR).z), ground.standY(at2(-0.2, 0).x, at2(-0.2, 0).z))
  const top = Math.max(floor + c.def.depth + PORTAL_OVER, backGround + 0.8)
  // the headwall's back is on the cap, unless a BARRIERS line is nearer than BARRIER_CLEAR to it
  // there (the county-road cut's end cap meets the chicane approach's guardrail obliquely: its
  // wing corner is 0.27 m from the line) — then the whole headwall moves into the corridor
  let back = 0
  for (let i = 0; i < 15; i++) {
    const d = barrierDistance(barriers, at2(back, eR), at2(back, eL))
    if (d >= BARRIER_CLEAR + 0.01) break
    back += 0.1
  }
  const front = back + PORTAL_T
  // the interior box's ceiling stays INTERIOR_CLEAR under the drawn ground over it: the box is
  // INTERIOR_D deep where the ground allows the full opening, shorter where the verge behind
  // the portal falls toward the road (a pit 30 m from the road, its box under the blend)
  const wanted = isPit ? PED_OPENING : OPENING_H
  let interiorD = INTERIOR_D, overMin = Infinity
  for (const depth of [INTERIOR_D, INTERIOR_D * 0.75, INTERIOR_D * 0.5, INTERIOR_MIN_D]) {
    overMin = Infinity
    for (const along of [back - 0.5, back - depth / 2, back - depth]) for (const side of [oR + 0.2, 0, oL - 0.2]) {
      const p = at2(along, side)
      overMin = Math.min(overMin, ground.standY(p.x, p.z))
    }
    interiorD = depth
    if (overMin - INTERIOR_CLEAR - floor >= wanted) break
  }
  const openH = Math.max(1.8, Math.min(wanted, top - LINTEL_MIN - floor, overMin - INTERIOR_CLEAR - floor))
  const y0 = floor - WALL_SINK, yOpen = floor + openH
  const tile = M.concreteTile
  const T: [number, number] = [tile, tile]
  const outF = { x: u.x, z: u.z }, outB = { x: -u.x, z: -u.z }
  // front face: two piers and the lintel; back face the same (the box behind shows through the opening)
  for (const [along, out] of [[front, outF], [back, outB]] as const) {
    portals.wall(at2(along, eR), at2(along, oR), y0, top, y0, top, T, out)
    portals.wall(at2(along, oL), at2(along, eL), y0, top, y0, top, T, out)
    portals.wall(at2(along, oR), at2(along, oL), yOpen, top, yOpen, top, T, out)
  }
  // the ends and the reveals (jambs and soffit of the opening, between the two faces)
  portals.wall(at2(back, eL), at2(front, eL), y0, top, y0, top, T, across)
  portals.wall(at2(back, eR), at2(front, eR), y0, top, y0, top, T, { x: -across.x, z: -across.z })
  portals.wall(at2(front, oL), at2(back, oL), y0, yOpen, y0, yOpen, T, { x: -across.x, z: -across.z })
  portals.wall(at2(front, oR), at2(back, oR), y0, yOpen, y0, yOpen, T, across)
  {
    const a = at2(front, oR), b = at2(front, oL), cc = at2(back, oL), d = at2(back, oR)
    portals.quad(V(a.x, yOpen, a.z), V(b.x, yOpen, b.z), V(cc.x, yOpen, cc.z), V(d.x, yOpen, d.z), [[0, 0], [openW / tile, 0], [openW / tile, PORTAL_T / tile], [0, PORTAL_T / tile]], V(0, -1, 0))
  }
  // the coping: a white box over the headwall, overhanging the front and the ends (flush at the back: the cap's clearance is the barrier's)
  // (the frame's x is `u`, into the corridor; its z is the left of `u`, which is `across` for a
  //  start portal and −across for an end portal — the box is symmetric across, so only x matters)
  copings.push(boxIn(PORTAL_T + COPING_OVER, COPING_H, eL - eR + 2 * COPING_OVER, frameOf(q.x, top, q.z, u.x, u.z), (back + front) / 2 + COPING_OVER / 2, 0, (at === 'start' ? 1 : -1) * (eL + eR) / 2))
  // the tunnel interior: a dark bore from the opening back into the ground, its floor draped on
  // the drawn ground (see the header: the cut's own fade climbs through the headwall's thickness,
  // so a flat box left that lit ramp standing in the opening). It starts at the front face and is
  // BORE_OUT wider / taller than the opening, so its walls and ceiling are buried in the concrete
  // instead of fighting the reveal; it ends where the ground has closed it, at most interiorD
  // behind the back face.
  const boreD = (() => {
    const bR = oR - BORE_OUT, bL = oL + BORE_OUT, bTop = yOpen + BORE_OUT
    const cols = Math.max(2, Math.round((bL - bR) / BORE_COL))
    const maxD = PORTAL_T + interiorD
    const steps = Math.max(2, Math.ceil(maxD / BORE_STEP))
    const sideOf = (j: number) => bR + ((bL - bR) * j) / cols
    const alongOf = (i: number) => front - (maxD * i) / steps
    const pt = (i: number, j: number, y: number) => { const w = at2(alongOf(i), sideOf(j)); return V(w.x, y, w.z) }
    const UV: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const grid: number[][] = []
    let last = steps
    for (let i = 0; i <= steps; i++) {
      const row: number[] = []
      for (let j = 0; j <= cols; j++) {
        // the node and its four half-cell neighbours: the drape is the ground's upper envelope,
        // so a ramp that bulges between two stations still stays under it
        let g = -Infinity
        for (const [di, dj] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]] as const) {
          const w = at2(alongOf(Math.min(steps, Math.max(0, i + di))), sideOf(Math.min(cols, Math.max(0, j + dj))))
          g = Math.max(g, ground.standY(w.x, w.z))
        }
        row.push(Math.min(bTop, Math.max(y0, g + BORE_LIFT)))
      }
      grid.push(row)
      // the ground has closed the opening: the bore ends here (never at the mouth itself)
      if (i > 0 && row.every((y) => y >= bTop - 1e-6)) { last = i; break }
    }
    const inward = { x: -across.x, z: -across.z }
    for (let i = 0; i < last; i++) {
      const g0 = grid[i]!, g1 = grid[i + 1]!
      // the floor on the ground, and the two side walls from it up to the ceiling
      for (let j = 0; j < cols; j++) interiors.quad(pt(i, j, g0[j]!), pt(i, j + 1, g0[j + 1]!), pt(i + 1, j + 1, g1[j + 1]!), pt(i + 1, j, g1[j]!), UV, V(0, 1, 0))
      interiors.quad(pt(i, cols, g0[cols]!), pt(i + 1, cols, g1[cols]!), pt(i + 1, cols, bTop), pt(i, cols, bTop), UV, V(inward.x, 0, inward.z))
      interiors.quad(pt(i, 0, g0[0]!), pt(i + 1, 0, g1[0]!), pt(i + 1, 0, bTop), pt(i, 0, bTop), UV, V(across.x, 0, across.z))
    }
    // the ceiling, and the back wall closing the whole cross-section at the last station (sill to
    // ceiling, not just over the drape: where the ground already fills the opening the wall is
    // behind it, and where the drawn ground has a hole the bore is still closed)
    interiors.quad(pt(0, 0, bTop), pt(0, cols, bTop), pt(last, cols, bTop), pt(last, 0, bTop), UV, V(0, -1, 0))
    interiors.quad(pt(last, 0, y0), pt(last, cols, y0), pt(last, cols, bTop), pt(last, 0, bTop), UV, V(u.x, 0, u.z))
    return (maxD * last) / steps
  })()
  facts.portals.push({ cut: c.id, at, sill: [at2(front, oR), at2(front, oL)], back: [at2(back, eR), at2(back, eL)], openH, boreD })
}

// ---------------------------------------------------------------- pedestrian stairs

function buildStairs(ground: Ground, c: CutCorridor, edges: CorridorEdges, sink: Sink, rails: THREE.BufferGeometry[], M: CutMats, detail: boolean, facts: CuttingsFacts) {
  const sm = c.samples
  const k = sm.length - 1
  const q = sm[k]!
  const f = forwardAt(c, k)
  const L = edges.left[k]!, R = edges.right[k]!
  const across = unit(L.x - R.x, L.z - R.z)
  const wl = q.wl - CUT_WALL_FOOT, wr = q.wr - CUT_WALL_FOOT
  if (wl < 0.4 || wr < 0.4) return
  // the flight rises from the pit floor to the ground beyond the end cap
  const beyond = { x: q.x + f.x * (CUT_WALL_FOOT + 0.5), z: q.z + f.z * (CUT_WALL_FOOT + 0.5) }
  const rise = ground.standY(beyond.x, beyond.z) - q.floor
  const steps = Math.max(3, Math.ceil(rise / FOOTBRIDGE.riser))
  const riser = rise / steps
  const run = steps * FOOTBRIDGE.tread
  const at2 = (along: number, side: number): Pt => ({ x: q.x + f.x * along + across.x * side, z: q.z + f.z * along + across.z * side })
  const tile = M.concreteTile
  const T: [number, number] = [tile, tile]
  // the treads and risers, the clear width of the pit; the top tread lands on the end cap (d = endD)
  for (let i = 0; i < steps; i++) {
    const a0 = -run + i * FOOTBRIDGE.tread, a1 = a0 + FOOTBRIDGE.tread
    const y = q.floor + (i + 1) * riser
    const pa = at2(a0, -wr), pb = at2(a0, wl), pc = at2(a1, wl), pd = at2(a1, -wr)
    sink.quad(V(pa.x, y, pa.z), V(pb.x, y, pb.z), V(pc.x, y, pc.z), V(pd.x, y, pd.z), [[0, 0], [(wl + wr) / tile, 0], [(wl + wr) / tile, FOOTBRIDGE.tread / tile], [0, FOOTBRIDGE.tread / tile]], V(0, 1, 0))
    sink.wall(at2(a0, -wr), at2(a0, wl), y - riser, y, y - riser, y, T, { x: -f.x, z: -f.z })
  }
  // the sides, up to the walls' faces (a stepped triangle strip is more than it is worth: one sloped quad each, hidden in the wall)
  if (detail) {
    for (const side of [wl - 0.08, -wr + 0.08]) {
      const a = at2(-run, side), b = at2(0, side)
      const ya = q.floor + 0.9, yb = q.floor + rise + 0.9
      railAlong([{ x: a.x, y: ya, z: a.z }, { x: b.x, y: yb, z: b.z }], rails)
    }
  }
  facts.stairs.push(c.id)
}

// ---------------------------------------------------------------- footbridges

function buildFootbridges(ctx: EnvBuildContext, M: CutMats, facts: CuttingsFacts) {
  const { track, ground, group, quality } = ctx
  const field = ground.field
  const shadows = quality.infield.shadows
  const steps = new Sink()
  const rails: THREE.BufferGeometry[] = []
  const parapets = new Sink()
  const isRoadFace = (kind: string) => kind === 'asphaltArea' || kind === 'lane' || kind === 'road' || kind === 'pitLane' || kind === 'pitApron' || kind === 'deckShoulder'
  for (const def of FOOTBRIDGES) {
    const way = osmWay(def.osmWay)
    if (!way || way.en.length < 2) { console.error(`[cuttings] footbridge ${def.osmWay} "${def.name}": OSM way missing or too short`); continue }
    track.enToWorld(way.en[0]![0], way.en[0]![1], _a)
    track.enToWorld(way.en[way.en.length - 1]![0], way.en[way.en.length - 1]![1], _b)
    let A: Pt = { x: _a.x, z: _a.z }, B: Pt = { x: _b.x, z: _b.z }
    // `shift` moves the line across, to the left of the way's first → last direction
    if (def.shift) {
      const w = unit(B.x - A.x, B.z - A.z)
      A = { x: A.x - w.z * def.shift, z: A.z + w.x * def.shift }
      B = { x: B.x - w.z * def.shift, z: B.z + w.x * def.shift }
    }
    // 'north' = the end with the smaller world z
    if (A.z > B.z) [A, B] = [B, A]
    const span = Math.hypot(B.x - A.x, B.z - A.z)
    if (span < 2) continue
    const d = unit(B.x - A.x, B.z - A.z)
    const n = { x: -d.z, z: d.x }
    const at2 = (along: number, side: number): Pt => ({ x: A.x + d.x * along + n.x * side, z: A.z + d.z * along + n.z * side })
    const slab = FOOTBRIDGE.slab[def.kind]
    // the ground under the span, and what passes under it: the greater of ground + minGap and (cut floor | road face) + clearance
    let groundMax = -Infinity, passMax = -Infinity, under: FootbridgeFact['under'] = 'ground'
    for (let along = 0; along <= span + 1e-6; along += SPAN_STEP) for (const side of [-def.deckW / 2, 0, def.deckW / 2]) {
      const p = at2(along, side)
      groundMax = Math.max(groundMax, ground.standY(p.x, p.z))
      const cut = field.cutAt(p.x, p.z)
      if (cut !== null) { if (cut + def.clearance > passMax) { passMax = cut + def.clearance; under = 'cut' } continue }
      const b = ground.builtY(p.x, p.z)
      if (b && isRoadFace(b.kind) && b.y + def.clearance > passMax) { passMax = b.y + def.clearance; under = 'road' }
    }
    const soffit = Math.max(groundMax + FOOTBRIDGE.minGap, passMax)
    const top = soffit + slab
    const yA = ground.standY(A.x, A.z), yB = ground.standY(B.x, B.z)
    const deck: THREE.BufferGeometry[] = []
    const frame = frameOf(A.x, 0, A.z, d.x, d.z)
    // the deck slab, bearing BEARING onto each abutment
    {
      const g = new THREE.BoxGeometry(span + 2 * BEARING, slab, def.deckW).toNonIndexed()
      const uv = g.attributes.uv as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (span + 2 * BEARING)) / M.concreteTile, (uv.getY(i) * def.deckW) / M.concreteTile)
      g.translate(span / 2, soffit + slab / 2, 0)
      g.applyMatrix4(frame)
      deck.push(g)
    }
    // the abutments: a pier under each end from the ground − 0.3 to the soffit
    const footprints: Pt[][] = []
    for (const [along, gy] of [[-BEARING + ABUTMENT_L / 2, yA], [span + BEARING - ABUTMENT_L / 2, yB]] as const) {
      const h = soffit - (gy - 0.3)
      if (h <= 0.05) continue
      deck.push(boxIn(ABUTMENT_L, h, def.deckW - 0.4, frame, along, gy - 0.3, 0))
      footprints.push([at2(along - ABUTMENT_L / 2, -def.deckW / 2 + 0.2), at2(along + ABUTMENT_L / 2, -def.deckW / 2 + 0.2), at2(along + ABUTMENT_L / 2, def.deckW / 2 - 0.2), at2(along - ABUTMENT_L / 2, def.deckW / 2 - 0.2)])
    }
    // rails (foot) or parapets (road) along both edges of the deck
    if (def.kind === 'foot') {
      if (quality.infield.detail) for (const side of [-def.deckW / 2 + 0.06, def.deckW / 2 - 0.06]) {
        const a = at2(-BEARING, side), b = at2(span + BEARING, side)
        railAlongH([{ x: a.x, y: top, z: a.z }, { x: b.x, y: top, z: b.z }], def.railH, rails)
      }
    } else {
      const T: [number, number] = [M.concreteTile, M.concreteTile]
      for (const sgn of [1, -1] as const) {
        const sOut = sgn * def.deckW / 2, sIn = sgn * (def.deckW / 2 - PARAPET_T)
        parapets.wall(at2(-BEARING, sOut), at2(span + BEARING, sOut), top - 0.02, top + def.railH, top - 0.02, top + def.railH, T, { x: n.x * sgn, z: n.z * sgn })
        parapets.wall(at2(-BEARING, sIn), at2(span + BEARING, sIn), top - 0.02, top + def.railH, top - 0.02, top + def.railH, T, { x: -n.x * sgn, z: -n.z * sgn })
        const a = at2(-BEARING, sOut), b = at2(span + BEARING, sOut), c = at2(span + BEARING, sIn), e = at2(-BEARING, sIn)
        parapets.quad(V(a.x, top + def.railH, a.z), V(b.x, top + def.railH, b.z), V(c.x, top + def.railH, c.z), V(e.x, top + def.railH, e.z), [[0, 0], [1, 0], [1, 0.1], [0, 0.1]], V(0, 1, 0))
      }
    }
    // the ends: a 1 : 8 ramp slab or a flight of stairs down to the ground, continuing the deck's line outward
    const ends: ['north' | 'south', number, number, number][] = [['north', -BEARING, -1, yA], ['south', span + BEARING, 1, yB]]
    for (const [name, along, dir, gy] of ends) {
      const rise = top - gy
      if (rise < 0.15) continue
      const ramp = def.ramp === 'both' || def.ramp === name
      // a footway's stairs and ramp are as wide as its abutments (the Q2 gaps leave 0.6 m either side of 1.6 m)
      const w = def.deckW - (def.kind === 'road' ? 0 : 0.4)
      if (ramp) {
        const len = rise / FOOTBRIDGE.rampSlope
        const g = new THREE.BoxGeometry(Math.hypot(len, rise), 0.3, w).toNonIndexed()
        g.rotateZ(-dir * Math.atan2(rise, len))
        g.translate(along + dir * len / 2, top - 0.15 - rise / 2, 0)
        g.applyMatrix4(frame)
        steps.pos.push(...(g.attributes.position as THREE.BufferAttribute).array)
        steps.nrm.push(...(g.attributes.normal as THREE.BufferAttribute).array)
        steps.uv.push(...(g.attributes.uv as THREE.BufferAttribute).array)
        footprints.push([at2(along, -w / 2), at2(along + dir * len, -w / 2), at2(along + dir * len, w / 2), at2(along, w / 2)])
        if (def.kind === 'foot' && quality.infield.detail) for (const side of [-w / 2 + 0.06, w / 2 - 0.06]) {
          const a = at2(along, side), b = at2(along + dir * len, side)
          railAlongH([{ x: a.x, y: top, z: a.z }, { x: b.x, y: gy, z: b.z }], def.railH, rails)
        }
      } else {
        const nSteps = Math.max(2, Math.ceil(rise / FOOTBRIDGE.riser))
        const riser = rise / nSteps
        // each step a solid block from the ground up: box i rises to top − i · riser, FOOTBRIDGE.tread long
        for (let i = 0; i < nSteps; i++) {
          const y = top - (i + 1) * riser
          const h = y - (gy - 0.2)
          if (h <= 0) continue
          const x0 = along + dir * (i * FOOTBRIDGE.tread + FOOTBRIDGE.tread / 2)
          const g = boxIn(FOOTBRIDGE.tread, h, w, frame, x0, gy - 0.2, 0)
          steps.pos.push(...(g.attributes.position as THREE.BufferAttribute).array)
          steps.nrm.push(...(g.attributes.normal as THREE.BufferAttribute).array)
          steps.uv.push(...(g.attributes.uv as THREE.BufferAttribute).array)
        }
        const len = nSteps * FOOTBRIDGE.tread
        footprints.push([at2(along, -w / 2), at2(along + dir * len, -w / 2), at2(along + dir * len, w / 2), at2(along, w / 2)])
        if (quality.infield.detail) for (const side of [-w / 2 + 0.06, w / 2 - 0.06]) {
          const a = at2(along, side), b = at2(along + dir * len, side)
          railAlongH([{ x: a.x, y: top, z: a.z }, { x: b.x, y: gy + riser, z: b.z }], 0.9, rails)
        }
      }
    }
    addMerged(group, deck, M.concrete, `structures-footbridge-${def.osmWay}`, shadows)
    facts.footbridges.push({ osmWay: def.osmWay, top, soffit, ends: [at2(0, 0), at2(span, 0)], headroom: soffit - (under === 'ground' ? groundMax : passMax - def.clearance), under, footprints })
  }
  if (!steps.empty) addMerged(group, [steps.build()], M.concrete, 'props-footbridge-steps', false)
  if (!parapets.empty) addMerged(group, [parapets.build()], M.concrete, 'props-footbridge-parapets', shadows)
  addMerged(group, rails, M.steel, 'props-footbridge-rails', false)
}

/** a handrail of height `h` along a polyline (the rail follows the points' y): posts every FOOTBRIDGE.railPitch, a top rail and a mid rail */
function railAlongH(pts: { x: number; y: number; z: number }[], h: number, rails: THREE.BufferGeometry[]) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 1e-6) continue
    const d = unit(b.x - a.x, b.z - a.z)
    const m = frameOf(a.x, a.y, a.z, d.x, d.z)
    const dy = b.y - a.y
    for (const hh of [h, h * 0.55]) {
      const r = new THREE.BoxGeometry(Math.hypot(len, dy), 0.04, 0.04).toNonIndexed()
      r.rotateZ(Math.atan2(dy, len))
      r.translate(len / 2, hh + dy / 2, 0)
      r.applyMatrix4(m)
      rails.push(r)
    }
    const nPosts = Math.max(2, Math.ceil(len / FOOTBRIDGE.railPitch) + 1)
    for (let k = 0; k < nPosts; k++) {
      const t = k / (nPosts - 1)
      rails.push(boxIn(RAIL_POST, h, RAIL_POST, m, len * t, dy * t, 0))
    }
  }
}
