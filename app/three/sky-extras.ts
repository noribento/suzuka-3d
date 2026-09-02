import * as THREE from 'three'
import { cloudTexture, flareTexture, treeLineTexture } from './textures'

/**
 * Backdrop extras: a slowly drifting cloud layer, a sun flare drawn in screen space, and a
 * distant tree-line ring that hides the edge of the terrain.
 */

export interface SkyExtras {
  group: THREE.Group
  /** call every frame with the current sun direction (unit) and camera */
  update: (dt: number, sun: THREE.Vector3, camera: THREE.PerspectiveCamera) => void
}

const _ndc = new THREE.Vector3()
const _dir = new THREE.Vector3()

export function buildSkyExtras(centre: THREE.Vector3): SkyExtras {
  const group = new THREE.Group()
  group.name = 'skyExtras'

  // --- clouds: an inverted sphere with an alpha cloud map, only above the horizon -------------
  const cloudGeo = new THREE.SphereGeometry(9000, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5)
  const cloudMat = new THREE.MeshBasicMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, side: THREE.BackSide, fog: false, opacity: 0.85 })
  const clouds = new THREE.Mesh(cloudGeo, cloudMat)
  clouds.position.copy(centre)
  clouds.renderOrder = -1
  group.add(clouds)

  // --- distant tree line hiding the terrain edge ----------------------------------------------
  const ringGeo = new THREE.CylinderGeometry(1240, 1240, 44, 96, 1, true)
  const ringMat = new THREE.MeshBasicMaterial({ map: treeLineTexture(), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, color: 0x2e4a2a })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.set(centre.x, centre.y + 30, centre.z)
  group.add(ring)

  // --- sun flare: a bright core sprite at the sun plus two ghosts along the line to the centre
  const flareTex = flareTexture()
  const mk = (size: number, color: number, opacity: number) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, toneMapped: false }))
    s.scale.setScalar(size)
    s.renderOrder = 100
    return s
  }
  const core = mk(0.9, 0xfff2d0, 0.75)
  const ghost1 = mk(0.35, 0xffc890, 0.22)
  const ghost2 = mk(0.6, 0x90c8ff, 0.12)
  const flares = [core, ghost1, ghost2]
  for (const f of flares) group.add(f)

  const update = (dt: number, sun: THREE.Vector3, camera: THREE.PerspectiveCamera) => {
    clouds.rotation.y += dt * 0.0012
    // sun in normalised device coordinates
    _ndc.copy(sun).multiplyScalar(5000).add(camera.position).project(camera)
    const behind = _ndc.z > 1 || sun.dot(_dir.set(0, 0, -1).applyQuaternion(camera.quaternion)) < 0
    const inFrame = !behind && Math.abs(_ndc.x) < 1.35 && Math.abs(_ndc.y) < 1.35
    if (!inFrame) {
      for (const f of flares) f.visible = false
      return
    }
    // fade as the sun leaves the frame
    const edge = Math.max(Math.abs(_ndc.x), Math.abs(_ndc.y))
    const fade = 1 - THREE.MathUtils.smoothstep(edge, 0.9, 1.35)
    const place = (s: THREE.Sprite, t: number, base: number) => {
      // t = 0 at the sun, 1 at the screen centre, >1 beyond
      const nx = _ndc.x * (1 - t)
      const ny = _ndc.y * (1 - t)
      _dir.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize()
      s.position.copy(camera.position).addScaledVector(_dir, 2)
      ;(s.material as THREE.SpriteMaterial).opacity = base * fade
      s.scale.setScalar(s.userData.size as number)
      s.visible = true
    }
    core.userData.size ??= 0.9
    ghost1.userData.size ??= 0.35
    ghost2.userData.size ??= 0.6
    // sprites sit 2 m in front of the camera: scale them to a fraction of the view height
    const k = 2 * Math.tan((camera.fov * Math.PI) / 360)
    core.userData.size = 0.55 * k
    ghost1.userData.size = 0.18 * k
    ghost2.userData.size = 0.32 * k
    place(core, 0, 0.75)
    place(ghost1, 0.45, 0.22)
    place(ghost2, 1.25, 0.12)
  }

  return { group, update }
}
