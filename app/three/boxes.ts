import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Track } from '~/sim/track'
import type { Ground } from './ground'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _one = new THREE.Vector3(1, 1, 1)

/**
 * Places track-aligned boxes (buildings, huts, gantries …) beside the road and adds them to
 * `group`. Single-material boxes are collected per (material, caster flag) and merged into one
 * mesh each by `flush()` (≈10 draws instead of ≈180); multi-material boxes stay individual
 * meshes. One instance is shared by every builder adding to the same group, so boxes of the
 * same material end up in the same merged mesh whichever module placed them.
 */
export class BoxPlacer {
  private readonly buckets = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>()

  constructor(private readonly track: Track, private readonly ground: Ground, private readonly group: THREE.Group) {}

  /**
   * Placement matrix (world) of a box standing on the ground at (s, lateral) — its base follows
   * the verge / terrain there, not the road plane. `onPlane` keeps it on the road plane instead
   * (pit apron, garages). Local frame: +X = left of the track, +Z = along the track.
   */
  matrix(s: number, lateral: number, height: number, yOffset: number, onPlane: boolean, out: THREE.Matrix4): THREE.Matrix4 {
    const h = this.track.headingAt(s)
    this.track.pointAt(s, lateral, _p)
    const base = onPlane ? 0 : this.ground.yAt(s, lateral)
    _p.y += base + height / 2 + yOffset
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    _q.setFromRotationMatrix(_m)
    return out.compose(_p, _q, _one)
  }

  /**
   * Box of `length` along the track × `depth` across it × `height`. A single material goes to
   * the merge bucket, an array of materials makes an individual mesh right away.
   * Returns the placement matrix (world).
   */
  place(s: number, lateral: number, length: number, depth: number, height: number, mats: THREE.Material | THREE.Material[], yOffset = 0, onPlane = false, cast = true, uvFn?: (uv: THREE.BufferAttribute) => void): THREE.Matrix4 {
    const geo = new THREE.BoxGeometry(depth, height, length)
    if (uvFn) uvFn(geo.attributes.uv as THREE.BufferAttribute)
    const m = this.matrix(s, lateral, height, yOffset, onPlane, new THREE.Matrix4())
    if (Array.isArray(mats)) {
      const mesh = new THREE.Mesh(geo, mats)
      mesh.applyMatrix4(m)
      mesh.castShadow = cast
      mesh.receiveShadow = true
      this.group.add(mesh)
      return m
    }
    geo.applyMatrix4(m)
    const key = `${mats.uuid}|${cast ? 1 : 0}`
    let b = this.buckets.get(key)
    if (!b) this.buckets.set(key, (b = { mat: mats, cast, geos: [] }))
    b.geos.push(geo)
    return m
  }

  /** Merge every single-material box placed so far into one mesh per (material, caster flag). */
  flush() {
    for (const b of this.buckets.values()) {
      const merged = mergeGeometries(b.geos, false)
      if (!merged) continue
      for (const g of b.geos) g.dispose()
      const mesh = new THREE.Mesh(merged, b.mat)
      mesh.castShadow = b.cast
      mesh.receiveShadow = true
      mesh.name = 'props'
      this.group.add(mesh)
    }
    this.buckets.clear()
  }

  /** one InstancedMesh for a run of same-sized, per-instance-coloured boxes */
  instanced(length: number, depth: number, height: number, items: { m: THREE.Matrix4; color: THREE.Color }[], roughness: number, cast: boolean, name: string): THREE.InstancedMesh {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(depth, height, length), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness }), items.length)
    items.forEach((it, i) => {
      inst.setMatrixAt(i, it.m)
      inst.setColorAt(i, it.color)
    })
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    inst.castShadow = cast
    inst.receiveShadow = true
    inst.name = name
    this.group.add(inst)
    return inst
  }
}
