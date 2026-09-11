import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { AssetRegistry } from './assets'

/**
 * A shipped GLB turned into instancing prototypes: every mesh primitive of the model (or of the
 * nodes a regex selects) is split by material, widened from the pack's quantised attributes,
 * baked through its node transform, made non-indexed and merged per PART — the caller names the
 * parts from the material / mesh / node path (leaf vs bark, glass vs body, sign face vs post),
 * so each part can be drawn with its own material as one InstancedMesh. The merged model is
 * then put at metric scale (the packs ship in assorted units) with a base-centred origin, so a
 * placement matrix is a position, a yaw and a scale. The forest's hero trees, the hero houses,
 * the road signs, the utility boxes and the GLB car bodies all come through here.
 *
 * Why the widening: gltfpack quantises (KHR_mesh_quantization — int16 positions, int8 normals /
 * uvs), and three keeps the attributes as normalised integer arrays. `applyMatrix4` on those
 * would truncate the baked transform, and `mergeGeometries` refuses to merge an int16 buffer
 * with a float one, so every attribute the prototype keeps is copied into a Float32 attribute
 * first (the getters apply the normalisation). Tangents and the second uv set are dropped.
 *
 * Why the group split: a multi-material mesh draws its geometry groups with different
 * materials, and the part of a primitive is decided by its material, so each group becomes its
 * own geometry before the parts are merged.
 */

export interface ProtoPart {
  /** non-indexed, world-baked, scaled and recentred; position / normal / uv (+ `keepColor`) */
  geometry: THREE.BufferGeometry
  /** the first material of the pack for this part when it is a MeshStandardMaterial (its maps / colour), else null */
  source: THREE.MeshStandardMaterial | null
  triangles: number
}

export interface ModelProtoOptions {
  /** only meshes whose node path (names of the node and its ancestors below the scene root joined by '/') matches */
  nodes?: RegExp
  /** part name of a mesh (default: 'main'); e.g. leaf vs bark by material name */
  partOf?: (material: THREE.Material, mesh: THREE.Mesh, path: string) => string
  /** uniform scale so the merged bbox height / long side becomes this (metres); both given: the smaller factor (the model fits both) */
  scaleTo?: { height?: number; long?: number }
  /** rotate about Y so the bbox's long horizontal axis lies along local +x (or the given sign / z) */
  forward?: 'x' | '-x' | 'z' | '-z'
  /** copy the glTF vertex `color` attribute into an attribute of this name (widened to float; white where a mesh has none) */
  keepColor?: string
  /** recentre: 'base' (xz centre of the given part or the whole, min y at 0 — default) */
  origin?: { part?: string }
}

export interface ModelProto {
  parts: Record<string, ProtoPart>
  /** the merged bbox after scaling: the longer and the shorter horizontal side, the height (m) */
  footprint: { long: number; short: number; height: number }
  triangles: number
}

/** widen a quantised attribute (KHR_mesh_quantization int16 / int8) to floats, so the node transform does not truncate it */
function widened(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.Float32BufferAttribute {
  const f = new THREE.Float32BufferAttribute(a.count * size, size)
  for (let i = 0; i < a.count; i++) {
    if (size === 2) f.setXY(i, a.getX(i), a.getY(i))
    else if (size === 3) f.setXYZ(i, a.getX(i), a.getY(i), a.getZ(i))
    else f.setXYZW(i, a.getX(i), a.getY(i), a.getZ(i), a.itemSize >= 4 ? a.getW(i) : 1)
  }
  return f
}

/** names of the node and its ancestors below the scene root, root-most first, joined by '/' */
function nodePath(o: THREE.Object3D, root: THREE.Object3D): string {
  const names: string[] = []
  for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) names.push(n.name)
  return names.reverse().join('/')
}

/**
 * Extract the prototype of `reg.model(key)` (see the module comment). null when the model is
 * not in the registry, matches no mesh, or has no height — the caller falls back to its
 * procedural stand-in.
 */
export function modelPrototype(reg: AssetRegistry, key: string, opts: ModelProtoOptions = {}): ModelProto | null {
  const m = reg.model(key)
  if (!m) return null
  m.scene.updateMatrixWorld(true)
  const pieces = new Map<string, { geos: THREE.BufferGeometry[]; source: THREE.Material | null }>()
  const bbox = new THREE.Box3()
  const nodes = opts.nodes
  const keepColor = opts.keepColor
  m.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const path = nodePath(mesh, m.scene)
    if (nodes) {
      nodes.lastIndex = 0
      if (!nodes.test(path)) return
    }
    const src = mesh.geometry
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    // a multi-material mesh draws its groups with different materials; split by group
    const groups = src.groups.length ? src.groups : [{ start: 0, count: src.index ? src.index.count : src.attributes.position!.count, materialIndex: 0 }]
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] ?? mats[0]!
      const g = new THREE.BufferGeometry()
      for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
        const a = src.getAttribute(name)
        if (a) g.setAttribute(name, widened(a, size))
      }
      const count = g.getAttribute('position')!.count
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(count * 2, 2))
      if (keepColor) {
        const c = src.getAttribute('color')
        g.setAttribute(keepColor, c ? widened(c, 4) : new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(1), 4))
      }
      const idx = src.index
      if (idx) {
        const end = Math.min(idx.count, grp.start + grp.count)
        const sub: number[] = []
        for (let i = grp.start; i < end; i++) sub.push(idx.getX(i))
        g.setIndex(sub)
      } else if (grp.start > 0 || grp.count < count) {
        const sub: number[] = []
        for (let i = grp.start; i < grp.start + grp.count; i++) sub.push(i)
        g.setIndex(sub)
      }
      g.applyMatrix4(mesh.matrixWorld)
      const part = g.index ? g.toNonIndexed() : g
      // a pack without normals (rare) gets flat ones, so the merge below has the same attributes on every piece
      if (!part.getAttribute('normal')) part.computeVertexNormals()
      part.computeBoundingBox()
      bbox.union(part.boundingBox!)
      const name = opts.partOf ? opts.partOf(mat, mesh, path) : 'main'
      let piece = pieces.get(name)
      if (!piece) pieces.set(name, (piece = { geos: [], source: null }))
      piece.geos.push(part)
      piece.source ??= mat
    }
  })
  if (!pieces.size) return null

  // the long horizontal axis along the asked direction: a quarter turn when it lies along the
  // other axis, a half turn more for the negative sign (the bbox cannot tell front from back;
  // the caller looked at the model)
  if (opts.forward) {
    const w = bbox.max.x - bbox.min.x, d = bbox.max.z - bbox.min.z
    const wantX = opts.forward === 'x' || opts.forward === '-x'
    let angle = (wantX ? d > w : w > d) ? Math.PI / 2 : 0
    if (opts.forward.startsWith('-')) angle += Math.PI
    if (angle) {
      bbox.makeEmpty()
      for (const piece of pieces.values()) {
        for (const g of piece.geos) {
          g.rotateY(angle)
          g.computeBoundingBox()
          bbox.union(g.boundingBox!)
        }
      }
    }
  }

  const height = bbox.max.y - bbox.min.y
  if (!(height > 0)) return null
  const w = bbox.max.x - bbox.min.x, d = bbox.max.z - bbox.min.z
  const long = Math.max(w, d), short = Math.min(w, d)
  let k = Infinity
  if (opts.scaleTo?.height !== undefined) k = Math.min(k, opts.scaleTo.height / height)
  if (opts.scaleTo?.long !== undefined && long > 0) k = Math.min(k, opts.scaleTo.long / long)
  if (!Number.isFinite(k)) k = 1

  // the origin: the xz centre of the named part's bbox (the trunk, not the crown that leans
  // over it) or of the whole, the lowest vertex at y = 0
  let base = bbox
  const originPart = opts.origin?.part !== undefined ? pieces.get(opts.origin.part) : undefined
  if (originPart) {
    const b = new THREE.Box3()
    for (const g of originPart.geos) b.union(g.boundingBox!)
    if (!b.isEmpty()) base = b
  }
  const cx = (base.min.x + base.max.x) / 2, cz = (base.min.z + base.max.z) / 2

  const parts: Record<string, ProtoPart> = {}
  let triangles = 0
  for (const [name, piece] of pieces) {
    const merged = mergeGeometries(piece.geos, false)
    for (const g of piece.geos) g.dispose()
    if (!merged) continue
    merged.translate(-cx, -bbox.min.y, -cz)
    merged.scale(k, k, k)
    merged.computeBoundingSphere()
    const src = piece.source
    const source = src && (src as THREE.MeshStandardMaterial).isMeshStandardMaterial ? (src as THREE.MeshStandardMaterial) : null
    const tris = merged.getAttribute('position').count / 3
    parts[name] = { geometry: merged, source, triangles: tris }
    triangles += tris
  }
  if (!Object.keys(parts).length) return null
  return { parts, footprint: { long: long * k, short: short * k, height: height * k }, triangles }
}
