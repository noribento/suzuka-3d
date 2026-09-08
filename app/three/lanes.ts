import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { OFFSET_LANES, type OffsetLaneDef } from '~/data/suzuka-barriers-spec'
import type { Track } from '~/sim/track'
import { LAYER, type Ground } from './ground'
import type { Terrain } from './environment'
import { addRoadSurface } from './track-mesh'
import { ASPHALT_TILE_M, asphaltMaps, kerbMaps } from './textures'
import { laneWorldPath, type LanePoint } from './trackside'

/** the lane dips below the road surface where it overlaps it, so the lap is always drawn on top */
const UNDER = LAYER.road.under
const ON_GROUND = LAYER.verge.lane - LAYER.verge.grass
/**
 * Metres between the rails a lane ribbon is swept from.
 *
 * It used to be swept from its two edges only, and BOTH took the height of the centreline, so a
 * 9 m ribbon was a flat chord across whatever the ground did underneath it. Measured on the built
 * scene, the terrain came through the lanes over 13.6 % of their area (worst 0.24 m). The terrain
 * grid is 13.3 m (17.7 m on the low tier), so rails every 3 m resolve it with room to spare.
 */
const RAIL_STEP = 3

/**
 * The paved roads that are not the Grand Prix lap but touch it: the 200R and Astemo two-wheel
 * chicanes, the two-wheel pit-in slip, the East Course link and the West Course pit lane.
 *
 * They used to be drawn by props.ts as 9 m ribbons draped on the terrain along the raw OSM
 * polyline, which put a mitred blob across the verge and over the racing surface (the "P" at the
 * 200R in the 2026-09 audit). Here each one is a lane in the lap's own frame: its OSM vertices are
 * mapped to (s, lateral) inside its own window, resampled through a spline, and swept like the
 * road — so it meets the lap at the right angle, sits at the right height, and can carry its own
 * edge lines (lines.ts) and kerbs.
 */
export function buildLanes(track: Track, ground: Ground, terrain: Terrain): THREE.Group {
  const group = new THREE.Group()
  group.name = 'lanes'
  const maps = asphaltMaps(false)
  const mat = new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.roughnessMap, roughness: 1 })
  addRoadSurface(mat, new THREE.Vector2(1, ASPHALT_TILE_M / 300), 9)
  const kerbTex = kerbMaps()
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex.map, normalMap: kerbTex.normalMap, roughness: 0.75 })
  const road: THREE.BufferGeometry[] = []
  const kerbs: THREE.BufferGeometry[] = []

  for (const def of OFFSET_LANES) {
    const pts = laneWorldPath(track, def)
    if (pts.length < 3) continue
    if (!def.paved) road.push(sweepLane(track, ground, pts, def.width))
    for (const k of def.kerbs ?? []) {
      const from = Math.floor(k.from * (pts.length - 1))
      const to = Math.ceil(k.to * (pts.length - 1))
      const slice = pts.slice(from, to + 1)
      if (slice.length < 2) continue
      kerbs.push(sweepLane(track, ground, slice, 1.0, k.side * (def.width / 2 + 0.5), 0.05))
    }
  }
  const add = (geos: THREE.BufferGeometry[], material: THREE.Material, name: string) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) return
    const mesh = new THREE.Mesh(merged, material)
    mesh.name = name
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    group.add(mesh)
    // the lanes run out on the verge, where the drawn terrain is a 13 m facet: without this the
    // grid comes through them (measured: 13.6 % of their area, worst 0.24 m)
    terrain.addGroundSurface(merged, { name, maxDrop: 1 })
  }
  add(road, mat, 'lanePaving')
  add(kerbs, kerbMat, 'laneKerbs')
  return group
}

/**
 * Ribbon of `width` metres centred `offset` metres to the side of the sampled lane centreline,
 * `lift` above the ground it runs on — and below the road surface wherever it overlaps the lap, so
 * the merge and split mouths do not z-fight with the racing surface.
 */
function sweepLane(track: Track, ground: Ground, pts: LanePoint[], width: number, offset = 0, lift = ON_GROUND): THREE.BufferGeometry {
  const n = pts.length
  const rails = Math.max(2, Math.round(width / RAIL_STEP) + 1)
  const pos = new Float32Array(n * rails * 3)
  const uv = new Float32Array(n * rails * 2)
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const prev = pts[Math.max(0, i - 1)]!, next = pts[Math.min(n - 1, i + 1)]!
    const dx = next.x - prev.x, dz = next.z - prev.z
    const inv = 1 / (Math.hypot(dx, dz) || 1)
    // left of the lane's direction first (the track frame's left normal is (tz, −tx)), so the
    // ribbon winds counter-clockwise seen from above and its faces point up
    const lx = dz * inv, lz = -dx * inv
    const cx = p.x + lx * offset, cz = p.z + lz * offset
    const onRoad = Math.abs(p.lat) < track.halfWidthAt(p.s) + 1.5
    // the lap's own left normal at this station, to turn a world offset into a lateral
    const ti = Math.round(track.wrap(p.s) / track.ds) % track.n
    const tnx = track.nx[ti]!, tnz = track.nz[ti]!
    for (let r = 0; r < rails; r++) {
      const t = (0.5 - r / (rails - 1)) * width
      const x = cx + lx * t, z = cz + lz * t
      // this rail's own lateral, so every rail is draped on the ground under IT rather than on
      // the ground under the centreline
      const lat = p.lat + (x - p.x) * tnx + (z - p.z) * tnz
      // the lap's surface wins where the two overlap; elsewhere the lane sits on the verge
      const y = onRoad ? ground.worldY(p.s, p.lat) + UNDER : ground.worldY(p.s, lat) + lift
      const k = i * rails + r
      pos.set([x, y, z], k * 3)
      uv.set([r / (rails - 1), p.d / ASPHALT_TILE_M], k * 2)
    }
    if (i < n - 1) {
      for (let r = 0; r < rails - 1; r++) {
        const a = i * rails + r
        idx.push(a, a + 1, a + rails, a + 1, a + rails + 1, a + rails)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export type { OffsetLaneDef }
