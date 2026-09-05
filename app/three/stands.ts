import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GRANDSTANDS } from '~/data/suzuka'
import { forwardDelta, type Track } from '~/sim/track'
import { ribbonGeometry, wallGeometry } from './track-mesh'
import type { Ground } from './ground'
import { crowdTexture } from './textures'

const _p = new THREE.Vector3()

/**
 * Legacy grandstands: one ribbon of seats per GRANDSTANDS entry with its structure walls, end
 * caps and (optionally) a roof on columns, merged into one mesh each for seats, structure and
 * roofs. Slated to be replaced by the footprint-based stand generator.
 */
export function buildLegacyStands(track: Track, ground: Ground, group: THREE.Group) {
  const hw = track.halfWidth
  const seatMat = new THREE.MeshStandardMaterial({ map: crowdTexture(), roughness: 0.9 })
  const structMat = new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.8, side: THREE.DoubleSide })
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide })
  const seatGeos: THREE.BufferGeometry[] = []
  const structGeos: THREE.BufferGeometry[] = []
  const roofGeos: THREE.BufferGeometry[] = []
  for (const [from, to, side, depth, roof] of GRANDSTANDS) {
    const gap = 11
    const l0 = side * (hw + gap)
    const l1 = side * (hw + gap + depth)
    const height = depth * 0.62
    const len = forwardDelta(from, to, track.length)
    seatGeos.push(ribbonGeometry(track, from, to, () => (side > 0 ? l1 : l0), () => (side > 0 ? l0 : l1), () => (side > 0 ? height : 1.6), () => (side > 0 ? 1.6 : height), 4, 32, depth / 12))
    // the structure walls reach down into the ground, whatever the verge does underneath
    structGeos.push(wallGeometry(track, from, to, () => l1, (s) => ground.yAt(s, l1) - 1, () => height, 4))
    structGeos.push(wallGeometry(track, from, to, () => l0, (s) => ground.yAt(s, l0) - 1, () => 1.6, 4))
    // end caps
    for (const s of [from, to]) {
      structGeos.push(ribbonGeometry(track, s, s + 0.3, () => (side > 0 ? l1 : l0), () => (side > 0 ? l0 : l1), () => (side > 0 ? height : 1.6), () => (side > 0 ? 1.6 : height), 1, 1))
      structGeos.push(wallGeometry(track, s, s + 0.3, () => l0 + side * depth * 0.5, (ss) => ground.yAt(ss, l0 + side * depth * 0.5) - 1, () => height * 0.6, 1))
    }
    if (roof) {
      roofGeos.push(ribbonGeometry(track, from, to, () => (side > 0 ? l1 + 2 : l0 - 1), () => (side > 0 ? l0 - 1 : l1 + 2), () => height + 7, () => height + 7, 4, 8))
      const cols = Math.max(2, Math.floor(len / 28))
      for (let k = 0; k <= cols; k++) {
        const s = from + (len * k) / cols
        track.pointAt(s, l1 + side * 1, _p)
        const gy = ground.yAt(s, l1 + side * 1) - 0.5
        const col = new THREE.CylinderGeometry(0.5, 0.5, height + 7 - gy, 8)
        col.translate(_p.x, _p.y + (height + 7 + gy) / 2, _p.z)
        structGeos.push(col)
      }
    }
  }
  const seats = new THREE.Mesh(mergeGeometries(seatGeos, false)!, seatMat)
  seats.name = 'grandstandSeats'
  seats.castShadow = true
  seats.receiveShadow = true
  const struct = new THREE.Mesh(mergeGeometries(structGeos, false)!, structMat)
  struct.name = 'grandstandStructure'
  struct.castShadow = true
  group.add(seats, struct)
  if (roofGeos.length) {
    const roofs = new THREE.Mesh(mergeGeometries(roofGeos, false)!, roofMat)
    roofs.name = 'grandstandRoofs'
    roofs.castShadow = true
    group.add(roofs)
  }
}
