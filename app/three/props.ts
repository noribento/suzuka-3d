import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { APEX_SPEED_TARGETS, CIRCUIT, OVERTAKE_ZONES, TV_CAMERA_SPOTS } from '~/data/suzuka'
import { signedDelta, type Track } from '~/sim/track'
import { ribbonGeometry } from './track-mesh'
import type { Ground } from './ground'
import type { BoxPlacer } from './boxes'
import { brakingRubberTexture, labelTexture } from './textures'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Trackside props: braking-distance boards, sector boards, marshal posts with their flags, the
 * rubbered-in braking zones and the TV camera masts. The marshal huts go through the shared
 * `boxes` placer (the caller flushes it); `hutRoofMat` is the pit building's roof material, so
 * the hut roofs merge into the same mesh as the rest of that material.
 * Returns the flag-wave clock (also left on `group.userData.flagTime`), advanced per frame.
 */
export function buildTracksideProps(track: Track, ground: Ground, group: THREE.Group, boxes: BoxPlacer, hutRoofMat: THREE.Material): { flagTime: { value: number } } {
  const hw = track.halfWidth
  const flagTime = { value: 0 }

  // --- trackside furniture: distance boards, marshal posts, sector boards -------------------------
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.6 })
    const boardGeos: Record<string, THREE.Matrix4[]> = { '150': [], '100': [], '50': [] }
    const postGeos: THREE.BufferGeometry[] = []
    const orient = (s: number, lateral: number, y: number, out: THREE.Matrix4) => {
      const h = track.headingAt(s)
      track.pointAt(s, lateral, _p, y + ground.yAt(s, lateral))
      _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
      _q.setFromRotationMatrix(_m)
      out.compose(_p, _q, new THREE.Vector3(1, 1, 1))
    }
    // braking boards before every corner that has a braking zone
    for (const c of track.corners) {
      const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(signedDelta(t.s, c.apex, track.length)) < 60)
      if (!tgt || tgt.kmh > 240) continue
      const side: 1 | -1 = c.sign > 0 ? -1 : 1 // outside of the corner
      for (const [label, dist] of [['150', 150], ['100', 100], ['50', 50]] as const) {
        const s = c.from - dist
        const lat = side * (track.halfWidthAt(s) + 3.2)
        const m = new THREE.Matrix4()
        orient(s, lat, 1.55, m)
        boardGeos[label]!.push(m)
        track.pointAt(s, lat, _p, ground.yAt(s, lat))
        const post = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6)
        post.translate(_p.x, _p.y + 0.55, _p.z)
        postGeos.push(post)
      }
    }
    // boards face the approaching cars (back along the track)
    const boardGeo = new THREE.PlaneGeometry(0.9, 0.9)
    boardGeo.rotateY(Math.PI)
    for (const [label, mats] of Object.entries(boardGeos)) {
      if (!mats.length) continue
      const mat = new THREE.MeshStandardMaterial({ map: labelTexture(label, '#1848a0', '#ffffff'), roughness: 0.6, side: THREE.DoubleSide })
      const inst = new THREE.InstancedMesh(boardGeo, mat, mats.length)
      mats.forEach((m, i) => inst.setMatrixAt(i, m))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = true
      group.add(inst)
    }
    // sector boards at the timing lines
    const sectorGeo = new THREE.PlaneGeometry(2.4, 1.0)
    sectorGeo.rotateY(Math.PI)
    CIRCUIT.sectors.forEach((s, i) => {
      const side = cameraSide(track, s)
      const lat = side * (track.halfWidthAt(s) + 4)
      const mesh = new THREE.Mesh(sectorGeo, new THREE.MeshStandardMaterial({ map: labelTexture(`SECTOR ${i + 2}`, '#111111', '#ffffff', 512, 224, 96), roughness: 0.6, side: THREE.DoubleSide }))
      const m = new THREE.Matrix4()
      orient(s, lat, 2.4, m)
      mesh.applyMatrix4(m)
      group.add(mesh)
      track.pointAt(s, lat, _p, ground.yAt(s, lat))
      for (const dx of [-1, 1]) {
        const post = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6)
        const hh = track.headingAt(s)
        post.translate(_p.x + hh.tx * dx * 1.0, _p.y + 1.0, _p.z + hh.tz * dx * 1.0)
        postGeos.push(post)
      }
    })
    group.add(new THREE.Mesh(mergeGeometries(postGeos, false)!, postMat))
    // marshal posts every ~330 m, alternating sides, with a flag pole and a green flag
    const hutMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 })
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1f8a3f, roughness: 0.7 })
    const flagGeos: THREE.BufferGeometry[] = []
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x1fa34a, roughness: 0.9, side: THREE.DoubleSide })
    let marshal = 0
    for (let s = 160; s < track.length - 100; s += 330) {
      const side: 1 | -1 = marshal++ % 2 ? -1 : 1
      const lat = side * (track.halfWidthAt(s) + 7.5)
      boxes.place(s, lat, 2.4, 1.8, 1.3, hutMat, 0, false, false)
      boxes.place(s, lat, 2.4, 1.85, 0.25, stripeMat, 0.6, false, false)
      boxes.place(s, lat, 2.5, 1.9, 0.12, hutRoofMat, 1.3, false, false)
      const poleS = s + 1.8
      track.pointAt(poleS, lat, _p, ground.yAt(poleS, lat))
      const pole = new THREE.CylinderGeometry(0.03, 0.03, 3.6, 6)
      pole.translate(_p.x, _p.y + 1.8, _p.z)
      postGeos.push(pole)
      const flag = new THREE.PlaneGeometry(1.0, 0.7, 8, 2)
      const h = track.headingAt(poleS)
      // hang from the pole top, trailing along the track direction; per-vertex phase in uv.x
      flag.translate(0.5, 0, 0)
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tx, 0, h.tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-h.tz, 0, h.tx))
      m.setPosition(_p.x, _p.y + 3.2, _p.z)
      flag.applyMatrix4(m)
      flagGeos.push(flag)
    }
    const flags = new THREE.Mesh(mergeGeometries(flagGeos, false)!, flagMat)
    flags.name = 'flags'
    flags.frustumCulled = false
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = flagTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = uv.x;
          transformed.y += sin(uTime * 5.0 + position.x * 2.0 + position.z * 2.0 + w * 6.0) * 0.06 * w;
          transformed.x += cos(uTime * 3.7 + w * 5.0 + position.z) * 0.05 * w;`)
    }
    group.add(flags)
    group.userData.flagTime = flagTime
  }

  // --- rubbered-in braking zones (dark streaks laid down before the slow corners) ---------------
  {
    const rubberTex = brakingRubberTexture()
    // lit rubber so the streaks take the asphalt's shading (polygon offset keeps it off the road
    // surface on the reversed-Z path; three flips the offset sign there)
    const rubberMat = new THREE.MeshStandardMaterial({ map: rubberTex, alphaMap: rubberTex, color: 0x101012, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const geos: THREE.BufferGeometry[] = []
    for (const z of OVERTAKE_ZONES) {
      const from = z.s - 40
      const to = z.s + 110
      geos.push(ribbonGeometry(track, from, to, (s) => track.halfWidthAt(s) * 0.9, (s) => -track.halfWidthAt(s) * 0.9, () => 0.006, () => 0.006, 2, 10))
    }
    const rubber = new THREE.Mesh(mergeGeometries(geos, false)!, rubberMat)
    rubber.renderOrder = 1
    rubber.name = 'brakingRubber'
    group.add(rubber)
  }

  // --- TV camera masts -------------------------------------------------------------------------
  {
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.6, metalness: 0.5 })
    const mastGeo = new THREE.CylinderGeometry(0.18, 0.25, 9, 8)
    const camGeo = new THREE.BoxGeometry(0.7, 0.5, 1.1)
    const masts = new THREE.InstancedMesh(mastGeo, mastMat, TV_CAMERA_SPOTS.length)
    const cams = new THREE.InstancedMesh(camGeo, mastMat, TV_CAMERA_SPOTS.length)
    TV_CAMERA_SPOTS.forEach((s, i) => {
      const side = cameraSide(track, s)
      track.pointAt(s, side * (hw + 9), _p, ground.yAt(s, side * (hw + 9)))
      masts.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 3.5, _p.z))
      cams.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 8.3, _p.z))
    })
    masts.instanceMatrix.needsUpdate = true
    cams.instanceMatrix.needsUpdate = true
    masts.castShadow = true
    masts.name = 'tvMasts'
    group.add(masts, cams)
  }

  return { flagTime }
}

/** Which side of the track a trackside camera should stand on (outside of the nearest corner). */
export function cameraSide(track: Track, s: number): 1 | -1 {
  let k = 0
  for (let d = -40; d <= 40; d += 10) k += track.kappaAt(s + d)
  if (Math.abs(k) < 1e-4) return 1
  return k > 0 ? -1 : 1
}
