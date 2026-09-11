import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SUR_BUILDINGS, SUR_PARKING, SUR_ROADS, SUR_SITES, SUR_SOLAR } from '~/data/suzuka-surroundings'
import { worldRing, type SurFeatureBase } from '~/data/en-codec'
import type { EnvBuildContext } from './environment'
import type { Ground } from './ground'
import { inBBox, pointInRing, principalAxis, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
import { BARRIER_KIND, FENCE_TILE_M } from './barriers'
import { cutoutFromAssets, cutoutParams } from './materials'
import { armcoMaps, cached, chainLinkTexture, makeTexture, mulberry, paint, scaled } from './textures'

/**
 * Outskirts furniture (plan §2b, §2e): the solar farms, the circuit's perimeter fence, the light
 * poles of the car parks and the service roads, the utility poles with their wires along the
 * public roads and the guardrails of the prefectural roads — everything that STANDS on
 * `ground.standY` outside the fences, built as deferred 'dressing' jobs of `ctx.farField`, one
 * per family and 250 m cell, and chosen per cell by the registry's LOD pass.
 *
 * The rule every family obeys (README 地面の契約): a thing stands ≥ OUTSKIRTS.minD (140 m) from
 * the GP centreline (`ground.plan.project`), on no drawn ground face (`ground.builtY === null`)
 * and inside the terrain grid (`terrain.grid()`, where the far-field cells are). The one
 * exception is the perimeter fence, which follows the OSM circuit boundary to within 60 m of the
 * centreline (the barriers and the stands own the band inside that). Nothing here samples the
 * terrain; the only ground reads are `standY` / `builtY` / `plan.project` (R3), and no opaque
 * ground face is added (R1, R11).
 *
 * The planning (decoding the polygons and ways, resampling, bucketing by cell) is synchronous
 * and cheap — pure XZ arithmetic, no ground reads. Every ground read and every vertex is made in
 * the deferred job of its cell, so no job holds the main thread for more than a few ms. The
 * materials are made lazily by the first job that runs (the registry's attach callback covers
 * every job's root, and `setupMaterials` is idempotent), textures through textures.ts's cache
 * with `textureScale` in the key.
 *
 *  - SOLAR `solar-<cell>` (kind 'solar', range ∞ — the farms read from the overview): rows
 *    along world X at a 5.5 m pitch (a global phase, so neighbouring farms align the way the
 *    aerial shows), scanline-intersected with the OSM polygon, inset, cut at 30 m, each segment
 *    one 3.3 m deep, 8 cm thick box tilted 15° facing south (front edge 0.8 m over the ground,
 *    read at the front edge) with the panel texture on top (navy cells, silver frame; one
 *    module = 1.0 × 1.65 m). The rings are pushed into `ctx.keepOutPolys` synchronously, so
 *    the forest's stems and the trackside scatter stay out of the farms.
 *  - FENCE `fence-<cell>` (kind 'fence', range `OUTSKIRTS.fence.range`): the circuit boundary
 *    775428456 (171 vertices, 7,467 m) resampled at 3 m — instanced 60 mm posts, a 50 mm top
 *    rail (three faces) and, with `Quality.fence`, 2.4 m mesh panels (fence003 through
 *    `cutoutFromAssets`, the procedural chain-link without the pack); a 20 m gap at the boundary
 *    point nearest each of the four OSM gates (南ゲート sits 9 m off the boundary, メインゲート
 *    238 m, ホテルゲート 307 m and パーキングゲート 837 m outside it — for those three the gap
 *    marks where their approach road meets the boundary). Nothing is built where the boundary
 *    runs within `fence.minD` of the centreline: the barriers and the stands own that band.
 *  - LIGHT POLES `poles-<cell>` (kind 'poles', 600 m): one procedural 8 m pole + arm + head
 *    (36 triangles; the street_lamp_02 GLB is 20k) in the car parks' row dividers every 35 m
 *    and along the service roads inside the circuit every 40 m, the nearest to the track first
 *    up to `Quality.farField.lightPoles`. No emissive: the race is at 14:00.
 *  - UTILITY `utility-<cell>` (kind 'poles', 600 m) + `wires-<cell>` (400 m): 11 m tapered
 *    concrete poles (24 triangles with the 1.5 m crossarm) every 35 m on one side of the
 *    tertiary / unclassified / residential roads outside the circuit, three catenary wires
 *    (thin dark strips standing on edge — a wire has to read as a line from a camera at eye
 *    level, and a strip lying flat is invisible there — no shadow) between consecutive poles,
 *    and the white W-beam guardrail (armco maps, BARRIER_KIND.guardrail heights) on both sides
 *    of the trunk / primary / secondary roads.
 *
 * The poles keep out of the OSM building footprints on their own (a disc from the centroid and
 * the area, `BuildingClearance`) rather than through `ctx.keepOut` / `ctx.keepOutPolys`: those hold
 * the car parks too, and a car park is exactly where the light poles belong.
 */

/** the numbers this builder tunes (the tier budgets — lightPoles, shadows, rangeFar, fence — are in quality.ts) */
export const OUTSKIRTS = {
  /** nothing stands closer than this to the GP centreline (m) */
  minD: 140,
  /**
   * A feature whose centroid is further than this outside the terrain grid is skipped before its
   * vertex stream is decoded (the extract reaches 3.3 km, the grid 1.7 × 1.3 km — most of the
   * 4,000 ways never come near it). The margin is generous: the longest way of the extract is a
   * few hundred metres, so no way that touches the grid is dropped by its centroid.
   */
  gridMargin: 1200,
  /** a pole keeps this many times sqrt(footprint area) away from an OSM building's centroid */
  buildingClear: 0.6,
  solar: {
    /** row pitch (m, north–south) and the world-z phase of the rows */
    pitch: 5.5,
    /** a row is cut into segments of this length (m); remnants shorter than `minSegment` are dropped */
    segment: 30,
    minSegment: 4,
    /** panel depth along the slope (m), tilt, front-edge height over the ground (m), thickness (m) */
    depth: 3.3,
    tilt: (15 * Math.PI) / 180,
    front: 0.8,
    thick: 0.08,
    /** rows stop this far inside the polygon edge (m) */
    inset: 1.5,
    /** one module of the panel texture (m along the row × m down the slope) */
    moduleW: 1.0,
    moduleD: 1.65,
  },
  fence: {
    /** OSM way of the circuit boundary and the resampling step (m) */
    wayId: 775428456,
    step: 3,
    /** mesh height (m), post section (m), how deep the posts are set (m), rail section (m), the panel's clearance (m) */
    height: 2.4,
    post: 0.06,
    bury: 0.3,
    rail: 0.05,
    panelBottom: 0.1,
    /** the fence stops inside this distance of the centreline (m) — the barriers' and stands' band */
    minD: 60,
    /** gap centred on each gate (m) */
    gateGap: 20,
    /**
     * Visible within this distance (m, × lodScale). A 2.4 m mesh is sub-pixel beyond a kilometre,
     * and from the overview (1.8 km up) every cell was in range at `rangeFar`: 81 draws for nothing.
     */
    range: 1000,
  },
  lightPole: {
    height: 8,
    arm: 1.5,
    bury: 0.3,
    /** pitch along a car-park row divider, the divider pitch across the rows (two 16 m rows), and the smallest car park that gets poles (m²) */
    parkPitch: 35,
    rowPitch: 32,
    parkMinArea: 900,
    /** pitch along the service roads and the pole's offset from the road axis (m) */
    roadPitch: 40,
    roadOffset: 3,
    range: 600,
  },
  utility: {
    height: 11,
    bury: 0.4,
    pitch: 35,
    /** the pole stands this far off the road axis, at least (m); wider roads: half the width + 1 */
    offset: 3.5,
    arm: 1.5,
    armY: 10.3,
    /** wires: sag = sagK × span² (m), strip height (m, the strip stands on edge), segments per span, the longest span a wire is strung over (m) */
    sagK: 0.00035,
    wireW: 0.08,
    wireSegs: 5,
    maxSpan: 70,
    range: 600,
    wiresRange: 400,
  },
  guardrail: {
    /** sampling step along the road (m), the rail's distance beyond the road edge (m), the armco tile (m) */
    step: 8,
    edge: 0.5,
    tile: 4,
    /** highway classes that carry a guardrail on both sides */
    kinds: ['trunk', 'trunk_link', 'primary', 'secondary'] as readonly string[],
  },
  /** highway classes that carry utility poles (outside the circuit polygon) */
  utilityKinds: ['tertiary', 'unclassified', 'residential'] as readonly string[],
} as const

export interface OutskirtsStats {
  /** solar farms: polygons planned, rows and segments planned (before the ground rule), cells */
  solar: { polygons: number; rows: number; segments: number; cells: number }
  /** perimeter fence: posts planned, cells */
  fence: { posts: number; cells: number }
  /** light-pole candidates (car parks / service roads) and the tier's budget */
  lightPoles: { candidates: number; budget: number }
  /** utility poles planned, guardrail samples planned, cells */
  utility: { poles: number; guardrailSamples: number; cells: number }
  /** deferred jobs queued */
  jobs: number
}

// ---------------------------------------------------------------------------------------------
// small helpers

interface Sample {
  x: number
  z: number
  /** unit tangent */
  tx: number
  tz: number
  /** arc length from the start (m) */
  t: number
  /** distance to the nearer of the two OSM vertices of the edge the sample lies on (the 1-Lipschitz bound's radius) */
  dv: number
}

/** [x, z, x, z, …] → points */
function polyline(flat: Float64Array): XZ[] {
  return ringFromFlat(flat)
}

/**
 * Resample a polyline at `step` metres of arc length (closed: the last edge back to the first
 * vertex is walked too), each sample with its tangent and its distance to the nearer edge vertex.
 */
function resample(pts: readonly XZ[], step: number, closed: boolean, phase = 0): Sample[] {
  const out: Sample[] = []
  const n = pts.length
  if (n < 2) return out
  const edges = closed ? n : n - 1
  let total = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  if (total < step) return out
  // a closed ring is resampled at an integer count so the last post meets the first
  const actual = closed ? total / Math.max(1, Math.round(total / step)) : step
  let next = phase, walked = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    const ex = b[0] - a[0], ez = b[1] - a[1]
    const len = Math.hypot(ex, ez)
    if (len < 1e-6) continue
    const tx = ex / len, tz = ez / len
    while (next <= walked + len + (closed ? -1e-6 : 1e-6) && (!closed || next < total - 1e-6)) {
      const u = (next - walked) / len
      out.push({ x: a[0] + ex * u, z: a[1] + ez * u, tx, tz, t: next, dv: Math.min(u, 1 - u) * len })
      next += actual
    }
    walked += len
  }
  return out
}

/** arc-length position on a polyline nearest to (x, z), and the distance to it */
function nearestArc(pts: readonly XZ[], closed: boolean, x: number, z: number): { t: number; d: number } {
  const n = pts.length
  const edges = closed ? n : n - 1
  let best = Infinity, bestT = 0, walked = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    const ex = b[0] - a[0], ez = b[1] - a[1]
    const l2 = ex * ex + ez * ez
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0
    const dx = x - (a[0] + ex * u), dz = z - (a[1] + ez * u)
    const d2 = dx * dx + dz * dz
    if (d2 < best) {
      best = d2
      bestT = walked + Math.sqrt(l2) * u
    }
    walked += Math.sqrt(l2)
  }
  return { t: bestT, d: Math.sqrt(best) }
}

/** distance from (x, z) to the nearest vertex of a ring */
function nearestVertex(x: number, z: number, ring: readonly XZ[]): number {
  let best = Infinity
  for (const [vx, vz] of ring) {
    const d2 = (vx - x) * (vx - x) + (vz - z) * (vz - z)
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

function inGrid(g: GridShape, x: number, z: number): boolean {
  return x >= g.x0 && z >= g.z0 && x < g.x0 + g.w && z < g.z0 + g.d
}

/** further than `margin` outside the grid rectangle — the cheap pre-reject, before any decoding */
function outsideGrid(g: GridShape, x: number, z: number, margin: number): boolean {
  return x < g.x0 - margin || z < g.z0 - margin || x > g.x0 + g.w + margin || z > g.z0 + g.d + margin
}

/** total length of a polyline (`closed`: the edge back to the first vertex counts) */
function pathLength(pts: readonly XZ[], closed: boolean): number {
  let total = 0
  const edges = closed ? pts.length : pts.length - 1
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

function push<T>(map: Map<number, T[]>, key: number, item: T) {
  let list = map.get(key)
  if (!list) map.set(key, (list = []))
  list.push(item)
}

/** rotation about Y that maps local +x onto the world direction (dx, dz) */
function yawTo(dx: number, dz: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromAxisAngle(Y_UP, Math.atan2(-dz, dx))
}

const Y_UP = new THREE.Vector3(0, 1, 0)
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3(1, 1, 1)

/**
 * A non-indexed triangle sink with flat normals: quads given as four corners (any order) and an
 * outward direction, so the winding never has to be worked out by hand.
 */
class TriSink {
  private readonly pos: number[] = []
  private readonly uv: number[] = []
  get triangles(): number {
    return this.pos.length / 9
  }
  private tri(a: readonly number[], b: readonly number[], c: readonly number[], ua: readonly number[], ub: readonly number[], uc: readonly number[]) {
    this.pos.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!)
    this.uv.push(ua[0]!, ua[1]!, ub[0]!, ub[1]!, uc[0]!, uc[1]!)
  }
  /** corners p0 → p1 → p2 → p3 around the quad, `out` the side the face shows; uvs per corner */
  quad(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], out: readonly number[], uvs: readonly (readonly number[])[]) {
    const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!
    const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const flip = nx * out[0]! + ny * out[1]! + nz * out[2]! < 0
    if (flip) {
      this.tri(p0, p2, p1, uvs[0]!, uvs[2]!, uvs[1]!)
      this.tri(p0, p3, p2, uvs[0]!, uvs[3]!, uvs[2]!)
    } else {
      this.tri(p0, p1, p2, uvs[0]!, uvs[1]!, uvs[2]!)
      this.tri(p0, p2, p3, uvs[0]!, uvs[2]!, uvs[3]!)
    }
  }
  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}

// ---------------------------------------------------------------------------------------------
// textures and materials (textures.ts helpers; `textureScale` in the key through `scaled`)

/** one photovoltaic module: 6 × 10 navy cells with pale gaps inside a silver frame */
function solarPanelTexture(): THREE.Texture {
  const [w, h] = scaled(96, 160)
  return cached(`outskirts/solar@${w}`, () => {
    const rnd = mulberry(311)
    const frame = Math.max(2, Math.round(w * 0.035))
    const cols = 6, rows = 10
    const c = paint(w, h, (x, y, out) => {
      const inFrame = x < frame || y < frame || x >= w - frame || y >= h - frame
      if (inFrame) {
        const g = 178 + (rnd() - 0.5) * 14
        out[0] = g; out[1] = g + 2; out[2] = g + 5
        return
      }
      const cw = (w - 2 * frame) / cols, ch = (h - 2 * frame) / rows
      const fx = ((x - frame) % cw) / cw, fy = ((y - frame) % ch) / ch
      const gap = Math.max(1.5 / cw, 0.035)
      if (fx < gap || fy < gap || fx > 1 - gap || fy > 1 - gap) {
        out[0] = 150; out[1] = 158; out[2] = 170
        return
      }
      // the cell: deep navy with a faint diagonal sheen and busbar lines
      const sheen = 0.9 + 0.2 * ((fx + fy) / 2) + (rnd() - 0.5) * 0.06
      const bus = Math.abs(fx - 0.33) < 0.012 || Math.abs(fx - 0.67) < 0.012 ? 1.6 : 1
      out[0] = 16 * sheen * bus
      out[1] = 24 * sheen * bus
      out[2] = 62 * sheen * bus
    })
    const tex = makeTexture(c, { srgb: true })
    tex.repeat.set(1 / OUTSKIRTS.solar.moduleW, 1 / OUTSKIRTS.solar.moduleD)
    return tex
  })
}

interface Materials {
  solar: THREE.MeshStandardMaterial
  galvanised: THREE.MeshStandardMaterial
  fencePanel: THREE.MeshStandardMaterial
  lightPole: THREE.MeshStandardMaterial
  concretePole: THREE.MeshStandardMaterial
  wire: THREE.MeshStandardMaterial
  guardrail: THREE.MeshStandardMaterial
  /** prototypes (instanced): the light pole with its arm and head; the utility pole with its crossarm */
  lightPoleGeo: THREE.BufferGeometry
  utilityPoleGeo: THREE.BufferGeometry
  postGeo: THREE.BufferGeometry
}

function makeMaterials(ctx: EnvBuildContext): Materials {
  const q = ctx.quality
  const solar = new THREE.MeshStandardMaterial({ map: solarPanelTexture(), roughness: 0.25, metalness: 0.6 })
  const galvanised = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, roughness: 0.5, metalness: 0.7 })
  const fencePanel = cutoutFromAssets(ctx.assets, 'fence003', {
    quality: q,
    tile: FENCE_TILE_M,
    handBuiltUv: true,
    normalScale: 0.6,
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(1 / 0.2, 1 / 0.2)
      return new THREE.MeshStandardMaterial({ map, ...cutoutParams(q), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 })
    },
  })
  const lightPole = new THREE.MeshStandardMaterial({ color: 0xb4b8b6, roughness: 0.6, metalness: 0.4 })
  const concretePole = new THREE.MeshStandardMaterial({ color: 0x9d9c97, roughness: 0.9, metalness: 0.05 })
  const wire = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide })
  const armco = armcoMaps()
  const guardrail = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xdfe2e4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })

  // the light pole: a tapered 6-sided mast, the arm, the head — local +x is the arm's direction
  const lp = OUTSKIRTS.lightPole
  const mast = new THREE.CylinderGeometry(0.05, 0.09, lp.height, 6, 1, true)
  mast.translate(0, lp.height / 2, 0)
  const arm = new THREE.BoxGeometry(lp.arm, 0.07, 0.07)
  arm.translate(lp.arm / 2, lp.height - 0.04, 0)
  const head = new THREE.BoxGeometry(0.55, 0.16, 0.28)
  head.translate(lp.arm - 0.1, lp.height - 0.1, 0)
  const lightPoleGeo = mergeGeometries([mast, arm, head], false)!
  for (const g of [mast, arm, head]) g.dispose()
  lightPoleGeo.computeBoundingSphere()

  // the utility pole: a tapered 6-sided concrete pole (12 tris) and the crossarm along local x
  // (across the road, 12 tris) — 24 triangles the wires hang from
  const up = OUTSKIRTS.utility
  const shaft = new THREE.CylinderGeometry(0.095, 0.17, up.height, 6, 1, true)
  shaft.translate(0, up.height / 2, 0)
  const cross = new THREE.BoxGeometry(up.arm, 0.09, 0.09)
  cross.translate(0, up.armY, 0)
  const utilityPoleGeo = mergeGeometries([shaft, cross], false)!
  shaft.dispose()
  cross.dispose()
  utilityPoleGeo.computeBoundingSphere()

  const postGeo = new THREE.BoxGeometry(1, 1, 1)
  return { solar, galvanised, fencePanel, lightPole, concretePole, wire, guardrail, lightPoleGeo, utilityPoleGeo, postGeo }
}

// ---------------------------------------------------------------------------------------------
// the site rule

interface SiteRule {
  ground: Ground
  grid: GridShape
  /** exact centreline distances taken (for the stats) */
  projections: number
}

/**
 * Whether something may stand at (x, z): inside the terrain grid, ≥ `minD` from the centreline
 * (`lo` is a lower bound of that distance — the feature's `dmin` minus the sample's distance to
 * the feature's nearest vertex, valid because distance to the centreline is 1-Lipschitz — so
 * the projection is only taken when the bound does not settle it) and on no drawn ground face.
 */
function standOk(rule: SiteRule, x: number, z: number, lo: number, minD: number): boolean {
  if (!inGrid(rule.grid, x, z)) return false
  if (lo < minD) {
    rule.projections++
    if (rule.ground.plan.project(x, z).d < minD) return false
  }
  return !rule.ground.builtY(x, z)
}

/**
 * A pole's clearance from the OSM buildings, from the shipped centroid and area alone (the
 * footprints are never decoded): a disc of `buildingClear × sqrt(area)` around the centroid,
 * ≈ 0.6 of the side of a square footprint. Read straight from `SUR_BUILDINGS` rather than from
 * `ctx.keepOut` / `ctx.keepOutPolys`, which also carry the car parks the light poles stand in.
 * The buildings are hashed into 100 m tiles once per build (≈ 1,300 footprints).
 */
class BuildingClearance {
  private static readonly TILE = 100
  private readonly tiles = new Map<number, { x: number; z: number; r: number }[]>()
  constructor(enScale: number, grid: GridShape, margin: number) {
    for (const b of SUR_BUILDINGS) {
      const x = b.centroid[0] * enScale, z = -b.centroid[1] * enScale
      if (outsideGrid(grid, x, z, margin)) continue
      const r = Math.sqrt(Math.max(0, b.area)) * OUTSKIRTS.buildingClear
      const disc = { x, z, r }
      const reach = Math.ceil(r / BuildingClearance.TILE)
      const i0 = Math.floor(x / BuildingClearance.TILE), j0 = Math.floor(z / BuildingClearance.TILE)
      for (let i = i0 - reach; i <= i0 + reach; i++) {
        for (let j = j0 - reach; j <= j0 + reach; j++) {
          const key = i * 8192 + j
          let list = this.tiles.get(key)
          if (!list) this.tiles.set(key, (list = []))
          list.push(disc)
        }
      }
    }
  }
  hit(x: number, z: number): boolean {
    const key = Math.floor(x / BuildingClearance.TILE) * 8192 + Math.floor(z / BuildingClearance.TILE)
    for (const d of this.tiles.get(key) ?? []) if ((x - d.x) * (x - d.x) + (z - d.z) * (z - d.z) < d.r * d.r) return true
    return false
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Queue the outskirts' deferred jobs (see the module comment) and push the solar farms' rings
 * into `ctx.keepOutPolys`. Returns the plan's counts for the offline harness.
 */
export function buildOutskirts(ctx: EnvBuildContext): OutskirtsStats {
  const { track, terrain, ground, quality: q, farField } = ctx
  const grid: GridShape = terrain.grid()
  const enScale = track.enScale
  const rule: SiteRule = { ground, grid, projections: 0 }
  const castShadow = q.farField.shadows
  let materials: Materials | null = null
  const mats = (): Materials => (materials ??= makeMaterials(ctx))
  // both built by the first deferred job that needs them, never during the synchronous build
  let clearance: BuildingClearance | null = null
  const buildings = (): BuildingClearance => (clearance ??= new BuildingClearance(enScale, grid, OUTSKIRTS.gridMargin))
  let jobs = 0
  const MIN_D = OUTSKIRTS.minD

  const circuit = SUR_SITES.find((s) => s.id === OUTSKIRTS.fence.wayId && s.closed)
  if (!circuit && import.meta.dev) console.warn(`[outskirts] circuit boundary ${OUTSKIRTS.fence.wayId} is not in SUR_SITES: no perimeter fence, and the poles cannot tell inside from outside`)
  const circuitRing: XZ[] = circuit ? polyline(worldRing(circuit, enScale)) : []
  const circuitBox = circuitRing.length ? ringBBox(circuitRing) : ([0, 0, 0, 0] as [number, number, number, number])
  const insideCircuit = (x: number, z: number) => circuitRing.length > 0 && inBBox(x, z, circuitBox) && pointInRing(x, z, circuitRing)
  const centroidWorld = (f: SurFeatureBase): XZ => [f.centroid[0] * enScale, -f.centroid[1] * enScale]

  // ===========================================================================================
  // 1. solar farms
  const S = OUTSKIRTS.solar
  interface SolarSeg { x0: number; x1: number; z: number; lo: number; id: number }
  const solarByCell = new Map<number, SolarSeg[]>()
  let solarPolys = 0, solarRows = 0, solarSegs = 0
  const cosT = Math.cos(S.tilt), sinT = Math.sin(S.tilt)
  const depthXZ = S.depth * cosT, rise = S.depth * sinT
  for (const f of SUR_SOLAR) {
    const ring = polyline(worldRing(f, enScale))
    if (ring.length < 3) continue
    const box = ringBBox(ring)
    // every farm keeps the woods out, whether or not its panels are built
    ctx.keepOutPolys.push({ ring, box })
    if (box[2] <= grid.x0 || box[0] >= grid.x0 + grid.w || box[3] <= grid.z0 || box[1] >= grid.z0 + grid.d) continue
    solarPolys++
    // rows: the panel's front edge (south, +z) lies on the scanline, the back edge depthXZ north of it
    const k0 = Math.ceil((box[1] + S.inset + depthXZ) / S.pitch), k1 = Math.floor((box[3] - S.inset) / S.pitch)
    for (let k = k0; k <= k1; k++) {
      const zf = k * S.pitch, zb = zf - depthXZ
      // the span along x where BOTH the front and the back scanlines are inside the ring
      const spansAt = (z: number): [number, number][] => {
        const xs: number[] = []
        for (let i = 0, n = ring.length; i < n; i++) {
          const a = ring[i]!, b = ring[(i + 1) % n]!
          if (a[1] > z !== b[1] > z) xs.push(a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
        }
        xs.sort((p, r) => p - r)
        const out: [number, number][] = []
        for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]! + S.inset, xs[i + 1]! - S.inset])
        return out
      }
      const front = spansAt(zf), back = spansAt(zb)
      for (const [fa, fb] of front) {
        for (const [ba, bb] of back) {
          const a = Math.max(fa, ba), b = Math.min(fb, bb)
          if (b - a < S.minSegment) continue
          solarRows++
          const n = Math.max(1, Math.round((b - a) / S.segment))
          const len = (b - a) / n
          for (let i = 0; i < n; i++) {
            const x0 = a + i * len, x1 = x0 + len
            if (x1 - x0 < S.minSegment) continue
            const mx = (x0 + x1) / 2, mz = zf - depthXZ / 2
            if (!inGrid(grid, x0, zb) || !inGrid(grid, x1, zf) || !inGrid(grid, x0, zf) || !inGrid(grid, x1, zb)) continue
            const lo = f.dmin - Math.max(nearestVertex(x0, zf, ring), nearestVertex(x1, zf, ring), nearestVertex(mx, mz, ring)) - S.depth
            push(solarByCell, farField.cellOf(mx, mz), { x0, x1, z: zf, lo, id: f.id })
            solarSegs++
          }
        }
      }
    }
  }
  for (const [cell, segs] of solarByCell) {
    jobs++
    farField.defer('dressing', `solar-${cell}`, 4, () => {
      const m = mats()
      const sink = new TriSink()
      let built = 0, onMask = 0
      const N = [0, cosT, sinT] as const
      const NEG = [0, -cosT, -sinT] as const
      for (const s of segs) {
        const zf = s.z, zb = zf - depthXZ
        const samples: [number, number][] = [[s.x0, zf], [s.x1, zf], [s.x0, zb], [s.x1, zb], [(s.x0 + s.x1) / 2, (zf + zb) / 2]]
        let ok = true
        for (const [x, z] of samples) if (!standOk(rule, x, z, s.lo, MIN_D)) { ok = false; break }
        if (!ok) continue
        // the front edge stands `front` over the ground it is on; where the ground rises to the
        // north (the back edge is `rise` higher) the whole panel is lifted so the BACK edge keeps
        // that clearance too, instead of the row burying itself in the slope
        const yF0 = Math.max(ground.standY(s.x0, zf), ground.standY(s.x0, zb) - rise) + S.front
        const yF1 = Math.max(ground.standY(s.x1, zf), ground.standY(s.x1, zb) - rise) + S.front
        const yB0 = yF0 + rise, yB1 = yF1 + rise
        const FL = [s.x0, yF0, zf], FR = [s.x1, yF1, zf], BR = [s.x1, yB1, zb], BL = [s.x0, yB0, zb]
        const down = (p: number[]) => [p[0]! - N[0] * S.thick, p[1]! - N[1] * S.thick, p[2]! - N[2] * S.thick]
        const fl = down(FL), fr = down(FR), br = down(BR), bl = down(BL)
        const len = s.x1 - s.x0
        // top: u along the row, v down the slope (metres; the texture's repeat maps modules onto them)
        sink.quad(FL, FR, BR, BL, N, [[0, 0], [len, 0], [len, S.depth], [0, S.depth]])
        sink.quad(fl, fr, br, bl, NEG, [[0, 0], [len, 0], [len, S.depth], [0, S.depth]])
        const edge: [number, number][] = [[0, 0], [len, 0], [len, S.thick], [0, S.thick]]
        sink.quad(FL, FR, fr, fl, [0, -sinT, cosT], edge)
        sink.quad(BL, BR, br, bl, [0, sinT, -cosT], edge)
        const side: [number, number][] = [[0, 0], [S.depth, 0], [S.depth, S.thick], [0, S.thick]]
        sink.quad(FL, BL, bl, fl, [-1, 0, 0], side)
        sink.quad(FR, BR, br, fr, [1, 0, 0], side)
        built++
        if (ctx.landCover.classAt((s.x0 + s.x1) / 2, (zf + zb) / 2) === 'solar') onMask++
      }
      const geo = sink.build()
      if (!geo) return null
      const mesh = new THREE.Mesh(geo, m.solar)
      mesh.name = `solar-${cell}`
      mesh.castShadow = castShadow
      mesh.receiveShadow = true
      mesh.userData.outskirts = { family: 'solar', segments: built, onMask }
      farField.register({ kind: 'solar', name: `solar-${cell}`, cell, levels: [{ object: mesh, range: Infinity, static: true }] })
      return mesh
    })
  }

  // ===========================================================================================
  // 2. the perimeter fence
  const F = OUTSKIRTS.fence
  let fencePosts = 0
  const fenceByCell = new Map<number, number[]>()
  const fenceSamples: Sample[] = circuitRing.length ? resample(circuitRing, F.step, true) : []
  /** posts dropped for a gate: |arc − gate arc| < gap / 2 (wrapping) */
  const perimeter = circuitRing.length ? pathLength(circuitRing, true) : 0
  const gateArcs: number[] = []
  if (fenceSamples.length) {
    for (const g of SUR_SITES) {
      if (g.role !== 'gate') continue
      const [gx, gz] = centroidWorld(g)
      gateArcs.push(nearestArc(circuitRing, true, gx, gz).t)
    }
  }
  const atGate = (t: number) => gateArcs.some((g) => { const d = Math.abs(t - g); return Math.min(d, perimeter - d) < F.gateGap / 2 })
  fenceSamples.forEach((s, i) => {
    if (atGate(s.t)) return
    push(fenceByCell, farField.cellOf(s.x, s.z), i)
    fencePosts++
  })
  /** site of post i, memoised across the cells' jobs (a rail spans two cells at a boundary) */
  const fenceSite = new Map<number, number | null>()
  const fenceY = (i: number): number | null => {
    let y = fenceSite.get(i)
    if (y !== undefined) return y
    const s = fenceSamples[i]!
    if (!inGrid(grid, s.x, s.z) || atGate(s.t)) y = null
    else {
      rule.projections++
      y = ground.plan.project(s.x, s.z).d < F.minD ? null : ground.standY(s.x, s.z)
    }
    fenceSite.set(i, y)
    return y
  }
  for (const [cell, posts] of fenceByCell) {
    jobs++
    farField.defer('dressing', `fence-${cell}`, 6, () => {
      const m = mats()
      const matrices: THREE.Matrix4[] = []
      const rail = new TriSink()
      const panel = new TriSink()
      const H = F.height, R = F.rail
      let panels = 0
      for (const i of posts) {
        const y = fenceY(i)
        if (y === null) continue
        const s = fenceSamples[i]!
        _p.set(s.x, y - F.bury + (H + F.bury) / 2, s.z)
        _q.identity()
        matrices.push(new THREE.Matrix4().compose(_p, _q, _s.set(F.post, H + F.bury, F.post)))
        // the rail and the panel to the next post (the last post's run closes the ring)
        const j = (i + 1) % fenceSamples.length
        const yj = fenceY(j)
        if (yj === null) continue
        const n = fenceSamples[j]!
        const ex = n.x - s.x, ez = n.z - s.z
        const len = Math.hypot(ex, ez) || 1
        const px = (ez / len) * (R / 2), pz = (-ex / len) * (R / 2)
        const a0 = [s.x - px, y + H, s.z - pz], a1 = [s.x + px, y + H, s.z + pz]
        const b0 = [n.x - px, yj + H, n.z - pz], b1 = [n.x + px, yj + H, n.z + pz]
        const a0d = [a0[0]!, y + H - R, a0[2]!], a1d = [a1[0]!, y + H - R, a1[2]!]
        const b0d = [b0[0]!, yj + H - R, b0[2]!], b1d = [b1[0]!, yj + H - R, b1[2]!]
        const uv = [[0, 0], [1, 0], [1, 1], [0, 1]]
        rail.quad(a0, b0, b1, a1, [0, 1, 0], uv)
        rail.quad(a0, b0, b0d, a0d, [-px, 0, -pz], uv)
        rail.quad(a1, b1, b1d, a1d, [px, 0, pz], uv)
        if (q.fence) {
          // metre uv: u along the ring, v up from the ground (cutoutFromAssets maps the tile onto it)
          panel.quad([s.x, y + F.panelBottom, s.z], [n.x, yj + F.panelBottom, n.z], [n.x, yj + H, n.z], [s.x, y + H, s.z], [px, 0, pz], [[s.t, F.panelBottom], [s.t + len, F.panelBottom], [s.t + len, H], [s.t, H]])
          panels++
        }
      }
      if (!matrices.length) return null
      const root = new THREE.Group()
      root.name = `fence-${cell}`
      const inst = new THREE.InstancedMesh(m.postGeo, m.galvanised, matrices.length)
      matrices.forEach((mat, k) => inst.setMatrixAt(k, mat))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = castShadow
      inst.frustumCulled = true
      inst.computeBoundingSphere()
      inst.name = `fencePosts-${cell}`
      root.add(inst)
      const railGeo = rail.build()
      if (railGeo) {
        const mesh = new THREE.Mesh(railGeo, m.galvanised)
        mesh.name = `fenceRail-${cell}`
        mesh.castShadow = castShadow
        root.add(mesh)
      }
      const panelGeo = panel.build()
      if (panelGeo) {
        const mesh = new THREE.Mesh(panelGeo, m.fencePanel)
        mesh.name = `fencePanel-${cell}`
        mesh.castShadow = false
        root.add(mesh)
      }
      root.userData.outskirts = { family: 'fence', posts: matrices.length, panels }
      farField.register({ kind: 'fence', name: `fence-${cell}`, cell, levels: [{ object: root, range: OUTSKIRTS.fence.range }] })
      return root
    })
  }

  // ===========================================================================================
  // 3. light poles: car-park row dividers and the service roads inside the circuit
  const LP = OUTSKIRTS.lightPole
  interface PoleSite { x: number; z: number; dx: number; dz: number; lo: number; clear: boolean }
  const lightCandidates: PoleSite[] = []
  for (const f of SUR_PARKING) {
    if (f.area < LP.parkMinArea) continue
    const [fx, fz] = centroidWorld(f)
    if (outsideGrid(grid, fx, fz, OUTSKIRTS.gridMargin)) continue
    const ring = polyline(worldRing(f, enScale))
    if (ring.length < 3) continue
    const box = ringBBox(ring)
    if (box[2] <= grid.x0 || box[0] >= grid.x0 + grid.w || box[3] <= grid.z0 || box[1] >= grid.z0 + grid.d) continue
    const pa = principalAxis(ring)
    if (pa.along < LP.parkPitch || pa.across < 12) continue
    // dividers parallel to the rows every two rows, poles along them every parkPitch metres
    const K = Math.floor(pa.across / 2 / LP.rowPitch + 0.5)
    for (let k = -K; k <= K; k++) {
      const c = (k + 0.5) * LP.rowPitch
      if (Math.abs(c) > pa.across / 2) continue
      const t0 = -pa.along / 2 + LP.parkPitch / 2
      for (let t = t0; t <= pa.along / 2; t += LP.parkPitch) {
        const x = pa.cx + pa.ax * t - pa.az * c, z = pa.cz + pa.az * t + pa.ax * c
        if (!inBBox(x, z, box) || !pointInRing(x, z, ring)) continue
        // 3 m of car park on every side (the pole is not on the edge)
        if (!pointInRing(x + 3, z, ring) || !pointInRing(x - 3, z, ring) || !pointInRing(x, z + 3, ring) || !pointInRing(x, z - 3, ring)) continue
        // the arm reaches across the aisle, perpendicular to the rows; a pole standing in the
        // middle of a car park owes no clearance to the buildings around it
        lightCandidates.push({ x, z, dx: -pa.az, dz: pa.ax, lo: f.dmin - nearestVertex(x, z, ring), clear: false })
      }
    }
  }
  for (const w of SUR_ROADS) {
    if (w.kind !== 'service') continue
    const [cx, cz] = centroidWorld(w)
    if (outsideGrid(grid, cx, cz, OUTSKIRTS.gridMargin)) continue
    const pts = polyline(worldRing(w, enScale))
    const side = mulberry(w.id)() < 0.5 ? 1 : -1
    for (const s of resample(pts, LP.roadPitch, false, LP.roadPitch / 2)) {
      const nx = -s.tz * side, nz = s.tx * side
      const x = s.x + nx * LP.roadOffset, z = s.z + nz * LP.roadOffset
      // the circuit's own service roads only — tested per sample, not on the way's centroid
      if (!insideCircuit(x, z)) continue
      lightCandidates.push({ x, z, dx: -nx, dz: -nz, lo: w.dmin - s.dv - LP.roadOffset, clear: true })
    }
  }
  // nearest to the track first: the lower bound orders the candidates, the exact rule filters them
  lightCandidates.sort((a, b) => a.lo - b.lo)
  const lightBudget = q.farField.lightPoles
  if (lightCandidates.length && lightBudget > 0) {
    jobs++
    farField.defer('dressing', 'poles', 30, () => {
      const m = mats()
      const matrices: THREE.Matrix4[] = []
      for (const c of lightCandidates) {
        if (matrices.length >= lightBudget) break
        if (!standOk(rule, c.x, c.z, c.lo, MIN_D)) continue
        if (c.clear && buildings().hit(c.x, c.z)) continue
        _p.set(c.x, ground.standY(c.x, c.z) - LP.bury, c.z)
        matrices.push(new THREE.Matrix4().compose(_p, yawTo(c.dx, c.dz, _q), _s.set(1, 1, 1)))
      }
      if (!matrices.length) return null
      const entries = farField.registerBuckets('poles', 'poles', m.lightPoleGeo, m.lightPole, matrices, null, [{ range: LP.range }], { castShadow })
      for (const e of entries) e.levels[0]!.object.userData.outskirts = { family: 'poles', poles: (e.levels[0]!.object as THREE.InstancedMesh).count }
      return null
    })
  }

  // ===========================================================================================
  // 4. utility poles + wires, guardrails
  const U = OUTSKIRTS.utility, G = OUTSKIRTS.guardrail
  interface UPole { x: number; z: number; nx: number; nz: number; lo: number; way: number; idx: number }
  const uPoles: UPole[] = []
  const uByCell = new Map<number, number[]>()
  interface RailWay { pts: XZ[]; samples: Sample[]; off: number; dmin: number }
  const railWays: RailWay[] = []
  const railByCell = new Map<number, [number, number][]>()
  let railSamples = 0
  for (const w of SUR_ROADS) {
    const utility = OUTSKIRTS.utilityKinds.includes(w.kind)
    const guard = G.kinds.includes(w.kind)
    if (!utility && !guard) continue
    const [cx, cz] = centroidWorld(w)
    if (outsideGrid(grid, cx, cz, OUTSKIRTS.gridMargin)) continue
    const pts = polyline(worldRing(w, enScale))
    if (pts.length < 2) continue
    if (utility) {
      const side = mulberry(w.id * 7 + 1)() < 0.5 ? 1 : -1
      const off = Math.max(U.offset, w.width / 2 + 1)
      const samples = resample(pts, U.pitch, false, U.pitch / 2)
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!
        const nx = -s.tz * side, nz = s.tx * side
        const x = s.x + nx * off, z = s.z + nz * off
        // outside the circuit's own grounds, tested per pole rather than on the way's centroid
        if (!inGrid(grid, x, z) || insideCircuit(x, z)) continue
        const idx = uPoles.length
        uPoles.push({ x, z, nx, nz, lo: w.dmin - s.dv - off, way: w.id, idx: i })
        push(uByCell, farField.cellOf(x, z), idx)
      }
    }
    if (guard) {
      const samples = resample(pts, G.step, false, 0)
      // the far end of the way, so the rail reaches the last vertex
      const last = pts[pts.length - 1]!, prev = pts[pts.length - 2]!
      const ex = last[0] - prev[0], ez = last[1] - prev[1], el = Math.hypot(ex, ez) || 1
      const total = samples.length ? samples[samples.length - 1]!.t : 0
      if (samples.length && Math.hypot(last[0] - samples[samples.length - 1]!.x, last[1] - samples[samples.length - 1]!.z) > 1) samples.push({ x: last[0], z: last[1], tx: ex / el, tz: ez / el, t: total + Math.hypot(last[0] - samples[samples.length - 1]!.x, last[1] - samples[samples.length - 1]!.z), dv: 0 })
      if (samples.length < 2) continue
      const wi = railWays.length
      railWays.push({ pts, samples, off: w.width / 2 + G.edge, dmin: w.dmin })
      for (let i = 0; i + 1 < samples.length; i++) {
        const s = samples[i]!
        if (!inGrid(grid, s.x, s.z)) continue
        push(railByCell, farField.cellOf(s.x, s.z), [wi, i] as [number, number])
        railSamples++
      }
    }
  }
  /** utility pole i: its ground height, null where it may not stand — memoised across the cells' jobs (a wire span crosses a cell boundary) */
  const uSite = new Map<number, number | null>()
  const uY = (i: number): number | null => {
    let y = uSite.get(i)
    if (y !== undefined) return y
    const p = uPoles[i]!
    // the crossarm's half-length more, so the wires hung from its ends keep the 140 m too
    y = standOk(rule, p.x, p.z, p.lo, MIN_D + U.arm / 2 + U.wireW) && !buildings().hit(p.x, p.z) ? ground.standY(p.x, p.z) : null
    uSite.set(i, y)
    return y
  }
  /** guardrail sample (way, i, side): the rail's base height, null where it may not stand */
  const railSite = new Map<number, number | null>()
  const railY = (wi: number, i: number, side: 1 | -1): number | null => {
    const key = (wi * 65536 + i) * 2 + (side > 0 ? 1 : 0)
    let y = railSite.get(key)
    if (y !== undefined) return y
    const w = railWays[wi]!, s = w.samples[i]!
    const x = s.x - s.tz * side * w.off, z = s.z + s.tx * side * w.off
    y = standOk(rule, x, z, w.dmin - s.dv - w.off, MIN_D) ? ground.standY(x, z) : null
    railSite.set(key, y)
    return y
  }
  const utilityCells = new Set<number>([...uByCell.keys(), ...railByCell.keys()])
  const armY = U.armY, wireY = U.height + 0.1
  for (const cell of utilityCells) {
    jobs++
    farField.defer('dressing', `utility-${cell}`, 8, () => {
      const m = mats()
      const matrices: THREE.Matrix4[] = []
      const wires = new TriSink()
      let spans = 0
      for (const i of uByCell.get(cell) ?? []) {
        const y = uY(i)
        if (y === null) continue
        const p = uPoles[i]!
        _p.set(p.x, y - U.bury, p.z)
        matrices.push(new THREE.Matrix4().compose(_p, yawTo(p.nx, p.nz, _q), _s.set(1, 1, 1)))
        // wires to the next pole of the same way
        const j = i + 1
        const n = uPoles[j]
        if (!n || n.way !== p.way || n.idx !== p.idx + 1) continue
        const yn = uY(j)
        if (yn === null) continue
        const span = Math.hypot(n.x - p.x, n.z - p.z)
        if (span < 3 || span > U.maxSpan) continue
        const sag = U.sagK * span * span
        const dx = (n.x - p.x) / span, dz = (n.z - p.z) / span
        // the strip stands on edge (its width is in Y): a catenary is looked at from the side,
        // and a ribbon lying flat 11 m up is edge-on — invisible — from every camera on the ground
        const out = [-dz, 0, dx]
        const attach: [number, number][] = [[-U.arm / 2 + 0.05, armY], [U.arm / 2 - 0.05, armY], [0, wireY]]
        for (const [lx, ly] of attach) {
          const ax = p.x + p.nx * lx, az = p.z + p.nz * lx, ay = y - U.bury + ly
          const bx = n.x + n.nx * lx, bz = n.z + n.nz * lx, by = yn - U.bury + ly
          let prev0: number[] | null = null, prev1: number[] | null = null
          for (let k = 0; k <= U.wireSegs; k++) {
            const t = k / U.wireSegs
            const x = ax + (bx - ax) * t, z = az + (bz - az) * t
            const yy = ay + (by - ay) * t - sag * 4 * t * (1 - t)
            const c0 = [x, yy - U.wireW / 2, z], c1 = [x, yy + U.wireW / 2, z]
            if (prev0 && prev1) wires.quad(prev0, prev1, c1, c0, out, [[0, 0], [1, 0], [1, 1], [0, 1]])
            prev0 = c0
            prev1 = c1
          }
        }
        spans++
      }
      const rail = new TriSink()
      let railM = 0
      const bottom = BARRIER_KIND.guardrail.bottom, top = BARRIER_KIND.guardrail.top
      for (const [wi, i] of railByCell.get(cell) ?? []) {
        const w = railWays[wi]!, s = w.samples[i]!, n = w.samples[i + 1]!
        for (const side of [1, -1] as const) {
          const ya = railY(wi, i, side), yb = railY(wi, i + 1, side)
          if (ya === null || yb === null) continue
          const ax = s.x - s.tz * side * w.off, az = s.z + s.tx * side * w.off
          const bx = n.x - n.tz * side * w.off, bz = n.z + n.tx * side * w.off
          // the face looks at the road
          const out = [s.tz * side, 0, -s.tx * side]
          rail.quad([ax, ya + bottom, az], [bx, yb + bottom, bz], [bx, yb + top, bz], [ax, ya + top, az], out, [[s.t / G.tile, 0], [n.t / G.tile, 0], [n.t / G.tile, 1], [s.t / G.tile, 1]])
          railM += n.t - s.t
        }
      }
      if (!matrices.length && !rail.triangles && !wires.triangles) return null
      // the poles and the rail are one LOD level, the wires (a shorter range) another entry;
      // both are registered parentless, so the registry adds and attaches each on its own
      const near = new THREE.Group()
      near.name = `utility-${cell}`
      if (matrices.length) {
        const inst = new THREE.InstancedMesh(m.utilityPoleGeo, m.concretePole, matrices.length)
        matrices.forEach((mat, k) => inst.setMatrixAt(k, mat))
        inst.instanceMatrix.needsUpdate = true
        inst.castShadow = castShadow
        inst.frustumCulled = true
        inst.computeBoundingSphere()
        inst.name = `utilityPoles-${cell}`
        near.add(inst)
      }
      const railGeo = rail.build()
      if (railGeo) {
        const mesh = new THREE.Mesh(railGeo, m.guardrail)
        mesh.name = `guardrail-${cell}`
        mesh.castShadow = castShadow
        mesh.receiveShadow = true
        near.add(mesh)
      }
      near.userData.outskirts = { family: 'utility', poles: matrices.length, guardrailM: Math.round(railM) }
      farField.register({ kind: 'poles', name: `utility-${cell}`, cell, levels: [{ object: near, range: U.range }] })
      const wireGeo = wires.build()
      if (wireGeo) {
        const mesh = new THREE.Mesh(wireGeo, m.wire)
        mesh.name = `wires-${cell}`
        mesh.castShadow = false
        mesh.receiveShadow = false
        mesh.userData.outskirts = { family: 'wires', spans, strips: spans * 3 }
        farField.register({ kind: 'poles', name: `wires-${cell}`, cell, levels: [{ object: mesh, range: U.wiresRange }] })
      }
      return null
    })
  }

  const stats: OutskirtsStats = {
    solar: { polygons: solarPolys, rows: solarRows, segments: solarSegs, cells: solarByCell.size },
    fence: { posts: fencePosts, cells: fenceByCell.size },
    lightPoles: { candidates: lightCandidates.length, budget: lightBudget },
    utility: { poles: uPoles.length, guardrailSamples: railSamples, cells: utilityCells.size },
    jobs,
  }
  if (import.meta.dev) console.info(`[outskirts] solar ${solarPolys} farms / ${solarSegs} segments in ${solarByCell.size} cells, fence ${fencePosts} posts in ${fenceByCell.size} cells, ${lightCandidates.length} light-pole sites for ${lightBudget}, ${uPoles.length} utility poles + ${railSamples} guardrail samples in ${utilityCells.size} cells; ${jobs} jobs`)
  return stats
}
