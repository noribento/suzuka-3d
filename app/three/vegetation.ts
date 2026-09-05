import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FERRIS_WHEEL } from '~/data/suzuka-facilities-spec'
import type { EnvBuildContext } from './environment'
import { bucketedInstancedMeshes } from './instancing'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

/**
 * Ferris wheel (the Suzuka landmark beside the main straight). The returned group is added to
 * `group`; its child named 'wheel' turns (the caller animates it), so it must be kept out of
 * `freezeStatic`.
 */
export function buildFerrisWheel(ctx: EnvBuildContext): THREE.Group {
  const { track, terrain, group } = ctx
  const ferrisWheel = new THREE.Group()
  {
    // the real サーキットホイール: OSM footprint centroid behind the final-corner stands, 50.4 m
    // high, 48 m across, 36 gondolas (see FERRIS_WHEEL); it stands on ground ~7.6 m above the track
    track.enToWorld(FERRIS_WHEEL.en[0], FERRIS_WHEEL.en[1], _p)
    const groundY = terrain.meshHeightAt(_p.x, _p.z)
    ferrisWheel.position.set(_p.x, groundY, _p.z)
    const h = track.headingAt(FERRIS_WHEEL.s)
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    ferrisWheel.quaternion.setFromRotationMatrix(_m)
    const R = FERRIS_WHEEL.diameter / 2
    const hub = FERRIS_WHEEL.height - R
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5, metalness: 0.3 })
    const wheel = new THREE.Group()
    wheel.name = 'wheel'
    wheel.position.set(0, hub, 0)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.7, 8, 48), whiteMat)
    const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 3, 0.4, 8, 48), whiteMat)
    rim.castShadow = true
    wheel.add(rim, rim2)
    const spokeGeo = new THREE.BoxGeometry(0.4, R * 2, 0.4)
    const gondolaGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6)
    const colors = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffb703, 0x8ecae6]
    for (let i = 0; i < 12; i++) {
      const spoke = new THREE.Mesh(spokeGeo, whiteMat)
      spoke.rotation.z = (i / 12) * Math.PI
      wheel.add(spoke)
    }
    for (let i = 0; i < FERRIS_WHEEL.gondolas; i++) {
      const a = (i / FERRIS_WHEEL.gondolas) * Math.PI * 2
      const g = new THREE.Mesh(gondolaGeo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.4 }))
      g.position.set(Math.cos(a) * R, Math.sin(a) * R, 0)
      g.name = 'gondola'
      wheel.add(g)
    }
    ferrisWheel.add(wheel)
    const legGeo = new THREE.BoxGeometry(1.2, hub * 1.08, 1.2)
    for (const [dx, dz] of [[-14, 3], [14, 3], [-14, -3], [14, -3]]) {
      const leg = new THREE.Mesh(legGeo, whiteMat)
      leg.position.set(dx! / 2, hub / 2, dz!)
      leg.rotation.z = dx! > 0 ? -0.3 : 0.3
      leg.castShadow = true
      ferrisWheel.add(leg)
    }
    group.add(ferrisWheel)
  }
  return ferrisWheel
}

/**
 * Trees: `quality.trees` instances scattered over the terrain, kept off the track, the pit /
 * paddock zone, the grandstands and the Ferris wheel. Placement draws from `rng` in a fixed
 * order, so the caller's seeded generator decides the woods; run this after the Ferris wheel
 * is placed.
 */
export function buildTrees(ctx: EnvBuildContext, ferrisWheel: THREE.Group) {
  const { track, terrain, quality, rng, group, standZones } = ctx
  const canopy = mergeGeometries([
    (() => { const g = new THREE.ConeGeometry(3.2, 7, 7); g.translate(0, 6.5, 0); return g })(),
    (() => { const g = new THREE.ConeGeometry(2.4, 5, 7); g.translate(0, 9.5, 0); return g })(),
  ], false)!
  const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 6)
  trunk.translate(0, 2, 0)
  const count = quality.trees
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d25, roughness: 0.9 })
  const matrices: THREE.Matrix4[] = []
  const colors: THREE.Color[] = []
  const b = track.bounds
  let placed = 0
  let tries = 0
  const wheelPos = ferrisWheel.position
  while (placed < count && tries < count * 40) {
    tries++
    const x = rng.range(b.minX - 420, b.maxX + 420)
    const z = rng.range(b.minZ - 380, b.maxZ + 380)
    const near = terrain.distanceToTrack(x, z, 200)
    if (near.d < 44) continue
    if (near.i >= 0) {
      const s = near.s
      const inPitZone = s >= 5540 || s <= 90
      if (inPitZone && near.lateral > -125 && near.lateral < 80) continue
      let inStand = false
      for (const { from, to, side, lateralBack } of standZones) {
        const inS = from < to ? s >= from - 15 && s <= to + 15 : s >= from - 15 || s <= to + 15
        if (inS && Math.sign(near.lateral) === side && Math.abs(near.lateral) < lateralBack + 26) inStand = true
      }
      if (inStand) continue
    }
    if (Math.hypot(x - wheelPos.x, z - wheelPos.z) < 60) continue
    // denser woods further from the track
    if (near.d < 120 && rng.next() < 0.55) continue
    const y = terrain.meshHeightAt(x, z)
    const sc = rng.range(0.7, 1.45)
    _s.set(sc, sc * rng.range(0.85, 1.2), sc)
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * Math.PI * 2)
    matrices.push(new THREE.Matrix4().compose(_p.set(x, y - 0.3, z), _q, _s))
    colors.push(new THREE.Color().setHSL(0.26 + rng.next() * 0.09, 0.45 + rng.next() * 0.3, 0.2 + rng.next() * 0.14))
    placed++
  }
  // one InstancedMesh per terrain chunk (16) so the follow cameras and the cascades cull the
  // far side of the circuit; canopies cast only on the high tier, trunks never
  const bucketOf = (_i: number, m: THREE.Matrix4) => terrain.chunkIndex(m.elements[12]!, m.elements[14]!)
  for (const inst of bucketedInstancedMeshes(canopy, canopyMat, matrices, colors, bucketOf, { castShadow: quality.treeShadows, name: 'canopies' })) group.add(inst)
  for (const inst of bucketedInstancedMeshes(trunk, trunkMat, matrices, null, bucketOf, { castShadow: false, name: 'trunks' })) group.add(inst)
}
