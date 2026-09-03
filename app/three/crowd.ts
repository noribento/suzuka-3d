import * as THREE from 'three'
import { GRANDSTANDS } from '~/data/suzuka'
import { Rng } from '~/sim/random'
import type { Track } from '~/sim/track'
import { spectatorAtlas } from './textures'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

export interface Crowd {
  objects: THREE.Object3D[]
  time: { value: number }
  /** per frame: soft density LOD (back rows thin out between 280 and 380 m) and the yaw uniform */
  update: (cameraPos: THREE.Vector3) => void
}

/**
 * Individual spectators on the grandstands: one instanced billboard per seat, each picking
 * one of 16 figures from a procedural atlas and swaying gently. The figures turn up to ±35°
 * towards the camera; the instance count of each stand ramps down with distance (the rows
 * are generated front to back, so truncation empties the back rows first) and beyond 420 m
 * the flat crowd texture on the seat ribbon carries the look alone (THREE.LOD per stand).
 */
export function buildCrowd(track: Track, maxInstances: number, seed = 11, alphaToCoverage = false): Crowd {
  const rng = new Rng(seed)
  const atlas = spectatorAtlas()
  const geo = new THREE.PlaneGeometry(0.5, 0.95)
  geo.translate(0, 0.42, 0)
  // per-instance atlas cell (u offset, v offset) and the stand's base yaw in a custom attribute
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
        // turn the figure towards the camera, at most 0.6 rad away from the stand's facing
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
  const stands3: { lod: THREE.LOD; inst: THREE.InstancedMesh; full: number }[] = []

  const out: THREE.Object3D[] = []
  const hw = track.halfWidth
  // budget the instances across the stands by seat count
  const stands = GRANDSTANDS.map(([from, to, side, depth]) => {
    let len = to - from
    if (len < 0) len += track.length
    const rows = Math.max(2, Math.floor(depth / 0.8))
    const cols = Math.max(2, Math.floor(len / 0.55))
    return { from, to, side, depth, len, rows, cols }
  })
  const totalSeats = stands.reduce((a, s) => a + s.rows * s.cols, 0)
  const fill = Math.min(1, maxInstances / totalSeats)

  for (const st of stands) {
    const gap = 11
    const l0 = st.side * (hw + gap)
    const height = st.depth * 0.62
    const stride = Math.max(1, Math.round(1 / Math.sqrt(fill)))
    const count = Math.ceil(st.rows / stride) * Math.ceil(st.cols / stride)
    const inst = new THREE.InstancedMesh(geo, mat, count)
    const cells = new Float32Array(count * 3)
    let k = 0
    const mid = st.from + st.len / 2
    const h = track.headingAt(mid)
    // face the track: billboards look across the stand towards the road
    const facing = new THREE.Vector3(-st.side * h.tz, 0, st.side * h.tx)
    _m.lookAt(new THREE.Vector3(), facing.clone().negate(), new THREE.Vector3(0, 1, 0))
    _q.setFromRotationMatrix(_m)
    const baseYaw = Math.atan2(facing.x, facing.z)
    for (let r = 0; r < st.rows; r += stride) {
      const t = (r + 0.5) / st.rows
      const lat = l0 + st.side * st.depth * t
      const y = 1.6 + (height - 1.6) * t
      for (let c = 0; c < st.cols; c += stride) {
        if (rng.next() < 0.12) continue // empty seat
        const s = st.from + (c + 0.5) * (st.len / st.cols)
        track.pointAt(s, lat + (rng.next() - 0.5) * 0.2, _p, y - 0.25)
        const sc = 0.9 + rng.next() * 0.2
        _s.set(sc, sc, sc)
        _m.compose(_p, _q, _s)
        inst.setMatrixAt(k, _m)
        cells[k * 3] = Math.floor(rng.next() * 4) * 0.25
        cells[k * 3 + 1] = Math.floor(rng.next() * 4) * 0.25
        cells[k * 3 + 2] = baseYaw
        k++
      }
    }
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
    track.pointAt(mid, l0 + st.side * st.depth * 0.5, _p, height / 2)
    lod.position.copy(_p)
    inst.position.sub(_p)
    out.push(lod)
    stands3.push({ lod, inst, full: k })
  }
  const update = (cameraPos: THREE.Vector3) => {
    camPos.value.copy(cameraPos)
    for (const s of stands3) {
      const dist = cameraPos.distanceTo(s.lod.position)
      const f = THREE.MathUtils.clamp((380 - dist) / 100, 0, 1)
      const n = Math.round(s.full * f)
      if (n !== s.inst.count) s.inst.count = n
    }
  }
  return { objects: out, time, update }
}
