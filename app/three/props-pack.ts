import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import { modelPrototype, type ModelProtoOptions } from './model-proto'
import { orientPack } from './road-furniture'

/**
 * Prop prototypes for the infield (plan I0-a): the one shape every I-phase builder instances —
 * a pit-lane tyre stack, a transporter, a marshal cabin, a TV tower, a cone — whether it came
 * from the pack (`packProp`: a shipped GLB through `modelPrototype`, oriented with
 * road-furniture's `orientPack`, one material per part) or was built here (`procProp`: the
 * procedural stand-in that Node, the low tier and a missing drop always get). A prototype is
 * ONE geometry with groups and a material array, so a set of them draws as one InstancedMesh
 * per prototype and cell (infield-lod.ts `registerPropSet`) with one draw per material.
 *
 * Materials are shared through `PropCache`: one MeshStandardMaterial per texture set
 * (map | normalMap | side | alphaTest) and one per plain colour, so a hundred props from one
 * pack drop share a handful of materials — and, more to the point, a handful of PROGRAMS
 * (three caches a program per distinct material parameter set; a fresh material per prop would
 * not add programs, but sharing keeps the material count and the setup cost flat). No custom
 * `customProgramCacheKey` here: every material is a plain Standard with the map combinations
 * the scene already compiles (plan §横断 7).
 *
 * `glbOr` is the tier switch: the pack prototype as the near level when the tier asks for GLBs
 * and the registry has the drop, else the procedural one — the procedural prototype is what
 * scene-cost and surface-check measure, and the far level behind a GLB near level.
 */

export interface PropProto {
  /** stable name for meshes and stats: the pack key's last segment or the caller's name */
  id: string
  /** non-indexed, metric, base-centred (see `PackPropOptions.origin`); one group per material */
  geometry: THREE.BufferGeometry
  /** one per geometry group */
  materials: THREE.MeshStandardMaterial[]
  /** the bbox: the longer and the shorter horizontal side, the height (m) */
  footprint: { long: number; short: number; height: number }
  triangles: number
  source: 'glb' | 'proc'
}

/** Shared by every infield builder through `ctx.props`: the materials per texture set / colour and the prototypes per pack key. */
export interface PropCache {
  mats: Map<string, THREE.MeshStandardMaterial>
  /** null = the pack has no usable model for that key (looked up once) */
  protos: Map<string, PropProto | null>
}

export function makePropCache(): PropCache {
  return { mats: new Map(), protos: new Map() }
}

/** a plain (untextured) material request */
export interface PlainSpec {
  color: THREE.ColorRepresentation
  roughness?: number
  metalness?: number
  side?: THREE.Side
}

export interface PropMaterialOptions {
  side?: THREE.Side
  /** alpha-tested cutout (nets, foliage): the tier's `cutoutParams` */
  cutout?: { alphaTest: number; alphaToCoverage: boolean }
}

const _c = new THREE.Color()

/**
 * The material for a prototype part: the pack material's maps (map, normalMap) on a fresh
 * Standard, or a plain colour. Memoised in the cache by texture set / colour — the same maps
 * (or the same colour) with the same side and cutout always answer the same material.
 */
export function propMaterial(cache: PropCache, src: THREE.MeshStandardMaterial | PlainSpec | null, opts: PropMaterialOptions = {}): THREE.MeshStandardMaterial {
  const side = opts.side ?? THREE.FrontSide
  const pack = src && (src as THREE.MeshStandardMaterial).isMeshStandardMaterial ? (src as THREE.MeshStandardMaterial) : null
  const plain = src && !pack ? (src as PlainSpec) : null
  const cut = opts.cutout
  let key: string
  if (pack?.map) key = `${pack.map.uuid}|${pack.normalMap?.uuid ?? ''}|${side}|${cut ? cut.alphaTest : ''}`
  else {
    _c.set(plain?.color ?? pack?.color ?? 0x9a9ea2)
    const sd = plain?.side ?? side
    key = `plain:${_c.getHexString()}|${sd}|${plain?.roughness ?? 0.6}|${plain?.metalness ?? 0.2}`
  }
  let mat = cache.mats.get(key)
  if (!mat) {
    if (pack?.map) {
      mat = new THREE.MeshStandardMaterial({ map: pack.map, normalMap: pack.normalMap ?? null, color: 0xffffff, roughness: 0.6, metalness: 0.2, side })
      if (pack.normalMap) mat.normalScale.copy(pack.normalScale)
      if (cut) {
        mat.alphaTest = cut.alphaTest
        mat.alphaToCoverage = cut.alphaToCoverage
      }
    } else {
      mat = new THREE.MeshStandardMaterial({ color: _c.clone(), roughness: plain?.roughness ?? 0.6, metalness: plain?.metalness ?? 0.2, side: plain?.side ?? side })
    }
    cache.mats.set(key, mat)
  }
  return mat
}

export interface PackPropOptions extends Pick<ModelProtoOptions, 'nodes' | 'partOf' | 'scaleTo' | 'forward'> {
  /** prototype id (default: the key's last segment); also the cache key's suffix when one model yields several prototypes */
  id?: string
  /**
   * road-furniture's `orientPack` after the extraction: the PCA yaw puts the long side along
   * local x and this rule turns the FRONT to +z ('none' keeps the PCA sign). Omit to keep
   * `modelPrototype`'s orientation (`forward`).
   */
  front?: 'uvTop' | 'moreArea' | 'none'
  /** where the origin goes after orienting: on the base (default), at the bbox centre, or at the top centre (something hanging) */
  origin?: 'base' | 'centre' | 'top'
  side?: THREE.Side
  cutout?: { alphaTest: number; alphaToCoverage: boolean }
}

/**
 * A shipped GLB as a prototype: `modelPrototype` (nodes / parts / scale / forward), the parts
 * merged into one geometry with a group per part, oriented (`front`), the origin set, one
 * cached material per part. null when the registry has no model for the key or the selection
 * matches nothing — the caller keeps its procedural prototype. Looked up once per key + id.
 */
export function packProp(reg: AssetRegistry | null, cache: PropCache, key: string, opts: PackPropOptions = {}): PropProto | null {
  if (!reg) return null
  const id = opts.id ?? key.slice(key.lastIndexOf('/') + 1)
  const cacheKey = `${key}#${id}`
  const hit = cache.protos.get(cacheKey)
  if (hit !== undefined) return hit
  const proto = modelPrototype(reg, key, { nodes: opts.nodes, partOf: opts.partOf, scaleTo: opts.scaleTo, forward: opts.forward })
  let out: PropProto | null = null
  if (proto) {
    const names = Object.keys(proto.parts)
    const geos = names.map((n) => proto.parts[n]!.geometry)
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, true)
    if (merged) {
      if (geos.length > 1) for (const g of geos) g.dispose()
      if (opts.front !== undefined) orientPack(merged, opts.front)
      merged.computeBoundingBox()
      const b = merged.boundingBox!
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2
      const origin = opts.origin ?? 'base'
      merged.translate(-cx, origin === 'centre' ? -(b.min.y + b.max.y) / 2 : origin === 'top' ? -b.max.y : -b.min.y, -cz)
      merged.computeBoundingBox()
      merged.computeBoundingSphere()
      const bb = merged.boundingBox!
      const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z
      const mats = names.map((n) => propMaterial(cache, proto.parts[n]!.source, { side: opts.side, cutout: opts.cutout }))
      out = { id, geometry: merged, materials: mats, footprint: { long: Math.max(w, d), short: Math.min(w, d), height: bb.max.y - bb.min.y }, triangles: proto.triangles, source: 'glb' }
    }
  }
  cache.protos.set(cacheKey, out)
  return out
}

/**
 * A procedural prototype from parts (one material each): merged into one geometry with a group
 * per part; every part is expected non-indexed with position / normal / uv, base-centred like
 * the pack ones. The footprint is measured unless given.
 */
export function procProp(id: string, parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[], footprint?: PropProto['footprint']): PropProto {
  if (!parts.length) throw new Error(`[props-pack] procProp('${id}'): no parts`)
  const geos = parts.map((p) => (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry))
  const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, true)
  if (!merged) throw new Error(`[props-pack] procProp('${id}'): the parts' attribute sets differ`)
  if (geos.length > 1) for (const g of geos) g.dispose()
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  const b = merged.boundingBox!
  const w = b.max.x - b.min.x, d = b.max.z - b.min.z
  const tris = merged.getAttribute('position').count / 3
  return {
    id,
    geometry: merged,
    materials: parts.map((p) => p.material),
    footprint: footprint ?? { long: Math.max(w, d), short: Math.min(w, d), height: b.max.y - b.min.y },
    triangles: tris,
    source: 'proc',
  }
}

/**
 * The tier switch of a prototype pair: the pack model (`packProp`) when the tier draws GLBs and
 * the registry has the drop, otherwise — and always in Node / on the low tier — the procedural
 * prototype. The near level of a prop set is what this returns; the procedural one stays its
 * far level (infield-lod.ts).
 */
export function glbOr(ctx: Pick<EnvBuildContext, 'assets' | 'quality' | 'props'>, key: string, opts: PackPropOptions, proc: PropProto): PropProto {
  if (!ctx.quality.infield.glb || !ctx.assets) return proc
  return packProp(ctx.assets, ctx.props, key, opts) ?? proc
}
