import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  BUILDINGS, GROUND_AREAS, INFIELD_FACILITIES, INFIELD_ISLAND_KERBS, INFIELD_LAMPS, INFIELD_PARKING, SOUTH_COURSE_KERBS, type InfieldFacility, type InfieldParkingRow,
} from '~/data/suzuka-facilities-spec'
import { osmFeature } from '~/data/suzuka-facilities'
import { Rng } from '~/sim/random'
import type { Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { GROUND_OBJECTS, LAYER, markDecal, markObject, type Ground } from './ground'
import type { DecalQuad, DecalStats } from './ground-mesh'
import { insideRing, registerPropSet, type PropSet } from './infield-lod'
import { bucketedInstancedMeshes } from './instancing'
import { sweepKerb } from './lanes'
import { latticeGeometry } from './lattice'
import { cutoutFromAssets, cutoutParams } from './materials'
import { bayLineQuads, carPropSets, inPoly, lampPoleProto, layoutBays, parkCar, quadHits, rollerShutterProto, type Bay, type BayReject } from './paddock'
import { addMerged, extrudeFootprint, frameAt, pitMaterials } from './pit-geometry'
import { glbOr, packProp, procProp, propMaterial, type PropProto } from './props-pack'
import { chainLinkTexture, kerbMaps } from './textures'
import { wayChainPath, type LanePoint } from './trackside'

const _p = new THREE.Vector3()

/** the ways of a chained-way footprint (GROUND_AREAS `ways`) */
export type WayChain = { id: number; verts?: [number, number]; reverse?: boolean }[]

/**
 * The infield ground and what stands on it (plan I5): the facilities, walls and fences, the
 * ponds' banks, the west and south course pits, the parked cars and the lamps, the infield
 * trees' keep-outs. The ground itself is never built here — the GROUND_AREAS rows draw it
 * (README 地面の契約) — this builder only paints on it and stands things on it.
 *
 * I5-a: the dashed centre lines of the service roads (`wayLineDecal` on every `{ way, width }`
 * asphaltArea row: the four service roads, the driving school's loops) and the driving school
 * block (BUILDINGS `builder: 'infield'`, extruded from its OSM footprint at `ground.standY`).
 * I5-b: `buildInfieldFacilities` — the INFIELD_FACILITIES table, the south course's kerbs, walls
 * and fences, the infield car parks, the service roads' lamps, the islands' kerbs (below).
 * The umbrella (infield.ts) calls it after the trackside and laps its wall-clock into 'infield'
 * together with the cuttings.
 */

/** the service roads' centre line: 0.15 m white, 3 m dashes on a 6 m cycle (ROADS.dash's look, on the ground faces) */
export const INFIELD_LINE = { width: 0.15, dash: [3, 3] as [number, number] }
/** a dash is cut into pieces no longer than this so every quad lies within one 2 m raster row of the face it is clipped to */
const DASH_PIECE = 2
/** a dash whose corners differ by more than this in height is over a step (a terrace under a stand) and is not painted */
const DASH_STEP = 0.08
/** the road-frame owners: a service road meeting the lap ends at the kerb, its paint never crosses the racing surface */
const ROAD_FRAME = new Set(['road', 'kerb', 'deckShoulder', 'pitLane', 'pitApron'])

export interface WayLineDecal {
  geo: THREE.BufferGeometry | null
  /** the decal's own stats (ground.decal) */
  stats: DecalStats
  /** metres of dash asked for, and the metres skipped because no drawn face (or only a road-frame one) lies there */
  metres: number
  skipped: number
}

/**
 * The dashed centre line of an OSM way as a ground decal: `width` m wide dashes of `dash[0]` m
 * every `dash[0] + dash[1]` m along the way's polyline (EN → world), each cut into ≤ 2 m quads
 * clipped to the drawn faces under them (`ground.decal`, the face's own triangles one rung up).
 * A quad over bare terrain or over a road-frame face (the lap, the pit lane) is skipped — the
 * former has nothing to lie on, the latter is not the service road's.
 */
export function wayLineDecal(ground: Ground, track: Track, way: number | WayChain, width = INFIELD_LINE.width, dash: [number, number] = INFIELD_LINE.dash): WayLineDecal {
  const empty: WayLineDecal = { geo: null, stats: { quads: 0, triangles: 0, area: 0, uncovered: 0, bareAt: [] }, metres: 0, skipped: 0 }
  const chain = wayChainPath(track, typeof way === 'number' ? [{ id: way }] : way)
  const pts = chain.closed ? [...chain.pts, chain.pts[0]!] : chain.pts
  if (pts.length < 2) return empty
  const quads: DecalQuad[] = []
  let metres = 0
  let skipped = 0
  const cycle = dash[0] + dash[1]
  // walk the polyline by arc length; `d` is the distance along it, a dash is on for the first
  // dash[0] m of every cycle
  const at = (d: number): { x: number; z: number; nx: number; nz: number } | null => {
    let acc = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (d <= acc + len || i === pts.length - 2) {
        const t = len > 1e-6 ? Math.max(0, Math.min(1, (d - acc) / len)) : 0
        const ex = (b.x - a.x) / (len || 1), ez = (b.z - a.z) / (len || 1)
        return { x: a.x + ex * len * t, z: a.z + ez * len * t, nx: -ez, nz: ex }
      }
      acc += len
    }
    return null
  }
  let total = 0
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z)
  for (let d0 = 0; d0 < total; d0 += cycle) {
    const d1 = Math.min(total, d0 + dash[0])
    for (let a = d0; a < d1 - 1e-6; a += DASH_PIECE) {
      const b = Math.min(d1, a + DASH_PIECE)
      const pa = at(a), pb = at(b)
      if (!pa || !pb) continue
      metres += b - a
      const w = width / 2
      const xz = [pa.x + pa.nx * w, pa.z + pa.nz * w, pb.x + pb.nx * w, pb.z + pb.nz * w, pb.x - pb.nx * w, pb.z - pb.nz * w, pa.x - pa.nx * w, pa.z - pa.nz * w]
      // the piece and its four corners must all lie on drawn, non-road faces within a step of
      // each other: a dash across a face's end, a junction's edge or a terrace step under a
      // stand would be part bare, part buried
      const mx = (pa.x + pb.x) / 2, mz = (pa.z + pb.z) / 2
      const face = ground.builtY(mx, mz)
      let ok = !!face && !ROAD_FRAME.has(face.kind)
      let lo = face?.y ?? 0, hi = face?.y ?? 0
      // sampled every 0.25 m along and across (a terrace riser under a stand is narrower than
      // a dash, and the four corners alone can all sit on the treads), and one face source too
      // (raster / world part / stitch): across their seam two triangulations of the same field
      // differ by a few mm, which buries a decal's rung
      for (let u = 0; ok && u <= 1; u += 0.125) for (const t of [-1, 0, 1]) {
        const x = pa.x + (pb.x - pa.x) * u + (pa.nx + (pb.nx - pa.nx) * u) * w * t
        const z = pa.z + (pb.z - pa.z) * u + (pa.nz + (pb.nz - pa.nz) * u) * w * t
        const c = ground.builtY(x, z)
        if (!c || ROAD_FRAME.has(c.kind) || c.src !== face!.src) { ok = false; break }
        lo = Math.min(lo, c.y); hi = Math.max(hi, c.y)
      }
      if (!ok || hi - lo > DASH_STEP) { skipped += b - a; continue }
      quads.push({ xz, yHint: face!.y, attrs: () => [] })
    }
  }
  if (!quads.length) return { ...empty, metres, skipped }
  const built = ground.decal(quads, LAYER.verge.line, [])
  return { geo: built.geo, stats: built.stats, metres, skipped }
}

export function buildInfieldGround(ctx: EnvBuildContext): void {
  const { track, ground, group } = ctx
  const stat = (key: string, n: number) => { ctx.infieldStats[key] = (ctx.infieldStats[key] ?? 0) + n }

  // --- the service roads' dashed centre lines: every `{ way, width }` asphaltArea row ----------------
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, metalness: 0 })
  let lineM = 0, lineSkipped = 0, lineUncovered = 0, lineQuads = 0
  for (const area of GROUND_AREAS) {
    const fp = area.footprint
    if (!('way' in fp || 'ways' in fp) || area.kind !== 'asphaltArea') continue
    const ways: WayChain = 'ways' in fp ? fp.ways : [{ id: fp.way }]
    // the secondary raceways (the south course, the kart tracks) are circuits, not service roads
    if (!ways.every((w) => osmFeature(w.id)?.role === 'road')) continue
    const line = wayLineDecal(ground, track, ways)
    lineM += line.metres
    lineSkipped += line.skipped
    lineUncovered += line.stats.uncovered
    lineQuads += line.stats.quads
    if (!line.geo) continue
    const mesh = new THREE.Mesh(line.geo, lineMat)
    mesh.name = `infield-wayLines-${ways.map((w) => w.id).join('+')}`
    mesh.receiveShadow = true
    mesh.renderOrder = 2
    markDecal(mesh, LAYER.verge.line, line.stats)
    group.add(mesh)
  }
  stat('infield-wayLineM', Math.round(lineM))
  stat('infield-wayLineSkippedM', Math.round(lineSkipped))
  stat('infield-wayLineUncoveredM2', Math.round(lineUncovered * 10) / 10)
  stat('infield-wayLineQuads', lineQuads)

  // --- the BUILDINGS rows this builder owns (the driving school): OSM footprint extrusions ---------------
  const pm = pitMaterials(ctx)
  const v = new THREE.Vector3()
  const capGeos: THREE.BufferGeometry[] = []
  const wallGeos: THREE.BufferGeometry[] = []
  let blocks = 0
  for (const b of BUILDINGS) {
    if (b.builder !== 'infield' || b.osmWay === null) continue
    const f = osmFeature(b.osmWay)
    if (!f) continue
    let base: number
    if (b.anchor === 'terrain') {
      const [ce, cn] = f.en.reduce(([ae, an], [e, n]) => [ae + e / f.en.length, an + n / f.en.length], [0, 0])
      track.enToWorld(ce, cn, v)
      base = ground.standY(v.x, v.z)
    } else {
      track.pointAt(b.anchor.s, b.anchor.lateral, v, ground.standAt(b.anchor.s, b.anchor.lateral))
      base = v.y
    }
    const ext = extrudeFootprint(track, f.en, base, b.height)
    capGeos.push(...ext.cap)
    wallGeos.push(...ext.walls)
    blocks++
  }
  addMerged(group, wallGeos, pm.whiteMat, 'infield-buildings', true)
  addMerged(group, capGeos, pm.buildingRoofMat, 'infield-buildingRoofs', true)
  stat('infield-buildings', blocks)

  // --- I5-b: the facilities, walls, fences, kerbs, cars and lamps -------------------------------------
  buildInfieldFacilities(ctx)
}

// =============================================================================================
// I5-b: the facilities, walls, fences and kerbs, the parked cars, the street lamps
// =============================================================================================

type P2 = { x: number; z: number }
const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const Q = Math.PI / 2
const m4 = () => new THREE.Matrix4()

/** Non-indexed triangle sink (position / normal / uv) for the hand-built cards: the fences, walls, flags, gables. */
class Cards {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  /** a quad a → b → c → d; the winding is fixed so the normal agrees with `out` when given */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvs: [number, number][], out?: THREE.Vector3) {
    const n = new THREE.Vector3().copy(b).sub(a).cross(new THREE.Vector3().copy(c).sub(a))
    if (n.lengthSq() < 1e-12) n.copy(new THREE.Vector3().copy(c).sub(a).cross(new THREE.Vector3().copy(d).sub(a)))
    n.normalize()
    let pts = [a, b, c, d], tc = uvs
    if (out && n.dot(out) < 0) {
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
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out?: THREE.Vector3) {
    const n = new THREE.Vector3().copy(b).sub(a).cross(new THREE.Vector3().copy(c).sub(a)).normalize()
    let pts = [a, b, c]
    if (out && n.dot(out) < 0) { n.negate(); pts = [a, c, b] }
    for (const p of pts) {
      this.pos.push(p.x, p.y, p.z)
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(p.x, p.z)
    }
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

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** a box (w × h × d, non-indexed) with its base centre at (x, y, z) */
function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  g.translate(x, y + h / 2, z)
  return g
}

/** the polygon's signed area (XZ, shoelace) */
const areaOf = (r: P2[]): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.z - q.x * p.z } return a / 2 }
/** the polygon scaled about its centroid by `k` (a balcony ring, a proud glass band) */
function scaledRing(r: P2[], k: number): P2[] {
  let cx = 0, cz = 0
  for (const p of r) { cx += p.x / r.length; cz += p.z / r.length }
  return r.map((p) => ({ x: cx + (p.x - cx) * k, z: cz + (p.z - cz) * k }))
}

/**
 * The facilities of the infield (plan I5-b, INFIELD_FACILITIES / INFIELD_PARKING / INFIELD_LAMPS /
 * INFIELD_ISLAND_KERBS / SOUTH_COURSE_KERBS in suzuka-facilities-spec.ts): the Spoon yard's sheds
 * and stores, the 200R officials' building, the L-yard tank compound, the west-course pits and
 * their control tower, the south course's garage, huts, walls, chain-link fences and red-white
 * kerbs, the Dunlop loop's sheds, marquee and compound, the hairpin's tyre island and floodlight
 * mast, the Degner-east marquee compound, the T1 infield's brown-roofed block and pump house, the
 * far OSM huts — then the parked cars of the infield lots, the street lamps of the service roads
 * and the traffic islands' kerbs.
 *
 * Everything stands on `ground.standY` (R3: no terrain reads) and is one of: a merged mesh per
 * material named `furniture-infield-<mat>` (the buildings' walls and roofs, the tank, the tower,
 * the flags, the walls `furniture-infield-walls`, the fence cards `furniture-infield-fence` —
 * the `furniture` prefix is surface-check G8's exemption, so nothing here may be a slab near the
 * ground: the extrusions are sunk 0.5 m with no up-facing floor); an InstancedMesh prop set on
 * the far-field registry (`registerPropSet`, kind 'infield': the blocks, tyre stacks (tagged
 * GROUND_OBJECTS.tyreStack), forklift, toilets, roller shutters, marquees, flood heads, cars,
 * lamps, fence posts); a ground OBJECT (the kerbs, GROUND_OBJECTS.laneKerb / islandKerb) or a
 * DECAL (the bay lines, LAYER.paddock.line). Buildings on sloping ground (the west garage's
 * footprint spans 3.5 m of DEM) take their floor at the lowest vertex and their eaves `height`
 * over the highest, so no corner floats. Materials: the pit complex's shared set
 * (whiteMat / concreteMat / buildingRoofMat / glassMat / railMat), plain colours through the
 * prop cache, the barriers' fence003 cutout — no new program (plan §横断 7).
 */
export function buildInfieldFacilities(ctx: EnvBuildContext): void {
  const { track, ground, group, quality } = ctx
  const pm = pitMaterials(ctx)
  const stat = (key: string, n: number) => { ctx.infieldStats[key] = (ctx.infieldStats[key] ?? 0) + n }
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const enScale = track.enScale
  const world = (s: number, lat: number): P2 => { track.pointAt(track.wrap(s), lat, _p, 0); return { x: _p.x, z: _p.z } }
  const enOf = (p: P2): [number, number] => [p.x / enScale, -p.z / enScale]
  const shadows = quality.farField.shadows
  const rng = new Rng(0x15b0f1e)

  // --- materials and the merged buckets ------------------------------------------------------------
  const M = {
    white: pm.whiteMat,
    grey: new THREE.MeshStandardMaterial({ color: 0x9ea2a5, roughness: 0.75 }),
    corrugated: new THREE.MeshStandardMaterial({ color: 0xd8dbd8, roughness: 0.55, metalness: 0.35 }),
    glass: pm.glassMat,
    concrete: pm.concreteMat,
    roof: pm.buildingRoofMat,
    roofBlue: new THREE.MeshStandardMaterial({ color: 0x5a7fa6, roughness: 0.5, metalness: 0.3 }),
    roofBrown: new THREE.MeshStandardMaterial({ color: 0x6b4a3a, roughness: 0.7 }),
    roofRed: new THREE.MeshStandardMaterial({ color: 0x9a3a32, roughness: 0.7 }),
    /** a light plaster / membrane roof (the sheds the aerial reads as white-roofed; the I5 review, V9) */
    roofWhite: new THREE.MeshStandardMaterial({ color: 0xdcdcd8, roughness: 0.8 }),
    rail: pm.railMat,
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.6 }),
    pvc: new THREE.MeshStandardMaterial({ color: 0xf0f0ec, roughness: 0.7, side: THREE.DoubleSide }),
  }
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>()
  const put = (key: string, mat: THREE.Material, geo: THREE.BufferGeometry, cast = true) => {
    let b = buckets.get(key)
    if (!b) buckets.set(key, (b = { mat, geos: [], cast }))
    b.geos.push(geo)
  }
  const wallMatOf = (f: InfieldFacility): [string, THREE.Material] => (f.wall === 'grey' ? ['grey', M.grey] : f.wall === 'corrugated' ? ['corrugated', M.corrugated] : f.wall === 'glass' ? ['glass', M.glass] : ['white', M.white])
  const roofMatOf = (f: InfieldFacility): [string, THREE.Material] => (f.roof === 'blue' ? ['roofBlue', M.roofBlue] : f.roof === 'brown' ? ['roofBrown', M.roofBrown] : f.roof === 'red' ? ['roofRed', M.roofRed] : f.roof === 'white' ? ['roofWhite', M.roofWhite] : ['roof', M.roof])

  // --- footprints: the OSM ring or the sized box, in world XZ --------------------------------------
  const ringOf = (f: InfieldFacility): P2[] | null => {
    if (f.osmWay !== undefined) {
      const o = osmFeature(f.osmWay)
      if (!o) { console.warn(`[infield-ground] ${f.id}: OSM way ${f.osmWay} not in OSM_FEATURES`); return null }
      return o.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
    }
    if (f.s === undefined || f.lateral === undefined || !f.size) return null
    const c = world(f.s, f.lateral)
    const h = track.headingAt(track.wrap(f.s))
    const yaw = ((f.yaw ?? 0) * Math.PI) / 180
    // +s along the heading, +lateral its left normal (tz, −tx); the yaw turns both about +y
    const ax = h.tx * Math.cos(yaw) + h.tz * Math.sin(yaw), az = h.tz * Math.cos(yaw) - h.tx * Math.sin(yaw)
    const lx = az, lz = -ax
    const [a, b] = f.size
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ x: c.x + (ax * u! * a) / 2 + (lx * v! * b) / 2, z: c.z + (az * u! * a) / 2 + (lz * v! * b) / 2 }))
  }
  /** the ground under a footprint: the lowest and highest standY of its vertices and centroid */
  const groundOf = (ring: P2[]): { lo: number; hi: number; cx: number; cz: number } => {
    let cx = 0, cz = 0
    for (const p of ring) { cx += p.x / ring.length; cz += p.z / ring.length }
    let lo = ground.standY(cx, cz), hi = lo
    for (const p of ring) { const y = ground.standY(p.x, p.z); lo = Math.min(lo, y); hi = Math.max(hi, y) }
    return { lo, hi, cx, cz }
  }
  /** every facility's footprint (the lots' bays and the lamps keep off them) and the trees' keep-outs */
  const footprints: P2[][] = []
  /** per facility: its world XZ box and its lap window (the smoke reads `group.userData.infieldFacilities`) */
  const report: { id: string; kind: string; box: [number, number, number, number]; sRange: [number, number] | null }[] = []
  const boxOf = (pts: P2[]): [number, number, number, number] => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z) }
    return [x0, z0, x1, z1]
  }
  const claim = (ring: P2[]) => {
    footprints.push(ring)
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (const p of ring) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z) }
    const poly = { ring: ring.map((p): [number, number] => [p.x, p.z]), box: [x0, z0, x1, z1] as [number, number, number, number] }
    ctx.keepOutPolys.push(poly)
    ctx.infieldFootprints.push(poly)
  }

  // --- the prop sets ------------------------------------------------------------------------------
  const nearM = quality.infield.propsNearM, farM = quality.infield.propsFarM
  const blockProto = procProp('concrete-block', [{ geometry: box(1, 0.5, 1), material: plain(0xb9b8b2, 0.9, 0.05) }])
  const blocks: PropSet = { proto: blockProto, placements: [] }
  const tyreRule = GROUND_OBJECTS.tyreStack
  const tyreProc = (() => {
    const r = tyreRule.maxWidth / 2, h = 0.93
    const side = new THREE.CylinderGeometry(r, r, h, 16, 1, true)
    side.translate(0, h / 2, 0)
    const top = new THREE.RingGeometry(0.2, r, 16)
    top.rotateX(-Q)
    top.translate(0, h, 0)
    const rubber = plain(0x1d1d1f, 0.95, 0.05)
    return procProp('tyre-stack', [{ geometry: side.toNonIndexed(), material: rubber }, { geometry: top.toNonIndexed(), material: rubber }])
  })()
  const tyreProto = glbOr(ctx, 'model/trackside/tire_stack', { id: 'tyre-stack-glb', origin: 'base', front: 'none', scaleTo: { height: 0.93 } }, tyreProc)
  const tyres: PropSet = { proto: tyreProto, far: tyreProc, placements: [] }
  const forkProc = procProp('forklift', [
    { geometry: box(1.2, 1.1, 2.2, 0, 0.3, 0), material: plain(0xd9a400, 0.5, 0.3) },
    { geometry: box(1.1, 0.9, 1.0, 0, 1.4, -0.3), material: plain(0x2a2d31, 0.6, 0.3) },
    { geometry: box(0.9, 2.0, 0.12, 0, 0.1, 1.15), material: plain(0x2a2d31, 0.6, 0.3) },
    { geometry: box(0.1, 0.05, 1.1, -0.3, 0.05, 1.7), material: plain(0x55585c, 0.5, 0.6) },
    { geometry: box(0.1, 0.05, 1.1, 0.3, 0.05, 1.7), material: plain(0x55585c, 0.5, 0.6) },
  ])
  const forkProto = glbOr(ctx, 'model/ops/forklift', { id: 'forklift-glb', origin: 'base', front: 'moreArea', scaleTo: { long: 3.7 } }, forkProc)
  const forklifts: PropSet = { proto: forkProto, far: forkProc, placements: [], casts: true }
  const toiletProc = procProp('porta-potty', [{ geometry: box(1.1, 2.2, 1.1), material: plain(0x2e6f9e, 0.6, 0.1) }, { geometry: box(1.16, 0.1, 1.16, 0, 2.2, 0), material: plain(0xe8ecef, 0.5, 0.1) }])
  const toiletProto = glbOr(ctx, 'model/ops/porta_potty', { id: 'porta-potty-glb', origin: 'base', front: 'moreArea', scaleTo: { height: 2.2 } }, toiletProc)
  const toilets: PropSet = { proto: toiletProto, far: toiletProc, placements: [] }
  const shutterPair = rollerShutterProto(ctx, 'infield-shutter', 3.0, 3.2)
  const shutters: PropSet = { proto: shutterPair.near, far: shutterPair.far, placements: [] }
  const headProc = procProp('flood-head', [{ geometry: box(0.6, 0.5, 0.45), material: plain(0x2a2d31, 0.5, 0.5) }, { geometry: box(0.5, 0.4, 0.03, 0, 0.05, 0.24), material: plain(0xe8ecef, 0.3, 0.2) }])
  const headProto = glbOr(ctx, 'model/trackside/flood_light', { id: 'flood-head-glb', front: 'moreArea', scaleTo: { height: 1.2 } }, headProc)
  const heads: PropSet = { proto: headProto, far: headProc, placements: [] }
  /** the marquees: a white PVC gable tent per size — the tent_canopy drop fitted to the box as the near roof */
  const marqueeProtos = new Map<string, { walls: PropProto; roof: PropProto; roofFar: PropProto }>()
  const marqueeProto = (along: number, across: number, h: number) => {
    const key = `${along}x${across}x${h}`
    const hit = marqueeProtos.get(key)
    if (hit) return hit
    const wallH = h * 0.6
    const parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[] = []
    // local: long side along z (the placement turns +z onto +s), x across
    for (const [x0, x1, z0, z1] of [[-across / 2, across / 2, -along / 2, -along / 2 + 0.03], [-across / 2, across / 2, along / 2 - 0.03, along / 2], [-across / 2, -across / 2 + 0.03, -along / 2, along / 2], [across / 2 - 0.03, across / 2, -along / 2, along / 2]] as const) {
      parts.push({ geometry: box(x1 - x0, wallH, z1 - z0, (x0 + x1) / 2, 0, (z0 + z1) / 2), material: M.pvc })
    }
    const gable = new Cards()
    for (const [z, sgn] of [[-along / 2, -1], [along / 2, 1]] as const) gable.tri(V(-across / 2, wallH, z), V(across / 2, wallH, z), V(0, h, z), V(0, 0, sgn))
    parts.push({ geometry: gable.build(), material: M.pvc })
    const walls = procProp(`marquee-walls-${key}`, parts)
    const roofCards = new Cards()
    const e = across / 2 + 0.25, ez = along / 2 + 0.25
    roofCards.quad(V(-e, wallH - 0.1, -ez), V(0, h, -ez), V(0, h, ez), V(-e, wallH - 0.1, ez), [[0, 0], [1, 0], [1, 1], [0, 1]], V(-1, 1, 0))
    roofCards.quad(V(0, h, -ez), V(e, wallH - 0.1, -ez), V(e, wallH - 0.1, ez), V(0, h, ez), [[0, 0], [1, 0], [1, 1], [0, 1]], V(1, 1, 0))
    const roofFar = procProp(`marquee-roof-${key}`, [{ geometry: roofCards.build(), material: M.pvc }])
    let roof: PropProto = roofFar
    if (quality.infield.glb && ctx.assets) {
      const canopy = packProp(ctx.assets, ctx.props, 'model/ops/tent_canopy', { id: `infield-marquee-canopy-${key}-glb`, nodes: /TentCanopy_0/, front: 'none', origin: 'base' })
      if (canopy) {
        const g = canopy.geometry
        const alongX = g.boundingBox!.max.x - g.boundingBox!.min.x >= g.boundingBox!.max.z - g.boundingBox!.min.z
        if (alongX) g.rotateY(Q)
        g.computeBoundingBox()
        const b = g.boundingBox!
        g.scale(across / (b.max.x - b.min.x), h / canopy.footprint.height, along / (b.max.z - b.min.z))
        g.computeBoundingBox()
        g.computeBoundingSphere()
        canopy.footprint = { long: along, short: across, height: h }
        roof = canopy
      }
    }
    const out = { walls, roof, roofFar }
    marqueeProtos.set(key, out)
    return out
  }
  const marqueeSets = new Map<PropProto, PropSet>()

  // --- the fence material (the barriers' fence003 cutout / chainLinkTexture) ----------------------
  const reg = ctx.assets
  const fenceTile = 2.0
  const fenceMat = cutoutFromAssets(reg, 'fence003', {
    quality, tile: fenceTile, handBuiltUv: true, normalScale: 0.5, extra: { color: 0xb8bcbf, metalness: 0.3 },
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(1 / 0.2, 1 / 0.2)
      return new THREE.MeshStandardMaterial({ map, color: 0xb8bcbf, ...cutoutParams(quality), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 })
    },
  })
  const fenceCards = new Cards()
  const postMatrices: THREE.Matrix4[] = []
  let fenceM = 0
  /**
   * A chain-link fence along a world polyline: every segment split at half the 3 m post pitch,
   * one vertical card per sub-span standing on the drawn ground at both of its ends (a card
   * across a fold in the terrain would hang or bury), posts on every second sub-span end. The
   * cards are drawn when the tier draws fences (`Quality.infield.fences`); the posts always.
   */
  const fence = (pts: P2[], closed: boolean, H: number) => {
    const run = closed ? [...pts, pts[0]!] : pts
    let u = 0
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1]!, b = run[i]!
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (len < 0.05) continue
      const nPost = Math.max(1, Math.round(len / 3))
      const nSub = 2 * nPost
      let px = a.x, pz = a.z, py = ground.standY(a.x, a.z)
      if (i === 1) postMatrices.push(m4().makeTranslation(px, py - 0.05, pz))
      for (let p = 1; p <= nSub; p++) {
        const t = p / nSub
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = ground.standY(x, z)
        const l = len / nSub
        if (quality.infield.fences) fenceCards.quad(V(px, py - 0.05, pz), V(x, y - 0.05, z), V(x, y + H, z), V(px, py + H, pz), [[u / fenceTile, 0], [(u + l) / fenceTile, 0], [(u + l) / fenceTile, H / fenceTile], [u / fenceTile, H / fenceTile]])
        if (p % 2 === 0 && !(closed && i === run.length - 1 && p === nSub)) postMatrices.push(m4().makeTranslation(x, y - 0.05, z))
        u += l
        px = x; pz = z; py = y
      }
      fenceM += len
    }
  }
  const wallCards = new Cards()
  let wallM = 0
  /**
   * A concrete wall along a world polyline: two faces 0.2 m apart and a top strip, every vertex
   * on the drawn ground at its own XZ (sunk 0.1 m). An OSM `area=yes` wall polygon thinner than
   * 2 m is collapsed to the centreline of its two long edges first.
   */
  const wall = (pts: P2[], closed: boolean, H: number) => {
    const run = closed ? [...pts, pts[0]!] : pts
    const T = 0.2, tile = pm.concreteTile
    let u = 0
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1]!, b = run[i]!
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (len < 0.05) continue
      const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len
      const n = Math.max(1, Math.ceil(len / 4))
      let prev = { x: a.x, z: a.z, y: ground.standY(a.x, a.z) }
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const cur = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: 0 }
        cur.y = ground.standY(cur.x, cur.z)
        const l = len / n
        for (const side of [1, -1]) {
          const ox = nx * side * (T / 2), oz = nz * side * (T / 2)
          wallCards.quad(V(prev.x + ox, prev.y - 0.1, prev.z + oz), V(cur.x + ox, cur.y - 0.1, cur.z + oz), V(cur.x + ox, cur.y + H, cur.z + oz), V(prev.x + ox, prev.y + H, prev.z + oz), [[u / tile, 0], [(u + l) / tile, 0], [(u + l) / tile, (H + 0.1) / tile], [u / tile, (H + 0.1) / tile]], V(nx * side, 0, nz * side))
        }
        wallCards.quad(V(prev.x + nx * T / 2, prev.y + H, prev.z + nz * T / 2), V(cur.x + nx * T / 2, cur.y + H, cur.z + nz * T / 2), V(cur.x - nx * T / 2, cur.y + H, cur.z - nz * T / 2), V(prev.x - nx * T / 2, prev.y + H, prev.z - nz * T / 2), [[u / tile, 0], [(u + l) / tile, 0], [(u + l) / tile, T / tile], [u / tile, T / tile]], V(0, 1, 0))
        u += l
        prev = cur
      }
      wallM += len
    }
  }
  /** a thin OSM wall polygon (4 vertices, < 2 m across) → its centreline; anything else is returned as is */
  const wallPath = (ring: P2[], closed: boolean): { pts: P2[]; closed: boolean } => {
    if (!closed || ring.length !== 4) return { pts: ring, closed }
    const d = (i: number, j: number) => Math.hypot(ring[i]!.x - ring[j]!.x, ring[i]!.z - ring[j]!.z)
    const d01 = d(0, 1), d12 = d(1, 2)
    const short = Math.min(d01, d12)
    if (short > 2) return { pts: ring, closed }
    const mid = (i: number, j: number): P2 => ({ x: (ring[i]!.x + ring[j]!.x) / 2, z: (ring[i]!.z + ring[j]!.z) / 2 })
    return d01 < d12 ? { pts: [mid(0, 1), mid(2, 3)], closed: false } : { pts: [mid(1, 2), mid(3, 0)], closed: false }
  }

  // --- the facilities ------------------------------------------------------------------------------
  let facilities = 0, buildings = 0, marquees = 0, tanks = 0
  const shutterH = 3.2
  for (const f of INFIELD_FACILITIES) {
    const ring = f.kind === 'fence' || f.kind === 'wall' ? null : ringOf(f)
    const window: [number, number] | null = f.sRange ?? (f.s !== undefined ? [f.s - 60, f.s + 60] : null)
    if (ring) report.push({ id: f.id, kind: f.kind, box: boxOf(ring), sRange: window })
    switch (f.kind) {
      case 'shed': case 'hut': case 'office': case 'garage': case 'pumphouse': {
        if (!ring) continue
        const g = groundOf(ring)
        const [wk, wm] = wallMatOf(f)
        const [rk, rm] = roofMatOf(f)
        // the floor at the lowest vertex, the eaves `height` over the highest (a sloping footprint never floats)
        const ext = extrudeFootprint(track, ring.map(enOf), g.lo, f.height + (g.hi - g.lo))
        for (const w of ext.walls) put(wk, wm, w)
        if (f.roof === 'gable' && ring.length === 4) {
          for (const c of ext.cap) c.dispose()
          const top = g.lo + f.height + (g.hi - g.lo)
          const gable = new Cards()
          // the ridge along the longer pair of edges, 1.2 m over the eaves
          const e01 = Math.hypot(ring[1]!.x - ring[0]!.x, ring[1]!.z - ring[0]!.z), e12 = Math.hypot(ring[2]!.x - ring[1]!.x, ring[2]!.z - ring[1]!.z)
          const [a, b, c, d] = e01 >= e12 ? [ring[0]!, ring[1]!, ring[2]!, ring[3]!] : [ring[1]!, ring[2]!, ring[3]!, ring[0]!]
          const r0 = { x: (a.x + d.x) / 2, z: (a.z + d.z) / 2 }, r1 = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 }
          const rh = top + 1.2
          gable.quad(V(a.x, top, a.z), V(b.x, top, b.z), V(r1.x, rh, r1.z), V(r0.x, rh, r0.z), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 1, 0))
          gable.quad(V(r0.x, rh, r0.z), V(r1.x, rh, r1.z), V(c.x, top, c.z), V(d.x, top, d.z), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 1, 0))
          gable.tri(V(a.x, top, a.z), V(r0.x, rh, r0.z), V(d.x, top, d.z), V(a.x - b.x, 0, a.z - b.z))
          gable.tri(V(b.x, top, b.z), V(c.x, top, c.z), V(r1.x, rh, r1.z), V(b.x - a.x, 0, b.z - a.z))
          put(rk, rm, gable.build())
        } else for (const c of ext.cap) put(rk, rm, c)
        // a garage's roller shutters: along its longest edge nearer the lap, evenly, 0.05 m proud
        if (f.doors) {
          const edges = ring.map((p, i) => ({ a: p, b: ring[(i + 1) % ring.length]!, len: Math.hypot(ring[(i + 1) % ring.length]!.x - p.x, ring[(i + 1) % ring.length]!.z - p.z) })).sort((p, q) => q.len - p.len)
          const cands = edges.slice(0, 2).map((e) => ({ e, d: ground.plan.project((e.a.x + e.b.x) / 2, (e.a.z + e.b.z) / 2, f.sRange ? [f.sRange[0] - 100, f.sRange[1] + 100] : undefined).d }))
          const edge = (cands.sort((p, q) => p.d - q.d)[0] ?? cands[0])!.e
          // outward = away from the ring's centroid
          const mx = (edge.a.x + edge.b.x) / 2, mz = (edge.a.z + edge.b.z) / 2
          let nx = -(edge.b.z - edge.a.z) / edge.len, nz = (edge.b.x - edge.a.x) / edge.len
          if ((mx - g.cx) * nx + (mz - g.cz) * nz < 0) { nx = -nx; nz = -nz }
          const n = Math.max(1, Math.min(f.doors, Math.floor(edge.len / 3.6)))
          const pitch = edge.len / n
          const h = Math.min(shutterH, f.height - 0.4)
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) * pitch / edge.len
            const x = edge.a.x + (edge.b.x - edge.a.x) * t + nx * 0.05, z = edge.a.z + (edge.b.z - edge.a.z) * t + nz * 0.05
            const m = m4().makeRotationY(Math.atan2(nx, nz))
            m.scale(V(1, h / shutterH, 1))
            m.setPosition(x, ground.standY(x, z) + 0.02, z)
            shutters.placements.push({ m })
          }
        }
        claim(ring)
        buildings++
        break
      }
      case 'tower': {
        if (!ring) continue
        const g = groundOf(ring)
        const en = ring.map(enOf)
        const levels = Math.max(1, f.levels ?? 2)
        const floorH = f.height / levels
        const base = g.lo
        // the shell: the lower level(s) white, a proud glass band round the top level, the parapet white
        const bandLo = base + floorH * (levels - 1) + 0.6 + (g.hi - g.lo), bandHi = base + f.height + (g.hi - g.lo) - 0.5
        const lower = extrudeFootprint(track, en, base, bandLo - base)
        for (const w of lower.walls) put('white', M.white, w)
        for (const c of lower.cap) c.dispose()
        const band = extrudeFootprint(track, scaledRing(ring, 1.012).map(enOf), bandLo, bandHi - bandLo, 0)
        for (const w of band.walls) put('glass', M.glass, w, false)
        for (const c of band.cap) c.dispose()
        const upper = extrudeFootprint(track, en, bandHi, base + f.height + (g.hi - g.lo) - bandHi, 0)
        for (const w of upper.walls) put('white', M.white, w)
        for (const c of upper.cap) put('roof', M.roof, c)
        // the balcony: a 1.2 m slab round the band's foot, a rail of φ0.05 posts every 1.5 m and a top tube
        const balcony = scaledRing(ring, 1 + 1.2 / Math.sqrt(Math.abs(areaOf(ring)) / Math.PI))
        const slab = extrudeFootprint(track, balcony.map(enOf), bandLo - 0.6, 0.15, 0)
        for (const w of slab.walls) put('grey', M.grey, w, false)
        for (const c of slab.cap) put('grey', M.grey, c, false)
        const railY = bandLo - 0.45
        for (let i = 0; i < balcony.length; i++) {
          const a = balcony[i]!, b = balcony[(i + 1) % balcony.length]!
          const len = Math.hypot(b.x - a.x, b.z - a.z)
          const tube = new THREE.BoxGeometry(0.05, 0.05, len)
          tube.rotateY(Math.atan2(b.x - a.x, b.z - a.z))
          tube.translate((a.x + b.x) / 2, railY + 1.05, (a.z + b.z) / 2)
          put('rail', M.rail, tube, false)
          const n = Math.max(1, Math.round(len / 1.5))
          for (let k = 0; k < n; k++) {
            const t = k / n
            const post = new THREE.BoxGeometry(0.05, 1.05, 0.05)
            post.translate(a.x + (b.x - a.x) * t, railY + 0.525, a.z + (b.z - a.z) * t)
            put('rail', M.rail, post, false)
          }
        }
        // the roof: an antenna mast with three crossbars and a plant box
        const roofY = base + f.height + (g.hi - g.lo)
        const mast = new THREE.CylinderGeometry(0.04, 0.06, 6, 6)
        mast.translate(g.cx, roofY + 3 - 0.05, g.cz)
        put('steel', M.steel, mast, false)
        for (const [dy, w] of [[5.6, 1.2], [4.8, 0.9], [4.0, 0.6]] as const) {
          const bar = new THREE.BoxGeometry(w, 0.04, 0.04)
          bar.translate(g.cx, roofY + dy, g.cz)
          put('steel', M.steel, bar, false)
        }
        const plant = box(2.0, 1.0, 1.5, g.cx + 3, roofY - 0.02, g.cz)
        put('grey', M.grey, plant, false)
        claim(ring)
        buildings++
        break
      }
      case 'marquee': {
        if (!ring || !f.size) continue
        const [along, across] = f.size
        const mp = marqueeProto(along, across, f.height)
        const c = world(f.s!, f.lateral!)
        const m = frameAt(track, track.wrap(f.s!), f.lateral!, ground.standAt(track.wrap(f.s!), f.lateral!) - 0.02, m4())
        if (f.yaw) m.multiply(_r.makeRotationY((f.yaw * Math.PI) / 180))
        void c
        let ws = marqueeSets.get(mp.walls)
        if (!ws) marqueeSets.set(mp.walls, (ws = { proto: mp.walls, placements: [], casts: true }))
        ws.placements.push({ m })
        let rs = marqueeSets.get(mp.roof)
        if (!rs) marqueeSets.set(mp.roof, (rs = { proto: mp.roof, far: mp.roofFar, placements: [], casts: true }))
        rs.placements.push({ m })
        claim(ring)
        marquees++
        break
      }
      case 'tank': {
        if (!ring || !f.size) continue
        const g = groundOf(ring)
        const r = f.size[0] / 2
        const body = new THREE.CylinderGeometry(r, r, f.height + 0.2, 24, 1, false)
        body.translate(g.cx, g.lo - 0.2 + (f.height + 0.2) / 2, g.cz)
        put('white', M.white, body)
        const cone = new THREE.ConeGeometry(r + 0.05, Math.min(0.8, r * 0.2), 24)
        cone.translate(g.cx, g.lo + f.height + Math.min(0.8, r * 0.2) / 2, g.cz)
        put('grey', M.grey, cone)
        claim(ring)
        tanks++
        break
      }
      case 'stack': case 'tyres': case 'toilet': {
        if (!ring || !f.size || f.s === undefined || f.lateral === undefined) continue
        const count = f.count ?? 1, cols = Math.max(1, f.cols ?? count)
        const rows = Math.ceil(count / cols)
        const h = track.headingAt(track.wrap(f.s))
        const yaw = ((f.yaw ?? 0) * Math.PI) / 180
        const ax = h.tx * Math.cos(yaw) + h.tz * Math.sin(yaw), az = h.tz * Math.cos(yaw) - h.tx * Math.sin(yaw)
        const lx = az, lz = -ax
        const c = world(f.s, f.lateral)
        const pitchA = f.size[0] / cols, pitchL = f.size[1] / rows
        const set = f.kind === 'stack' ? blocks : f.kind === 'tyres' ? tyres : toilets
        // a block stack is two layers deep: the count halves per layer
        const layers = f.kind === 'stack' ? 2 : 1
        const perLayer = Math.ceil(count / layers)
        let placed = 0
        for (let layer = 0; layer < layers && placed < count; layer++) {
          for (let i = 0; i < perLayer && placed < count; i++) {
            const col = i % cols, row = Math.floor(i / cols)
            const u = (col + 0.5) * pitchA - f.size[0] / 2, v = (row + 0.5) * pitchL - f.size[1] / 2
            const x = c.x + ax * u + lx * v, z = c.z + az * u + lz * v
            const yaw2 = Math.atan2(ax, az) + (f.kind === 'tyres' ? (rng.next() - 0.5) * 0.6 : 0)
            const m = m4().makeRotationY(yaw2)
            const sink = f.kind === 'tyres' ? tyreRule.sink : 0.02
            m.setPosition(x, ground.standY(x, z) - sink + layer * 0.5, z)
            set.placements.push({ m })
            placed++
          }
        }
        claim(ring)
        break
      }
      case 'forklift': {
        if (!ring || f.s === undefined || f.lateral === undefined) continue
        const m = frameAt(track, track.wrap(f.s), f.lateral, ground.standAt(track.wrap(f.s), f.lateral) + 0.02, m4())
        m.multiply(_r.makeRotationY(((f.yaw ?? 0) * Math.PI) / 180))
        forklifts.placements.push({ m })
        claim(ring)
        break
      }
      case 'flagpole': {
        if (f.s === undefined || f.lateral === undefined) continue
        const n = f.count ?? 1
        const colours = [0xffffff, 0xc8102e, 0x1d5bb5]
        for (let i = 0; i < n; i++) {
          const s = track.wrap(f.s + (i - (n - 1) / 2) * 4)
          const base = ground.standAt(s, f.lateral)
          const pole = new THREE.CylinderGeometry(0.04, 0.06, f.height, 6)
          pole.applyMatrix4(frameAt(track, s, f.lateral, base + f.height / 2 - 0.05, _m))
          put('rail', M.rail, pole, false)
          const flag = new THREE.PlaneGeometry(1.6, 1.0)
          flag.translate(0, 0, -0.8)
          flag.applyMatrix4(frameAt(track, s, f.lateral + 0.02, base + f.height - 0.7, _m))
          put(`flag${i % colours.length}`, new THREE.MeshStandardMaterial({ color: colours[i % colours.length]!, roughness: 0.9, side: THREE.DoubleSide }), flag, false)
        }
        if (ring) claim(ring)
        break
      }
      case 'mast': {
        if (f.s === undefined || f.lateral === undefined) continue
        const lattice = latticeGeometry({ height: f.height, baseHalf: 0.3, topHalf: 0.25, panel: 1.5, leg: 0.06, ring: 0.04, brace: 0.035, braces: quality.infield.detail })
        const s = track.wrap(f.s)
        const frame = frameAt(track, s, f.lateral, ground.standAt(s, f.lateral) - 0.05, m4())
        ctx.keepOut.push({ x: frame.elements[12]!, z: frame.elements[14]!, r: 2.2 })
        lattice.applyMatrix4(frame)
        put('steel', M.steel, lattice)
        const bar = new THREE.BoxGeometry(0.15, 0.15, 3.2)
        bar.translate(0, f.height - 1.0, 0)
        bar.applyMatrix4(frame)
        put('steel', M.steel, bar)
        // three heads facing the track (−x of the frame = −lateral on the left, so turn them to face the road)
        const toRoad = f.lateral > 0 ? -Q : Q
        for (let i = 0; i < 3; i++) {
          const m = frame.clone().multiply(_m.makeTranslation(-0.3 * Math.sign(f.lateral), f.height - 0.92, -1.2 + 1.2 * i))
          m.multiply(_r.makeRotationY(toRoad))
          heads.placements.push({ m })
        }
        break
      }
      case 'wall': case 'fence': {
        if (f.osmWay === undefined) continue
        const o = osmFeature(f.osmWay)
        if (!o) { console.warn(`[infield-ground] ${f.id}: OSM way ${f.osmWay} not in OSM_FEATURES`); continue }
        const pts = o.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
        const closed = !!o.closed || (pts.length > 3 && Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.z - pts[pts.length - 1]!.z) < 1e-3)
        if (closed && Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.z - pts[pts.length - 1]!.z) < 1e-3) pts.pop()
        if (f.kind === 'wall') { const w = wallPath(pts, closed); wall(w.pts, w.closed, f.height) }
        else fence(pts, closed, f.height)
        report.push({ id: f.id, kind: f.kind, box: boxOf(pts), sRange: window })
        break
      }
      case 'compound': {
        if (!ring) continue
        fence(ring, true, f.height)
        break
      }
    }
    facilities++
  }
  // the compound huts and tanks were claimed with their rings; the marquee sets, shutters and the rest register now
  const propSets: [string, PropSet[], number, number, boolean][] = [
    ['infield-blocks', [blocks], nearM, farM, false],
    ['infield-tyres', [tyres], nearM, farM, false],
    ['infield-forklift', [forklifts], quality.infield.vehiclesNearM, farM, true],
    ['infield-toilets', [toilets], nearM, farM, false],
    ['infield-shutters', [shutters], nearM, farM, false],
    ['infield-marquees', [...marqueeSets.values()], nearM, quality.farField.rangeFar, true],
    ['infield-mast-heads', [heads], nearM, Infinity, false],
  ]
  for (const [name, sets, near, far] of propSets) {
    const { entries } = registerPropSet(ctx, 'infield', name, sets, { nearM: near, farM: far }, { receiveShadow: true })
    // the tyre stacks are ground OBJECTS (GROUND_OBJECTS.tyreStack): every level's InstancedMesh is tagged
    if (name === 'infield-tyres') for (const e of entries) for (const level of e.levels) level.object.traverse((o) => { const im = o as THREE.InstancedMesh; if (im.isInstancedMesh) markObject(im, 'tyreStack', im.count * tyreRule.maxWidth) })
  }
  group.userData.infieldFacilities = report
  stat('infield-facilities', facilities)
  stat('infield-facilityBuildings', buildings)
  stat('infield-marqueeCount', marquees)
  stat('infield-tanks', tanks)

  // --- the fence cards and posts, the walls ---------------------------------------------------------
  if (!fenceCards.empty) {
    const mesh = new THREE.Mesh(fenceCards.build(), fenceMat)
    mesh.name = 'furniture-infield-fence'
    mesh.receiveShadow = true
    group.add(mesh)
  }
  if (postMatrices.length) {
    const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6)
    postGeo.translate(0, 1.25, 0)
    for (const inst of bucketedInstancedMeshes(postGeo, M.steel, postMatrices, null, (_i, m) => ctx.farField.cellOf(m.elements[12]!, m.elements[14]!), { name: 'furniture-infield-fencePosts', receiveShadow: true })) group.add(inst)
  }
  stat('infield-fenceM', Math.round(fenceM))
  stat('infield-fencePosts', postMatrices.length)
  if (!wallCards.empty) {
    const mesh = new THREE.Mesh(wallCards.build(), M.concrete)
    mesh.name = 'furniture-infield-walls'
    mesh.castShadow = shadows
    mesh.receiveShadow = true
    group.add(mesh)
  }
  stat('infield-wallM', Math.round(wallM))

  // --- the south course's kerbs: both edges of the raceway at its apex sections --------------------
  {
    const K = SOUTH_COURSE_KERBS
    const o = osmFeature(K.way)
    const kerbTex = kerbMaps()
    const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex.map, normalMap: kerbTex.normalMap, roughness: 0.75 })
    const rule = GROUND_OBJECTS.laneKerb
    const geos: THREE.BufferGeometry[] = []
    let kerbM = 0, sections = 0
    if (o) {
      const raw = o.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
      if (raw.length > 3 && Math.hypot(raw[0]!.x - raw[raw.length - 1]!.x, raw[0]!.z - raw[raw.length - 1]!.z) < 1e-3) raw.pop()
      // resample the loop every metre (the OSM vertices are 1 m DP'd, 0.5–40 m apart)
      const loop: LanePoint[] = []
      let d = 0
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i]!, b = raw[(i + 1) % raw.length]!
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        const n = Math.max(1, Math.ceil(len))
        for (let k = 0; k < n; k++) {
          const t = k / n
          loop.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s: 0, lat: 0, d })
          d += len / n
        }
      }
      const N = loop.length
      // curvature per sample: the turning angle over ±4 m; a section is a run of |curvature| ≥ minCurvature at least minRun long
      const curv = new Float32Array(N)
      const W = 4
      for (let i = 0; i < N; i++) {
        const a = loop[(i - W + N) % N]!, b = loop[i]!, c = loop[(i + W) % N]!
        const ang = Math.atan2((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z))
        curv[i] = ang / W
      }
      // find the runs (starting the scan at a straight sample so a run across the seam is not split)
      let start = 0
      while (start < N && Math.abs(curv[start]!) >= K.minCurvature) start++
      const runs: [number, number][] = []
      let runFrom: number | null = null
      for (let k = 0; k <= N; k++) {
        const i = (start + k) % N
        const on = k < N && Math.abs(curv[i]!) >= K.minCurvature
        if (on && runFrom === null) runFrom = k
        if (!on && runFrom !== null) {
          if (k - runFrom >= K.minRun) runs.push([runFrom, k])
          runFrom = null
        }
      }
      const offset = K.width / 2 - K.inset
      for (const [from, to] of runs) {
        const pts: LanePoint[] = []
        for (let k = from; k < to; k++) pts.push(loop[(start + k) % N]!)
        if (pts.length < 2) continue
        for (const side of [1, -1]) {
          geos.push(sweepKerb(ground, pts, rule.maxWidth, side * offset, rule))
          kerbM += pts.length - 1
        }
        sections++
      }
    }
    if (geos.length) {
      const merged = mergeGeometries(geos, false)
      for (const g of geos) g.dispose()
      if (merged) {
        const mesh = new THREE.Mesh(merged, kerbMat)
        mesh.name = 'infield-southKerbs'
        mesh.receiveShadow = true
        mesh.renderOrder = 1
        markObject(mesh, 'laneKerb', kerbM)
        group.add(mesh)
      }
    }
    stat('infield-southKerbM', Math.round(kerbM))
    stat('infield-southKerbSections', sections)
  }

  // --- the traffic islands' kerbs ------------------------------------------------------------------
  {
    const rule = GROUND_OBJECTS.islandKerb
    const geos: THREE.BufferGeometry[] = []
    let len = 0
    for (const isl of INFIELD_ISLAND_KERBS) {
      const segs = Math.max(24, Math.ceil((2 * Math.PI * isl.radius) / 0.8))
      const pts: LanePoint[] = []
      for (let i = 0; i < segs; i++) {
        const t = (i / segs) * Math.PI * 2
        const si = track.wrap(isl.s + isl.radius * Math.cos(t)), li = isl.lateral + isl.radius * Math.sin(t)
        track.pointAt(si, li, _p, 0)
        pts.push({ x: _p.x, z: _p.z, s: si, lat: li, d: (i / segs) * 2 * Math.PI * isl.radius })
      }
      geos.push(sweepKerb(ground, pts, rule.maxWidth, 0, rule, true))
      // the object's length is the ring's WORLD perimeter (G2 divides the top-view area by it):
      // the (s, lateral) circle is an ellipse in the world wherever the road bends
      for (let i = 0; i < segs; i++) { const a = pts[i]!, b = pts[(i + 1) % segs]!; len += Math.hypot(b.x - a.x, b.z - a.z) }
      const c = world(isl.s, isl.lateral)
      footprints.push(Array.from({ length: 8 }, (_, i) => ({ x: c.x + (isl.radius + 0.5) * Math.cos((i / 8) * 2 * Math.PI), z: c.z + (isl.radius + 0.5) * Math.sin((i / 8) * 2 * Math.PI) })))
    }
    const merged = geos.length ? mergeGeometries(geos, false) : null
    for (const g of geos) g.dispose()
    if (merged) {
      const mesh = new THREE.Mesh(merged, M.concrete)
      mesh.name = 'infield-islandKerbs'
      mesh.receiveShadow = true
      markObject(mesh, 'islandKerb', len)
      group.add(mesh)
    }
    stat('infield-islandKerbs', INFIELD_ISLAND_KERBS.length)
  }

  // --- the street lamps of the service roads --------------------------------------------------------
  const lampXZ: P2[] = []
  {
    const Lp = INFIELD_LAMPS
    const lamps: PropSet = { proto: lampPoleProto(ctx), placements: [] }
    let dropped = 0
    const put2 = (x: number, z: number, yaw: number) => {
      const b = ground.builtY(x, z)
      // never on the lap or the pit lane, never in a pond, never outside the ring, never in a
      // facility, never on a cut corridor's floor (the I6 review, R6)
      if ((b && (ROAD_FRAME.has(b.kind) || b.kind === 'water')) || !insideRing(track, x, z) || footprints.some((f) => inPoly(x, z, f)) || ground.field.cutAt(x, z) !== null) { dropped++; return }
      const m = m4().makeRotationY(yaw)
      m.setPosition(x, ground.standY(x, z) - 0.02, z)
      lamps.placements.push({ m })
      lampXZ.push({ x, z })
    }
    for (const area of GROUND_AREAS) {
      const fp = area.footprint
      if (!('way' in fp) || area.kind !== 'asphaltArea') continue
      const o = osmFeature(fp.way)
      if (!o || o.role !== 'road') continue
      const pts = o.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
      let next = Lp.pitch / 2
      let walked = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 1e-6) continue
        const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len
        while (next <= walked + len) {
          const t = (next - walked) / len
          const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t
          // the pole on the side nearer the lap, its arm pointing back at the road
          const rx = -tz, rz = tx
          const win: [number, number] = fp.sRange ?? [0, track.length]
          const dR = ground.plan.project(cx + rx * Lp.offset, cz + rz * Lp.offset, win).d
          const dL = ground.plan.project(cx - rx * Lp.offset, cz - rz * Lp.offset, win).d
          const sgn = dR <= dL ? 1 : -1
          put2(cx + sgn * rx * Lp.offset, cz + sgn * rz * Lp.offset, Math.atan2(sgn * rz, -sgn * rx))
          next += Lp.pitch
        }
        walked += len
      }
    }
    registerPropSet(ctx, 'infield', 'infield-service-lamps', [lamps], { nearM: 700, farM: Infinity }, { receiveShadow: true })
    stat('infield-lampsDropped', dropped)
  }

  // --- the infield car parks: bays on the I5-a lots, bay lines, cars --------------------------------
  {
    const sets = carPropSets(ctx)
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, metalness: 0 })
    const blocksOut: { row: InfieldParkingRow; bays: Bay[] }[] = []
    const report: { id: string; walked: number; kept: number; rejects: Record<BayReject, number>; cars: number }[] = []
    let bays = 0, lineM = 0
    /** a bay's quad scaled 0.9 about its centre: neighbours in a row share an edge, so the test for a bay laid over another must not see the touching corners */
    const shrunk = (q: P2[]): P2[] => {
      let cx = 0, cz = 0
      for (const p of q) { cx += p.x / q.length; cz += p.z / q.length }
      return q.map((p) => ({ x: cx + (p.x - cx) * 0.9, z: cz + (p.z - cz) * 0.9 }))
    }
    // the bays already kept, in world XZ, across every row: a block whose s range wraps round a
    // bend (the C lot, s 305–875 round T1–T2) walks two legs over the same paddock face and would
    // lay every bay twice — cars on cars, bay lines crossing (the I5 review, V1) — and two rows
    // can meet (C and T3 at s 869–875), so a bay over a kept one is rejected whatever its row or
    // leg (the veto is layoutBays's last test)
    const keptQuads: P2[][] = []
    for (const row of INFIELD_PARKING) {
      const r = layoutBays(track, ground, row, ({ corners, samples }) => {
        // O2: every sample ≥ hw + 8 off the centreline; inside the ring; off every facility and lamp
        for (const [s_, l_] of samples) if (Math.abs(l_) < track.halfWidthAt(track.wrap(s_)) + 8) return 'clear'
        for (const c of corners) if (!insideRing(track, c.x, c.z)) return 'clear'
        if (footprints.some((f) => quadHits(corners, f, true))) return 'footprint'
        if (lampXZ.some((l) => inPoly(l.x, l.z, corners) || samples.some(([, , q]) => (q.x - l.x) ** 2 + (q.z - l.z) ** 2 < 0.5))) return 'lamp'
        const q = shrunk(corners)
        if (keptQuads.some((k) => quadHits(q, k, true))) return 'overlap'
        keptQuads.push(q)
        return null
      })
      blocksOut.push({ row, bays: r.kept })
      report.push({ id: row.id, walked: r.walked, kept: r.kept.length, rejects: r.rejects, cars: 0 })
      bays += r.kept.length
      const lines = bayLineQuads(track, ground, r.kept)
      lineM += lines.metres
      if (!lines.quads.length) continue
      const built = ground.decal(lines.quads, LAYER.paddock.line, [])
      if (!built.geo) continue
      const mesh = new THREE.Mesh(built.geo, lineMat)
      mesh.name = `infield-bayLines-${row.id}`
      mesh.receiveShadow = true
      mesh.renderOrder = 2
      markDecal(mesh, LAYER.paddock.line, built.stats)
      group.add(mesh)
    }
    // the tier budget: every lot but the largest gets its full occupancy × bays first, the
    // largest (the C lot, 300+ bays) whatever is left — a uniform scale starved the small lots
    // the aerial shows full (Degner east 7 cars, the west paddock 1) while C took 225 of 260
    // (the I5 review, F6). Only if the small lots alone exceed the budget (a smaller future
    // budget) does every block scale alike.
    const budget = quality.infield.infieldCars
    const full = blocksOut.map(({ row, bays: list }) => Math.min(list.length, Math.round(row.occupancy * list.length)))
    const big = blocksOut.reduce((bi, b, i) => (b.bays.length > blocksOut[bi]!.bays.length ? i : bi), 0)
    const small = full.reduce((a, n, i) => a + (i === big ? 0 : n), 0)
    let takes: number[]
    if (small <= budget) {
      takes = full.slice()
      takes[big] = Math.max(0, Math.min(blocksOut[big]!.bays.length, budget - small))
    } else {
      const want = blocksOut.reduce((n, b) => n + b.row.occupancy * b.bays.length, 0)
      const scale = want > 0 ? Math.min(1, budget / want) : 0
      takes = blocksOut.map(({ row, bays: list }) => Math.min(list.length, Math.round(row.occupancy * scale * list.length)))
      const over = takes.reduce((a, b) => a + b, 0) - budget
      if (over > 0) takes[big] = Math.max(0, takes[big]! - over)
    }
    let cars = 0
    blocksOut.forEach(({ bays: list }, bi) => {
      const take = takes[bi]!
      report[bi]!.cars = take
      const order = list.map((b, i) => ({ b, r: rng.next(), i })).sort((p, q) => p.r - q.r || p.i - q.i)
      for (let n = 0; n < take; n++) parkCar(track, ground, sets, order[n]!.b, rng)
      cars += take
    })
    group.userData.infieldParking = report
    registerPropSet(ctx, 'infield', 'infield-cars', [...sets.values()], { nearM: quality.infield.vehiclesNearM, farM: 500 }, { receiveShadow: true })
    stat('infield-bays', bays)
    stat('infield-bayLinesM', Math.round(lineM))
    void cars
  }

  // --- the merged meshes: one per material ------------------------------------------------------------
  for (const [key, b] of buckets) addMerged(group, b.geos, b.mat, `furniture-infield-${key}`, b.cast && shadows)
}
