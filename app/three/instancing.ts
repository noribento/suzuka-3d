import * as THREE from 'three'

export interface BucketOptions {
  castShadow?: boolean
  receiveShadow?: boolean
  name?: string
}

/**
 * Split one circuit-wide set of instances into several InstancedMeshes, one per spatial bucket,
 * so the camera (and the shadow cameras) can frustum-cull whole groups instead of always
 * drawing every tree / post around the lap. Placement order is preserved inside each bucket.
 */
export function bucketedInstancedMeshes(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  colors: THREE.Color[] | null,
  bucketOf: (index: number, matrix: THREE.Matrix4) => number,
  opts: BucketOptions = {},
): THREE.InstancedMesh[] {
  const groups = new Map<number, number[]>()
  matrices.forEach((m, i) => {
    const b = bucketOf(i, m)
    let list = groups.get(b)
    if (!list) groups.set(b, (list = []))
    list.push(i)
  })
  const out: THREE.InstancedMesh[] = []
  for (const [b, list] of groups) {
    const inst = new THREE.InstancedMesh(geometry, material, list.length)
    list.forEach((i, k) => {
      inst.setMatrixAt(k, matrices[i]!)
      if (colors) inst.setColorAt(k, colors[i]!)
    })
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    inst.castShadow = opts.castShadow ?? false
    inst.receiveShadow = opts.receiveShadow ?? false
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    inst.name = `${opts.name ?? 'bucket'}-${b}`
    out.push(inst)
  }
  return out
}

/**
 * Freeze the transforms of everything static under `root` (after computing them once) so the
 * renderer stops re-deriving ~1 400 matrices per frame. Subtrees in `skip` (moving parts such
 * as the Ferris wheel) keep updating; their ancestors up to `root` stay live as well.
 */
export function freezeStatic(root: THREE.Object3D, skip: THREE.Object3D[] = []) {
  root.updateMatrixWorld(true)
  const live = new Set<THREE.Object3D>()
  for (const s of skip) {
    let o: THREE.Object3D | null = s
    while (o && o !== root) {
      live.add(o)
      o = o.parent
    }
  }
  const walk = (o: THREE.Object3D) => {
    if (skip.includes(o)) return
    if (o !== root && !live.has(o)) {
      o.matrixAutoUpdate = false
      o.matrixWorldAutoUpdate = false
    }
    for (const c of o.children) walk(c)
  }
  walk(root)
}
