import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { OFFSET_LANES, type OffsetLaneDef } from '~/data/suzuka-barriers-spec'
import type { Track } from '~/sim/track'
import type { Ground } from './ground'
import { addRoadSurface } from './track-mesh'
import { ASPHALT_TILE_M, asphaltMaps, kerbMaps } from './textures'
import { laneWorldPath, type LanePoint } from './trackside'

/** the lane dips below the road surface where it overlaps it, so the lap is always drawn on top */
const UNDER = -0.06
const ON_GROUND = 0.02

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
export function buildLanes(track: Track, ground: Ground): THREE.Group {
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
    road.push(sweepLane(track, ground, pts, def.width))
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
  const pos = new Float32Array(n * 6)
  const uv = new Float32Array(n * 4)
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
    // the lap's surface wins where the two overlap; elsewhere the lane sits on the verge
    const y = onRoad ? ground.worldY(p.s, p.lat) + UNDER : ground.worldY(p.s, p.lat + offset) + lift
    const k = i * 2
    pos.set([cx + lx * width / 2, y, cz + lz * width / 2, cx - lx * width / 2, y, cz - lz * width / 2], k * 3)
    uv.set([0, p.d / ASPHALT_TILE_M, 1, p.d / ASPHALT_TILE_M], k * 2)
    if (i < n - 1) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export type { OffsetLaneDef }
