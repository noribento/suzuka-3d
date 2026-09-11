import * as THREE from 'three'
import { enBBox, worldRing, type SurPolygon, type SurWay } from '~/data/en-codec'
import { SUR_FARMLAND, SUR_RAIL, SUR_STREAMS } from '~/data/suzuka-surroundings'
import { PADDY, RAIL, ROADS, STREAM, STREAM_WIDTH } from '~/data/surroundings-spec'
import type { EnvBuildContext, TerrainRing } from './environment'
import { cellClippedStrip, makeNodeCache, pointInRing, ringBBox, ringFromFlat, StripSink, type GridShape, type NodeCache, type StripInput, type XZ } from './far-geometry'
import { inGrid, resample, siteOk, TriSink, type Rect, type SiteRule } from './far-lines'
import { FAR_CELL_M, MERGE_CELLS } from './farfield'
import { COVER_COLOURS } from './landcover'
import { pbr, repeatMetres } from './materials'
import { nearestRoad, roadNetwork, type RoadNet } from './road-section'
import { waterRippleNormal } from './terrain-far'
import { cached, concreteMaps, makeTexture, mulberry, paint, scaled } from './textures'

/**
 * The terrain-side relief outside the fences (plan R フェーズ Phase 6): the paddies' levees and
 * ditches, the 伊勢鉄道 railway and the streams, all as thin ribbons draped on the terrain with
 * `cellClippedStrip` (far-geometry.ts) plus a few flat-shaded boxes (`TriSink`) where a ribbon
 * cannot stand in for the thing — the rails, the viaduct decks and piers. Before this the mask
 * painted a 3.3 m-texel bund line, a dark 4 m band for the railway and a blue band for a stream:
 * from the heli every one of them read as paint on a flat lawn.
 *
 *  - PADDIES (`paddy-b<n>`, `Quality.farField.paddyRelief`): the in-grid SUR_FARMLAND rings get
 *    a levee (畦, PADDY.levee: a 3-row ridge, crest + two feet) along the field boundary and along
 *    the 90 × 30 m 圃場整備 lattice rotated to the field's principal axis — the SAME lines the
 *    land-cover mask draws its bund texels on (`fieldAxis` below is landcover.ts's principal axis,
 *    duplicated so the two cannot drift), so the ridge sits on the mask's line — and a dark
 *    ditch band (用水路) just inside the boundary. A line is sampled every PADDY.levee.step and cut
 *    into runs where the sample is inside the ring, obeys the site rule and is off every road
 *    ribbon (a field polygon often runs down a farm track's centreline — the levee must not).
 *  - RAILWAY (`rail-b<n>` / `rail-ring-<k>`): the 44 SUR_RAIL pieces are chained by shared
 *    endpoints into continuous ways (the twin rows of the passing loop are two chains), sampled
 *    every RAIL.step in the grid and RAIL.ringStep on the ring, and given a LEVEL along the
 *    chain: the ground for a plain piece, the ground + RAIL.embankH for `layer=1`, and for a
 *    `bridge=yes` run a flat deck at the highest ground within ±60 m + the clearance (RAIL.viaduct
 *    .rise where a road passes under, else the embankment height — a girder over a stream simply
 *    continues the embankment), with the approaches ramped at APPROACH_GRADE so the line never
 *    steps. On that level: the ballast bed (a 4-row strip, crest RAIL.crest at +bedH with the
 *    shoulders down to the ground, `railBedTexture` with the sleepers painted), the earth
 *    embankment (two 2-row flank strips at 1:RAIL.slope), the concrete viaduct (slab sides and
 *    bottom, box piers every pierPitch, parapets — dropped on the side where the twin track's
 *    deck is) and two rails (TriSink boxes at ±gauge/2 on the crest). At a level crossing with a
 *    road of the network the bed is cut over hw + 2 m and the crest ramps down to the road
 *    ribbon's level, so the rails cross ON the ribbon instead of floating 35 cm over it.
 *  - STREAMS (`stream-b<n>` / `stream-ring-<k>`): every SUR_STREAMS way touching the ring rect;
 *    per sample the bank kind follows the land — concrete U-channel rims inside the settlements
 *    (the mask's settle weight ≥ STREAM.settleMin), earth berms in the fields, levees for a
 *    river — and the water is a 2-row strip STREAM.waterLift over the ground (the DEM carries no
 *    channel; sinking one would touch the grid, R11). Where a road crosses at grade, a stream's
 *    banks and water stop hw + crossingGap outside the paved edge (a culvert under the ribbon)
 *    and a river's levees open for it while its water runs on (a ford or an untagged bridge);
 *    under a road tagged `bridge` everything runs on. A bank whose feet would stand on a road
 *    — a canal along a farm track — is left out on that side. On the ring only the water (and
 *    the rivers' levees) is drawn, at the coarser step.
 *
 * Every family is a 'dressing' job per 1 km block (the blocks of roads.ts / road-section.ts
 * `blockOf`), the ring pieces one job per band, each registering ONE static entry (a Group of
 * the block's meshes) — the entries budget is the tightest of the static budgets. The rail's
 * and the streams' keep-outs are pushed synchronously (the forest stage runs before dressing).
 * Heights come from `ground.standY` / `ground.builtY` / `ground.plan.project` only (R3); on the
 * ring the strips drape on the ring's own triangles (`drape: 'nodes'`) and the boxes read the
 * same planes (`ringPlaneY`) — `standY` is bilinear there. Nothing here uses `ctx.boxes` or the
 * asset pack: the low tier and the Node harness build exactly the same geometry (minus the
 * paddies, which the tier flag turns off).
 */

// ---------------------------------------------------------------------------------------------
// statistics

export interface TerrainSideStats {
  paddy: { fields: number; leveeM: number; ditchM: number; triangles: number }
  rail: { ways: number; m: number; viaducts: number; crossings: number; triangles: number }
  stream: { ways: number; m: number; rimM: number; bermM: number; crossings: number; triangles: number }
  /** block and ring jobs queued */
  blocks: number
  /** keep-out quads pushed into ctx.keepOutPolys (rail + streams, in the grid) */
  keepOuts: number
  /** per job: the triangles it poured (wall-clock is farField.stats().buildMs) */
  jobs: Record<string, { triangles: number }>
}

// ---------------------------------------------------------------------------------------------
// tuning that is not a design number (those live in surroundings-spec PADDY / RAIL / STREAM)

/** the rows that meet the ground stand this far over it (m): the forest floor's argument, a constant lift over vertices on the terrain's own planes */
const GROUND_LIFT = 0.05
/** a bridge approach cannot fall faster than this from the deck level (rise / run) — 1:12, steep for rail but short enough to read from 1 km */
const APPROACH_GRADE = 1 / 12
/** the ground under a deck is searched this far (m of arc) beyond the run for the deck level */
const DECK_REACH_M = 60
/** the bed's crest ramps down to the road level over this length (m) before a level crossing */
const CROSSING_RAMP_M = 10
/** the crest's lift at a level crossing: over the road ribbon's highest class rung (0.024) plus a 5 m half-width's crown (0.075) by more than LAYER_MIN_STEP */
const RAIL_ON_ROAD = ROADS.lift + 0.11
/** the bed is cut this far outside a crossing road's paved edge (m) */
const CROSSING_CUT_M = 2
/** the rail's keep-out half-width (m): bed / 2 + a 1.6 m embankment's flank + a tree's clearance */
const RAIL_KEEP_OUT = 6.7
/** a stream's keep-out reaches this far beyond its half-width (m) */
const STREAM_KEEP_OUT = 2
/** a road crossing is one whose tangent makes at least asin(this) with the way — a canal along a road is not a crossing */
const CROSSING_SIN = 0.35
/** the widest road half-width the crossing / on-road tests search (m) */
const ROAD_SEARCH_M = 12
/** a levee or bank centreline keeps this far outside a road's paved edge (m) */
const ROAD_CLEAR_M = 0.5
/** a bank blocked by a road at a sample is left out this many samples either way too: beside a weaving farm track it would otherwise dash on and off */
const BANK_DILATE = 2
/** the sample-pair pre-reject pad beyond the row half-width (m), ≥ the longest quad (RAIL.ringStep) */
const WINDOW_PAD_M = 20
/** an embankment flank is drawn from this height (m); under it the bed's shoulders are the whole profile */
const EMBANK_MIN = 0.15
/** the flank's minimum width (m) so a low embankment's quads never degenerate */
const FLANK_MIN = 0.3
/** the rim's vertical faces are this wide in XZ (m): the strip clips in XZ, a true vertical would be a zero-area quad */
const RIM_FACE_M = 0.03
/** sleepers per RAIL.tile of ballast texture (7 per 4 m = 0.57 m pitch, the JR narrow-gauge spacing) */
const SLEEPERS_PER_TILE = 7
/** a pier's footing reaches this far under the ground (m) */
const PIER_BURY = 0.3
/** a twin track (the other chain of a double-track stretch) within this lateral distance (m) suppresses the parapet on that side */
const TWIN_M = 6
/** the concrete tile (textures.ts concreteMaps) is 4 m; the boxes' uv is in metres */
const CONCRETE_TILE_M = 4
/** the ripple normal (terrain-far.ts waterRippleNormal) tiles every 4 m; the water strip's uv is world metres */
const RIPPLE_TILE_M = 4
/** a lattice run's end is bisected onto the field boundary to this precision (m) */
const RUN_END_EPS = 0.1

type Rect4 = [number, number, number, number]

/** one sample of a way: position, unit tangent, arc length, the piece it lies on and the centreline-distance lower bound */
interface WaySample {
  x: number
  z: number
  tx: number
  tz: number
  t: number
  piece: number
  /** the piece's `dmin` minus the distance to the edge's nearer vertex (distance to the centreline is 1-Lipschitz) */
  lo: number
}

function inRect(x: number, z: number, r: Rect4, pad: number): boolean {
  return x >= r[0] - pad && x < r[2] + pad && z >= r[1] - pad && z < r[3] + pad
}

function overlaps(b: readonly [number, number, number, number], r: Rect4, pad: number): boolean {
  return b[2] + pad > r[0] && b[0] - pad < r[2] && b[3] + pad > r[1] && b[1] - pad < r[3]
}

/** the point `lateral` metres to the left of travel of a sample: the road-section convention (tz, −tx) */
function offset(s: { x: number; z: number; tx: number; tz: number }, lateral: number): XZ {
  return [s.x + s.tz * lateral, s.z - s.tx * lateral]
}

/** the way's vertices in world XZ with zero-length edges removed */
function wayPoints(row: SurWay | SurPolygon, enScale: number): XZ[] {
  const raw = ringFromFlat(worldRing(row, enScale))
  const out: XZ[] = []
  for (const p of raw) {
    const q = out[out.length - 1]
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3) continue
    out.push(p)
  }
  return out
}

/** the EN bbox of a row as a world rectangle (EN → world flips north) */
function worldBox(row: SurWay | SurPolygon, enScale: number): Rect4 {
  const [e0, n0, e1, n1] = enBBox(row)
  return [e0 * enScale, -n1 * enScale, e1 * enScale, -n0 * enScale]
}

/**
 * Samples along a polyline at a pitch that may change along it (`stepOf` at the sample just
 * placed: RAIL.step inside the grid, RAIL.ringStep on the ring), both end vertices included so
 * consecutive pieces of one line meet without a gap — `resample` of far-lines.ts stops short
 * of the end by up to a step, which is fine for a fence and a hole in a railway.
 */
function walkWay(pts: readonly XZ[], edgePiece: readonly number[], dminOf: (piece: number) => number, stepOf: (x: number, z: number) => number): WaySample[] {
  const n = pts.length
  if (n < 2) return []
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
  const total = cum[n - 1]!
  if (total < 1e-3) return []
  const out: WaySample[] = []
  let e = 0
  const at = (t: number): WaySample => {
    while (e < n - 2 && cum[e + 1]! <= t) e++
    const a = pts[e]!, b = pts[e + 1]!
    const len = cum[e + 1]! - cum[e]!
    const u = len > 0 ? Math.max(0, Math.min(1, (t - cum[e]!) / len)) : 0
    const tx = len > 0 ? (b[0] - a[0]) / len : 1, tz = len > 0 ? (b[1] - a[1]) / len : 0
    const piece = edgePiece[e] ?? 0
    return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, tx, tz, t, piece, lo: dminOf(piece) - Math.min(u, 1 - u) * len }
  }
  let t = 0
  for (;;) {
    const s = at(t)
    out.push(s)
    const step = stepOf(s.x, s.z)
    // the last regular sample keeps at least a third of a step from the end sample
    if (t + step >= total - 0.35 * step) break
    t += step
  }
  out.push(at(total))
  return out
}

/**
 * The ring mesh's height at (x, z): the coarse ring is meshed on the b–c diagonal (terrain-far.ts)
 * while `ground.standY` is bilinear there — for a box standing on a ring-draped strip the
 * difference is decimetres in the hills, so the boxes read the same planes the strips do
 * (`drape: 'nodes'`). Clamped to the ring's outer edge like standY.
 */
function ringPlaneY(r: TerrainRing, x: number, z: number): number {
  const cx = r.nx - 1, cz = r.nz - 1
  const fu = Math.min(cx, Math.max(0, (x - r.x0) / r.dx))
  const fv = Math.min(cz, Math.max(0, (z - r.z0) / r.dz))
  const i = Math.min(cx - 1, Math.floor(fu)), j = Math.min(cz - 1, Math.floor(fv))
  const u = fu - i, v = fv - j
  const k = j * r.nx + i
  const H = r.heights
  const a = H[k]!, b = H[k + 1]!, c = H[k + r.nx]!, e = H[k + r.nx + 1]!
  if (u + v <= 1) return a + u * (b - a) + v * (c - a)
  return e + (1 - u) * (c - e) + (1 - v) * (b - e)
}

/** the principal axis of a field — landcover.ts `principalAxis` (second moments of area), duplicated so the levees lie on the mask's bund lines */
function fieldAxis(ring: readonly XZ[]): { cx: number; cz: number; cos: number; sin: number } {
  const n = ring.length
  let a2 = 0, cx = 0, cz = 0
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    const c = p[0] * q[1] - q[0] * p[1]
    a2 += c
    cx += (p[0] + q[0]) * c
    cz += (p[1] + q[1]) * c
  }
  if (Math.abs(a2) < 1e-6) {
    let mx = 0, mz = 0
    for (const [x, z] of ring) {
      mx += x
      mz += z
    }
    return { cx: mx / n, cz: mz / n, cos: 1, sin: 0 }
  }
  cx /= 3 * a2
  cz /= 3 * a2
  let ixx = 0, izz = 0, ixz = 0
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    const x0 = p[0] - cx, z0 = p[1] - cz, x1 = q[0] - cx, z1 = q[1] - cz
    const c = x0 * z1 - x1 * z0
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c
    izz += (z0 * z0 + z0 * z1 + z1 * z1) * c
    ixz += (x0 * z1 + 2 * x0 * z0 + 2 * x1 * z1 + x1 * z0) * c
  }
  const theta = 0.5 * Math.atan2(2 * ixz, ixx - izz)
  return { cx, cz, cos: Math.cos(theta), sin: Math.sin(theta) }
}

/** signed shoelace area: > 0 when the interior lies to the (−tz, tx) side of every edge */
function signedArea(ring: readonly XZ[]): number {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** distance from (x, z) to the nearest vertex of a ring (the 1-Lipschitz bound's radius for a field's samples) */
function nearestVertex(x: number, z: number, ring: readonly XZ[]): number {
  let best = Infinity
  for (const [px, pz] of ring) {
    const d = (px - x) * (px - x) + (pz - z) * (pz - z)
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

// ---------------------------------------------------------------------------------------------
// materials

interface Materials {
  bund: THREE.MeshStandardMaterial
  ditch: THREE.MeshStandardMaterial
  ballast: THREE.MeshStandardMaterial
  embank: THREE.MeshStandardMaterial
  rail: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  water: THREE.MeshStandardMaterial
}

/**
 * The ballast bed, 256²: grey crushed-stone noise with the sleepers as dark bars across the
 * crest, SLEEPERS_PER_TILE per RAIL.tile along (u) and the bed width across (v — the crest is
 * the middle RAIL.crest / RAIL.bed of it, the shoulders the rest). In the style of textures.ts:
 * periodic value noise on a small lattice, so the tile wraps.
 */
function railBedTexture(): THREE.Texture {
  const [w, h] = scaled(256, 256)
  return cached(`rail-bed-${w}`, () => {
    const rng = mulberry(61)
    const N = 32
    const lattice = new Float32Array(N * N)
    for (let i = 0; i < N * N; i++) lattice[i] = rng()
    const noise = (u: number, v: number, f: number): number => {
      const x = u * f, y = v * f
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const fx = x - x0, fy = y - y0
      const at = (i: number, j: number) => lattice[(((j % N) + N) % N) * N + (((i % N) + N) % N)]!
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1)
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
    }
    const crest0 = (RAIL.bed - RAIL.crest) / 2 / RAIL.bed, crest1 = 1 - crest0
    // a JR narrow-gauge sleeper is 2.1 m long, 0.2 m wide
    const sleeperV = 2.1 / 2 / RAIL.bed, sleeperU = 0.2 / RAIL.tile
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      const stone = noise(u, v, 32) * 0.55 + noise(u, v, 16) * 0.3 + noise(u, v, 8) * 0.15
      const speck = (noise(u + 0.37, v + 0.11, N) - 0.5) * 0.5
      let g = 118 + (stone - 0.5) * 70 + speck * 40
      // the shoulders are a little darker and browner: weathered stone and the soil showing through
      const onCrest = v >= crest0 && v <= crest1
      let r = g + 2, b = g - 4
      if (!onCrest) {
        r = g * 0.9 + 6
        g = g * 0.86
        b = b * 0.8
      }
      // the sleepers: dark bars across the crest, every RAIL.tile / SLEEPERS_PER_TILE along
      const phase = (u * SLEEPERS_PER_TILE) % 1
      const bar = Math.min(phase, 1 - phase) < (sleeperU * SLEEPERS_PER_TILE) / 2
      if (bar && Math.abs(v - 0.5) < sleeperV) {
        const wood = 0.9 + (noise(u * 3, v * 5, 24) - 0.5) * 0.3
        r = 78 * wood
        g = 70 * wood
        b = 60 * wood
      }
      out[0] = r
      out[1] = g
      out[2] = b
    })
    return makeTexture(c)
  })
}

function makeMaterials(): Materials {
  const maps = concreteMaps()
  const world: readonly [number, number] = [1, 1]
  const concrete = pbr({
    map: repeatMetres(maps.map.clone(), CONCRETE_TILE_M, world),
    normalMap: maps.normalMap && repeatMetres(maps.normalMap.clone(), CONCRETE_TILE_M, world),
    roughnessMap: maps.roughnessMap && repeatMetres(maps.roughnessMap.clone(), CONCRETE_TILE_M, world),
  }, { roughness: 0.9, color: 0xc9c7c0 }, 0.6)
  const ripple = repeatMetres(waterRippleNormal().clone(), RIPPLE_TILE_M, world)
  ripple.needsUpdate = true
  const water = new THREE.MeshStandardMaterial({ color: 0x2b3a36, roughness: 0.2, metalness: 0, normalMap: ripple })
  water.normalScale.set(0.25, 0.25)
  return {
    bund: new THREE.MeshStandardMaterial({ color: COVER_COLOURS.bund, roughness: 1, metalness: 0 }),
    ditch: new THREE.MeshStandardMaterial({ color: 0x2a2c28, roughness: 0.4, metalness: 0 }),
    ballast: new THREE.MeshStandardMaterial({ map: railBedTexture(), roughness: 0.95, metalness: 0 }),
    embank: new THREE.MeshStandardMaterial({ color: 0x8a8266, roughness: 1, metalness: 0 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.45, metalness: 0.7 }),
    concrete,
    water,
  }
}

/** a mesh of a job: no shadow (the far field trims its casters to what a cascade resolves, C5), receives, tagged for the harness */
function meshOf(geo: THREE.BufferGeometry, material: THREE.Material, name: string, tag: Record<string, unknown>): THREE.Mesh {
  const m = new THREE.Mesh(geo, material)
  m.name = name
  m.castShadow = false
  m.receiveShadow = true
  m.userData.terrainSide = tag
  return m
}

// ---------------------------------------------------------------------------------------------
// the railway

interface RailPiece {
  row: SurWay
  pts: XZ[]
  bridge: boolean
  embank: boolean
}

interface RailChain {
  pts: XZ[]
  /** piece index (into `pieces`) per edge */
  edgePiece: number[]
  samples: WaySample[]
  bbox: Rect4
  length: number
}

/**
 * The per-sample profile of one chain, computed once (in the first job that needs it): the
 * ground, the level the rail bed stands on, the crest's lift, the deck runs, the level
 * crossings and the site rule.
 */
interface RailProfile {
  /** the ground at the sample (standY in the grid, the ring's plane outside) */
  g: Float64Array
  /** the absolute level of the formation (the bed's outer rows sit GROUND_LIFT over it, the crest bedH) */
  level: Float64Array
  /** level − ground: the embankment height; 0 on plain track */
  base: Float64Array
  /** the crest's lift over the drape (base + bedH, ramped down to RAIL_ON_ROAD at a level crossing) */
  crest: Float64Array
  bridge: Uint8Array
  /** the bed is cut here (a road crosses within hw + CROSSING_CUT_M) */
  cut: Uint8Array
  /** the site rule at the sample (the rails and boxes; the strip applies its own per quad) */
  ok: Uint8Array
  /** a twin chain's track within TWIN_M on the left / right of the sample */
  twinL: Uint8Array
  twinR: Uint8Array
  runs: { i0: number; i1: number; y: number; road: boolean }[]
  crossings: number
}

/**
 * Chain the SUR_RAIL pieces by shared endpoints (a 5 cm hash — the generator keeps the shared
 * nodes through its simplification) into continuous polylines: a piece is joined to the one
 * other piece that ends at its endpoint; where three or more meet (a switch), or where nothing
 * does, the chain ends. The twin rows of a double-track stretch never share a vertex, so they
 * come out as two chains.
 */
function chainPieces(pieces: RailPiece[]): { pts: XZ[]; edgePiece: number[] }[] {
  const key = (p: XZ) => `${Math.round(p[0] / 0.05)},${Math.round(p[1] / 0.05)}`
  const atEnd = new Map<string, number[]>()
  pieces.forEach((pc, i) => {
    for (const p of [pc.pts[0]!, pc.pts[pc.pts.length - 1]!]) {
      const k = key(p)
      let l = atEnd.get(k)
      if (!l) atEnd.set(k, (l = []))
      l.push(i)
    }
  })
  const used = new Uint8Array(pieces.length)
  const other = (k: string, self: number): number => {
    const l = atEnd.get(k)
    if (!l || l.length !== 2) return -1
    const o = l[0] === self ? l[1]! : l[0]!
    return used[o] ? -1 : o
  }
  const chains: { pts: XZ[]; edgePiece: number[] }[] = []
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const order: { p: number; rev: boolean }[] = [{ p: i, rev: false }]
    let cur = i
    let endKey = key(pieces[i]!.pts[pieces[i]!.pts.length - 1]!)
    for (;;) {
      const o = other(endKey, cur)
      if (o < 0) break
      used[o] = 1
      const op = pieces[o]!.pts
      const rev = key(op[op.length - 1]!) === endKey
      order.push({ p: o, rev })
      endKey = key(rev ? op[0]! : op[op.length - 1]!)
      cur = o
    }
    cur = i
    let startKey = key(pieces[i]!.pts[0]!)
    for (;;) {
      const o = other(startKey, cur)
      if (o < 0) break
      used[o] = 1
      const op = pieces[o]!.pts
      const rev = key(op[0]!) === startKey
      order.unshift({ p: o, rev })
      startKey = key(rev ? op[op.length - 1]! : op[0]!)
      cur = o
    }
    const pts: XZ[] = [], edgePiece: number[] = []
    for (const { p, rev } of order) {
      const src = rev ? [...pieces[p]!.pts].reverse() : pieces[p]!.pts
      for (let k = 0; k < src.length; k++) {
        if (k === 0 && pts.length) continue
        pts.push(src[k]!)
        if (pts.length > 1) edgePiece.push(p)
      }
    }
    if (pts.length >= 2) chains.push({ pts, edgePiece })
  }
  return chains
}

// ---------------------------------------------------------------------------------------------
// the streams

interface StreamWay {
  row: SurWay
  river: boolean
  width: number
  samples: WaySample[]
  bbox: Rect4
  length: number
}

/** bank kinds per sample */
const BANK_BERM = 0, BANK_RIM = 1, BANK_LEVEE = 2

/** per-side bits of `StreamProfile.bank` / `mid`: the bank on the left / right of travel */
const SIDE_L = 1, SIDE_R = 2

interface StreamProfile {
  kind: Uint8Array
  /** the water strip's width at the sample (m) */
  wW: Float64Array
  /** the water is cut here: a road at grade crosses a stream (a culvert); a river runs on under the ribbon */
  cut: Uint8Array
  /** the banks are cut here: a road at grade crosses (a stream's culvert, the ramp over a river's levee) */
  cutBank: Uint8Array
  ok: Uint8Array
  /**
   * SIDE_L / SIDE_R bits: a bank may stand on that side at the sample — its feet are off every
   * road there and within BANK_DILATE samples either way (a canal along a farm track keeps the
   * bank on its far side only, and keeps it continuous)
   */
  bank: Uint8Array
  /** the same bits inside quad i, at its quarter points (a road converging on a canal at under CROSSING_SIN is never a crossing, and one crossing a ring quad obliquely can miss both corners) */
  mid: Uint8Array
  crossings: number
}

// ---------------------------------------------------------------------------------------------
// the paddies

interface Field {
  row: SurPolygon
  ring: XZ[]
  bbox: Rect4
}

/** one run of a bund line: samples with tangents, and whether it closes on itself */
interface Run {
  pts: { x: number; z: number; tx: number; tz: number }[]
  length: number
}

interface FieldPlan {
  levees: Run[]
  ditches: Run[]
  leveeM: number
  ditchM: number
}

// ---------------------------------------------------------------------------------------------

/**
 * Plan the terrain-side relief: decode the rows, chain the railway, push the keep-outs (now)
 * and queue one 'dressing' job per 1 km block per family plus the ring jobs. Returns the
 * statistics the jobs fill in; they are also on `ctx.farField.group.userData.terrainSide`.
 */
export function buildTerrainSide(ctx: EnvBuildContext): TerrainSideStats {
  const { track, terrain, ground, quality: q, farField, landCover } = ctx
  const plan = ground.plan
  const enScale = track.enScale
  const stats: TerrainSideStats = {
    paddy: { fields: 0, leveeM: 0, ditchM: 0, triangles: 0 },
    rail: { ways: 0, m: 0, viaducts: 0, crossings: 0, triangles: 0 },
    stream: { ways: 0, m: 0, rimM: 0, bermM: 0, crossings: 0, triangles: 0 },
    blocks: 0, keepOuts: 0, jobs: {},
  }
  farField.group.userData.terrainSide = stats

  const grid = terrain.grid()
  const gridRect: Rect4 = [grid.x0, grid.z0, grid.x0 + grid.w, grid.z0 + grid.d]
  const ring = terrain.ring
  const ringShape: GridShape = { x0: ring.x0, z0: ring.z0, dx: ring.dx, dz: ring.dz, nx: ring.nx - 1, nz: ring.nz - 1, w: (ring.nx - 1) * ring.dx, d: (ring.nz - 1) * ring.dz }
  const ringRect: Rect = { x0: ringShape.x0, z0: ringShape.z0, w: ringShape.w, d: ringShape.d }
  const ringRect4: Rect4 = [ringRect.x0, ringRect.z0, ringRect.x0 + ringRect.w, ringRect.z0 + ringRect.d]
  const rule: SiteRule = { ground, grid, projections: 0 }
  const net: RoadNet = roadNetwork(ctx)
  const cache: NodeCache = makeNodeCache(grid)
  const ringCache: NodeCache = makeNodeCache(ringShape)
  const ringNodeY = (i: number, j: number) => ring.heights[j * ring.nx + i]!
  /** the ground a box stands on: the settled mesh in the grid, the ring's own planes outside */
  const drapeY = (x: number, z: number): number => (inGrid(grid, x, z) ? ground.standY(x, z) : ringPlaneY(ring, x, z))
  const mats = makeMaterials()

  /**
   * The nearest road at (x, z) whose tangent crosses (tx, tz) — a canal along a road is no
   * crossing — within `reach` of its paved edge; null when none. `atGrade` excludes bridge ways:
   * a road bridge passes OVER the stream or the railway, so nothing under it is cut.
   */
  const crossingRoad = (x: number, z: number, tx: number, tz: number, reach: number, atGrade = false, minSin = CROSSING_SIN) => {
    const r = nearestRoad(net, x, z, ROAD_SEARCH_M + reach)
    if (!r || r.d > r.way.hw + reach) return null
    if (Math.abs(tx * r.tz - tz * r.tx) < minSin) return null
    if (atGrade && r.way.bridge) return null
    return r
  }
  /** on no road ribbon's asphalt (+ ROAD_CLEAR_M) */
  const roadFree = (x: number, z: number): boolean => {
    const r = nearestRoad(net, x, z, ROAD_SEARCH_M)
    return !r || r.d >= r.way.hw + ROAD_CLEAR_M
  }

  // --- the blocks, as roads.ts / road-section.ts blockOf lay them out --------------------------
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M)), ncz = Math.max(1, Math.ceil(grid.d / FAR_CELL_M))
  const blockCols = Math.ceil(ncx / MERGE_CELLS), blockRows = Math.ceil(ncz / MERGE_CELLS)
  const blocks: { b: number; window: Rect4 }[] = []
  for (let bz = 0; bz < blockRows; bz++) {
    for (let bx = 0; bx < blockCols; bx++) {
      const x0 = grid.x0 + bx * MERGE_CELLS * FAR_CELL_M, z0 = grid.z0 + bz * MERGE_CELLS * FAR_CELL_M
      blocks.push({ b: bx + bz * blockCols, window: [x0, z0, Math.min(x0 + MERGE_CELLS * FAR_CELL_M, gridRect[2]), Math.min(z0 + MERGE_CELLS * FAR_CELL_M, gridRect[3])] })
    }
  }
  /** the four bands around the inner rectangle partition the ring's cells (cell centres decide) */
  const bands: Record<string, Rect4> = {
    n: [ringRect4[0], ringRect4[1], ringRect4[2], gridRect[1]],
    s: [ringRect4[0], gridRect[3], ringRect4[2], ringRect4[3]],
    w: [ringRect4[0], gridRect[1], gridRect[0], gridRect[3]],
    e: [gridRect[2], gridRect[1], ringRect4[2], gridRect[3]],
  }

  const pushKeepOut = (a: WaySample, b: WaySample, half: number) => {
    if (!inRect((a.x + b.x) / 2, (a.z + b.z) / 2, gridRect, WINDOW_PAD_M)) return
    const ringQ: XZ[] = [offset(a, half), offset(b, half), offset(b, -half), offset(a, -half)]
    ctx.keepOutPolys.push({ ring: ringQ, box: ringBBox(ringQ) })
    stats.keepOuts++
  }

  const tally = (name: string, tris: number, family: 'paddy' | 'rail' | 'stream') => {
    stats.jobs[name] = { triangles: tris }
    stats[family].triangles += tris
  }

  // =============================================================================================
  // RAILWAY
  // =============================================================================================
  const pieces: RailPiece[] = []
  for (const row of SUR_RAIL) {
    if (!overlaps(worldBox(row, enScale), ringRect4, RAIL.bed)) continue
    const pts = wayPoints(row, enScale)
    if (pts.length < 2) continue
    const bridgeTag = row.tags.bridge
    pieces.push({ row, pts, bridge: bridgeTag !== undefined && bridgeTag !== 'no', embank: (parseInt(row.tags.layer ?? '', 10) || 0) >= 1 })
  }
  const chains: RailChain[] = chainPieces(pieces).map((c): RailChain => {
    const samples = walkWay(c.pts, c.edgePiece, (p) => pieces[p]!.row.dmin, (x, z) => (inGrid(grid, x, z) ? RAIL.step : RAIL.ringStep))
    return { pts: c.pts, edgePiece: c.edgePiece, samples, bbox: ringBBox(c.pts), length: samples.length ? samples[samples.length - 1]!.t : 0 }
  }).filter((c) => c.samples.length >= 2)
  stats.rail.ways = chains.length
  for (const c of chains) {
    stats.rail.m += c.length
    for (let i = 0; i < c.samples.length - 1; i++) pushKeepOut(c.samples[i]!, c.samples[i + 1]!, RAIL_KEEP_OUT)
  }
  /** every chain's samples hashed by 20 m tile, for the twin-track test */
  const railTiles = new Map<number, { c: number; i: number }[]>()
  const tileKey = (x: number, z: number) => (Math.floor(x / 20) + 0x8000) * 0x10000 + (Math.floor(z / 20) + 0x8000)
  chains.forEach((c, ci) => {
    c.samples.forEach((s, i) => {
      const k = tileKey(s.x, s.z)
      let l = railTiles.get(k)
      if (!l) railTiles.set(k, (l = []))
      l.push({ c: ci, i })
    })
  })
  const twinSide = (ci: number, s: WaySample): number => {
    let side = 0, best = TWIN_M
    const i0 = Math.floor((s.x - TWIN_M) / 20), i1 = Math.floor((s.x + TWIN_M) / 20)
    const j0 = Math.floor((s.z - TWIN_M) / 20), j1 = Math.floor((s.z + TWIN_M) / 20)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = railTiles.get((i + 0x8000) * 0x10000 + (j + 0x8000))
      if (!l) continue
      for (const e of l) {
        if (e.c === ci) continue
        const o = chains[e.c]!.samples[e.i]!
        const dx = o.x - s.x, dz = o.z - s.z
        // the lateral (left-of-travel) component of the other sample's offset, and its along component (a twin runs beside, not ahead)
        const lat = dx * s.tz - dz * s.tx, along = dx * s.tx + dz * s.tz
        if (Math.abs(lat) < best && Math.abs(along) < RAIL.ringStep) {
          best = Math.abs(lat)
          side = lat > 0 ? 1 : -1
        }
      }
    }
    return side
  }

  const profiles = new Map<number, RailProfile>()
  const railProfile = (ci: number): RailProfile => {
    let p = profiles.get(ci)
    if (p) return p
    const c = chains[ci]!
    const sm = c.samples
    const n = sm.length
    const g = new Float64Array(n), level = new Float64Array(n), base = new Float64Array(n), crest = new Float64Array(n)
    const bridge = new Uint8Array(n), cut = new Uint8Array(n), ok = new Uint8Array(n), twinL = new Uint8Array(n), twinR = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const s = sm[i]!
      g[i] = drapeY(s.x, s.z)
      bridge[i] = pieces[s.piece]!.bridge ? 1 : 0
      level[i] = g[i]! + (pieces[s.piece]!.embank && !bridge[i] ? RAIL.embankH : 0)
      ok[i] = siteOk(rule, s.x, s.z, s.lo - RAIL.bed / 2, RAIL.minD, ringRect) ? 1 : 0
      const tw = twinSide(ci, s)
      if (tw > 0) twinL[i] = 1
      else if (tw < 0) twinR[i] = 1
    }
    // the deck runs: flat at the highest ground within DECK_REACH_M of the run + the clearance
    const runs: RailProfile['runs'] = []
    for (let i = 0; i < n; i++) {
      if (!bridge[i]) continue
      let i1 = i
      while (i1 + 1 < n && bridge[i1 + 1]) i1++
      const t0 = sm[i]!.t - DECK_REACH_M, t1 = sm[i1]!.t + DECK_REACH_M
      let hi = -Infinity, road = false
      for (let j = 0; j < n; j++) if (sm[j]!.t >= t0 && sm[j]!.t <= t1 && g[j]! > hi) hi = g[j]!
      // any road under the deck — crossing or running along under it — wants the clearance
      for (let j = i; j <= i1 && !road; j++) {
        const s = sm[j]!
        if (crossingRoad(s.x, s.z, s.tx, s.tz, RAIL.viaduct.deckW, false, 0)) road = true
      }
      const y = hi + (road ? RAIL.viaduct.rise : RAIL.embankH)
      for (let j = i; j <= i1; j++) level[j] = y
      runs.push({ i0: i, i1, y, road })
      i = i1
    }
    // the approaches: nothing falls faster than APPROACH_GRADE from a deck's level
    for (const r of runs) {
      for (let j = r.i0 - 1; j >= 0 && !bridge[j]; j--) {
        const want = r.y - (sm[r.i0]!.t - sm[j]!.t) * APPROACH_GRADE
        if (want <= level[j]!) break
        level[j] = want
      }
      for (let j = r.i1 + 1; j < n && !bridge[j]; j++) {
        const want = r.y - (sm[j]!.t - sm[r.i1]!.t) * APPROACH_GRADE
        if (want <= level[j]!) break
        level[j] = want
      }
    }
    for (let i = 0; i < n; i++) base[i] = Math.max(0, level[i]! - g[i]!)
    // level crossings: the bed is cut, the crest ramps down to the ribbon over CROSSING_RAMP_M
    let crossings = 0
    for (let i = 0; i < n; i++) {
      const s = sm[i]!
      if (!bridge[i] && crossingRoad(s.x, s.z, s.tx, s.tz, CROSSING_CUT_M, true)) {
        cut[i] = 1
        if (!cut[i - 1]) crossings++
      }
    }
    for (let i = 0; i < n; i++) {
      const s = sm[i]!
      crest[i] = base[i]! + RAIL.bedH
      if (bridge[i]) continue
      // the arc distance to the nearest cut sample either way, within the ramp's reach
      let d = Infinity
      const reachT = CROSSING_RAMP_M + RAIL.ringStep + 1
      for (let j = i; j >= 0 && sm[i]!.t - sm[j]!.t <= reachT; j--) if (cut[j]) { d = sm[i]!.t - sm[j]!.t; break }
      for (let j = i; j < n && sm[j]!.t - sm[i]!.t <= reachT; j++) if (cut[j]) { d = Math.min(d, sm[j]!.t - sm[i]!.t); break }
      if (d === Infinity) continue
      // the first uncut sample sits at the road level, the ramp climbs from there
      const near = Math.max(0, d - (inGrid(grid, s.x, s.z) ? RAIL.step : RAIL.ringStep))
      const k = 1 - Math.min(1, near / CROSSING_RAMP_M)
      crest[i] = crest[i]! + (RAIL_ON_ROAD - crest[i]!) * k
    }
    p = { g, level, base, crest, bridge, cut, ok, twinL, twinR, runs, crossings }
    profiles.set(ci, p)
    stats.rail.viaducts += runs.length
    stats.rail.crossings += crossings
    return p
  }

  /**
   * One chain's geometry into the job's sinks: the bed strip, the flank strips, the rails and
   * the viaduct boxes, restricted to `scope` (the block window with the cells inside it, or a
   * ring band with the grid as a hole) and draped as the scope says.
   */
  const pourRail = (ci: number, sinks: { bed: StripSink; embank: StripSink; rails: TriSink; concrete: TriSink }, scope: { window: Rect4; hole: Rect4 | null; ringSide: boolean }, key: number): number => {
    const c = chains[ci]!
    const sm = c.samples
    const n = sm.length
    const pr = railProfile(ci)
    const pad = RAIL.bed / 2 + RAIL.embankH * RAIL.slope + WINDOW_PAD_M
    const inScope = (x: number, z: number): boolean => inRect(x, z, scope.window, 0) && !(scope.hole && inRect(x, z, scope.hole, 0))
    const reach = (i: number): boolean => inRect(sm[i]!.x, sm[i]!.z, scope.window, pad) && !(scope.hole && inRect(sm[i]!.x, sm[i]!.z, scope.hole, -pad))
    const clip = scope.ringSide
      ? { grid: ringShape, drape: 'nodes' as const, nodeY: ringNodeY, ground, plan, minD: RAIL.minD, window: scope.window, hole: scope.hole!, cache: ringCache }
      : { grid, drape: 'mesh' as const, ground, plan, minD: RAIL.minD, window: scope.window, cache }
    let tris = 0

    // --- the ballast bed: 4 rows, crest at +crest, the shoulders down to GROUND_LIFT --------------
    const L = [-RAIL.bed / 2, -RAIL.crest / 2, RAIL.crest / 2, RAIL.bed / 2]
    const bedRows: XZ[][] = L.map((lat) => sm.map((s) => offset(s, lat)))
    const outer = (r: number) => r === 0 || r === 3
    const bed: StripInput = {
      rows: bedRows,
      lift: (r, i) => (outer(r) ? pr.base[i]! + GROUND_LIFT : pr.crest[i]!),
      rigidY: (r, i) => (pr.bridge[i] ? pr.level[i]! + (outer(r) ? GROUND_LIFT : RAIL.bedH) : NaN),
      attr: (r, i, out) => {
        out[0] = sm[i]!.t / RAIL.tile
        out[1] = (L[r]! + RAIL.bed / 2) / RAIL.bed
      },
      okAt: (i) => !pr.cut[i] && !pr.cut[i + 1] && reach(i) && reach(i + 1),
      dLo: (i) => sm[i]!.lo,
    }
    sinks.bed.begin(key)
    tris += cellClippedStrip(sinks.bed, bed, clip).triangles

    // --- the embankment flanks: two 2-row strips at 1:slope, where the base is worth a flank ------
    const flankW = (i: number) => Math.max(FLANK_MIN, pr.base[i]! * RAIL.slope)
    for (const side of [-1, 1] as const) {
      // rows [outer foot, inner crest edge]; the strip winds every triangle to face +Y whatever the row order
      const flank: StripInput = {
        rows: [sm.map((s, i) => offset(s, side * (RAIL.bed / 2 + flankW(i)))), sm.map((s) => offset(s, side * RAIL.bed / 2))],
        lift: (r, i) => (r === 0 ? GROUND_LIFT : pr.base[i]! + GROUND_LIFT),
        attr: () => {},
        okAt: (i) => !pr.bridge[i] && !pr.bridge[i + 1] && (pr.base[i]! > EMBANK_MIN || pr.base[i + 1]! > EMBANK_MIN) && reach(i) && reach(i + 1),
        dLo: (i) => sm[i]!.lo,
      }
      sinks.embank.begin(key * 4 + (side > 0 ? 1 : 2))
      tris += cellClippedStrip(sinks.embank, flank, clip).triangles
    }

    // --- the rails: a box (top + two sides) per sample pair at ±gauge/2 on the crest ---------------
    const { w: rw, h: rh } = RAIL.rail
    const railY = (i: number, lat: number): number => {
      const s = sm[i]!
      if (pr.bridge[i]) return pr.level[i]! + RAIL.bedH
      const p = offset(s, lat)
      return drapeY(p[0], p[1]) + pr.crest[i]!
    }
    const before = sinks.rails.triangles
    for (let i = 0; i < n - 1; i++) {
      const a = sm[i]!, b = sm[i + 1]!
      if (!pr.ok[i] || !pr.ok[i + 1] || b.t - a.t < 1e-6) continue
      if (!inScope((a.x + b.x) / 2, (a.z + b.z) / 2)) continue
      for (const side of [-1, 1] as const) {
        const lat = side * RAIL.gauge / 2
        const ya = railY(i, lat), yb = railY(i + 1, lat)
        const ai = offset(a, lat - rw / 2), ao = offset(a, lat + rw / 2), bi = offset(b, lat - rw / 2), bo = offset(b, lat + rw / 2)
        const AI = [ai[0], ya, ai[1]], AO = [ao[0], ya, ao[1]], BI = [bi[0], yb, bi[1]], BO = [bo[0], yb, bo[1]]
        const AIt = [ai[0], ya + rh, ai[1]], AOt = [ao[0], ya + rh, ao[1]], BIt = [bi[0], yb + rh, bi[1]], BOt = [bo[0], yb + rh, bo[1]]
        // +lateral is (tz, −tx): the face at lat + rw/2 looks that way, the other the opposite
        const left = [a.tz, 0, -a.tx] as const, right = [-a.tz, 0, a.tx] as const
        const uv = [[a.t, 0], [b.t, 0], [b.t, rh], [a.t, rh]]
        sinks.rails.quad(AIt, BIt, BOt, AOt, [0, 1, 0], [[a.t, 0], [b.t, 0], [b.t, rw], [a.t, rw]])
        sinks.rails.quad(AO, BO, BOt, AOt, left, uv)
        sinks.rails.quad(AI, BI, BIt, AIt, right, uv)
      }
    }
    tris += sinks.rails.triangles - before

    // --- the viaduct: slab sides and bottom, parapets, end caps, piers ---------------------------------
    const V = RAIL.viaduct
    const beforeC = sinks.concrete.triangles
    for (const run of pr.runs) {
      const y = run.y, yb = y - V.deckH
      for (let i = run.i0; i < run.i1; i++) {
        const a = sm[i]!, b = sm[i + 1]!
        if (!pr.ok[i] || !pr.ok[i + 1] || b.t - a.t < 1e-6) continue
        if (!inScope((a.x + b.x) / 2, (a.z + b.z) / 2)) continue
        for (const side of [-1, 1] as const) {
          const out = [side * a.tz, 0, -side * a.tx] as const, inward = [-out[0], 0, -out[2]] as const
          const ao = offset(a, side * V.deckW / 2), bo = offset(b, side * V.deckW / 2)
          // the slab's side face
          sinks.concrete.quad([ao[0], y, ao[1]], [bo[0], y, bo[1]], [bo[0], yb, bo[1]], [ao[0], yb, ao[1]], out, [[a.t, y], [b.t, y], [b.t, yb], [a.t, yb]])
          // the parapet, unless the twin track's deck is on this side
          if (side > 0 ? pr.twinL[i] : pr.twinR[i]) continue
          const ai = offset(a, side * (V.deckW / 2 - ROADS.bridge.parapetT)), bi = offset(b, side * (V.deckW / 2 - ROADS.bridge.parapetT))
          const yt = y + V.parapet
          sinks.concrete.quad([ao[0], y, ao[1]], [bo[0], y, bo[1]], [bo[0], yt, bo[1]], [ao[0], yt, ao[1]], out, [[a.t, y], [b.t, y], [b.t, yt], [a.t, yt]])
          sinks.concrete.quad([ai[0], y, ai[1]], [bi[0], y, bi[1]], [bi[0], yt, bi[1]], [ai[0], yt, ai[1]], inward, [[a.t, y], [b.t, y], [b.t, yt], [a.t, yt]])
          sinks.concrete.quad([ai[0], yt, ai[1]], [bi[0], yt, bi[1]], [bo[0], yt, bo[1]], [ao[0], yt, ao[1]], [0, 1, 0], [[a.t, 0], [b.t, 0], [b.t, ROADS.bridge.parapetT], [a.t, ROADS.bridge.parapetT]])
        }
        // the bottom
        const al = offset(a, V.deckW / 2), ar = offset(a, -V.deckW / 2), bl = offset(b, V.deckW / 2), br = offset(b, -V.deckW / 2)
        sinks.concrete.quad([al[0], yb, al[1]], [bl[0], yb, bl[1]], [br[0], yb, br[1]], [ar[0], yb, ar[1]], [0, -1, 0], [[a.t, 0], [b.t, 0], [b.t, V.deckW], [a.t, V.deckW]])
      }
      // the end caps of the slab and the parapets
      for (const end of [run.i0, run.i1]) {
        const s = sm[end]!
        if (!pr.ok[end] || !inScope(s.x, s.z)) continue
        const dir = end === run.i0 ? -1 : 1
        const along = [dir * s.tx, 0, dir * s.tz] as const
        const l = offset(s, V.deckW / 2), r = offset(s, -V.deckW / 2)
        sinks.concrete.quad([l[0], y + V.parapet, l[1]], [r[0], y + V.parapet, r[1]], [r[0], yb, r[1]], [l[0], yb, l[1]], along, [[0, y + V.parapet], [V.deckW, y + V.parapet], [V.deckW, yb], [0, yb]])
      }
      // the piers: box columns every pierPitch from the ground to the slab's underside
      const t0 = sm[run.i0]!.t, t1 = sm[run.i1]!.t
      for (let t = t0 + V.pierPitch / 2; t < t1; t += V.pierPitch) {
        let j = run.i0
        while (j < run.i1 - 1 && sm[j + 1]!.t <= t) j++
        const a = sm[j]!, b = sm[j + 1]!
        const u = b.t - a.t > 1e-6 ? (t - a.t) / (b.t - a.t) : 0
        const s = { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: a.tx, tz: a.tz }
        if (!pr.ok[j] || !inScope(s.x, s.z)) continue
        const yg = drapeY(s.x, s.z) - PIER_BURY
        if (yb - yg < 0.5) continue
        const [pl, pw] = V.pier
        const corner = (dl: number, dw: number): XZ => [s.x + s.tx * dl + s.tz * dw, s.z + s.tz * dl - s.tx * dw]
        const c0 = corner(-pl / 2, -pw / 2), c1 = corner(pl / 2, -pw / 2), c2 = corner(pl / 2, pw / 2), c3 = corner(-pl / 2, pw / 2)
        const face = (p: XZ, qq: XZ, nrm: readonly number[]) => sinks.concrete.quad([p[0], yg, p[1]], [qq[0], yg, qq[1]], [qq[0], yb, qq[1]], [p[0], yb, p[1]], nrm, [[0, yg], [pw, yg], [pw, yb], [0, yb]])
        face(c0, c1, [-s.tz, 0, s.tx])
        face(c1, c2, [s.tx, 0, s.tz])
        face(c2, c3, [s.tz, 0, -s.tx])
        face(c3, c0, [-s.tx, 0, -s.tz])
      }
    }
    tris += sinks.concrete.triangles - beforeC
    return tris
  }

  const railJob = (name: string, here: number[], scope: { window: Rect4; hole: Rect4 | null; ringSide: boolean }, tag: Record<string, unknown>) => {
    stats.blocks++
    farField.defer('dressing', name, 20, () => {
      const sinks = { bed: new StripSink([{ name: 'aRail', size: 2 }]), embank: new StripSink([]), rails: new TriSink(), concrete: new TriSink() }
      let tris = 0
      for (const ci of here) tris += pourRail(ci, sinks, scope, ci)
      tally(name, tris, 'rail')
      const group = new THREE.Group()
      group.name = name
      const bedGeo = sinks.bed.build()
      if (bedGeo) {
        // the bed's uv is (arc length / tile, across / bed), poured as an attribute: the strip's own uv is world xz
        bedGeo.setAttribute('uv', bedGeo.getAttribute('aRail'))
        bedGeo.deleteAttribute('aRail')
        group.add(meshOf(bedGeo, mats.ballast, `railBed-${name.slice(5)}`, { ...tag, family: 'rail', part: 'bed' }))
      }
      const embankGeo = sinks.embank.build()
      if (embankGeo) group.add(meshOf(embankGeo, mats.embank, `railEmbank-${name.slice(5)}`, { ...tag, family: 'rail', part: 'embank' }))
      const railGeo = sinks.rails.build()
      if (railGeo) group.add(meshOf(railGeo, mats.rail, `railRails-${name.slice(5)}`, { ...tag, family: 'rail', part: 'rails' }))
      const concGeo = sinks.concrete.build()
      if (concGeo) group.add(meshOf(concGeo, mats.concrete, `railViaduct-${name.slice(5)}`, { ...tag, family: 'rail', part: 'viaduct' }))
      if (!group.children.length) return null
      group.userData.terrainSide = { ...tag, family: 'rail', triangles: tris }
      farField.register({ kind: 'rail', name, levels: [{ object: group, range: Infinity, static: true }] })
      return group
    })
  }

  if (chains.length) {
    const railPad = RAIL.bed / 2 + RAIL.embankH * RAIL.slope + 1
    for (const { b, window } of blocks) {
      const here = chains.map((c, i) => (overlaps(c.bbox, window, railPad) ? i : -1)).filter((i) => i >= 0)
      if (here.length) railJob(`rail-b${b}`, here, { window, hole: null, ringSide: false }, { block: b })
    }
    for (const [k, window] of Object.entries(bands)) {
      const here = chains.map((c, i) => (overlaps(c.bbox, window, railPad) ? i : -1)).filter((i) => i >= 0)
      if (here.length) railJob(`rail-ring-${k}`, here, { window, hole: gridRect, ringSide: true }, { ring: k })
    }
  }

  // =============================================================================================
  // STREAMS
  // =============================================================================================
  const streams: StreamWay[] = []
  for (const row of SUR_STREAMS) {
    if (!overlaps(worldBox(row, enScale), ringRect4, row.width)) continue
    const pts = wayPoints(row, enScale)
    if (pts.length < 2) continue
    const samples = walkWay(pts, pts.map(() => 0), () => row.dmin, (x, z) => (inGrid(grid, x, z) ? STREAM.step : STREAM.ringStep))
    if (samples.length < 2) continue
    streams.push({ row, river: row.kind === 'river', width: row.width, samples, bbox: ringBBox(pts), length: samples[samples.length - 1]!.t })
  }
  stats.stream.ways = streams.length
  for (const w of streams) {
    stats.stream.m += w.length
    for (let i = 0; i < w.samples.length - 1; i++) pushKeepOut(w.samples[i]!, w.samples[i + 1]!, w.width / 2 + STREAM_KEEP_OUT)
  }

  const streamProfiles = new Map<number, StreamProfile>()
  const streamProfile = (wi: number): StreamProfile => {
    let p = streamProfiles.get(wi)
    if (p) return p
    const w = streams[wi]!
    const sm = w.samples
    const n = sm.length
    const kind = new Uint8Array(n), wW = new Float64Array(n), cut = new Uint8Array(n), cutBank = new Uint8Array(n), ok = new Uint8Array(n), bank = new Uint8Array(n), mid = new Uint8Array(n)
    const free = new Uint8Array(n)
    let crossings = 0
    for (let i = 0; i < n; i++) {
      const s = sm[i]!
      if (w.river) {
        kind[i] = BANK_LEVEE
        wW[i] = w.width
      } else if (landCover.weightAt(s.x, s.z, 'settle') >= STREAM.settleMin) {
        kind[i] = BANK_RIM
        wW[i] = Math.max(1, w.width - 2 * STREAM.rim.w)
      } else {
        kind[i] = BANK_BERM
        wW[i] = w.width * 0.55
      }
      ok[i] = siteOk(rule, s.x, s.z, s.lo - w.width / 2 - STREAM.levee.w, STREAM.minD, ringRect) ? 1 : 0
      // a road at grade crosses here: a stream goes into a culvert (nothing drawn under the ribbon),
      // a river runs on under it and only its levees open for the road; under a road BRIDGE the
      // water and the banks run on. The reach covers half the sample pitch, so a road crossing
      // between two samples still cuts at one of them
      const reach = Math.max(STREAM.crossingGap, (inGrid(grid, s.x, s.z) ? STREAM.step : STREAM.ringStep) / 2 + 0.5)
      if (crossingRoad(s.x, s.z, s.tx, s.tz, reach, true)) {
        cutBank[i] = 1
        if (!w.river) cut[i] = 1
        if (!cutBank[i - 1]) crossings++
      }
      // a bank whose feet would stand on a road — a canal along a road, an oblique crossing beyond
      // the cut, a lane on the levee's crown — is left out on that side: the water alone there
      const bw = kind[i] === BANK_LEVEE ? STREAM.levee.w : STREAM.berm.w
      for (const [side, bit] of [[1, SIDE_L], [-1, SIDE_R]] as const) {
        const e0 = offset(s, side * wW[i]! / 2), e1 = offset(s, side * (wW[i]! / 2 + bw))
        if (roadFree(e0[0], e0[1]) && roadFree(e1[0], e1[1])) free[i] = free[i]! | bit
      }
      if (kind[i] === BANK_RIM) stats.stream.rimM += i ? s.t - sm[i - 1]!.t : 0
      else stats.stream.bermM += i ? s.t - sm[i - 1]!.t : 0
    }
    for (let i = 0; i < n; i++) {
      let m = SIDE_L | SIDE_R
      for (let j = Math.max(0, i - BANK_DILATE); j <= Math.min(n - 1, i + BANK_DILATE); j++) m &= free[j]!
      bank[i] = m
    }
    // inside quad i: the bank's inner and outer lines at the quarter points (a road crossing the
    // 12 m ring quads obliquely can pass between the corners and the midpoint, so points every
    // ≤ 3 m along both lines — closer than any road's width — catch it)
    for (let i = 0; i < n - 1; i++) {
      const a = sm[i]!, b = sm[i + 1]!
      const bw = kind[i] === BANK_LEVEE ? STREAM.levee.w : STREAM.berm.w
      const inner = Math.max(wW[i]!, wW[i + 1]!) / 2, outer = inner + bw
      let m = SIDE_L | SIDE_R
      for (let u = 0.25; u < 1 && m; u += 0.25) {
        const c = { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: a.tx, tz: a.tz }
        for (const [side, bit] of [[1, SIDE_L], [-1, SIDE_R]] as const) {
          if (!(m & bit)) continue
          const p0 = offset(c, side * inner), p1 = offset(c, side * outer)
          if (!roadFree(p0[0], p0[1]) || !roadFree(p1[0], p1[1])) m &= ~bit
        }
      }
      mid[i] = m
    }
    p = { kind, wW, cut, cutBank, ok, bank, mid, crossings }
    streamProfiles.set(wi, p)
    stats.stream.crossings += crossings
    return p
  }

  const pourStream = (wi: number, sinks: { water: StripSink; bank: StripSink; rim: StripSink }, scope: { window: Rect4; hole: Rect4 | null; ringSide: boolean }, key: number): number => {
    const w = streams[wi]!
    const sm = w.samples
    const pr = streamProfile(wi)
    const pad = w.width / 2 + STREAM.levee.w + WINDOW_PAD_M
    const reach = (i: number): boolean => pr.ok[i] === 1 && inRect(sm[i]!.x, sm[i]!.z, scope.window, pad) && !(scope.hole && inRect(sm[i]!.x, sm[i]!.z, scope.hole, -pad))
    const clip = scope.ringSide
      ? { grid: ringShape, drape: 'nodes' as const, nodeY: ringNodeY, ground, plan, minD: STREAM.minD, window: scope.window, hole: scope.hole!, cache: ringCache }
      : { grid, drape: 'mesh' as const, ground, plan, minD: STREAM.minD, window: scope.window, cache }
    let tris = 0
    const pairOk = (i: number) => reach(i) && reach(i + 1) && sm[i + 1]!.t - sm[i]!.t > 1e-6
    const bankPairOk = (i: number) => !pr.cutBank[i] && !pr.cutBank[i + 1] && pairOk(i)

    // --- the water: 2 rows, STREAM.waterLift over the ground ---------------------------------------
    const water: StripInput = {
      rows: [sm.map((s, i) => offset(s, pr.wW[i]! / 2)), sm.map((s, i) => offset(s, -pr.wW[i]! / 2))],
      lift: () => STREAM.waterLift,
      attr: () => {},
      okAt: (i) => !pr.cut[i] && !pr.cut[i + 1] && pairOk(i),
      dLo: (i) => sm[i]!.lo,
    }
    sinks.water.begin(key * 8)
    tris += cellClippedStrip(sinks.water, water, clip).triangles

    // --- the banks: a berm / levee ridge (3 rows) or a concrete rim (4 rows, near-vertical faces) each side
    const bankW = (i: number) => (pr.kind[i] === BANK_LEVEE ? STREAM.levee.w : STREAM.berm.w)
    const bankH = (i: number) => (pr.kind[i] === BANK_LEVEE ? STREAM.levee.h : STREAM.berm.h)
    // a quad takes its bank kind from its first sample; it needs the bank allowed on its side at
    // both samples and at its midpoint (a road under the feet at either end would put the quad's
    // end on the asphalt); a berm → rim change is continuous: the rim rows exist at every sample
    const sideOk = (i: number, bit: number) => (pr.bank[i]! & bit) !== 0 && (pr.bank[i + 1]! & bit) !== 0 && (pr.mid[i]! & bit) !== 0
    const ridgeKind = (i: number) => (pr.kind[i] === BANK_BERM && !scope.ringSide) || pr.kind[i] === BANK_LEVEE
    for (const [side, bit] of [[-1, SIDE_R], [1, SIDE_L]] as const) {
      const e = (i: number) => pr.wW[i]! / 2
      // rows [water's edge, crest, outer foot] (a rim: [edge, top inner, top outer, outer foot]); the strip winds to +Y whatever the order
      const ridge: StripInput = {
        rows: [sm.map((s, i) => offset(s, side * e(i))), sm.map((s, i) => offset(s, side * (e(i) + bankW(i) / 2))), sm.map((s, i) => offset(s, side * (e(i) + bankW(i))))],
        lift: (r, i) => (r === 1 ? bankH(i) : STREAM.waterLift),
        attr: () => {},
        okAt: (i) => ridgeKind(i) && sideOk(i, bit) && bankPairOk(i),
        dLo: (i) => sm[i]!.lo,
      }
      sinks.bank.begin(key * 8 + (side > 0 ? 1 : 2))
      tris += cellClippedStrip(sinks.bank, ridge, clip).triangles
      if (scope.ringSide) continue
      const rim: StripInput = {
        rows: [
          sm.map((s, i) => offset(s, side * e(i))),
          sm.map((s, i) => offset(s, side * (e(i) + RIM_FACE_M))),
          sm.map((s, i) => offset(s, side * (e(i) + STREAM.rim.w))),
          sm.map((s, i) => offset(s, side * (e(i) + STREAM.rim.w + RIM_FACE_M))),
        ],
        lift: (r) => (r === 1 || r === 2 ? STREAM.rim.h : STREAM.waterLift),
        attr: () => {},
        okAt: (i) => pr.kind[i] === BANK_RIM && sideOk(i, bit) && bankPairOk(i),
        dLo: (i) => sm[i]!.lo,
      }
      sinks.rim.begin(key * 8 + (side > 0 ? 3 : 4))
      tris += cellClippedStrip(sinks.rim, rim, clip).triangles
    }
    return tris
  }

  const streamJob = (name: string, here: number[], scope: { window: Rect4; hole: Rect4 | null; ringSide: boolean }, tag: Record<string, unknown>) => {
    stats.blocks++
    farField.defer('dressing', name, 20, () => {
      const sinks = { water: new StripSink([]), bank: new StripSink([]), rim: new StripSink([]) }
      let tris = 0
      for (const wi of here) tris += pourStream(wi, sinks, scope, wi)
      tally(name, tris, 'stream')
      const group = new THREE.Group()
      group.name = name
      const suffix = name.slice(7)
      const waterGeo = sinks.water.build()
      if (waterGeo) group.add(meshOf(waterGeo, mats.water, `water-${suffix}`, { ...tag, family: 'stream', part: 'water' }))
      const bankGeo = sinks.bank.build()
      if (bankGeo) group.add(meshOf(bankGeo, mats.bund, `streamBank-${suffix}`, { ...tag, family: 'stream', part: 'bank' }))
      const rimGeo = sinks.rim.build()
      if (rimGeo) group.add(meshOf(rimGeo, mats.concrete, `streamRim-${suffix}`, { ...tag, family: 'stream', part: 'rim' }))
      if (!group.children.length) return null
      group.userData.terrainSide = { ...tag, family: 'stream', triangles: tris }
      farField.register({ kind: 'stream', name, levels: [{ object: group, range: Infinity, static: true }] })
      return group
    })
  }

  if (streams.length) {
    const streamPad = Math.max(...Object.values(STREAM_WIDTH)) / 2 + STREAM.levee.w + 1
    for (const { b, window } of blocks) {
      const here = streams.map((w, i) => (overlaps(w.bbox, window, streamPad) ? i : -1)).filter((i) => i >= 0)
      if (here.length) streamJob(`stream-b${b}`, here, { window, hole: null, ringSide: false }, { block: b })
    }
    for (const [k, window] of Object.entries(bands)) {
      const here = streams.map((w, i) => (overlaps(w.bbox, window, streamPad) ? i : -1)).filter((i) => i >= 0)
      if (here.length) streamJob(`stream-ring-${k}`, here, { window, hole: gridRect, ringSide: true }, { ring: k })
    }
  }

  // =============================================================================================
  // PADDIES (high tier: the levees and ditches of the in-grid fields)
  // =============================================================================================
  const fields: Field[] = []
  if (q.farField.paddyRelief) {
    for (const row of SUR_FARMLAND) {
      if (!overlaps(worldBox(row, enScale), gridRect, 0)) continue
      const ring = wayPoints(row, enScale)
      if (ring.length < 3) continue
      fields.push({ row, ring, bbox: ringBBox(ring) })
    }
  }

  const fieldPlans = new Map<number, FieldPlan>()
  /**
   * The bund lines of one field as runs: the boundary (the levee's outer foot on the edge, the
   * ditch inside it) and the cell lattice on the field's principal axis, each sampled every
   * PADDY.levee.step and cut wherever a sample leaves the ring, fails the site rule or stands on
   * a road ribbon; a lattice run's ends are bisected onto the boundary so it meets the boundary
   * levee instead of stopping a step short.
   */
  const fieldPlan = (fi: number): FieldPlan => {
    let fp = fieldPlans.get(fi)
    if (fp) return fp
    const f = fields[fi]!
    const ring = f.ring
    const dmin = f.row.dmin
    const okAt = (x: number, z: number): boolean => siteOk(rule, x, z, dmin - nearestVertex(x, z, ring), PADDY.minD) && roadFree(x, z)
    const levees: Run[] = [], ditches: Run[] = []
    let leveeM = 0, ditchM = 0
    const push = (list: Run[], pts: Run['pts']) => {
      if (pts.length < 2) return
      let len = 0
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z)
      if (len < PADDY.levee.step / 2) return
      list.push({ pts, length: len })
      if (list === levees) leveeM += len
      else ditchM += len
    }
    /** split a circular or open list of candidates into runs by `ok` */
    const runsOf = (list: Run[], cand: Run['pts'], closed: boolean) => {
      const n = cand.length
      const good = cand.map((p) => okAt(p.x, p.z))
      if (closed && good.every(Boolean)) {
        push(list, [...cand, cand[0]!])
        return
      }
      let start = 0
      if (closed) {
        start = good.indexOf(false)
        if (start < 0) return
      }
      let run: Run['pts'] = []
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n
        if (good[i]) run.push(cand[i]!)
        else {
          push(list, run)
          run = []
        }
      }
      push(list, run)
    }

    // --- the boundary: the levee's outer foot on the edge, the ditch just inside it ---------------
    const inwardSign = signedArea(ring) > 0 ? 1 : -1
    const edge = resample(ring, PADDY.levee.step, true)
    const inward = (s: { x: number; z: number; tx: number; tz: number }, d: number) => ({ x: s.x + inwardSign * -s.tz * d, z: s.z + inwardSign * s.tx * d, tx: s.tx, tz: s.tz })
    runsOf(levees, edge.map((s) => inward(s, PADDY.levee.w / 2)), true)
    runsOf(ditches, edge.map((s) => inward(s, PADDY.levee.w + PADDY.ditch.w / 2 + 0.05)), true)

    // --- the lattice: lines at every cell pitch along and across the principal axis ----------------
    const ax = fieldAxis(ring)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const [x, z] of ring) {
      const dx = x - ax.cx, dz = z - ax.cz
      const u = ax.cos * dx + ax.sin * dz, v = -ax.sin * dx + ax.cos * dz
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
    }
    const toWorld = (u: number, v: number): XZ => [ax.cx + ax.cos * u - ax.sin * v, ax.cz + ax.sin * u + ax.cos * v]
    /** the boundary crossing between an inside point and an outside point, by bisection */
    const onEdge = (pin: XZ, pout: XZ): XZ => {
      let a = pin, b = pout
      while (Math.hypot(b[0] - a[0], b[1] - a[1]) > RUN_END_EPS) {
        const m: XZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        if (pointInRing(m[0], m[1], ring)) a = m
        else b = m
      }
      return a
    }
    const line = (fixedU: boolean, c: number, lo: number, hi: number) => {
      const n = Math.max(1, Math.ceil((hi - lo) / PADDY.levee.step))
      const step = (hi - lo) / n
      const dir: XZ = fixedU ? [-ax.sin, ax.cos] : [ax.cos, ax.sin]
      const pts: XZ[] = []
      for (let k = 0; k <= n; k++) pts.push(fixedU ? toWorld(c, lo + k * step) : toWorld(lo + k * step, c))
      const inside = pts.map((p) => pointInRing(p[0], p[1], ring))
      let run: Run['pts'] = []
      const flush = (endIdx: number) => {
        if (run.length) {
          // extend to the boundary at both ends where the neighbouring point is outside the ring
          const first = run[0]!, last = run[run.length - 1]!
          const iFirst = pts.findIndex((p) => p[0] === first.x && p[1] === first.z)
          if (iFirst > 0 && !inside[iFirst - 1]) {
            const e = onEdge([first.x, first.z], pts[iFirst - 1]!)
            if (okAt(e[0], e[1])) run.unshift({ x: e[0], z: e[1], tx: dir[0], tz: dir[1] })
          }
          if (endIdx < pts.length && !inside[endIdx]) {
            const e = onEdge([last.x, last.z], pts[endIdx]!)
            if (okAt(e[0], e[1])) run.push({ x: e[0], z: e[1], tx: dir[0], tz: dir[1] })
          }
          push(levees, run)
        }
        run = []
      }
      for (let k = 0; k <= n; k++) {
        const p = pts[k]!
        if (inside[k] && okAt(p[0], p[1])) run.push({ x: p[0], z: p[1], tx: dir[0], tz: dir[1] })
        else flush(k)
      }
      flush(n + 1)
    }
    const [cellU, cellV] = PADDY.cell
    for (let k = Math.ceil(u0 / cellU); k * cellU < u1; k++) line(true, k * cellU, v0, v1)
    for (let m = Math.ceil(v0 / cellV); m * cellV < v1; m++) line(false, m * cellV, u0, u1)
    fp = { levees, ditches, leveeM, ditchM }
    fieldPlans.set(fi, fp)
    if (leveeM > 0) stats.paddy.fields++
    stats.paddy.leveeM += leveeM
    stats.paddy.ditchM += ditchM
    return fp
  }

  const pourPaddy = (fi: number, sinks: { levee: StripSink; ditch: StripSink }, window: Rect4, key: number): number => {
    const fp = fieldPlan(fi)
    const clip = { grid, drape: 'mesh' as const, ground, plan, minD: PADDY.minD, window, cache }
    const dmin = fields[fi]!.row.dmin
    const ring = fields[fi]!.ring
    let tris = 0
    const pad = PADDY.levee.w + WINDOW_PAD_M
    let k = 0
    for (const run of fp.levees) {
      const pts = run.pts
      const lo = pts.map((p) => dmin - nearestVertex(p.x, p.z, ring))
      const half = PADDY.levee.w / 2
      const input: StripInput = {
        rows: [pts.map((p) => offset(p, -half)), pts.map((p) => offset(p, 0)), pts.map((p) => offset(p, half))],
        lift: (r) => (r === 1 ? PADDY.levee.h : PADDY.levee.foot),
        attr: () => {},
        okAt: (i) => inRect(pts[i]!.x, pts[i]!.z, window, pad) && inRect(pts[i + 1]!.x, pts[i + 1]!.z, window, pad),
        dLo: (i) => lo[i]!,
      }
      sinks.levee.begin(key * 4096 + k++)
      tris += cellClippedStrip(sinks.levee, input, clip).triangles
    }
    for (const run of fp.ditches) {
      const pts = run.pts
      const lo = pts.map((p) => dmin - nearestVertex(p.x, p.z, ring))
      const half = PADDY.ditch.w / 2
      const input: StripInput = {
        rows: [pts.map((p) => offset(p, -half)), pts.map((p) => offset(p, half))],
        lift: () => PADDY.ditch.lift,
        attr: () => {},
        okAt: (i) => inRect(pts[i]!.x, pts[i]!.z, window, pad) && inRect(pts[i + 1]!.x, pts[i + 1]!.z, window, pad),
        dLo: (i) => lo[i]!,
      }
      sinks.ditch.begin(key * 4096 + k++)
      tris += cellClippedStrip(sinks.ditch, input, clip).triangles
    }
    return tris
  }

  if (fields.length) {
    for (const { b, window } of blocks) {
      const here = fields.map((f, i) => (overlaps(f.bbox, window, PADDY.levee.w + 1) ? i : -1)).filter((i) => i >= 0)
      if (!here.length) continue
      const name = `paddy-b${b}`
      stats.blocks++
      farField.defer('dressing', name, 30, () => {
        const sinks = { levee: new StripSink([]), ditch: new StripSink([]) }
        let tris = 0
        for (const fi of here) tris += pourPaddy(fi, sinks, window, fi)
        tally(name, tris, 'paddy')
        const group = new THREE.Group()
        group.name = name
        const leveeGeo = sinks.levee.build()
        if (leveeGeo) group.add(meshOf(leveeGeo, mats.bund, `paddyLevee-b${b}`, { block: b, family: 'paddy', part: 'levee' }))
        const ditchGeo = sinks.ditch.build()
        if (ditchGeo) group.add(meshOf(ditchGeo, mats.ditch, `paddyDitch-b${b}`, { block: b, family: 'paddy', part: 'ditch' }))
        if (!group.children.length) return null
        group.userData.terrainSide = { block: b, family: 'paddy', triangles: tris }
        farField.register({ kind: 'paddy', name, levels: [{ object: group, range: Infinity, static: true }] })
        return group
      })
    }
  }

  if (import.meta.dev) console.info(`[terrain-side] rail ${chains.length} chains / ${stats.rail.m.toFixed(0)} m, streams ${streams.length} ways / ${stats.stream.m.toFixed(0)} m, ${fields.length} fields${q.farField.paddyRelief ? '' : ' (paddy relief off)'}, ${stats.keepOuts} keep-out quads, ${stats.blocks} jobs deferred`)
  return stats
}
