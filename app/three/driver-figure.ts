import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Driver figure for the cockpit: shoulders, torso, HANS device, arms to the steering wheel,
 * and the wheel itself. Car frame: +Z forward, +X left, +Y up; the helmet sits at
 * (0, 0.79, 0.4) so the shoulders are just below the cockpit rim (~0.69).
 */

export interface DriverFigure {
  /** static body (torso, shoulders, HANS) — race suit colour */
  body: THREE.BufferGeometry
  /** arms + gloves: black */
  arms: THREE.BufferGeometry
  /** steering wheel rim + spokes (carbon) */
  wheel: THREE.BufferGeometry
  /** wheel display face */
  wheelFace: THREE.BufferGeometry
  /** where the wheel sits (pivot for the steering rotation) */
  wheelPivot: THREE.Vector3
  /** wheel axis (points out of the wheel face towards the driver) */
  wheelAxis: THREE.Vector3
}

let cached: DriverFigure | null = null

function capsule(r: number, len: number, a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, 3, 8)
  const dir = b.clone().sub(a)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

export function driverFigure(): DriverFigure {
  if (cached) return cached
  const body: THREE.BufferGeometry[] = []
  const arms: THREE.BufferGeometry[] = []

  // shoulders + upper torso, reclined ~40° like a real seating position
  const torso = new THREE.SphereGeometry(0.2, 16, 10)
  torso.scale(1.15, 0.55, 0.7)
  torso.translate(0, 0.6, 0.47)
  body.push(torso)
  const chest = new THREE.CylinderGeometry(0.17, 0.2, 0.3, 12)
  chest.rotateX(-0.7)
  chest.translate(0, 0.5, 0.62)
  body.push(chest)
  // HANS collar behind the helmet
  const hans = new THREE.TorusGeometry(0.12, 0.035, 8, 16, Math.PI)
  hans.rotateX(Math.PI / 2)
  hans.rotateY(Math.PI)
  hans.translate(0, 0.66, 0.34)
  body.push(hans)

  // steering wheel: a flat-bottomed rectangle-ish rim with a display
  const wheelPivot = new THREE.Vector3(0, 0.62, 0.88)
  const wheelAxis = new THREE.Vector3(0, 0.5, -1).normalize()
  const rimShape = new THREE.Shape()
  rimShape.moveTo(-0.14, -0.06)
  rimShape.lineTo(0.14, -0.06)
  rimShape.quadraticCurveTo(0.16, -0.06, 0.16, -0.04)
  rimShape.lineTo(0.16, 0.06)
  rimShape.quadraticCurveTo(0.16, 0.09, 0.13, 0.09)
  rimShape.lineTo(-0.13, 0.09)
  rimShape.quadraticCurveTo(-0.16, 0.09, -0.16, 0.06)
  rimShape.lineTo(-0.16, -0.04)
  rimShape.quadraticCurveTo(-0.16, -0.06, -0.14, -0.06)
  const inner = new THREE.Path()
  inner.moveTo(-0.11, -0.03)
  inner.lineTo(0.11, -0.03)
  inner.lineTo(0.12, 0.06)
  inner.lineTo(-0.12, 0.06)
  inner.lineTo(-0.11, -0.03)
  rimShape.holes.push(inner)
  const rim = new THREE.ExtrudeGeometry(rimShape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 2 })
  const face = new THREE.PlaneGeometry(0.2, 0.09)
  face.translate(0, 0.02, 0.031)
  // orient the wheel: shape is in XY, extruded along +Z; tilt to face the driver
  const orient = new THREE.Matrix4().lookAt(new THREE.Vector3(), wheelAxis.clone().negate(), new THREE.Vector3(0, 1, 0))
  rim.applyMatrix4(orient)
  face.applyMatrix4(orient)
  rim.translate(wheelPivot.x, wheelPivot.y, wheelPivot.z)
  face.translate(wheelPivot.x, wheelPivot.y, wheelPivot.z)

  // arms: shoulders (±0.17, 0.6, 0.5) → elbows → hands on the rim at (±0.15, 0.62, 0.86)
  for (const sgn of [1, -1]) {
    const shoulder = new THREE.Vector3(sgn * 0.17, 0.6, 0.5)
    const elbow = new THREE.Vector3(sgn * 0.2, 0.5, 0.66)
    const hand = new THREE.Vector3(sgn * 0.15, 0.62, 0.86)
    arms.push(capsule(0.04, shoulder.distanceTo(elbow) - 0.04, shoulder, elbow))
    arms.push(capsule(0.035, elbow.distanceTo(hand) - 0.035, elbow, hand))
    const glove = new THREE.SphereGeometry(0.045, 8, 6)
    glove.translate(hand.x, hand.y, hand.z)
    arms.push(glove)
  }

  cached = {
    body: mergeGeometries(body.map(strip), false)!,
    arms: mergeGeometries(arms.map(strip), false)!,
    wheel: strip(rim),
    wheelFace: strip(face),
    wheelPivot,
    wheelAxis,
  }
  return cached
}

function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name)
  }
  if (!out.attributes.normal) out.computeVertexNormals()
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position!.count * 2), 2))
  return out
}
