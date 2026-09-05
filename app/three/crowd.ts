import * as THREE from 'three'
import { STANDS } from '~/data/suzuka-facilities-spec'
import { Rng } from '~/sim/random'
import { forwardDelta, type Track } from '~/sim/track'
import { spectatorAtlas } from './textures'
import { STAND_BAY, type SeatSlot } from './stands'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _zero = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _facing = new THREE.Vector3()

export interface Crowd {
  objects: THREE.Object3D[]
  time: { value: number }
  /** per frame: soft density LOD (back rows thin out between 280 and 380 m) and the yaw uniform */
  update: (cameraPos: THREE.Vector3) => void
}

/** race-day occupancy of the stands */
const OCCUPANCY = 0.95

/**
 * Spectators on the stands: one instanced billboard per seat slot the stand generator handed
 * over, each picking one of 16 figures from a procedural atlas and swaying gently. The figures
 * turn up to ±35° towards the camera. `maxInstances` is the tier's budget: the slots are strided
 * uniformly (every n-th seat of every row) so a small budget still covers every stand. Each
 * stand is split into ≤ 60 m bays with their own InstancedMesh inside a THREE.LOD, so culling
 * and the distance ramp are local: a bay's count ramps down with distance (rows are filled front
 * to back, so truncation empties the back rows first) and beyond 420 m the bay is not visited.
 */
export function buildCrowd(track: Track, seats: SeatSlot[], maxInstances: number, seed = 11, alphaToCoverage = false): Crowd {
  const rng = new Rng(seed)
  const atlas = spectatorAtlas()
  const geo = new THREE.PlaneGeometry(0.5, 0.95)
  geo.translate(0, 0.42, 0)
  // per-instance atlas cell (u offset, v offset) and the seat's base yaw in a custom attribute
  const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: alphaToCoverage ? 0.3 : 0.5, alphaToCoverage, side: THREE.DoubleSide, roughness: 0.9 })
  const time = { value: 0 }
  const camPos = { value: new THREE.Vector3() }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.uniforms.uCamPos = camPos
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCell;
        uniform float uTime;
        uniform vec3 uCamPos;`)
      // the atlas cell is padded 8 px top and bottom (of 128): inset the v range to match
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = (vMapUv * vec2(1.0, 0.875) + vec2(0.0, 0.0625)) * 0.25 + aCell.xy;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // turn the figure towards the camera, at most 0.6 rad away from the seat's facing
        vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = uCamPos - iPos;
        float yaw = atan(toCam.x, toCam.z) - aCell.z;
        yaw = mod(yaw + PI, PI2) - PI;
        yaw = clamp(yaw, -0.6, 0.6);
        float cy = cos(yaw), sy = sin(yaw);
        transformed.xz = vec2(transformed.x * cy + transformed.z * sy, -transformed.x * sy + transformed.z * cy);
        float ph = aCell.x * 37.0 + aCell.y * 91.0 + float(gl_InstanceID) * 0.37;
        transformed.x += sin(uTime * 1.6 + ph) * 0.02 * uv.y;`)
  }
  mat.userData.time = time

  // --- bays: stand × 60 m along the stand, rows front to back inside each ---------------------
  const standStart = new Map<string, number>()
  for (const d of STANDS) standStart.set(d.id, d.sRange[0])
  const bays = new Map<string, SeatSlot[]>()
  for (const slot of seats) {
    const s0 = standStart.get(slot.standId) ?? 0
    const bay = Math.floor(forwardDelta(s0, slot.s, track.length) / STAND_BAY)
    const key = `${slot.standId}|${bay}`
    let list = bays.get(key)
    if (!list) bays.set(key, (list = []))
    list.push(slot)
  }
  // the budget: every n-th seat of every row, so the density is even across the circuit
  const stride = Math.max(1, Math.round((seats.length * OCCUPANCY) / Math.max(1, maxInstances)))

  const out: THREE.Object3D[] = []
  const bayLods: { lod: THREE.LOD; inst: THREE.InstancedMesh; full: number }[] = []
  for (const list of bays.values()) {
    list.sort((a, b) => a.row - b.row || a.s - b.s)
    const cap = Math.ceil(list.length / stride)
    if (!cap) continue
    const inst = new THREE.InstancedMesh(geo, mat, cap)
    const cells = new Float32Array(cap * 3)
    const centre = new THREE.Vector3()
    let k = 0
    for (let i = 0; i < list.length; i += stride) {
      const slot = list[i]!
      if (rng.next() > OCCUPANCY) continue // empty seat
      _facing.set(Math.sin(slot.yaw), 0, Math.cos(slot.yaw))
      // the billboard's +Z (its face) looks along the seat's facing, towards the track
      _m.lookAt(_zero, _facing.negate(), _up)
      _q.setFromRotationMatrix(_m)
      const sc = 0.9 + rng.next() * 0.2
      _s.set(sc, sc, sc)
      _p.set(slot.x, slot.y + 0.03, slot.z)
      centre.add(_p)
      _m.compose(_p, _q, _s)
      inst.setMatrixAt(k, _m)
      cells[k * 3] = Math.floor(rng.next() * 4) * 0.25
      cells[k * 3 + 1] = Math.floor(rng.next() * 4) * 0.25
      cells[k * 3 + 2] = slot.yaw
      k++
    }
    if (!k) {
      inst.dispose()
      continue
    }
    centre.multiplyScalar(1 / k)
    inst.count = k
    inst.instanceMatrix.needsUpdate = true
    inst.geometry = geo.clone()
    inst.geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 3))
    inst.castShadow = false
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    const lod = new THREE.LOD()
    lod.addLevel(inst, 0)
    // the density ramp reaches zero at 380 m; the hard cut just stops the object being visited
    lod.addLevel(new THREE.Object3D(), 420)
    lod.position.copy(centre)
    inst.position.sub(centre)
    out.push(lod)
    bayLods.push({ lod, inst, full: k })
  }
  const update = (cameraPos: THREE.Vector3) => {
    camPos.value.copy(cameraPos)
    for (const b of bayLods) {
      const dist = cameraPos.distanceTo(b.lod.position)
      const f = THREE.MathUtils.clamp((380 - dist) / 100, 0, 1)
      const n = Math.round(b.full * f)
      if (n !== b.inst.count) b.inst.count = n
    }
  }
  return { objects: out, time, update }
}
