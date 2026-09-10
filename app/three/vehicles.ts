import * as THREE from 'three'
import { SUR_PARKING, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing } from '~/data/en-codec'
import { CAR_LAYOUT } from '~/data/impostor-atlas'
import { CAR_BODIES, carBodyGeometry, carBodyMaterial, pickCarBody, pickCarColour, type CarBody } from './car-bodies'
import type { EnvBuildContext } from './environment'
import type { FarLevel } from './farfield'
import { inBBox, pointInRing, principalAxis, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
import { IMPOSTOR_ATTRIBUTES, impostorGeometry, impostorMaterial } from './impostor'
import { cutoutParams } from './materials'

/**
 * Parked cars in the OSM car parks (plan §2d): every `amenity=parking` polygon of
 * app/data/suzuka-surroundings.ts (SUR_PARKING, 111 lots) is filled with rows of nose-in bays
 * along its principal axis at the 16 m pitch of a double-loaded aisle (5 m bays, 6 m aisle, 5 m
 * bays), 2.5 m per bay, and every bay that passes the ground rules takes a car from the
 * late-March mix of car-bodies.ts. Nothing is built for the asphalt itself — a lot's surface is
 * the `parking` class of the land-cover mask (landcover.ts), not a ground face — so the cars
 * simply stand on `ground.standY` (README 地面の契約 R3), 2 cm up.
 *
 * A bay is kept only when (R1 / R11, and the pit complex's flatness rule):
 *  - its four corners lie inside the lot and inside the terrain rectangle,
 *  - neither a corner nor the centre is in a keep-out disc (`ctx.keepOut`) or polygon
 *    (`ctx.keepOutPolys`) — the building footprints, pushed in the same 'buildings' stage by the
 *    jobs that run before these ones,
 *  - it is ≥ 140 m from the centreline (`ground.plan.project`) and stands on no drawn ground face
 *    (`ground.builtY === null`) at its corners and its centre,
 *  - the ground under it is no steeper than `CAR_PARK.slopeGrade`: a car body is rigid, and a
 *    bank or a ditch would bury one wheel and hang another in the air.
 * Occupancy is 0.95 within 900 m of the circuit boundary (SUR_SITES 775428456) and 0.6 beyond;
 * the temporary lot also parks a few cars on the grass verge outside its own edges. Coaches
 * (≈ 4 % of a lot's vehicles, capped per lot) take a 13 m strip along one long side, and only in
 * the lots within 700 m of a gate.
 *
 * LOD, one far-field entry per 250 m cell (`carPark-<cell>`), the registry picks the level:
 *  0  the 3D bodies, one InstancedMesh per silhouette, inside 500 m and count-ramped over the
 *     last 100 m — one planned car in `stride` per cell, so that about
 *     `Quality.farField.parkedCars` bodies are drawn over the whole map (coaches are never
 *     strided away),
 *  1  the baked impostor cards (`tex/car_atlas`, CAR_LAYOUT, impostor.ts 'body' mask mode) out to
 *     `Quality.farField.rangeFar` — high tier with the asset pack only; the low tier has no
 *     level 1 and drops from the bodies straight to
 *  2  the overview "speckle" (`carSpeckle-<cell>`, range ∞): one vertex-coloured quad per run of
 *     four kept bays, coloured by the mean paintwork of the cars in the run and mixed towards the
 *     asphalt by the share of empty bays in it. From 1.8 km up a lot then reads as the mottled
 *     white-grey of the aerials instead of bare asphalt, for two triangles per four bays.
 *
 * The speckle is an UP-FACING OVERLAY, so it obeys the far-field overlay rule (≥ 140 m from the
 * centreline and `ground.builtY === null`) that far-geometry.ts's `cellClippedPolygon` enforces
 * for the forest: its quads are built only from bays that already passed the bay test, so it
 * inherits both conditions instead of testing them again. It clears the ground it covers by
 * `speckle.lift` (`stripY`) — 2.5 × ground.ts's LAYER_MIN_STEP rather than the 2 mm of the plan
 * sketch, because the low tier draws with a logarithmic depth buffer, where `polygonOffset` is a
 * no-op and the geometric separation has to stand on its own. 2 cm is 0.05 px at the 275 m from
 * which the speckle is ever shown.
 *
 * Every lot's ring is pushed to `ctx.keepOutPolys` in the 'buildings' stage, before the forest.
 * All materials are created inside the jobs (the registry's attach hook sets them up).
 */

/** the layout and rule constants of this builder (the tier budgets live in quality.ts) */
export const CAR_PARK = {
  /** the closest a bay may come to the centreline (m): the far field's overlay band */
  minD: 140,
  /** double-loaded row pitch: bay depth + aisle + bay depth (m) */
  pitch: 16,
  bayW: 2.5,
  bayD: 5,
  aisle: 6,
  /** per-car yaw jitter (deg) and the position jitter inside the bay (m) */
  yawJitterDeg: 2,
  posJitter: 0.15,
  /**
   * The steepest ground a bay may stand on, as a GRADE: `standY` may spread over the footprint by
   * at most this times the footprint's diagonal (a car bay 25 cm, a coach's 12.5 m bay 58 cm).
   * The plan asked for a flat 2 cm — the pit complex's rule — but a real lot is GRADED and the
   * 30 m DEM under these lots is not: the median spread over a 2.5 × 5 m footprint in the car
   * parks is 14 cm (a 2.8 % grade), so 2 cm keeps 3.8 % of the bays and empties the car parks.
   * 4.5 % is steeper than any lot's drainage fall, so what the rule still rejects is banks,
   * ditches and the shoulders of the access roads; the residual gap under a wheel is ≤ 12 cm,
   * a third of a pixel at the 140 m the nearest bay is allowed to be.
   */
  slopeGrade: 0.045,
  /** the cars' lift over standY (m) */
  lift: 0.02,
  /** share of cars reversed into the bay (nose to the aisle) — the Japanese habit, and the photo */
  noseOut: 0.7,
  occupancy: { near: 0.95, far: 0.6, nearM: 900 },
  /** coaches: share of a lot's vehicles, cap per lot, gate radius (m), their bay and the strip they take on the lot's long side */
  coach: { share: 0.04, maxPerLot: 24, gateM: 700, bayW: 3.5, bayD: 12.5, strip: 13 },
  /** the temporary lot's grass verge: OSM ids, spacing along the edge, offset outside it, occupancy, cap */
  verge: { lotIds: [184529074] as readonly number[], spacing: 7, offset: 3.2, occupancy: 0.4, max: 14 },
  /** LOD: the 3D bodies' range and count ramp (m, × lodScale); the cards use Quality.farField.rangeFar */
  lod: { bodies: 500, ramp: 100 },
  /** the overview speckle: bays per quad along a row, clearance over the ground under it (m, `stripY`), the asphalt tone empty bays mix in (linear grey) */
  speckle: { baysPerQuad: 4, lift: 0.02, asphalt: 0.07 },
} as const

export type BayReject = 'ring' | 'grid' | 'keepOut' | 'minD' | 'builtY' | 'slope'

export interface ParkedCarStats {
  lots: number
  /** lots that ended up with at least one car */
  lotsUsed: number
  rows: number
  /** bays laid out / bays that passed the rules */
  bays: number
  kept: number
  rejected: Record<BayReject, number>
  /** cars planned (coaches and verge cars included) */
  cars: number
  coaches: number
  verge: number
  /** one car in `stride` is drawn in levels 0 / 1 (the budget over the cars planned) */
  stride: number
  bodies: number
  cards: number
  /** speckle quads (level 2) */
  quads: number
  cells: number
  jobs: number
  atlas: 'baked' | 'none'
  /** triangles per LOD level, as registered */
  tris: { bodies: number; cards: number; speckle: number }
}

interface Lot {
  id: number
  name: string
  ring: XZ[]
  box: [number, number, number, number]
  /** the largest distance from the frame centre to a ring vertex (m) */
  radius: number
  /** frame: centre, unit axis (along), extents along / across the axis, relative to the centre */
  cx: number
  cz: number
  ax: number
  az: number
  a0: number
  a1: number
  c0: number
  c1: number
  occupancy: number
  coach: boolean
  verge: boolean
  seed: number
}

interface Car {
  x: number
  z: number
  y: number
  yaw: number
  body: CarBody
  colour: THREE.Color
}

interface Quad {
  /** world corners in frame order (a0 c0, a1 c0, a1 c1, a0 c1) — wound to face +Y on emit */
  p: [XZ, XZ, XZ, XZ]
  y: [number, number, number, number]
  colour: THREE.Color
}

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _asphalt = new THREE.Color()
const Y_UP = new THREE.Vector3(0, 1, 0)

function hash2(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** distance from (x, z) to the nearest edge of `ring` (inside or outside — the callers test that separately) */
function distToRing(x: number, z: number, ring: readonly XZ[]): number {
  let best = Infinity
  for (let i = 0, n = ring.length; i < n; i++) {
    const [ax, az] = ring[i]!, [bx, bz] = ring[(i + 1) % n]!
    const ex = bx - ax, ez = bz - az
    const l2 = ex * ex + ez * ez
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0
    const dx = x - (ax + ex * t), dz = z - (az + ez * t)
    const d2 = dx * dx + dz * dz
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

// ---------------------------------------------------------------------------------------------
// the lots

function lots(ctx: EnvBuildContext): Lot[] {
  const enScale = ctx.track.enScale
  const circuitSite = SUR_SITES.find((s) => s.role === 'circuit')
  const circuit = circuitSite ? ringFromFlat(worldRing(circuitSite, enScale)) : null
  const circuitBox = circuit ? ringBBox(circuit) : null
  const gates = SUR_SITES.filter((s) => s.role === 'gate').map((g) => [g.centroid[0] * enScale, -g.centroid[1] * enScale] as XZ)
  const out: Lot[] = []
  for (const f of SUR_PARKING) {
    const ring = ringFromFlat(worldRing(f, enScale))
    if (ring.length < 3) continue
    const box = ringBBox(ring)
    const pa = principalAxis(ring)
    let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity, r2 = 0
    for (const [x, z] of ring) {
      const dx = x - pa.cx, dz = z - pa.cz
      const a = dx * pa.ax + dz * pa.az
      const c = -dx * pa.az + dz * pa.ax
      if (a < a0) a0 = a
      if (a > a1) a1 = a
      if (c < c0) c0 = c
      if (c > c1) c1 = c
      if (dx * dx + dz * dz > r2) r2 = dx * dx + dz * dz
    }
    const cx = pa.cx, cz = pa.cz
    // the circuit boundary: 0 inside it, otherwise the distance to its nearest edge
    let dCircuit = Infinity
    if (circuit && circuitBox) dCircuit = inBBox(cx, cz, circuitBox) && pointInRing(cx, cz, circuit) ? 0 : distToRing(cx, cz, circuit)
    let dGate = Infinity
    for (const [gx, gz] of gates) dGate = Math.min(dGate, Math.hypot(gx - cx, gz - cz))
    out.push({
      id: f.id,
      name: f.tags.name ?? '',
      ring,
      box,
      radius: Math.sqrt(r2),
      cx, cz, ax: pa.ax, az: pa.az, a0, a1, c0, c1,
      occupancy: dCircuit <= CAR_PARK.occupancy.nearM ? CAR_PARK.occupancy.near : CAR_PARK.occupancy.far,
      coach: dGate <= CAR_PARK.coach.gateM,
      verge: CAR_PARK.verge.lotIds.includes(f.id),
      seed: f.id | 0,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------

/**
 * Queue the car parks' deferred jobs, all in the 'buildings' stage so the keep-out rings are in
 * `ctx.keepOutPolys` before the 'forest' jobs read them: one planning job per lot, then one
 * fan-out job that fixes the stride and queues a build job per 250 m cell the cars landed in
 * (a job may queue more jobs of its own stage — they are spliced in before the later stages).
 * Returns the statistics object the jobs fill in; it is also on
 * `ctx.farField.group.userData.parkedCars` for the offline harness.
 */
export function buildParkedCars(ctx: EnvBuildContext): ParkedCarStats {
  const { ground, quality: q, farField, assets, landCover, terrain } = ctx
  const plan = ground.plan
  const grid: GridShape = terrain.grid()
  const all = lots(ctx)
  const stats: ParkedCarStats = {
    lots: all.length, lotsUsed: 0, rows: 0, bays: 0, kept: 0,
    rejected: { ring: 0, grid: 0, keepOut: 0, minD: 0, builtY: 0, slope: 0 },
    cars: 0, coaches: 0, verge: 0, stride: 1, bodies: 0, cards: 0, quads: 0, cells: 0, jobs: 0,
    atlas: 'none', tris: { bodies: 0, cards: 0, speckle: 0 },
  }
  farField.group.userData.parkedCars = stats
  if (!all.length) return stats

  // --- state the planning jobs fill and the cell jobs read --------------------------------------
  const carsByCell = new Map<number, Car[]>()
  const quadsByCell = new Map<number, Quad[]>()
  let totalCars = 0
  const gridInset: [number, number, number, number] = [grid.x0 + 1, grid.z0 + 1, grid.x0 + grid.w - 1, grid.z0 + grid.d - 1]

  // materials and the atlas, made in the first cell job that needs them (the attach hook is run
  // on every root, and setupMaterials is idempotent, so sharing them across the cells is fine)
  const time = { value: 0 }
  const camPos = { value: new THREE.Vector3() }
  let bodyMat: THREE.MeshStandardMaterial | null = null
  let speckleMat: THREE.MeshStandardMaterial | null = null
  let card: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null | undefined
  const materials = () => {
    if (!bodyMat) {
      bodyMat = carBodyMaterial()
      speckleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 })
      speckleMat.customProgramCacheKey = () => 'carSpeckle'
    }
    if (card === undefined) {
      card = null
      if (q.farField.carImpostors && assets) {
        const diff = assets.texture('tex/car_atlas/diff')
        const mask = assets.texture('tex/car_atlas/mask')
        if (diff && mask) {
          const mat = impostorMaterial({ map: diff, mask }, CAR_LAYOUT, {
            pitchBands: 1, cheer: false, sway: 0, maskMode: 'body', cutout: cutoutParams(q), cacheKey: 'impostor|car', time, camPos, roughness: 0.55,
          })
          card = { geo: impostorGeometry(CAR_LAYOUT), mat }
          stats.atlas = 'baked'
        }
      }
    }
    return { bodyMat: bodyMat!, speckleMat: speckleMat!, card }
  }

  // --- the bay rule -----------------------------------------------------------------------------
  /** the keep-outs that can reach a lot's bounding box, gathered once when the lot's job runs */
  const keepOutsFor = (box: readonly [number, number, number, number]) => {
    const m = CAR_PARK.coach.strip
    const discs = ctx.keepOut.filter((k) => k.x + k.r >= box[0] - m && k.x - k.r <= box[2] + m && k.z + k.r >= box[1] - m && k.z - k.r <= box[3] + m)
    const polys = ctx.keepOutPolys.filter((k) => k.box[2] >= box[0] - m && k.box[0] <= box[2] + m && k.box[3] >= box[1] - m && k.box[1] <= box[3] + m)
    return { discs, polys }
  }
  type KeepOuts = ReturnType<typeof keepOutsFor>
  const inKeepOut = (x: number, z: number, ko: KeepOuts): boolean => {
    for (const k of ko.discs) { const dx = x - k.x, dz = z - k.z; if (dx * dx + dz * dz < k.r * k.r) return true }
    for (const k of ko.polys) if (inBBox(x, z, k.box) && pointInRing(x, z, k.ring)) return true
    return false
  }

  /**
   * The rule on one footprint, given its centre and its four corners. `inside` 'in' wants the
   * corners inside the lot, 'out' wants them outside it (the verge). `dCentre` is the centreline
   * distance of the LOT's centre, measured once by the caller: most bays need no projection of
   * their own because that one distance already puts them outside the band.
   * Returns the rejection reason, or the footprint's height (`standY` at the centre).
   */
  const bayTest = (cx: number, cz: number, corners: readonly XZ[], lot: Lot, inside: 'in' | 'out', ko: KeepOuts, dCentre: number): BayReject | number => {
    for (const [x, z] of corners) {
      if (!inBBox(x, z, gridInset)) return 'grid'
      const inRing = inBBox(x, z, lot.box) && pointInRing(x, z, lot.ring)
      if (inside === 'in' ? !inRing : inRing) return 'ring'
    }
    if (inKeepOut(cx, cz, ko)) return 'keepOut'
    for (const [x, z] of corners) if (inKeepOut(x, z, ko)) return 'keepOut'
    let halfDiag = 0
    for (const [x, z] of corners) halfDiag = Math.max(halfDiag, Math.hypot(x - cx, z - cz))
    // One projection for the whole footprint — every corner is within the half diagonal of the
    // centre — and none at all where the lot centre's own distance already settles it: `project`
    // is 1-Lipschitz, so d(bay) ≥ dCentre − |bay − lot centre|. It is the expensive call in this
    // builder (a spiral search over the centreline samples), and the far lots are 2 km out.
    const bound = dCentre - Math.hypot(cx - lot.cx, cz - lot.cz)
    if (bound < CAR_PARK.minD + halfDiag && plan.project(cx, cz).d < CAR_PARK.minD + halfDiag) return 'minD'
    if (ground.builtY(cx, cz)) return 'builtY'
    for (const [x, z] of corners) if (ground.builtY(x, z)) return 'builtY'
    const y = ground.standY(cx, cz)
    let lo = y, hi = y
    for (const [x, z] of corners) {
      const yy = ground.standY(x, z)
      if (yy < lo) lo = yy
      if (yy > hi) hi = yy
    }
    if (hi - lo > CAR_PARK.slopeGrade * 2 * halfDiag) return 'slope'
    return y
  }

  const addCar = (car: Car) => {
    const cell = farField.cellOf(car.x, car.z)
    let list = carsByCell.get(cell)
    if (!list) carsByCell.set(cell, (list = []))
    list.push(car)
    totalCars++
    stats.cars++
  }

  const addQuad = (quad: Quad) => {
    const cell = farField.cellOf((quad.p[0][0] + quad.p[2][0]) / 2, (quad.p[0][1] + quad.p[2][1]) / 2)
    let list = quadsByCell.get(cell)
    if (!list) quadsByCell.set(cell, (list = []))
    list.push(quad)
    stats.quads++
  }

  /** world point of the lot frame (`a` along the principal axis, `c` across it) */
  const world = (lot: Lot, a: number, c: number): XZ => [lot.cx + a * lot.ax - c * lot.az, lot.cz + a * lot.az + c * lot.ax]

  /**
   * The four corner heights of a speckle strip: `standY` at the corners, then the whole strip
   * raised until nothing of the ground it covers pokes through it.
   *
   * A strip is up to 10 × 5 m of two triangles, and the bay rule only keeps the ground flat
   * over ONE bay (2.5 × 5 m) — over a run of four the surface bends, and a plane through the
   * corners then cuts into it. Measured before this correction: 3.5 % of the sampled strip
   * interior had ground standing above the strip, the worst by 11 cm, which from the overview
   * is exactly the hole in the speckle the strip exists to fill. So the interior is sampled on
   * a 5 × 5 grid against the surface that will actually be drawn — the two triangles always
   * split the corner rectangle on its 0–2 diagonal (`buildCell` only chooses the winding) — and
   * the largest shortfall is added to all four corners. The strip keeps the ground's tilt and
   * lands `speckle.lift` above the highest point under it.
   */
  const stripY = (p: readonly [XZ, XZ, XZ, XZ]): [number, number, number, number] => {
    const y0 = ground.standY(p[0][0], p[0][1]), y1 = ground.standY(p[1][0], p[1][1])
    const y2 = ground.standY(p[2][0], p[2][1]), y3 = ground.standY(p[3][0], p[3][1])
    // (u, v) run 0 → 1 from corner 0 towards corner 1 and corner 3; below the diagonal the
    // triangle is (0, 1, 2), above it (0, 2, 3)
    const at = (u: number, v: number) => (v <= u ? y0 + (y1 - y0) * u + (y2 - y1) * v : y0 + (y2 - y3) * u + (y3 - y0) * v)
    const N = 4
    let rise = 0
    for (let i = 0; i <= N; i++) {
      for (let k = 0; k <= N; k++) {
        const u = i / N, v = k / N
        if ((u === 0 || u === 1) && (v === 0 || v === 1)) continue
        const x = p[0][0] + (p[1][0] - p[0][0]) * u + (p[3][0] - p[0][0]) * v
        const z = p[0][1] + (p[1][1] - p[0][1]) * u + (p[3][1] - p[0][1]) * v
        const need = ground.standY(x, z) - at(u, v)
        if (need > rise) rise = need
      }
    }
    const lift = rise + CAR_PARK.speckle.lift
    return [y0 + lift, y1 + lift, y2 + lift, y3 + lift]
  }

  // --- one planning job per lot -----------------------------------------------------------------
  function planLot(lot: Lot) {
    // 60 of the 111 lots are outside the terrain rectangle, where there is no height field at all
    // — no bay of theirs could be kept, so lay none out (their ring still keeps the forest off)
    if (lot.box[2] < gridInset[0] || lot.box[0] > gridInset[2] || lot.box[3] < gridInset[1] || lot.box[1] > gridInset[3]) return
    const ko = keepOutsFor(lot.box)
    const before = stats.cars
    const jit = THREE.MathUtils.degToRad(CAR_PARK.yawJitterDeg)
    const { bayW, bayD, pitch, aisle } = CAR_PARK
    // The centreline distance of the lot's centre, measured once: `plan.project` is 1-Lipschitz,
    // so this one number plus the lot's radius already decides most bays (and, when the whole lot
    // is inside the 140 m band, the whole lot at once).
    const dCentre = plan.project(lot.cx, lot.cz).d
    if (dCentre + lot.radius < CAR_PARK.minD) {
      const bays = Math.max(1, Math.round(((lot.a1 - lot.a0) * (lot.c1 - lot.c0)) / (bayW * pitch / 2)))
      stats.bays += bays
      stats.rejected.minD += bays
      return
    }
    // a car whose nose points along +a
    const yawAlong = Math.atan2(lot.ax, lot.az)

    // The coach strip: one line of 12.5 m bays across the lot's short axis, in the lots within
    // 700 m of a gate. It cannot simply sit on the c0 edge of the oriented box — that edge only
    // touches the polygon at one vertex, so a 12.5 m bay there falls outside the ring — so the
    // strip is slid inwards in 4 m steps and settles where the most bays pass the bay rule (a
    // coach needs 12.5 × 3.5 m of ground that is inside the lot, clear and not a bank).
    let cStart = lot.c0
    if (lot.coach && lot.c1 - lot.c0 >= CAR_PARK.coach.strip + pitch && lot.a1 - lot.a0 >= 30) {
      const cars = ((lot.a1 - lot.a0) * (lot.c1 - lot.c0) / (bayW * pitch / 2)) * lot.occupancy
      const want = Math.min(CAR_PARK.coach.maxPerLot, Math.max(1, Math.round(cars * CAR_PARK.coach.share)))
      const cw = CAR_PARK.coach.bayW, cd = CAR_PARK.coach.bayD
      const mid = (lot.a0 + lot.a1) / 2
      const span = Math.min(lot.a1 - lot.a0 - 4, want * cw)
      const n = Math.floor(span / cw)
      const aOf = (i: number) => mid - span / 2 + cw * (i + 0.5)
      const cornersOf = (a: number, c: number): XZ[] => [world(lot, a - cw / 2, c - cd / 2), world(lot, a + cw / 2, c - cd / 2), world(lot, a + cw / 2, c + cd / 2), world(lot, a - cw / 2, c + cd / 2)]
      let best: { c: number; bays: { i: number; x: number; z: number; y: number }[]; why: BayReject[] } | null = null
      for (let off = 0; off <= 80; off += 4) {
        const c = lot.c0 + cd / 2 + 0.25 + off
        if (c + cd / 2 > lot.c1) break
        const bays: { i: number; x: number; z: number; y: number }[] = []
        const why: BayReject[] = []
        for (let i = 0; i < n; i++) {
          const a = aOf(i)
          const [x, z] = world(lot, a, c)
          const r = bayTest(x, z, cornersOf(a, c), lot, 'in', ko, dCentre)
          if (typeof r === 'string') why.push(r)
          else bays.push({ i, x, z, y: r })
        }
        if (!best || bays.length > best.bays.length) best = { c, bays, why }
        if (bays.length === n) break
      }
      if (best && best.bays.length) {
        // only the strip that was actually laid out counts as bays; the others were the search
        stats.bays += n
        stats.kept += best.bays.length
        for (const r of best.why) stats.rejected[r]++
        for (const bay of best.bays) {
          if (hash2(bay.i, 7, lot.seed) > lot.occupancy) continue
          // nose first, away from the aisle on the +c side (yawAlong + π/2 is −c), jittered
          const yaw = yawAlong + Math.PI / 2 + (hash2(bay.i, 8, lot.seed) - 0.5) * 2 * jit
          addCar({ x: bay.x, z: bay.z, y: bay.y + CAR_PARK.lift, yaw, body: 'coach', colour: pickCarColour(0.05, hash2(bay.i, 9, lot.seed), new THREE.Color()) })
          stats.coaches++
        }
        cStart = best.c + cd / 2 + aisle
      }
    }

    // the double-loaded rows: bays [base, base + 5] nosing −c, the 6 m aisle, bays [base + 11,
    // base + 16] nosing +c; bays are 2.5 m wide, counted from the lot's a0 end
    const nAlong = Math.floor((lot.a1 - lot.a0) / bayW)
    let rowIndex = 0
    for (let base = cStart; base + bayD <= lot.c1 + 1e-6; base += pitch) {
      for (const side of [0, 1] as const) {
        const cb0 = side === 0 ? base : base + bayD + aisle
        const cb1 = cb0 + bayD
        if (cb1 > lot.c1 + 1e-6) continue
        stats.rows++
        const row = rowIndex++
        // yaw θ points the nose at (sin θ, cos θ); +c is (−az, ax), which is yawAlong − π/2.
        // The aisle is on the +c side of the near row and the −c side of the far one, so this is
        // the nose-first yaw — the `noseOut` share below turns round and reverses in instead.
        const noseFirst = side === 0 ? yawAlong + Math.PI / 2 : yawAlong - Math.PI / 2
        // the speckle: runs of consecutive KEPT bays, `baysPerQuad` of them per quad
        let runStart = -1, runBays = 0
        let runR = 0, runG = 0, runB = 0, runCars = 0
        const flush = (endJ: number) => {
          if (runStart >= 0 && runCars > 0) {
            const a0 = lot.a0 + runStart * bayW, a1 = lot.a0 + endJ * bayW
            _c.setRGB(runR / runCars, runG / runCars, runB / runCars)
            _asphalt.setRGB(CAR_PARK.speckle.asphalt, CAR_PARK.speckle.asphalt, CAR_PARK.speckle.asphalt)
            _c.lerp(_asphalt, 1 - runCars / runBays)
            const p: [XZ, XZ, XZ, XZ] = [world(lot, a0, cb0), world(lot, a1, cb0), world(lot, a1, cb1), world(lot, a0, cb1)]
            addQuad({ p, y: stripY(p), colour: _c.clone() })
          }
          runStart = -1
          runBays = 0
          runR = runG = runB = runCars = 0
        }
        for (let j = 0; j < nAlong; j++) {
          const a = lot.a0 + bayW * (j + 0.5)
          const c = (cb0 + cb1) / 2
          const corners: XZ[] = [world(lot, a - bayW / 2, cb0), world(lot, a + bayW / 2, cb0), world(lot, a + bayW / 2, cb1), world(lot, a - bayW / 2, cb1)]
          const [x, z] = world(lot, a, c)
          stats.bays++
          const r = bayTest(x, z, corners, lot, 'in', ko, dCentre)
          if (typeof r === 'string') { stats.rejected[r]++; flush(j); continue }
          stats.kept++
          if (runStart < 0) runStart = j
          runBays++
          if (hash2(j, row, lot.seed) < lot.occupancy) {
            const h1 = hash2(j, row + 1000, lot.seed), h2 = hash2(j, row + 2000, lot.seed), h3 = hash2(j, row + 3000, lot.seed)
            const h4 = hash2(j, row + 4000, lot.seed), h5 = hash2(j, row + 5000, lot.seed), h6 = hash2(j, row + 6000, lot.seed)
            const colour = pickCarColour(h2, h3, new THREE.Color())
            const yaw = noseFirst + (h4 < CAR_PARK.noseOut ? Math.PI : 0) + (h5 - 0.5) * 2 * jit
            const pj = CAR_PARK.posJitter
            const [px, pz] = world(lot, a + (h6 - 0.5) * 2 * pj, c + (h5 - 0.5) * 2 * pj)
            addCar({ x: px, z: pz, y: r + CAR_PARK.lift, yaw, body: pickCarBody(h1), colour })
            runR += colour.r
            runG += colour.g
            runB += colour.b
            runCars++
          }
          if (runBays >= CAR_PARK.speckle.baysPerQuad) flush(j + 1)
        }
        flush(nAlong)
      }
    }

    // the verge: a few cars on the grass just outside the temporary lot's long edges
    if (lot.verge) {
      const { spacing, offset, occupancy, max } = CAR_PARK.verge
      let placed = 0
      const n = lot.ring.length
      outer: for (let i = 0; i < n; i++) {
        const [ax, az] = lot.ring[i]!, [bx, bz] = lot.ring[(i + 1) % n]!
        const ex = bx - ax, ez = bz - az
        const len = Math.hypot(ex, ez)
        if (len < 20) continue
        const ux = ex / len, uz = ez / len
        // the outward normal: the side of the edge's midpoint that is outside the ring
        let nx = uz, nz = -ux
        const mx = (ax + bx) / 2, mz = (az + bz) / 2
        if (pointInRing(mx + nx * 1.5, mz + nz * 1.5, lot.ring)) { nx = -nx; nz = -nz }
        const edgeYaw = Math.atan2(ux, uz)
        for (let t = spacing; t < len - spacing / 2; t += spacing) {
          const x = ax + ux * t + nx * offset, z = az + uz * t + nz * offset
          const k = Math.round(t)
          if (hash2(i, k, lot.seed + 77) > occupancy) continue
          // grass or bare ground only — never on a road, another lot or the water
          const cls = landCover.classAt(x, z)
          if (cls === 'paved' || cls === 'parking' || cls === 'water') continue
          const hw = CAR_PARK.bayW / 2, hl = CAR_PARK.bayD / 2
          const corners: XZ[] = [
            [x - ux * hl - nx * hw, z - uz * hl - nz * hw], [x + ux * hl - nx * hw, z + uz * hl - nz * hw],
            [x + ux * hl + nx * hw, z + uz * hl + nz * hw], [x - ux * hl + nx * hw, z - uz * hl + nz * hw],
          ]
          stats.bays++
          const r = bayTest(x, z, corners, lot, 'out', ko, dCentre)
          if (typeof r === 'string') { stats.rejected[r]++; continue }
          stats.kept++
          const yaw = edgeYaw + (hash2(i, k + 1, lot.seed) < 0.5 ? 0 : Math.PI) + (hash2(i, k + 2, lot.seed) - 0.5) * 2 * jit
          addCar({
            x, z, y: r + CAR_PARK.lift, yaw,
            body: pickCarBody(hash2(i, k + 3, lot.seed)),
            colour: pickCarColour(hash2(i, k + 4, lot.seed), hash2(i, k + 5, lot.seed), new THREE.Color()),
          })
          stats.verge++
          if (++placed >= max) break outer
        }
      }
    }
    if (stats.cars > before) stats.lotsUsed++
  }

  for (const lot of all) {
    stats.jobs++
    farField.defer('buildings', `carParkPlan-${lot.id}`, 4, () => {
      planLot(lot)
      return null
    })
  }

  // --- one build job per cell, queued once every lot is planned ---------------------------------
  const castShadow = q.farField.shadows
  const bodyGeos = new Map<CarBody, THREE.BufferGeometry>()
  const geoOf = (k: CarBody) => {
    let g = bodyGeos.get(k)
    if (!g) bodyGeos.set(k, (g = carBodyGeometry(k)))
    return g
  }
  /** share of the planned cars drawn in levels 0 / 1 (set by the fan-out job) */
  let keepRatio = 1
  const triCount = (g: THREE.BufferGeometry) => Math.floor((g.getIndex()?.count ?? g.attributes.position!.count) / 3)

  function buildCell(cell: number): THREE.Object3D | null {
    const cars = carsByCell.get(cell) ?? []
    const quads = quadsByCell.get(cell) ?? []
    if (!cars.length && !quads.length) return null
    const { bodyMat, speckleMat, card } = materials()
    stats.cells++
    const root = new THREE.Group()
    root.name = `carPark-${cell}`
    // the budget is spent as a per-cell FRACTION rather than an integer stride, so a cell of 5
    // cars keeps its share instead of rounding away and the total lands on the budget
    const drawn: Car[] = []
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!
      if (car.body === 'coach' || Math.floor((i + 1) * keepRatio) > Math.floor(i * keepRatio)) drawn.push(car)
    }

    // level 0: the 3D bodies, one InstancedMesh per silhouette
    const bodies = new THREE.Group()
    bodies.name = `carParkBodies-${cell}`
    const byBody = new Map<CarBody, Car[]>()
    for (const car of drawn) {
      let list = byBody.get(car.body)
      if (!list) byBody.set(car.body, (list = []))
      list.push(car)
    }
    for (const [kind, list] of byBody) {
      const geo = geoOf(kind)
      const inst = new THREE.InstancedMesh(geo, bodyMat, list.length)
      list.forEach((car, i) => {
        _q.setFromAxisAngle(Y_UP, car.yaw)
        _s.setScalar(1)
        inst.setMatrixAt(i, _m.compose(_p.set(car.x, car.y, car.z), _q, _s))
        inst.setColorAt(i, car.colour)
      })
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      inst.castShadow = castShadow
      inst.receiveShadow = true
      inst.computeBoundingSphere()
      inst.name = `carParkBodies-${cell}-${kind}`
      bodies.add(inst)
      stats.bodies += list.length
      stats.tris.bodies += triCount(geo) * list.length
    }
    root.add(bodies)
    const levels: FarLevel[] = [{ object: bodies, range: CAR_PARK.lod.bodies, ramp: CAR_PARK.lod.ramp }]

    // level 1: the baked impostor cards (high tier with the asset pack)
    if (card && drawn.length) {
      const n = drawn.length
      const cards = new THREE.Group()
      cards.name = `carParkCards-${cell}`
      const geo = card.geo.clone()
      const inst = new THREE.InstancedMesh(geo, card.mat, n)
      const arrays = IMPOSTOR_ATTRIBUTES.map((a) => new Float32Array(n * a.size))
      const info = arrays[0]!, tint0 = arrays[1]!, tint1 = arrays[2]!
      drawn.forEach((car, i) => {
        _q.identity()
        _s.setScalar(1)
        inst.setMatrixAt(i, _m.compose(_p.set(car.x, car.y, car.z), _q, _s))
        info[i * 4] = CAR_BODIES.indexOf(car.body)
        info[i * 4 + 1] = -1
        info[i * 4 + 2] = car.yaw
        info[i * 4 + 3] = hash2(Math.round(car.x), Math.round(car.z), 3)
        tint0[i * 4] = car.colour.r
        tint0[i * 4 + 1] = car.colour.g
        tint0[i * 4 + 2] = car.colour.b
        tint0[i * 4 + 3] = 1
        tint1[i * 3] = tint1[i * 3 + 1] = tint1[i * 3 + 2] = 0
      })
      inst.instanceMatrix.needsUpdate = true
      IMPOSTOR_ATTRIBUTES.forEach((a, i) => geo.setAttribute(a.name, new THREE.InstancedBufferAttribute(arrays[i]!, a.size)))
      inst.castShadow = false
      inst.receiveShadow = true
      inst.computeBoundingSphere()
      inst.name = `carParkCards-${cell}`
      // the shader billboards towards uCamPos: whichever camera is drawing this pass
      inst.onBeforeRender = (_r, _sc, camera) => { camPos.value.setFromMatrixPosition(camera.matrixWorld) }
      cards.add(inst)
      stats.cards += n
      stats.tris.cards += triCount(geo) * n
      root.add(cards)
      levels.push({ object: cards, range: q.farField.rangeFar })
    }

    // level 2: the overview speckle
    const speckle = new THREE.Group()
    speckle.name = `carSpeckleGroup-${cell}`
    if (quads.length) {
      const pos = new Float32Array(quads.length * 6 * 3)
      const col = new Float32Array(quads.length * 6 * 3)
      let k = 0
      const put = (x: number, y: number, z: number, c: THREE.Color) => {
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b
        k++
      }
      for (const qd of quads) {
        const [p0, p1, , p3] = qd.p
        // wind to face +Y: in XZ a triangle faces up when its signed area is NEGATIVE (z is south)
        const cross = (p1[0] - p0[0]) * (p3[1] - p0[1]) - (p1[1] - p0[1]) * (p3[0] - p0[0])
        const order = cross < 0 ? [0, 1, 2, 0, 2, 3] : [0, 3, 2, 0, 2, 1]
        for (const i of order) put(qd.p[i]![0], qd.y[i]!, qd.p[i]![1], qd.colour)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, speckleMat)
      mesh.name = `carSpeckle-${cell}`
      mesh.receiveShadow = castShadow
      speckle.add(mesh)
      stats.tris.speckle += quads.length * 2
    }
    root.add(speckle)
    levels.push({ object: speckle, range: Infinity })

    farField.register({ kind: 'carPark', name: `carPark-${cell}`, cell, levels })
    root.userData.cars = { planned: cars.length, drawn: drawn.length, quads: quads.length }
    return root
  }

  stats.jobs++
  farField.defer('buildings', 'carParkCells', 2, () => {
    // the lots' own rings become keep-outs only now that every bay is planned: a lot is not a
    // keep-out for its own cars, and neighbouring lots share edges
    for (const lot of all) ctx.keepOutPolys.push({ ring: lot.ring, box: lot.box })
    keepRatio = Math.min(1, q.farField.parkedCars / Math.max(1, totalCars))
    stats.stride = Number((1 / keepRatio).toFixed(2))
    const cells = new Set<number>([...carsByCell.keys(), ...quadsByCell.keys()])
    for (const cell of [...cells].sort((a, b) => a - b)) {
      stats.jobs++
      farField.defer('buildings', `carPark-${cell}`, 6, () => buildCell(cell))
    }
    return null
  })
  return stats
}
