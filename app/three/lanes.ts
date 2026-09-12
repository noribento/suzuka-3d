import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { OFFSET_LANES, type OffsetLaneDef } from '~/data/suzuka-barriers-spec'
import type { Track } from '~/sim/track'
import { GROUND_OBJECTS, markObject, type Ground, type GroundObjectRule } from './ground'
import { kerbMaps } from './textures'
import { laneWorldPath, type LanePoint } from './trackside'

const RULE = GROUND_OBJECTS.laneKerb

/**
 * A kerb's cross-section: (fraction of the width across, height over the face it stands on).
 * Both edges are sunk into the face and the crown is flat, so the kerb never has an edge lying ON
 * the face it marks (plan rule R8; surface-check G3-object measures every vertex). The sink and
 * the crown are the object rule's own numbers, so the audit judges what the rule declares.
 */
const profileOf = (rule: GroundObjectRule): readonly [number, number][] => [[0, -rule.sink], [0.2, rule.crown], [0.8, rule.crown], [1, -rule.sink]]

/**
 * The kerbs of the paved roads that are not the Grand Prix lap but touch it: the 200R and Astemo
 * two-wheel chicanes, the two-wheel pit-in slip, the East Course link and the West Course pit lane.
 *
 * The lanes' PAVING is ground: each lane's swept footprint is a `lane` owner of the ground plan
 * (ground-plan.ts laneFootprint) and is drawn by ground-mesh.ts on the field, in one mesh with the
 * verge around it. What remains here are the kerbs along them — OBJECTS standing on the drawn
 * ground (`ground.standY`), with the footprint GROUND_OBJECTS.laneKerb bounds. They are not ground
 * faces and are not registered with the terrain. The group keeps its name for the e2e suite.
 */
export function buildLanes(track: Track, ground: Ground): THREE.Group {
  const group = new THREE.Group()
  group.name = 'lanes'
  const kerbTex = kerbMaps()
  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex.map, normalMap: kerbTex.normalMap, roughness: 0.75 })
  const kerbs: THREE.BufferGeometry[] = []
  let length = 0

  for (const def of OFFSET_LANES) {
    const pts = laneWorldPath(track, def)
    if (pts.length < 3) continue
    for (const k of def.kerbs ?? []) {
      const from = Math.floor(k.from * (pts.length - 1))
      const to = Math.ceil(k.to * (pts.length - 1))
      const slice = pts.slice(from, to + 1)
      if (slice.length < 2) continue
      // centred half a metre outside the lane edge: half on the lane, half on the verge beside it
      kerbs.push(sweepKerb(ground, slice, RULE.maxWidth, k.side * (def.width / 2 + 0.5)))
      length += slice[slice.length - 1]!.d - slice[0]!.d
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
      markObject(mesh, 'laneKerb', length)
      group.add(mesh)
    }
  }
  return group
}

/**
 * Kerb of `width` metres centred `offset` metres to the side of the sampled polyline, with the
 * rule's profile across it, every rail standing on the DRAWN ground under its own position
 * (ground.standY). `closed` treats the polyline as a loop (the paddock traffic islands, I2-a):
 * the tangents wrap and the last quad joins the first sample, so the ring has no seam.
 */
export function sweepKerb(ground: Ground, pts: LanePoint[], width: number, offset: number, rule: GroundObjectRule = RULE, closed = false): THREE.BufferGeometry {
  const PROFILE = profileOf(rule)
  const n = pts.length
  const rails = PROFILE.length
  const pos = new Float32Array(n * rails * 3)
  const uv = new Float32Array(n * rails * 2)
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!, next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
    const dx = next.x - prev.x, dz = next.z - prev.z
    const inv = 1 / (Math.hypot(dx, dz) || 1)
    // left of the lane's direction first (the track frame's left normal is (tz, −tx)), so the
    // ribbon winds counter-clockwise seen from above and its faces point up
    const lx = dz * inv, lz = -dx * inv
    const cx = p.x + lx * offset, cz = p.z + lz * offset
    for (let r = 0; r < rails; r++) {
      const [f, dy] = PROFILE[r]!
      const t = (0.5 - f) * width
      const x = cx + lx * t, z = cz + lz * t
      const y = ground.standY(x, z) + dy
      const k = i * rails + r
      pos.set([x, y, z], k * 3)
      uv.set([f, p.d / 2], k * 2)
    }
    if (i < n - 1 || closed) {
      const b0 = ((i + 1) % n) * rails
      for (let r = 0; r < rails - 1; r++) {
        const a = i * rails + r
        idx.push(a, a + 1, b0 + r, a + 1, b0 + r + 1, b0 + r)
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
