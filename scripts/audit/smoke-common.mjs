/**
 * What every I-phase smoke (pit / paddock / ops / trackside / infield) checks before its own
 * facts (dev-only helpers — not part of `pnpm check`):
 *
 *  - no deferred far-field job failed (`farField.stats().failed === 0`);
 *  - every `ops-*` / `infield-*` object (the I-phase entries under env.group and the far-field
 *    group) has finite vertices, and every instance / mesh it draws stands inside the circuit
 *    ring 775428456 (ring.mjs `insideRing`);
 *  - the builder's `buildMs.<key>` is finite where the key exists (the umbrella of I0-a reports
 *    pitLane / paddock / ops / trackside / infield; a key not built yet is only noted).
 *
 *   import { commonChecks, smokeArgs, finiteVertices, trisOf } from './smoke-common.mjs'
 */
import { THREE } from './app-runtime.mjs'
import { circuitRing, insideRing } from './ring.mjs'

/** `--tier high|low|both` (default both) and the failure counter every smoke shares */
export function smokeArgs(name) {
  const args = process.argv.slice(2)
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
  const tierArg = flag('--tier', 'both')
  const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]
  const state = { failures: 0 }
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) state.failures++ }
  const finish = () => {
    console.log(state.failures ? `\n${name}: ${state.failures} failure(s)` : `\n${name}: ok`)
    process.exit(state.failures ? 1 : 0)
  }
  return { args, flag, tiers, check, finish, glb: args.includes('--glb') }
}

export const fmt = (n) => Number(n).toLocaleString('en-US')

export const trisOf = (mesh) => {
  const g = mesh.geometry
  const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
  return Math.floor(n / 3) * (mesh.isInstancedMesh ? mesh.count : 1)
}

export const finiteVertices = (meshes) => {
  let nan = 0, vertices = 0
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    if (!p) continue
    vertices += p.count
    for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) nan++
  }
  return { nan, vertices }
}

/** the I-phase roots: objects named `ops-…` / `infield-…` directly under env.group or the far-field group */
export function infieldRoots(env, prefix = /^(ops|infield)-/) {
  const roots = []
  for (const parent of [env.group, env.farField?.group].filter(Boolean)) for (const o of parent.children) if (prefix.test(o.name ?? '')) roots.push(o)
  return roots
}

/** every mesh / InstancedMesh under the roots */
export function meshesUnder(roots) {
  const out = []
  for (const r of roots) r.traverse((o) => { if (o.isMesh || o.isInstancedMesh) out.push(o) })
  return out
}

/**
 * Where each drawn thing stands, world XZ: every instance of an InstancedMesh (its matrix's
 * translation, through the mesh's world matrix) and the bounding-box centre of a plain Mesh.
 */
export function standPoints(meshes) {
  const pts = []
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3()
  for (const m of meshes) {
    m.updateWorldMatrix(true, false)
    if (m.isInstancedMesh) {
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, m4)
        m4.premultiply(m.matrixWorld)
        v.setFromMatrixPosition(m4)
        pts.push([v.x, v.z, `${m.name}[${i}]`])
      }
    } else {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const bb = m.geometry.boundingBox
      if (!bb) continue
      v.addVectors(bb.min, bb.max).multiplyScalar(0.5).applyMatrix4(m.matrixWorld)
      pts.push([v.x, v.z, m.name])
    }
  }
  return pts
}

/**
 * The common block: far-field failures, the I-phase roots' vertices and ring test, buildMs keys.
 * Returns the roots so the caller can go on with its own facts.
 */
export async function commonChecks(scene, check, { buildKeys = [], rootPrefix } = {}) {
  const { env } = scene
  const ff = env.farField
  const stats = ff.stats()
  check(stats.failed === 0, `no deferred job failed (${stats.failed})`)
  await circuitRing()
  const roots = infieldRoots(env, rootPrefix)
  const meshes = meshesUnder(roots)
  const fv = finiteVertices(meshes)
  check(fv.nan === 0, `ops-* / infield-* roots: ${roots.length}, ${meshes.length} meshes, ${fmt(fv.vertices)} vertices, no NaN / infinite (${fv.nan})`)
  const pts = standPoints(meshes)
  const outside = pts.filter(([x, z]) => !insideRing(x, z))
  check(outside.length === 0, `every ops-* / infield-* instance inside the circuit ring (${fmt(pts.length)} points, ${outside.length} outside${outside.length ? `: ${outside.slice(0, 3).map((p) => p[2]).join(', ')}` : ''})`)
  const buildMs = env.buildMs ?? {}
  for (const k of buildKeys) {
    if (k in buildMs) check(Number.isFinite(buildMs[k]), `buildMs.${k} = ${Number(buildMs[k]).toFixed(0)} ms`)
    else console.log(`  note buildMs.${k} not reported yet (the builder is not built)`)
  }
  return { roots, meshes, stats }
}
