import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SUR_BUILDINGS, SUR_PARKING, SUR_ROADS, SUR_SITES, SUR_SOLAR } from '~/data/suzuka-surroundings'
import { worldRing, type SurFeatureBase } from '~/data/en-codec'
import { ROAD_FURNITURE, SOLAR_DETAIL } from '~/data/surroundings-spec'
import type { EnvBuildContext } from './environment'
import { inBBox, pointInRing, principalAxis, ringArea, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
import { TriSink, inGrid, nearestArc, outsideGrid, pathLength, resample, siteOk, type Sample, type SiteRule } from './far-lines'
import { FENCE_TILE_M } from './barriers'
import { cutoutFromAssets, cutoutParams, pbrFromAssets, tileMetres } from './materials'
import { modelPrototype } from './model-proto'
import { cached, chainLinkTexture, makeTexture, mulberry, paint, scaled } from './textures'
import { offsetAt, roadNetwork, walk } from './road-section'

/**
 * Outskirts furniture (plan §2b, §2e): the solar farms, the circuit's perimeter fence, the light
 * poles of the car parks and the service roads, and the utility poles with their wires along
 * the public roads — everything that STANDS on `ground.standY` outside the fences, built as
 * deferred 'dressing' jobs of `ctx.farField`, one per family and 250 m cell, and chosen per cell
 * by the registry's LOD pass. (The guardrails, delineators, mirrors, signs and signals of the
 * public roads are road-furniture.ts, R フェーズ Phase 3; the transformer cans it hangs on every
 * fourth pole read the same `utilityPoles` plan, so both modules agree on where a pole stands.)
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
 *    read at the front edge) with the panel face on top — SolarPanel003 through
 *    `pbrFromAssets` (the uv is metres), the painted module texture (navy cells, silver frame;
 *    one module = 1.0 × 1.65 m) without the pack. The rings are pushed into `ctx.keepOutPolys`
 *    synchronously, so the forest's stems and the trackside scatter stay out of the farms.
 *    `solarDetail-<cell>` (kind 'solar', SOLAR_DETAIL.range, `Quality.farField.solarDetail`)
 *    is the near level over the same cells, ONE Group entry per cell: the racks (a front and a
 *    back post every 6 m under each segment, two rails under the panel's edges, galvanised),
 *    an inverter hut on every farm of ≥ 2,000 m² (concrete box, galvanised roof slab, in the
 *    row gap nearest the polygon's centroid) and a chain-link fence 0.8 m inside every farm's
 *    OSM edge (instanced posts every 4 m, a top rail, the mesh panel with `Quality.fence`).
 *    None of it casts a shadow (posts, rails and mesh are under a shadow texel; the hut's would
 *    be the one worth having, but one rule per entry keeps the shadow pass free of 26 draws).
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
 *  - UTILITY `utility-<cell>` (kind 'poles', 600 m) + `wires-<cell>` (400 m): JIS 12 m concrete
 *    poles (ROAD_FURNITURE.pole — 10.5 m exposed, φ320 → φ190, the HV crossarm with three pin
 *    insulators at 9.6 m, the LV arm at 8.2 m; 72 triangles) every 35 m on one side of the
 *    tertiary / unclassified / residential roads outside the circuit, placed on the road
 *    NETWORK (road-section.ts `walk` / `offsetAt`, so a pole stands off the real paved edge and
 *    never inside a junction mouth), and six catenary wires (thin dark strips standing on edge —
 *    a wire has to read as a line from a camera at eye level, and a strip lying flat is
 *    invisible there — no shadow) between consecutive poles: three HV on the crossarm, three LV
 *    on the lower arm. With the jp_denchu GLB in the pack a HERO entry `utilityHero-<cell>`
 *    draws the scanned pole over the procedural one inside `pole.heroRange`, thinning out over
 *    `pole.heroRamp` so the hand-off is a fade rather than a pop.
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
    /** how deep the pole is set (m); the exposed height, taper, arms and pitch are ROAD_FURNITURE.pole */
    bury: 0.4,
    /** wires: sag = sagK × span² (m), strip height (m, the strip stands on edge), segments per span, the longest span a wire is strung over (m) */
    sagK: 0.00035,
    wireW: 0.08,
    wireSegs: 5,
    maxSpan: 70,
    range: 600,
    wiresRange: 400,
    /** pin insulator on the HV crossarm: diameter and height (m) */
    insulator: { d: 0.08, h: 0.15 },
    /** a hero GLB whose footprint's long side exceeds this fraction of its height is not a pole (an exploded parts layout) and is refused */
    heroMaxAspect: 0.6,
  },
  /** highway classes that carry utility poles (outside the circuit polygon) */
  utilityKinds: ['tertiary', 'unclassified', 'residential'] as readonly string[],
} as const

export interface OutskirtsStats {
  /** solar farms: polygons planned, rows and segments planned (before the ground rule), cells; the detail level's cells, huts and fence posts planned (0 without `solarDetail`) */
  solar: { polygons: number; rows: number; segments: number; cells: number; detailCells: number; huts: number; fencePosts: number }
  /** perimeter fence: posts planned, cells */
  fence: { posts: number; cells: number }
  /** light-pole candidates (car parks / service roads) and the tier's budget */
  lightPoles: { candidates: number; budget: number }
  /** utility poles planned, cells; `heroDrop`: the jp_denchu GLB is in the registry (whether it is pole-shaped is decided by the first job) */
  utility: { poles: number; cells: number; heroDrop: boolean }
  /** deferred jobs queued */
  jobs: number
}

// ---------------------------------------------------------------------------------------------
// small helpers

/** [x, z, x, z, …] → points */
function polyline(flat: Float64Array): XZ[] {
  return ringFromFlat(flat)
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

function push<T>(map: Map<number, T[]>, key: number, item: T) {
  let list = map.get(key)
  if (!list) map.set(key, (list = []))
  list.push(item)
}

/**
 * The ring moved `d` inward (mitred corners, the mitre capped at ≈ 3 × d for acute vertices);
 * the ring itself when it is too narrow to hold the inset. The outward side is read from the
 * ring's winding, so either orientation works.
 */
function insetRingXZ(ring: readonly XZ[], d: number): XZ[] {
  const n = ring.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    area += p[0] * q[1] - q[0] * p[1]
  }
  const sgn = area > 0 ? 1 : -1
  const normals: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    const ex = q[0] - p[0], ez = q[1] - p[1]
    const len = Math.hypot(ex, ez) || 1
    normals.push([(sgn * ez) / len, (-sgn * ex) / len])
  }
  const [x0, z0, x1, z1] = ringBBox(ring)
  if (Math.min(x1 - x0, z1 - z0) < d * 3) return ring.slice()
  const out: XZ[] = []
  for (let i = 0; i < n; i++) {
    const n0 = normals[(i + n - 1) % n]!, n1 = normals[i]!
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1]
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-6) { mx = n1[0]; mz = n1[1] } else { mx /= ml; mz /= ml }
    const cosHalf = Math.max(0.34, Math.sqrt(Math.max(0, (1 + (n0[0] * n1[0] + n0[1] * n1[1])) / 2)))
    const len = d / cosHalf
    out.push([ring[i]![0] - mx * len, ring[i]![1] - mz * len])
  }
  return out
}

/**
 * An axis-aligned box (x0..x1 × y0..y1 × z0..z1) into a TriSink, faces named by the axis they
 * look along dropped through `skip` ('-y' the underside, '+y' the top, …); uv = metres along
 * each face for a tiled material. 2 triangles per kept face.
 */
function boxFaces(sink: TriSink, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, skip: readonly string[] = []) {
  const uv = (a: number, b: number): [number, number][] => [[0, 0], [a, 0], [a, b], [0, b]]
  const w = x1 - x0, h = y1 - y0, d = z1 - z0
  if (!skip.includes('-y')) sink.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], uv(w, d))
  if (!skip.includes('+y')) sink.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], uv(w, d))
  if (!skip.includes('+z')) sink.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], uv(w, h))
  if (!skip.includes('-z')) sink.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], uv(w, h))
  if (!skip.includes('-x')) sink.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], uv(d, h))
  if (!skip.includes('+x')) sink.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], uv(d, h))
}

/** rotation about Y that maps local +x onto the world direction (dx, dz) */
function yawTo(dx: number, dz: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromAxisAngle(Y_UP, Math.atan2(-dz, dx))
}

const Y_UP = new THREE.Vector3(0, 1, 0)
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3(1, 1, 1)

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

/**
 * The panel face: SolarPanel003 (diff / nor_gl / arm, `tile` m per tile from the manifest) on
 * the segments' metre uv — the maps are cloned so their repeat (1 / tile) stays this material's
 * own — or the painted module texture when the pack (or any of its maps) is absent. The painted
 * fallback keeps its own repeat (one module = moduleW × moduleD m).
 */
function solarMaterial(ctx: EnvBuildContext): THREE.MeshStandardMaterial {
  const fallback = () => new THREE.MeshStandardMaterial({ map: solarPanelTexture(), roughness: 0.25, metalness: 0.6 })
  const reg = ctx.assets
  if (!reg) return fallback()
  const m = pbrFromAssets(reg, 'solarpanel003', { fallback, normalScale: 0.5, extra: { envMapIntensity: 1 } })
  if (!m.aoMap) return m // the fallback came back (no arm map)
  const tile = tileMetres(reg, 'tex/solarpanel003/diff', 2.6)
  const own = <T extends THREE.Texture>(t: T): T => {
    const c = t.clone() as T
    c.repeat.set(1 / tile, 1 / tile)
    c.needsUpdate = true
    return c
  }
  if (m.map) m.map = own(m.map)
  if (m.normalMap) m.normalMap = own(m.normalMap)
  const arm = own(m.aoMap)
  m.aoMap = arm
  m.roughnessMap = arm
  m.metalnessMap = arm
  return m
}

interface Materials {
  /** the panel face: SolarPanel003 from the pack (metre uv, one tile = `tile` m), else the painted module */
  solar: THREE.MeshStandardMaterial
  galvanised: THREE.MeshStandardMaterial
  fencePanel: THREE.MeshStandardMaterial
  lightPole: THREE.MeshStandardMaterial
  concretePole: THREE.MeshStandardMaterial
  wire: THREE.MeshStandardMaterial
  /** prototypes (instanced): the light pole with its arm and head; the JIS utility pole with its arms */
  lightPoleGeo: THREE.BufferGeometry
  utilityPoleGeo: THREE.BufferGeometry
  postGeo: THREE.BufferGeometry
  /** the jp_denchu GLB at 10.5 m with the foot at the origin and the arms along local x, or null (no pack, or the drop is not pole-shaped) */
  hero: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } | null
}

function makeMaterials(ctx: EnvBuildContext): Materials {
  const q = ctx.quality
  const solar = solarMaterial(ctx)
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

  const utilityPoleGeo = utilityPolePrototype()
  const hero = heroPolePrototype(ctx)

  const postGeo = new THREE.BoxGeometry(1, 1, 1)
  return { solar, galvanised, fencePanel, lightPole, concretePole, wire, lightPoleGeo, utilityPoleGeo, postGeo, hero }
}

/**
 * The JIS 12 m concrete pole (ROAD_FURNITURE.pole): an 8-sided shaft tapering φ320 → φ190 over
 * the exposed 10.5 m (+ the buried part below y = 0, so the instance stands at standY), the HV
 * crossarm along local x at 9.6 m with three pin insulators (the middle one on a short bracket,
 * 0.3 m higher — the 三角配列 of a JIS distribution line), the LV arm at 8.2 m — 72 triangles
 * the wires hang from (`WIRE_ATTACH`, the tops of the pins and of the LV arm). Local +x is
 * across the road, away from it.
 */
function utilityPolePrototype(): THREE.BufferGeometry {
  const P = ROAD_FURNITURE.pole, U = OUTSKIRTS.utility
  const total = P.exposed + U.bury
  const shaft = new THREE.CylinderGeometry(P.dTop / 2, (P.dBase / 2) * (1 + (U.bury / P.exposed) * ((P.dBase - P.dTop) / P.dBase)), total, 8, 1, true)
  shaft.translate(0, total / 2 - U.bury, 0)
  const hv = new THREE.BoxGeometry(P.hvArm, ARM_T, ARM_T)
  hv.translate(0, P.hvArmY, 0)
  const lv = new THREE.BoxGeometry(P.lvArm, ARM_T, ARM_T)
  lv.translate(0, P.lvArmY, 0)
  const parts: THREE.BufferGeometry[] = [shaft, hv, lv]
  for (const [lx, ly] of WIRE_ATTACH.slice(0, 3)) {
    const pin = new THREE.CylinderGeometry(U.insulator.d / 2, U.insulator.d / 2, U.insulator.h, 4, 1, true)
    pin.translate(lx, ly - U.insulator.h / 2, 0)
    parts.push(pin)
    // the centre pin stands on a bracket above the arm
    const gap = ly - U.insulator.h - (P.hvArmY + ARM_T / 2)
    if (gap > 0.01) {
      const bracket = new THREE.CylinderGeometry(0.025, 0.025, gap, 4, 1, true)
      bracket.translate(lx, P.hvArmY + ARM_T / 2 + gap / 2, 0)
      parts.push(bracket)
    }
  }
  const geo = mergeGeometries(parts, false)!
  for (const g of parts) g.dispose()
  geo.computeBoundingSphere()
  return geo
}

/** the crossarms' section (m) */
const ARM_T = 0.09

/**
 * Where the six wires attach on the pole, in the prototype's frame: [x along the arm, y]. HV on
 * the tops of the three pin insulators standing on the crossarm at ±0.75 and the centre (that
 * one 0.3 m higher on its bracket), LV on the lower arm's top at ±0.5 and the centre.
 */
const WIRE_ATTACH: readonly (readonly [number, number])[] = (() => {
  const P = ROAD_FURNITURE.pole, U = OUTSKIRTS.utility
  const hv = P.hvArmY + ARM_T / 2 + U.insulator.h, lv = P.lvArmY + ARM_T / 2
  return [[-0.75, hv], [0, hv + 0.3], [0.75, hv], [-0.5, lv], [0, lv], [0.5, lv]]
})()

/**
 * The hero pole: the jp_denchu GLB (a scanned JIS pole with its arms, insulators and can) put
 * at the exposed height with the arms along local x (`forward: 'x'` — the pack's orientation is
 * not documented, so the widest horizontal extent of the bbox is taken as the arm direction) and
 * the FOOT at the origin: the bbox centre is not the shaft where the arms and cable stubs are
 * one-sided, so the xz centre is re-read from the lowest vertices. Refused (null, one warning)
 * when the drop is not pole-shaped — an exploded parts layout has a footprint as wide as it is
 * tall — so a bad drop degrades to the procedural pole instead of a 15 m blob at every site.
 */
function heroPolePrototype(ctx: EnvBuildContext): Materials['hero'] {
  const reg = ctx.assets
  if (!reg || !ROAD_FURNITURE.pole.hero) return null
  const proto = modelPrototype(reg, 'model/road/jp_denchu', { scaleTo: { height: ROAD_FURNITURE.pole.exposed }, forward: 'x' })
  if (!proto) return null
  const part = proto.parts.main!
  const geo = part.geometry
  if (proto.footprint.long > OUTSKIRTS.utility.heroMaxAspect * proto.footprint.height) {
    if (import.meta.dev) console.warn(`[outskirts] jp_denchu is ${proto.footprint.long.toFixed(1)} × ${proto.footprint.short.toFixed(1)} m at ${proto.footprint.height.toFixed(1)} m tall — not a single pole; hero level skipped`)
    geo.dispose()
    return null
  }
  // the foot: the xz mean of the lowest 3 % of the height
  const pos = geo.getAttribute('position')
  let sx = 0, sz = 0, n = 0
  const cut = proto.footprint.height * 0.03
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) <= cut) { sx += pos.getX(i); sz += pos.getZ(i); n++ }
  if (n) geo.translate(-sx / n, 0, -sz / n)
  geo.computeBoundingSphere()
  const src = part.source
  const material = new THREE.MeshStandardMaterial({ map: src?.map ?? null, normalMap: src?.normalMap ?? null, color: src?.map ? 0xffffff : 0x9d9c97, roughness: 0.85, metalness: 0.05 })
  return { geometry: geo, material }
}

// ---------------------------------------------------------------------------------------------
// the site rule (`siteOk` of far-lines.ts) and the poles' building clearance

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
  const S = OUTSKIRTS.solar, SD = SOLAR_DETAIL
  interface SolarSeg { x0: number; x1: number; z: number; lo: number; id: number }
  const solarByCell = new Map<number, SolarSeg[]>()
  /** the segments the panel jobs built, with the front-edge heights at x0 / x1: the detail jobs stand the racks on the same numbers */
  const solarBuilt = new Map<SolarSeg, { yF0: number; yF1: number }>()
  let solarPolys = 0, solarRows = 0, solarSegs = 0
  const cosT = Math.cos(S.tilt), sinT = Math.sin(S.tilt), tanT = sinT / cosT
  const depthXZ = S.depth * cosT, rise = S.depth * sinT
  const detail = q.farField.solarDetail
  /** the inverter huts: one per large farm, at the row gap nearest the centroid; the fence samples per farm */
  interface Hut { x: number; z: number; lo: number; id: number }
  const hutByCell = new Map<number, Hut[]>()
  const fenceRings: { samples: Sample[]; lo: number }[] = []
  /** global fence sample index → (ring, index) and its cell */
  const solarFenceByCell = new Map<number, [number, number][]>()
  let solarFencePosts = 0, huts = 0
  for (const f of SUR_SOLAR) {
    const ring = polyline(worldRing(f, enScale))
    if (ring.length < 3) continue
    const box = ringBBox(ring)
    // every farm keeps the woods out, whether or not its panels are built
    ctx.keepOutPolys.push({ ring, box })
    if (box[2] <= grid.x0 || box[0] >= grid.x0 + grid.w || box[3] <= grid.z0 || box[1] >= grid.z0 + grid.d) continue
    solarPolys++
    if (detail) {
      // the fence: the ring inset from the OSM edge, resampled at the post pitch (closed)
      const inner = insetRingXZ(ring, SD.fence.inset)
      const samples = resample(inner, SD.fence.pitch, true)
      if (samples.length >= 3) {
        const r = fenceRings.length
        fenceRings.push({ samples, lo: f.dmin - SD.fence.inset })
        samples.forEach((sm, i) => {
          if (!inGrid(grid, sm.x, sm.z)) return
          push(solarFenceByCell, farField.cellOf(sm.x, sm.z), [r, i])
          solarFencePosts++
        })
      }
      // the hut: the area-weighted centroid, its z snapped to the middle of the nearest gap
      // between two rows (the rows take 3.19 m of the 5.5 m pitch; a 2 m hut fits the rest),
      // kept only when the whole footprint lies inside the ring and the grid
      if (ringArea(ring) >= SD.hutMinArea) {
        let cx = 0, cz = 0, a2 = 0
        for (let i = 0, n = ring.length; i < n; i++) {
          const p = ring[i]!, qv = ring[(i + 1) % n]!
          const cr = p[0] * qv[1] - qv[0] * p[1]
          cx += (p[0] + qv[0]) * cr
          cz += (p[1] + qv[1]) * cr
          a2 += cr
        }
        if (Math.abs(a2) > 1e-6) {
          cx /= 3 * a2
          cz /= 3 * a2
          const gap = S.pitch - depthXZ
          const hz = Math.round((cz - gap / 2) / S.pitch) * S.pitch + gap / 2
          const [hw, hd] = [SD.hut[0] / 2 + 0.3, SD.hut[1] / 2 + 0.2]
          const corners: XZ[] = [[cx - hw, hz - hd], [cx + hw, hz - hd], [cx + hw, hz + hd], [cx - hw, hz + hd]]
          if (corners.every(([x, z]) => inGrid(grid, x, z) && inBBox(x, z, box) && pointInRing(x, z, ring))) {
            push(hutByCell, farField.cellOf(cx, hz), { x: cx, z: hz, lo: f.dmin - nearestVertex(cx, hz, ring) - hw, id: f.id })
            huts++
          }
        }
      }
    }
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
        for (const [x, z] of samples) if (!siteOk(rule, x, z, s.lo, MIN_D)) { ok = false; break }
        if (!ok) continue
        // the front edge stands `front` over the ground it is on; where the ground rises to the
        // north (the back edge is `rise` higher) the whole panel is lifted so the BACK edge keeps
        // that clearance too, instead of the row burying itself in the slope
        const yF0 = Math.max(ground.standY(s.x0, zf), ground.standY(s.x0, zb) - rise) + S.front
        const yF1 = Math.max(ground.standY(s.x1, zf), ground.standY(s.x1, zb) - rise) + S.front
        const yB0 = yF0 + rise, yB1 = yF1 + rise
        solarBuilt.set(s, { yF0, yF1 })
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

  // the detail level: queued after the panel jobs (same stage, FIFO), so a cell's racks read
  // the heights its panels were built on; one Group entry per cell holding the racks, the hut
  // and the fence, none casting shadows
  const detailCells = new Set<number>([...solarByCell.keys(), ...hutByCell.keys(), ...solarFenceByCell.keys()])
  /** site of fence sample (ring, i), memoised across the cells' jobs (a rail spans two cells at a boundary) */
  const solarFenceSite = new Map<number, number | null>()
  const solarFenceY = (r: number, i: number): number | null => {
    const key = r * 1_000_000 + i
    let y = solarFenceSite.get(key)
    if (y !== undefined) return y
    const ring = fenceRings[r]!
    const sm = ring.samples[i]!
    y = inGrid(grid, sm.x, sm.z) && siteOk(rule, sm.x, sm.z, ring.lo, MIN_D) ? ground.standY(sm.x, sm.z) : null
    solarFenceSite.set(key, y)
    return y
  }
  if (detail) {
    for (const cell of [...detailCells].sort((a, b) => a - b)) {
      jobs++
      farField.defer('dressing', `solarDetail-${cell}`, 5, () => {
        const m = mats()
        const steel = new TriSink()
        const concrete = new TriSink()
        const panel = new TriSink()
        let racks = 0, hutsBuilt = 0
        // racks: a front and a back post every postPitch along the segment (feet 0.2 m in the
        // ground, tops at the rail), the rails under the panel's front and back edges
        const half = SD.post / 2, inset = 0.15, R = SD.rail
        for (const s of solarByCell.get(cell) ?? []) {
          const b = solarBuilt.get(s)
          if (!b) continue
          const zf = s.z - inset, zb = s.z - depthXZ + inset
          const len = s.x1 - s.x0
          const yF = (x: number) => b.yF0 + ((b.yF1 - b.yF0) * (x - s.x0)) / len
          // the panel's underside at the inset front / back edge: the top face climbs
          // `tan(tilt)` per metre of inset from the front edge (falls from the back one), and the
          // underside is the thickness below it along the normal
          const under = (x: number, back: boolean) => yF(x) - S.thick * cosT + (back ? rise - inset * tanT : inset * tanT)
          const n = Math.max(1, Math.round(len / SD.postPitch))
          for (let i = 0; i < n; i++) {
            const x = s.x0 + ((i + 0.5) * len) / n
            for (const back of [false, true]) {
              const z = back ? zb : zf
              const top = under(x, back) - R
              const foot = ground.standY(x, z) - 0.2
              if (top <= foot) continue
              boxFaces(steel, x - half, x + half, foot, top, z - half, z + half, ['-y', '+y'])
            }
          }
          for (const back of [false, true]) {
            const z = back ? zb : zf
            const y0 = under(s.x0, back), y1 = under(s.x1, back)
            // the rail follows the row's fall: two quads per face would be exact, one box at the mean is 8 mm off over 30 m
            const y = (y0 + y1) / 2
            boxFaces(steel, s.x0, s.x1, y - R, y, z - R / 2, z + R / 2, ['+y'])
          }
          racks++
        }
        // the inverter hut: floor at the highest ground under it (no corner buried), walls
        // 0.3 m into the ground, a roof slab overhanging 0.2 m
        for (const h of hutByCell.get(cell) ?? []) {
          const [w, d, hh] = SD.hut
          const corners: XZ[] = [[h.x - w / 2, h.z - d / 2], [h.x + w / 2, h.z - d / 2], [h.x + w / 2, h.z + d / 2], [h.x - w / 2, h.z + d / 2]]
          if (!corners.every(([x, z]) => siteOk(rule, x, z, h.lo, MIN_D))) continue
          let y = -Infinity
          for (const [x, z] of corners) y = Math.max(y, ground.standY(x, z))
          boxFaces(concrete, h.x - w / 2, h.x + w / 2, y - 0.3, y + hh, h.z - d / 2, h.z + d / 2, ['-y', '+y'])
          boxFaces(steel, h.x - w / 2 - 0.2, h.x + w / 2 + 0.2, y + hh, y + hh + 0.1, h.z - d / 2 - 0.2, h.z + d / 2 + 0.2)
          hutsBuilt++
        }
        // the fence: posts, the top rail, the mesh (as the perimeter fence, at SOLAR_DETAIL's height)
        const matrices: THREE.Matrix4[] = []
        const H = SD.fence.h, FR = OUTSKIRTS.fence.rail, bury = OUTSKIRTS.fence.bury
        let panels = 0
        for (const [r, i] of solarFenceByCell.get(cell) ?? []) {
          const y = solarFenceY(r, i)
          if (y === null) continue
          const ring = fenceRings[r]!
          const sm = ring.samples[i]!
          _p.set(sm.x, y - bury + (H + bury) / 2, sm.z)
          _q.identity()
          matrices.push(new THREE.Matrix4().compose(_p, _q, _s.set(OUTSKIRTS.fence.post, H + bury, OUTSKIRTS.fence.post)))
          const j = (i + 1) % ring.samples.length
          const yj = solarFenceY(r, j)
          if (yj === null) continue
          const nx = ring.samples[j]!
          const ex = nx.x - sm.x, ez = nx.z - sm.z
          const len = Math.hypot(ex, ez) || 1
          const px = (ez / len) * (FR / 2), pz = (-ex / len) * (FR / 2)
          const a0 = [sm.x - px, y + H, sm.z - pz], a1 = [sm.x + px, y + H, sm.z + pz]
          const b0 = [nx.x - px, yj + H, nx.z - pz], b1 = [nx.x + px, yj + H, nx.z + pz]
          const uv = [[0, 0], [1, 0], [1, 1], [0, 1]]
          steel.quad(a0, b0, b1, a1, [0, 1, 0], uv)
          steel.quad(a0, b0, [b0[0]!, yj + H - FR, b0[2]!], [a0[0]!, y + H - FR, a0[2]!], [-px, 0, -pz], uv)
          steel.quad(a1, b1, [b1[0]!, yj + H - FR, b1[2]!], [a1[0]!, y + H - FR, a1[2]!], [px, 0, pz], uv)
          if (q.fence) {
            const pb = OUTSKIRTS.fence.panelBottom
            panel.quad([sm.x, y + pb, sm.z], [nx.x, yj + pb, nx.z], [nx.x, yj + H, nx.z], [sm.x, y + H, sm.z], [px, 0, pz], [[sm.t, pb], [sm.t + len, pb], [sm.t + len, H], [sm.t, H]])
            panels++
          }
        }
        const root = new THREE.Group()
        root.name = `solarDetail-${cell}`
        const steelGeo = steel.build()
        if (steelGeo) {
          const mesh = new THREE.Mesh(steelGeo, m.galvanised)
          mesh.name = `solarRacks-${cell}`
          mesh.castShadow = false
          mesh.receiveShadow = true
          root.add(mesh)
        }
        const concreteGeo = concrete.build()
        if (concreteGeo) {
          const mesh = new THREE.Mesh(concreteGeo, m.concretePole)
          mesh.name = `solarHuts-${cell}`
          mesh.castShadow = false
          mesh.receiveShadow = true
          root.add(mesh)
        }
        if (matrices.length) {
          const inst = new THREE.InstancedMesh(m.postGeo, m.galvanised, matrices.length)
          matrices.forEach((mat, k) => inst.setMatrixAt(k, mat))
          inst.instanceMatrix.needsUpdate = true
          inst.castShadow = false
          inst.frustumCulled = true
          inst.computeBoundingSphere()
          inst.name = `solarFencePosts-${cell}`
          root.add(inst)
        }
        const panelGeo = panel.build()
        if (panelGeo) {
          const mesh = new THREE.Mesh(panelGeo, m.fencePanel)
          mesh.name = `solarFencePanel-${cell}`
          mesh.castShadow = false
          root.add(mesh)
        }
        if (!root.children.length) return null
        root.userData.outskirts = { family: 'solarDetail', racks, huts: hutsBuilt, posts: matrices.length, panels }
        farField.register({ kind: 'solar', name: `solarDetail-${cell}`, cell, levels: [{ object: root, range: SD.range }] })
        return root
      })
    }
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
      // a 60 mm post and a 40 mm rail are under a texel of the 900 m cascade (≥ 10 cm): their
      // shadows flickered rather than read, for ~50 shadow draws a frame in the follow modes
      inst.castShadow = false
      inst.frustumCulled = true
      inst.computeBoundingSphere()
      inst.name = `fencePosts-${cell}`
      root.add(inst)
      const railGeo = rail.build()
      if (railGeo) {
        const mesh = new THREE.Mesh(railGeo, m.galvanised)
        mesh.name = `fenceRail-${cell}`
        mesh.castShadow = false
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
        if (!siteOk(rule, c.x, c.z, c.lo, MIN_D)) continue
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
  // 4. utility poles + wires (the plan is shared with road-furniture.ts through `utilityPoles`)
  const U = OUTSKIRTS.utility, P = ROAD_FURNITURE.pole
  const plan = utilityPoles(ctx)
  const uPoles = plan.poles
  for (const [cell, ids] of plan.byCell) {
    jobs++
    farField.defer('dressing', `utility-${cell}`, 8, () => {
      const m = mats()
      const matrices: THREE.Matrix4[] = []
      const wires = new TriSink()
      let spans = 0
      for (const i of ids) {
        const y = plan.y(i)
        if (y === null) continue
        const p = uPoles[i]!
        // the prototype's y = 0 is the ground (its shaft continues `bury` below it); the hero foot sits at 0 too
        _p.set(p.x, y, p.z)
        matrices.push(new THREE.Matrix4().compose(_p, yawTo(p.nx, p.nz, _q), _s.set(1, 1, 1)))
        // wires to the next pole of the same way
        const j = i + 1
        const n = uPoles[j]
        if (!n || n.way !== p.way || n.idx !== p.idx + 1) continue
        const yn = plan.y(j)
        if (yn === null) continue
        const span = Math.hypot(n.x - p.x, n.z - p.z)
        if (span < 3 || span > U.maxSpan) continue
        const sag = U.sagK * span * span
        const dx = (n.x - p.x) / span, dz = (n.z - p.z) / span
        // the strip stands on edge (its width is in Y): a catenary is looked at from the side,
        // and a ribbon lying flat 10 m up is edge-on — invisible — from every camera on the ground
        const out = [-dz, 0, dx]
        for (const [lx, ly] of WIRE_ATTACH) {
          const ax = p.x + p.nx * lx, az = p.z + p.nz * lx, ay = y + ly
          const bx = n.x + n.nx * lx, bz = n.z + n.nz * lx, by = yn + ly
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
      if (!matrices.length) return null
      // the poles are one entry (registered parentless, so the registry adds and attaches the
      // root on its own); the wires (a shorter range) another; the hero level a third that draws
      // OVER the procedural pole inside `heroRange` and thins out over `heroRamp` — a second
      // entry rather than a nearer level of the same one, because a level's ramp thins its
      // instances to nothing before the next level appears (the crowd's rule), which would make
      // the poles vanish over the hand-off band
      const near = new THREE.Group()
      near.name = `utility-${cell}`
      const inst = new THREE.InstancedMesh(m.utilityPoleGeo, m.concretePole, matrices.length)
      matrices.forEach((mat, k) => inst.setMatrixAt(k, mat))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = castShadow
      inst.frustumCulled = true
      inst.computeBoundingSphere()
      inst.name = `utilityPoles-${cell}`
      near.add(inst)
      near.userData.outskirts = { family: 'utility', poles: matrices.length }
      farField.register({ kind: 'poles', name: `utility-${cell}`, cell, levels: [{ object: near, range: U.range }] })
      if (m.hero) {
        const h = new THREE.InstancedMesh(m.hero.geometry, m.hero.material, matrices.length)
        matrices.forEach((mat, k) => h.setMatrixAt(k, mat))
        h.instanceMatrix.needsUpdate = true
        h.castShadow = castShadow
        h.receiveShadow = true
        h.frustumCulled = true
        h.computeBoundingSphere()
        h.name = `utilityHero-${cell}`
        h.userData.outskirts = { family: 'utilityHero', poles: matrices.length }
        farField.register({ kind: 'poles', name: `utilityHero-${cell}`, cell, levels: [{ object: h, range: P.heroRange, ramp: P.heroRamp }] })
      }
      const wireGeo = wires.build()
      if (wireGeo) {
        const mesh = new THREE.Mesh(wireGeo, m.wire)
        mesh.name = `wires-${cell}`
        mesh.castShadow = false
        mesh.receiveShadow = false
        mesh.userData.outskirts = { family: 'wires', spans, strips: spans * WIRE_ATTACH.length }
        farField.register({ kind: 'poles', name: `wires-${cell}`, cell, levels: [{ object: mesh, range: U.wiresRange }] })
      }
      return null
    })
  }

  const stats: OutskirtsStats = {
    solar: { polygons: solarPolys, rows: solarRows, segments: solarSegs, cells: solarByCell.size, detailCells: detail ? detailCells.size : 0, huts, fencePosts: solarFencePosts },
    fence: { posts: fencePosts, cells: fenceByCell.size },
    lightPoles: { candidates: lightCandidates.length, budget: lightBudget },
    utility: { poles: uPoles.length, cells: plan.byCell.size, heroDrop: !!ctx.assets?.model('model/road/jp_denchu') },
    jobs,
  }
  if (import.meta.dev) console.info(`[outskirts] solar ${solarPolys} farms / ${solarSegs} segments in ${solarByCell.size} cells (detail: ${detail ? detailCells.size : 0} cells, ${huts} huts, ${solarFencePosts} fence posts), fence ${fencePosts} posts in ${fenceByCell.size} cells, ${lightCandidates.length} light-pole sites for ${lightBudget}, ${uPoles.length} utility poles in ${plan.byCell.size} cells; ${jobs} jobs`)
  return stats
}

// ---------------------------------------------------------------------------------------------
// the utility-pole plan, shared with road-furniture.ts (the transformer cans hang on these poles)

export interface UtilityPole {
  x: number
  z: number
  /** unit direction from the road to the pole: the crossarm's local +x (the pole's yaw) */
  nx: number
  nz: number
  /** lower bound of the centreline distance at the pole (the way's dLo minus the offset) */
  lo: number
  /** the OSM way id and the pole's index along that way (consecutive indices are wired together) */
  way: number
  idx: number
}

export interface UtilityPlan {
  poles: UtilityPole[]
  /** far-field cell → indices into `poles` */
  byCell: Map<number, number[]>
  /**
   * The ground height a pole stands on, null where it may not stand (the site rule with the
   * crossarm's reach added to the 140 m, and the building clearance). Memoised: a wire span, a
   * transformer can and the pole itself read the same answer from different jobs.
   */
  y(i: number): number | null
}

const PLANS = new WeakMap<EnvBuildContext, UtilityPlan>()

/**
 * Plan the utility poles once per build context (memoised): every `ROAD_FURNITURE.pole.pitch`
 * metres along the tertiary / unclassified / residential ways of the road network, on one side
 * of the way (chosen per OSM way id), `pole.offset` outside the paved edge, never inside a
 * junction mouth, inside the terrain grid and outside the circuit's own grounds. Pure XZ
 * arithmetic; the ground reads happen in `y`, in the deferred jobs.
 */
export function utilityPoles(ctx: EnvBuildContext): UtilityPlan {
  let plan = PLANS.get(ctx)
  if (plan) return plan
  const { track, terrain, ground, quality: q, farField } = ctx
  const grid: GridShape = terrain.grid()
  const enScale = track.enScale
  const P = ROAD_FURNITURE.pole, U = OUTSKIRTS.utility
  const circuit = SUR_SITES.find((s) => s.id === OUTSKIRTS.fence.wayId && s.closed)
  const circuitRing: XZ[] = circuit ? polyline(worldRing(circuit, enScale)) : []
  const circuitBox = circuitRing.length ? ringBBox(circuitRing) : ([0, 0, 0, 0] as [number, number, number, number])
  const insideCircuit = (x: number, z: number) => circuitRing.length > 0 && inBBox(x, z, circuitBox) && pointInRing(x, z, circuitRing)
  const poles: UtilityPole[] = []
  const byCell = new Map<number, number[]>()
  // the poles follow the road NETWORK (road-section.ts) — the same trimmed, filleted paths the
  // ribbons are cut from — so a pole stands off the real paved edge and never in a junction the
  // ribbon was trimmed out of
  const net = roadNetwork(ctx, { stepScale: q.farField.roads.stepScale, ring: q.farField.roads.ring })
  for (const way of net.ways) {
    if (!OUTSKIRTS.utilityKinds.includes(way.kind)) continue
    const w = way.row
    const cx = w.centroid[0] * enScale, cz = -w.centroid[1] * enScale
    if (outsideGrid(grid, cx, cz, OUTSKIRTS.gridMargin)) continue
    if (way.path.length < 2) continue
    /** the junctions' reach along the way: no pole inside the other road's mouth */
    const nearJunction = (s: number): boolean => way.junctions.some((j) => Math.abs(j.s - s) < j.j.major.hw + 3)
    const side = mulberry(w.id * 7 + 1)() < 0.5 ? 1 : -1
    const off = way.hw + P.offset
    const samples = walk(way, P.pitch, P.pitch / 2)
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!
      if (nearJunction(s.s)) continue
      const [x, z] = offsetAt(s, side * off)
      // outside the circuit's own grounds, tested per pole rather than on the way's centroid
      if (!inGrid(grid, x, z) || insideCircuit(x, z)) continue
      const idx = poles.length
      // +lateral is (tz, −tx): the pole's outward normal on `side`
      poles.push({ x, z, nx: s.tz * side, nz: -s.tx * side, lo: s.dLo - off, way: w.id, idx: i })
      push(byCell, farField.cellOf(x, z), idx)
    }
  }
  const rule: SiteRule = { ground, grid, projections: 0 }
  let clearance: BuildingClearance | null = null
  const site = new Map<number, number | null>()
  const y = (i: number): number | null => {
    let v = site.get(i)
    if (v !== undefined) return v
    const p = poles[i]!
    clearance ??= new BuildingClearance(enScale, grid, OUTSKIRTS.gridMargin)
    // the crossarm's half-length more, so the wires hung from its ends keep the 140 m too
    v = siteOk(rule, p.x, p.z, p.lo, OUTSKIRTS.minD + P.hvArm / 2 + U.wireW) && !clearance.hit(p.x, p.z) ? ground.standY(p.x, p.z) : null
    site.set(i, v)
    return v
  }
  PLANS.set(ctx, (plan = { poles, byCell, y }))
  return plan
}
