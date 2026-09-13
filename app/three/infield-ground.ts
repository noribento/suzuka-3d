import * as THREE from 'three'
import { BUILDINGS, GROUND_AREAS } from '~/data/suzuka-facilities-spec'
import { osmFeature } from '~/data/suzuka-facilities'
import type { Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal, type Ground } from './ground'
import type { DecalQuad, DecalStats } from './ground-mesh'
import { addMerged, extrudeFootprint, pitMaterials } from './pit-geometry'
import { wayChainPath } from './trackside'

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
}
