import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { OFFSET_LANES, type OffsetLaneDef } from '~/data/suzuka-barriers-spec'
import type { Track } from '~/sim/track'
import { LAYER, type Ground } from './ground'
import type { Terrain } from './environment'
import { kerbMaps } from './textures'
import { laneWorldPath, type LanePoint } from './trackside'

/** metres between the rails a kerb ribbon is swept from */
const RAIL_STEP = 3

/**
 * The kerbs of the paved roads that are not the Grand Prix lap but touch it: the 200R and Astemo
 * two-wheel chicanes, the two-wheel pit-in slip, the East Course link and the West Course pit lane.
 *
 * The lanes' PAVING is ground: each lane's swept footprint is a `lane` owner of the ground plan
 * (ground-plan.ts laneFootprint) and is drawn by ground-mesh.ts on the field, in one mesh with the
 * verge around it. What remains here are the kerbs along them — objects standing on the drawn
 * lane, LAYER.verge.laneKerb proud of it, with a bounded footprint (plan rule R8). The group keeps
 * its name for the e2e suite.
 */
export function buildLanes(track: Track, ground: Ground, terrain: Terrain): THREE.Group {
  const group = new THREE.Group()
  group.name = 'lanes'
  const kerbTex = kerbMaps()
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex.map, normalMap: kerbTex.normalMap, roughness: 0.75 })
  const kerbs: THREE.BufferGeometry[] = []

  for (const def of OFFSET_LANES) {
    const pts = laneWorldPath(track, def)
    if (pts.length < 3) continue
    for (const k of def.kerbs ?? []) {
      const from = Math.floor(k.from * (pts.length - 1))
      const to = Math.ceil(k.to * (pts.length - 1))
      const slice = pts.slice(from, to + 1)
      if (slice.length < 2) continue
      kerbs.push(sweepKerb(ground, slice, 1.0, k.side * (def.width / 2 + 0.5), LAYER.verge.laneKerb))
    }
  }
  if (kerbs.length) {
    const merged = mergeGeometries(kerbs, false)
    for (const g of kerbs) g.dispose()
    if (merged) {
      const mesh = new THREE.Mesh(merged, kerbMat)
      mesh.name = 'laneKerbs'
      mesh.receiveShadow = true
      mesh.renderOrder = 1
      group.add(mesh)
      // an object on the ground, registered the raw way until it becomes a placed object (P4)
      terrain.addGroundSurface(merged, { name: 'laneKerbs', maxDrop: 1 })
    }
  }
  return group
}

/**
 * Ribbon of `width` metres centred `offset` metres to the side of the sampled lane centreline,
 * `lift` above the DRAWN ground under each rail (ground.builtY), so it stands on the lane face
 * it marks rather than on the field the face approximates.
 */
function sweepKerb(ground: Ground, pts: LanePoint[], width: number, offset: number, lift: number): THREE.BufferGeometry {
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
    for (let r = 0; r < rails; r++) {
      const t = (0.5 - r / (rails - 1)) * width
      const x = cx + lx * t, z = cz + lz * t
      const y = (ground.builtY(x, z)?.y ?? ground.field.y(x, z)) + lift
      const k = i * rails + r
      pos.set([x, y, z], k * 3)
      uv.set([r / (rails - 1), p.d / 2], k * 2)
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
