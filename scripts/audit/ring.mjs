/**
 * The circuit's own ring: OSM leisure=sports_centre 775428456 (SUR_SITES role 'circuit'), the
 * boundary the I phase works inside — decoded once from app/data/suzuka-surroundings.ts through
 * en-codec's `worldRing` (× enScale, z = −N) and tested even–odd.
 *
 *   import { insideRing, circuitRing } from './ring.mjs'
 *   const ring = await circuitRing()   // decodes once; the [x, z] vertices (world)
 *   insideRing(x, z)                   // world XZ inside the boundary (sync, after the await)
 *
 * Node-only (facilities-check §16 and the *-smoke scripts); the runtime twin is
 * app/three/infield-lod.ts `insideRing` (I0-a) — keep the two in step, this one exists so the
 * data-only guard does not import a three.js module.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import '../ts-hooks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const CIRCUIT_RING_WAY = 775428456

let ring = null
let box = null

async function load() {
  if (ring) return
  const sur = await import(path.join(ROOT, 'app/data/suzuka-surroundings.ts'))
  const codec = await import(path.join(ROOT, 'app/data/en-codec.ts'))
  const { Track } = await import(path.join(ROOT, 'app/sim/track.ts'))
  const enScale = new Track().enScale
  const site = sur.SUR_SITES.find((s) => s.id === CIRCUIT_RING_WAY && s.role === 'circuit')
  if (!site) throw new Error(`ring.mjs: SUR_SITES has no circuit boundary ${CIRCUIT_RING_WAY}`)
  const flat = codec.worldRing(site, enScale)
  ring = []
  for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]])
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const [x, z] of ring) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  box = [x0, z0, x1, z1]
}

/** decode the boundary (once) and return its vertices in world XZ, [x, z] pairs (no repeated closing vertex) */
export async function circuitRing() {
  await load()
  return ring
}

/** true when world (x, z) lies inside the circuit boundary (even–odd, bbox pre-test); `await circuitRing()` first */
export function insideRing(x, z) {
  if (!ring) throw new Error('ring.mjs: await circuitRing() before insideRing()')
  if (x < box[0] || x > box[2] || z < box[1] || z > box[3]) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]
    const [xj, zj] = ring[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
