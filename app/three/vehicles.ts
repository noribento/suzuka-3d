import * as THREE from 'three'
import { SUR_PARKING, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing } from '~/data/en-codec'
import { CAR_LAYOUT } from '~/data/impostor-atlas'
import { CAR_BODIES, COACH_ROW_SCALE, carBodyGeometry, carBodyMaterial, pickCarBody, pickCarColour, type CarBody } from './car-bodies'
import type { EnvBuildContext } from './environment'
import { FAR_CELL_M, type FarLevel } from './farfield'
import { inBBox, pointInRing, principalAxis, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
import { IMPOSTOR_ATTRIBUTES, impostorGeometry, impostorMaterial } from './impostor'
import { cutoutParams } from './materials'

/**
 * Parked cars in the OSM car parks (plan §2d): every `amenity=parking` polygon of
 * app/data/suzuka-surroundings.ts (SUR_PARKING, 111 lots) gets rows of nose-in bays along its
 * principal axis at the 16 m pitch of a double-loaded lot (5 m bays, 6 m aisle, 5 m bays), and
 * the bays that pass the ground rules are filled from the late-March mix of car-bodies.ts.
 * Nothing is built here for the asphalt itself — the lot's surface is the `parking` class of the
 * land-cover mask (landcover.ts) — so the cars stand straight on `ground.standY` (R3), 2 cm up.
 *
 * A bay is kept only when (README 地面の契約 R1 / R11, the pit-complex rule):
 *  - its four corners lie inside the lot and inside the terrain rectangle,
 *  - none of them is in a keep-out disc (`ctx.keepOut`) or polygon (`ctx.keepOutPolys`) — the
 *    buildings' footprints, pushed in the same 'buildings' stage before these jobs run,
 *  - it is ≥ 140 m from the centreline (`plan.project`) and on no drawn ground face
 *    (`ground.builtY === null`) — the corners and the centre,
 *  - `ground.standY` varies ≤ 2 cm over the bay (a flat car on a graded lot; a sloping bay
 *    would bury a wheel).
 * Occupancy is 0.95 inside 900 m of the circuit boundary (SUR_SITES 775428456) and 0.6
 * beyond; the temporary F1 lot also gets a few cars on its grass verge. Coaches (3–5 % of a
 * lot's vehicles) take a 13 m strip along one long side, only in lots within 700 m of a gate.
 *
 * LOD, one far-field entry per 250 m cell (`carPark-<cell>`), levels chosen by the registry:
 *  0  the 3D bodies (one InstancedMesh per silhouette) inside 500 m, count-ramped over the
 *     last 100 m — the cars strided down to `Quality.farField.parkedCars` (coaches always kept),
 *  1  (high tier with the asset pack) baked impostor cards (`tex/car_atlas`, CAR_LAYOUT,
 *     impostor.ts 'body' mask mode) to `Quality.farField.rangeFar`, the same strided cars,
 *  2  the overview "speckle" (`carSpeckle-<cell>`) at any distance: one vertex-coloured quad per
 *     run of four occupied bays, 3 cm over the ground, coloured by the mean paintwork of the
 *     cars in it — so a full lot reads as the mottled white-grey of the aerials from 1.8 km up
 *     instead of empty asphalt. It is an up-facing overlay, so it is built only from bays that
 *     passed the rules above (≥ 140 m out, no drawn face under it): the overlay rule is inherited.
 *
 * Every lot's ring is pushed to `ctx.keepOutPolys` in the 'buildings' stage, before the forest.
 * Materials are created inside the jobs (the registry's attach hook sets them up).
 */

/** the layout and rule constants of this builder (the tier budgets live in quality.ts) */
export const CAR_PARK = {
  /** the closest a bay may come to the centreline (m): the overlay band of the far field */
  minD: 140,
  /** double-loaded row pitch: bay depth + aisle + bay depth (m) */
  pitch: 16,
  bayW: 2.5,
  bayD: 5,
  aisle: 6,
  /** per-car yaw jitter (deg) and the position jitter inside the bay (m) */
  yawJitterDeg: 2,
  posJitter: 0.15,
  /** max `standY` spread over a bay's corners and centre (m) */
  slopeMax: 0.02,
  /** the cars' lift over standY (m) */
  lift: 0.02,
  /** share of cars reversed into the bay (nose to the aisle), the Japanese habit */
  noseOut: 0.7,
  occupancy: { near: 0.95, far: 0.6, nearM: 900 },
  /** coaches: share of a lot's vehicles, the gate radius (m), their bay and the strip they take on the lot's long side */
  coach: { share: 0.04, gateM: 700, bayW: 3.5, bayD: 12.5, strip: 13 },
  /** the temporary F1 lot's grass verge: OSM ids, spacing along the edge, offset outside it, occupancy, cap */
  verge: { lotIds: [184529074] as readonly number[], spacing: 7, offset: 3.2, occupancy: 0.4, max: 14 },
  /** LOD: the 3D bodies' range and count ramp (m, × lodScale); the cards use Quality.farField.rangeFar */
  lod: { bodies: 500, ramp: 100 },
  /** the overview speckle: bays per quad along a row, lift over standY (m), the asphalt tone empty bays mix in */
  speckle: { baysPerQuad: 4, lift: 0.03, asphalt: 0.16 },
} as const

export type BayReject = 'ring' | 'grid' | 'keepOut' | 'minD' | 'builtY' | 'slope'

export interface ParkedCarStats {
  lots: number
  /** lots with at least one car */
  lotsUsed: number
  rows: number
  /** bays laid out / bays that passed the rules */
  bays: number
  kept: number
  rejected: Record<BayReject, number>
  /** cars placed (coaches and verge cars included) */
  cars: number
  coaches: number
  verge: number
  /** every `stride`-th car draws in levels 0 / 1 */
  stride: number
  bodies: number
  cards: number
  /** speckle quads (level 2) */
  quads: number
  cells: number
  jobs: number
  atlas: 'baked' | 'none'
  /** cars that fell outside the queued cells (should be 0) */
  orphans: number
}

interface Lot {
  id: number
  name: string
  ring: XZ[]
  box: [number, number, number, number]
  dmin: number
  /** frame: centre, unit axis (along), extents along / across the axis relative to the centre */
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
  cell: number
}

interface Quad {
  /** world corners, counter-clockwise seen from above is not required: wound on emit */
  p: [XZ, XZ, XZ, XZ]
  y: [number, number, number, number]
  colour: THREE.Color
  cell: number
}

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const Y_UP = new THREE.Vector3(0, 1, 0)

function hash2(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** distance from (x, z) to the nearest edge of the ring */
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
    let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity
    for (const [x, z] of ring) {
      const dx = x - pa.cx, dz = z - pa.cz
      const a = dx * pa.ax + dz * pa.az
      const c = -dx * pa.az + dz * pa.ax
      if (a < a0) a0 = a
      if (a > a1) a1 = a
      if (c < c0) c0 = c
      if (c > c1) c1 = c
    }
    const cx = pa.cx, cz = pa.cz
    let dCircuit = Infinity
    if (circuit && circuitBox) dCircuit = inBBox(cx, cz, circuitBox) && pointInRing(cx, cz, circuit) ? 0 : distToRing(cx, cz, circuit)
    let dGate = Infinity
    for (const [gx, gz] of gates) dGate = Math.min(dGate, Math.hypot(gx - cx, gz - cz))
    out.push({
      id: f.id,
      name: f.tags.name ?? '',
      ring,
      box,
      dmin: f.dmin,
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
 * Queue the car parks' deferred jobs ('buildings' stage): one planning job per lot (the bays,
 * the rules, the keep-out ring), then one job per 250 m cell that builds the three LOD levels
 * from the cars planned into it. Returns the statistics object the jobs fill in (also
 * `ctx.farField.group.userData.parkedCars`, for the offline harness).
 */
export function buildParkedCars(ctx: EnvBuildContext): ParkedCarStats {
  const { ground, quality: q, farField, assets, landCover, terrain } = ctx
  const plan = ground.plan
  const grid: GridShape = terrain.grid()
  const all = lots(ctx)
  const stats: ParkedCarStats = {
    lots: all.length, lotsUsed: 0, rows: 0, bays: 0, kept: 0,
    rejected: { ring: 0, grid: 0, keepOut: 0, minD: 0, builtY: 0, slope: 0 },
    cars: 0, coaches: 0, verge: 0, stride: 1, bodies: 0, cards: 0, quads: 0, cells: 0, jobs: 0, atlas: 'none', orphans: 0,
  }
  farField.group.userData.parkedCars = stats
  if (!all.length) return stats

  // --- shared state the jobs fill and read ----------------------------------------------------
  const carsByCell = new Map<number, Car[]>()
  const quadsByCell = new Map<number, Quad[]>()
  let totalCars = 0
  const gridBox: [number, number, number, number] = [grid.x0, grid.z0, grid.x0 + grid.w, grid.z0 + grid.d]
  const gridInset: [number, number, number, number] = [gridBox[0] + 1, gridBox[1] + 1, gridBox[2] - 1, gridBox[3] - 1]

  // materials and the atlas, made in the first job that needs them (the attach hook covers every root)
  const time = { value: 0 }
  const camPos = { value: new THREE.Vector3() }
  let bodyMat: THREE.MeshStandardMaterial | null = null
  let speckleMat: THREE.MeshStandardMaterial | null = null
  let card: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null | undefined
  const materials = () => {
    if (!bodyMat) {
      bodyMat = carBodyMaterial()
      speckleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 })
      speckleMat.customProgramCacheKey = () => 'carSpeckle'
    }
    if (card === undefined) {
      card = null
      if (q.farField.carImpostors && assets) {
        const diff = assets.texture('tex/car_atlas/diff')
        const mask = assets.texture('tex/car_atlas/mask')
        if (diff && mask) {
          const mat = impostorMaterial({ map: diff, mask }, CAR_LAYOUT, { pitchBands: 1, cheer: false, sway: 0, maskMode: 'body', cutout: cutoutParams(q), cacheKey: 'impostor|car', time, camPos, roughness: 0.6 })
          card = { geo: impostorGeometry(CAR_LAYOUT), mat }
          stats.atlas = 'baked'
        }
      }
    }
    return { bodyMat: bodyMat!, speckleMat: speckleMat!, card }
  }

  // --- the bay rule ----------------------------------------------------------------------------
  /** keep-outs clipped to a lot's bbox (+ the coach strip), gathered when the lot's job runs */
  const keepOutsFor = (box: [number, number, number, number]) => {
    const m = 14
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
   * The rule on a footprint given by its centre and four corners. `inside` 'in' requires the
   * corners inside the lot, 'out' requires them outside it (the verge). Returns the rejection or
   * the footprint's height (standY at the centre).
   */
  const bayTest = (cx: number, cz: number, corners: readonly XZ[], lot: Lot, inside: 'in' | 'out', ko: KeepOuts): BayReject | number => {
    for (const [x, z] of corners) {
      if (!inBBox(x, z, gridInset)) return 'grid'
      const inRing = inBBox(x, z, lot.box) && pointInRing(x, z, lot.ring)
      if (inside === 'in' ? !inRing : inRing) return 'ring'
    }
    for (const [x, z] of corners) if (inKeepOut(x, z, ko)) return 'keepOut'
    if (inKeepOut(cx, cz, ko)) return 'keepOut'
    // the centreline distance: a lot whose nearest vertex is far beyond minD needs no projection
    if (lot.dmin < CAR_PARK.minD + 160) {
      const d = plan.project(cx, cz).d
      if (d < CAR_PARK.minD) return 'minD'
      if (d < CAR_PARK.minD + 8) for (const [x, z] of corners) if (plan.project(x, z).d < CAR_PARK.minD) return 'minD'
    }
    if (ground.builtY(cx, cz)) return 'builtY'
    for (const [x, z] of corners) if (ground.builtY(x, z)) return 'builtY'
    const y = ground.standY(cx, cz)
    let lo = y, hi = y
    for (const [x, z] of corners) {
      const yy = ground.standY(x, z)
      if (yy < lo) lo = yy
      if (yy > hi) hi = yy
    }
    if (hi - lo > CAR_PARK.slopeMax) return 'slope'
    return y
  }

  const addCar = (car: Car) => {
    let list = carsByCell.get(car.cell)
    if (!list) carsByCell.set(car.cell, (list = []))
    list.push(car)
    totalCars++
    stats.cars++
  }

  // --- the lots' planning jobs --------------------------------------------------------------
  const cellsWanted = new Set<number>()
  for (const lot of all) {
    // the cells this lot (and its verge) can put cars into
    const m = 8
    for (let z = Math.max(lot.box[1] - m, gridBox[1]); z <= Math.min(lot.box[3] + m, gridBox[3] - 0.01); z += FAR_CELL_M / 2) {
      for (let x = Math.max(lot.box[0] - m, gridBox[0]); x <= Math.min(lot.box[2] + m, gridBox[2] - 0.01); x += FAR_CELL_M / 2) cellsWanted.add(farField.cellOf(x, z))
    }
    stats.jobs++
    farField.defer('buildings', 'carParkPlan', 4, () => {
      planLot(lot)
      return null
    })
  }

  /** world point of the lot frame (a along the axis, c across it) */
  const world = (lot: Lot, a: number, c: number): XZ => [lot.cx + a * lot.ax - c * lot.az, lot.cz + a * lot.az + c * lot.ax]

  function planLot(lot: Lot) {
    const ko = keepOutsFor(lot.box)
    ctx.keepOutPolys.push({ ring: lot.ring, box: lot.box })
    const before = stats.cars
    const yawAlong = Math.atan2(lot.ax, lot.az) // a car whose nose points along +a
    const jit = THREE.MathUtils.degToRad(CAR_PARK.yawJitterDeg)
    const { bayW, bayD, pitch, aisle } = CAR_PARK
    // the coach strip on the c0 side of the lot, when the lot is near a gate and long enough for it
    let cStart = lot.c0
    if (lot.coach && lot.c1 - lot.c0 >= CAR_PARK.coach.strip + pitch && lot.a1 - lot.a0 >= 30) {
      const expected = ((lot.a1 - lot.a0) * (lot.c1 - lot.c0) / (bayW * pitch / 2)) * lot.occupancy
      const want = Math.max(1, Math.round(expected * CAR_PARK.coach.share))
      const cw = CAR_PARK.coach.bayW, cd = CAR_PARK.coach.bayD
      const mid = (lot.a0 + lot.a1) / 2
      const span = Math.min(lot.a1 - lot.a0 - 4, want * cw)
      const n = Math.floor(span / cw)
      const c = lot.c0 + cd / 2 + 0.25
      for (let i = 0; i < n; i++) {
        const a = mid - span / 2 + cw * (i + 0.5)
        const corners: XZ[] = [world(lot, a - cw / 2, c - cd / 2), world(lot, a + cw / 2, c - cd / 2), world(lot, a + cw / 2, c + cd / 2), world(lot, a - cw / 2, c + cd / 2)]
        const [x, z] = world(lot, a, c)
        stats.bays++
        const r = bayTest(x, z, corners, lot, 'in', ko)
        if (typeof r === 'string') { stats.rejected[r]++; continue }
        stats.kept++
        if (hash2(i, 7, lot.seed) > lot.occupancy) continue
        // nose to the aisle (+c side), a little yaw jitter
        const yaw = yawAlong + Math.PI / 2 + (hash2(i, 8, lot.seed) - 0.5) * 2 * jit
        addCar({ x, z, y: r + CAR_PARK.lift, yaw, body: 'coach', colour: pickCarColour(0.05, hash2(i, 9, lot.seed), new THREE.Color()), cell: farField.cellOf(x, z) })
        stats.coaches++
      }
      cStart = lot.c0 + CAR_PARK.coach.strip + aisle
    }
    // the double-loaded rows: bays [base, base + 5] nose −c, aisle, bays [base + 11, base + 16] nose +c
    const nAlong = Math.floor((lot.a1 - lot.a0) / bayW)
    let rowIndex = 0
    for (let base = cStart; base + bayD <= lot.c1 + 1e-6; base += pitch) {
      for (const side of [0, 1] as const) {
        const cb0 = side === 0 ? base : base + bayD + aisle
        const cb1 = cb0 + bayD
        if (cb1 > lot.c1 + 1e-6) continue
        stats.rows++
        const row = rowIndex++
        // nose direction of the row: away from the aisle
        const noseIn = side === 0 ? yawAlong - Math.PI / 2 : yawAlong + Math.PI / 2
        // speckle runs: consecutive kept bays, `baysPerQuad` per quad
        let runStart = -1, runCars: THREE.Color[] = [], runBays = 0
        const flush = (endJ: number) => {
          if (runStart >= 0 && runCars.length) {
            const a0 = lot.a0 + runStart * bayW, a1 = lot.a0 + endJ * bayW
            _c.setRGB(0, 0, 0)
            for (const col of runCars) _c.add(col)
            _c.multiplyScalar(1 / runCars.length)
            const empty = 1 - runCars.length / runBays
            _c.lerp(new THREE.Color(CAR_PARK.speckle.asphalt, CAR_PARK.speckle.asphalt, CAR_PARK.speckle.asphalt), empty)
            const p: [XZ, XZ, XZ, XZ] = [world(lot, a0, cb0), world(lot, a1, cb0), world(lot, a1, cb1), world(lot, a0, cb1)]
            const y = p.map(([x, z]) => ground.standY(x, z) + CAR_PARK.speckle.lift) as [number, number, number, number]
            const [mx, mz] = world(lot, (a0 + a1) / 2, (cb0 + cb1) / 2)
            const cell = farField.cellOf(mx, mz)
            let list = quadsByCell.get(cell)
            if (!list) quadsByCell.set(cell, (list = []))
            list.push({ p, y, colour: _c.clone(), cell })
            stats.quads++
          }
          runStart = -1
          runCars = []
          runBays = 0
        }
        for (let j = 0; j < nAlong; j++) {
          const a = lot.a0 + bayW * (j + 0.5)
          const c = (cb0 + cb1) / 2
          const corners: XZ[] = [world(lot, a - bayW / 2, cb0), world(lot, a + bayW / 2, cb0), world(lot, a + bayW / 2, cb1), world(lot, a - bayW / 2, cb1)]
          const [x, z] = world(lot, a, c)
          stats.bays++
          const r = bayTest(x, z, corners, lot, 'in', ko)
          if (typeof r === 'string') { stats.rejected[r]++; flush(j); continue }
          stats.kept++
          if (runStart < 0) runStart = j
          runBays++
          const h0 = hash2(j, row, lot.seed)
          if (h0 < lot.occupancy) {
            const h1 = hash2(j, row + 1000, lot.seed), h2 = hash2(j, row + 2000, lot.seed), h3 = hash2(j, row + 3000, lot.seed)
            const h4 = hash2(j, row + 4000, lot.seed), h5 = hash2(j, row + 5000, lot.seed), h6 = hash2(j, row + 6000, lot.seed)
            const body = pickCarBody(h1)
            const colour = pickCarColour(h2, h3, new THREE.Color())
            const out = h4 < CAR_PARK.noseOut
            const yaw = noseIn + (out ? Math.PI : 0) + (h5 - 0.5) * 2 * jit
            const pj = CAR_PARK.posJitter
            const [px, pz] = world(lot, a + (h6 - 0.5) * 2 * pj, c + (h5 - 0.5) * 2 * pj)
            addCar({ x: px, z: pz, y: r + CAR_PARK.lift, yaw, body, colour, cell: farField.cellOf(px, pz) })
            runCars.push(colour)
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
        // outward normal: the side of the edge's midpoint that is outside the ring
        let nx = uz, nz = -ux
        const mx = (ax + bx) / 2, mz = (az + bz) / 2
        if (pointInRing(mx + nx * 1.5, mz + nz * 1.5, lot.ring)) { nx = -nx; nz = -nz }
        const edgeYaw = Math.atan2(ux, uz)
        for (let t = spacing; t < len - spacing / 2; t += spacing) {
          const x = ax + ux * t + nx * offset, z = az + uz * t + nz * offset
          if (hash2(i, Math.round(t), lot.seed + 77) > occupancy) continue
          const cls = landCover.classAt(x, z)
          if (cls !== 'none' && cls !== 'edge') continue
          const hw = CAR_PARK.bayW / 2, hl = CAR_PARK.bayD / 2
          const corners: XZ[] = [
            [x - ux * hl - nx * hw, z - uz * hl - nz * hw], [x + ux * hl - nx * hw, z + uz * hl - nz * hw],
            [x + ux * hl + nx * hw, z + uz * hl + nz * hw], [x - ux * hl + nx * hw, z - uz * hl + nz * hw],
          ]
          stats.bays++
          const r = bayTest(x, z, corners, lot, 'out', ko)
          if (typeof r === 'string') { stats.rejected[r]++; continue }
          stats.kept++
          const k = Math.round(t)
          const yaw = edgeYaw + (hash2(i, k + 1, lot.seed) < 0.5 ? 0 : Math.PI) + (hash2(i, k + 2, lot.seed) - 0.5) * 2 * jit
          addCar({ x, z, y: r + CAR_PARK.lift, yaw, body: pickCarBody(hash2(i, k + 3, lot.seed)), colour: pickCarColour(hash2(i, k + 4, lot.seed), hash2(i, k + 5, lot.seed), new THREE.Color()), cell: farField.cellOf(x, z) })
          stats.verge++
          if (++placed >= max) break outer
        }
      }
    }
    if (stats.cars > before) stats.lotsUsed++
  }

  // --- the cells' build jobs (queued after every lot's job: same stage, later sequence) ----------
  const castShadow = q.farField.shadows
  const bodyGeos = new Map<CarBody, THREE.BufferGeometry>()
  const geoOf = (k: CarBody) => {
    let g = bodyGeos.get(k)
    if (!g) bodyGeos.set(k, (g = carBodyGeometry(k)))
    return g
  }
  let stride = 0
  let globalIndex = 0
  for (const cell of cellsWanted) {
    stats.jobs++
    farField.defer('buildings', `carPark-${cell}`, 6, () => {
      if (stride === 0) {
        stride = Math.max(1, Math.ceil(totalCars / Math.max(1, q.farField.parkedCars)))
        stats.stride = stride
        // cars planned into cells no job was queued for (none expected): count them once
        let seen = 0
        for (const c of cellsWanted) seen += carsByCell.get(c)?.length ?? 0
        stats.orphans = totalCars - seen
      }
      const cars = carsByCell.get(cell) ?? []
      const quads = quadsByCell.get(cell) ?? []
      if (!cars.length && !quads.length) return null
      const { bodyMat, speckleMat, card } = materials()
      stats.cells++
      const root = new THREE.Group()
      root.name = `carPark-${cell}`
      const drawn: Car[] = []
      for (const car of cars) {
        if (car.body === 'coach' || globalIndex % stride === 0) drawn.push(car)
        globalIndex++
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
        const inst = new THREE.InstancedMesh(geoOf(kind), bodyMat, list.length)
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
        inst.frustumCulled = true
        inst.computeBoundingSphere()
        inst.name = `carParkBodies-${cell}-${kind}`
        bodies.add(inst)
        stats.bodies += list.length
      }
      root.add(bodies)
      const levels: FarLevel[] = [{ object: bodies, range: CAR_PARK.lod.bodies, ramp: CAR_PARK.lod.ramp }]

      // level 1: the baked impostor cards (high tier with the atlas)
      if (card) {
        const n = drawn.length
        const cards = new THREE.Group()
        cards.name = `carParkCards-${cell}`
        if (n) {
          const inst = new THREE.InstancedMesh(card.geo.clone(), card.mat, n)
          const arrays = IMPOSTOR_ATTRIBUTES.map((a) => new Float32Array(n * a.size))
          const info = arrays[0]!, t0 = arrays[1]!, t1 = arrays[2]!
          drawn.forEach((car, i) => {
            const sc = car.body === 'coach' ? COACH_ROW_SCALE : 1
            _q.identity()
            _s.setScalar(sc)
            inst.setMatrixAt(i, _m.compose(_p.set(car.x, car.y, car.z), _q, _s))
            info[i * 4] = CAR_BODIES.indexOf(car.body)
            info[i * 4 + 1] = -1
            info[i * 4 + 2] = car.yaw
            info[i * 4 + 3] = hash2(Math.round(car.x), Math.round(car.z), 3)
            t0[i * 4] = car.colour.r
            t0[i * 4 + 1] = car.colour.g
            t0[i * 4 + 2] = car.colour.b
            t0[i * 4 + 3] = 1
            t1[i * 3] = 0
            t1[i * 3 + 1] = 0
            t1[i * 3 + 2] = 0
          })
          inst.instanceMatrix.needsUpdate = true
          IMPOSTOR_ATTRIBUTES.forEach((a, i) => inst.geometry.setAttribute(a.name, new THREE.InstancedBufferAttribute(arrays[i]!, a.size)))
          inst.castShadow = false
          inst.receiveShadow = true
          inst.frustumCulled = true
          inst.computeBoundingSphere()
          inst.name = `carParkCards-${cell}`
          // the shader billboards towards uCamPos: the camera of the pass that draws the cards
          inst.onBeforeRender = (_r, _s2, camera) => { camPos.value.setFromMatrixPosition(camera.matrixWorld) }
          cards.add(inst)
          stats.cards += n
        }
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
          const [p0, p1, p2, p3] = qd.p
          // wind to face +Y: (p1 − p0) × (p3 − p0) must point up
          const cross = (p1[0] - p0[0]) * (p3[1] - p0[1]) - (p1[1] - p0[1]) * (p3[0] - p0[0])
          const o = cross < 0 ? [0, 1, 2, 0, 2, 3] : [0, 3, 2, 0, 2, 1]
          for (const i of o) put(qd.p[i]![0], qd.y[i]!, qd.p[i]![1], qd.colour)
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
        geo.computeVertexNormals()
        geo.computeBoundingSphere()
        const mesh = new THREE.Mesh(geo, speckleMat)
        mesh.name = `carSpeckle-${cell}`
        mesh.receiveShadow = true
        speckle.add(mesh)
      }
      root.add(speckle)
      levels.push({ object: speckle, range: Infinity })

      farField.register({ kind: 'carPark', name: `carPark-${cell}`, cell, levels })
      root.userData.cars = { planned: cars.length, drawn: drawn.length, quads: quads.length }
      return root
    })
  }
  return stats
}
