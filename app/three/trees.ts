import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { TREE_CARD_ROW_HEIGHT_M, TREE_LAYOUT } from '~/data/impostor-atlas'
import { TREE_SPECIES, type TreeRole, type TreeSpecies, type TreeVariant } from '~/data/tree-species'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import type { FarLevel } from './farfield'
import { IMPOSTOR_ATTRIBUTES, impostorGeometry, impostorMaterial } from './impostor'
import { cutoutParams } from './materials'
import { modelPrototype } from './model-proto'
import type { Quality } from './quality'
import { treePrototype } from './vegetation'

/**
 * The tree library (plan R フェーズ Phase 2): one place that turns the species table
 * (~/data/tree-species.ts) into drawable prototypes and draws a list of placements as the
 * far-field entries of one cell. The placers (vegetation.ts for the trackside scatter,
 * forest.ts for the woods, hedges, bamboo and the cherry rows) only decide WHERE a tree of
 * WHICH role stands; everything about how it looks — pack meshes, LODs, materials, wind,
 * impostor cards, the cone stand-in — lives here.
 *
 * Prototypes: every species variant is three LOD meshes cut out of a Sketchfab pack GLB by
 * node-path regex (`modelPrototype`), bark and foliage told apart by material name, merged into
 * ONE geometry with two groups so a level is one InstancedMesh with a [bark, foliage] material
 * array (one object for the registry, two draws). Each LOD is normalised to height 1 by LOD0's
 * bbox (the three share the scale, so a placement's uniform scale IS its height in metres).
 *
 * Materials: one bark material per pack texture set, one foliage material per (texture set,
 * species sway) — every material is a separate program only when its map combination differs,
 * so all packs share the two programs `tree|bark` / `tree|foliage` (plus the cherry's map-only
 * variants). The foliage carries the wind (vertex), the back-light translucency (fragment) and
 * the per-instance tint (three's `instanceColor`, which the bark material deliberately ignores
 * so a species tone never discolours the trunks). The pack MRAO maps are not bound: each map
 * combination is another program, and bark roughness variation is invisible at tree distances.
 *
 * LOD (ranges from `Quality.farField.trees.lodM`, before lodScale): a hero (the stems nearest
 * the track, `heroPerCell`) draws LOD0 inside lodM[0] and LOD1 to lodM[1]; a plain tree LOD1
 * inside lodM[0] and LOD2 to lodM[1]; beyond that every tree of the cell is one impostor card
 * (`tex/tree_atlas`, one atlas row per species) up to `EmitOptions.cardsRange`, and the forest's
 * canopy mass takes over from there. Without the atlas (not yet baked, or `trees.cards` off)
 * the card level is the tinted cone stand-in instead, so no tree ever vanishes between the mesh
 * range and the mass.
 *
 * Shadows: a mesh level casts (bark and cutout foliage together — an InstancedMesh with a
 * material array casts as a whole, three's depth pass honours each material's alphaTest) when
 * `EmitOptions.castShadow`, the species casts and the level's range is at most
 * `trees.leafShadowM`; beyond that the level casts nothing — a bare trunk shadow under an
 * unshadowed crown reads worse than no shadow. Cards and cones only receive.
 *
 * Fallback: with no asset pack (Node, the low tier, `?assets=0`) or with `lodM = [0, 0]` the
 * library is in 'cone' mode and every placement is the procedural stem of vegetation.ts
 * (`treePrototype(kind, 'mid')`) tinted around the species' crown colour — the same buckets the
 * forest drew before, so scene-cost and surface-check see nothing new.
 *
 * Nothing here samples the terrain: the placements arrive with their stand height.
 */

export interface TreeGeo {
  /** groups: 0 = bark, 1 = foliage */
  geometry: THREE.BufferGeometry
  materials: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial]
  triangles: number
}

export interface TreeProto {
  species: TreeSpecies
  variant: number
  /** LOD0 / LOD1 / LOD2, each at natural height 1 (the placement scales to species.height) */
  lods: [TreeGeo, TreeGeo, TreeGeo]
}

export interface TreeLibrary {
  /** prototypes per role; a role with none falls back to the cones */
  protos: Partial<Record<TreeRole, TreeProto[]>>
  /** 'pack' when at least one role has prototypes (the high tier with the pack), else 'cone' (Node / low tier / assets off) */
  mode: 'pack' | 'cone'
  /** the impostor card (tex/tree_atlas) — null without the atlas or when Quality.farField.trees.cards is false */
  card: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } | null
  /** the foliage / card animation clock (s) and the wind strength 0–1, ticked by `tickTrees` */
  time: { value: number }
  wind: { value: number }
  hasRole(role: TreeRole): boolean
}

export interface TreePlacement {
  role: TreeRole
  x: number
  y: number
  z: number
  /** yaw about Y (rad) */
  yaw: number
  /** metres: the tree's height (picked in species.height) */
  height: number
  /** albedo multiplier (species.tint sampled) */
  tint: THREE.Color
  /** heroes get LOD0 inside lodM[0]; plain trees LOD1 */
  hero: boolean
  /** deterministic variant / card pick */
  seed: number
}

export interface EmitOptions {
  /** the cards' outer range and ramp (m, before lodScale); Infinity for the trackside scatter */
  cardsRange: number
  cardsRamp?: number
  castShadow: boolean
}

export interface EmitCounts {
  entries: number
  /** triangles of the nearest mesh level of every tree (what the cell costs with the camera inside it), cones included */
  triangles: number
  cards: number
  cones: number
}

/** what emitTrees needs beyond the public library: the tier, the card's camera uniform, the cone stand-ins */
interface Internals {
  q: Quality
  camPos: { value: THREE.Vector3 }
  cone: {
    geometry: Record<TreeSpecies['cone'], THREE.BufferGeometry>
    /** natural height (m) of each cone prototype, so a placement's height scales it */
    height: Record<TreeSpecies['cone'], number>
    material: THREE.MeshStandardMaterial
  }
}

const INTERNALS = new WeakMap<TreeLibrary, Internals>()

/** at most this many variants of one role per cell — every variant is its own InstancedMesh (two draws) */
const VARIANTS_PER_CELL = 3
/**
 * A pack LOD0 above this many triangles is not used: the variant's heroes draw its LOD1 instead
 * (the oak pack's Large trees are 19–38 k at LOD0; 24 heroes of those in one cell would be
 * 0.9 M triangles for the nearest 60 m, where the pines' 12 k already read as full trees).
 */
const HERO_LOD0_MAX_TRIS = 16000
/** the sway amplitude (m at the top of a 1 m tree, per unit of species.wind × uWind) */
const SWAY_M = 0.35
/** the back-light term: how much of the albedo leaks through a leaf lit from behind */
const TRANSLUCENCY = 0.25
/** the prevailing late-March wind at Suzuka: from the north-west, so it blows towards +E / +z (south-east) */
const WIND_DIR_GLSL = 'vec3(0.7071, 0.0, 0.7071)'

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const Y_UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------------------------------------
// deterministic picks

/** 32 bits out of a placement seed — a float in [0, 1) or an integer, either way stable */
function hashU(seed: number): number {
  let h = ((seed * 1e6) | 0) ^ Math.imul(seed | 0, 0x27d4eb2d)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Weighted role pick, `r` in [0, 1); the weights need not sum to 1. */
export function pickRole(mix: Partial<Record<TreeRole, number>>, r: number): TreeRole {
  const entries = Object.entries(mix) as [TreeRole, number][]
  let total = 0
  for (const [, w] of entries) total += Math.max(0, w)
  if (!entries.length || total <= 0) throw new Error('[trees] pickRole: empty mix')
  let acc = 0
  for (const [role, w] of entries) {
    acc += Math.max(0, w) / total
    if (r < acc) return role
  }
  return entries[entries.length - 1]![0]
}

/** The species' albedo multiplier sampled per channel from three uniform draws in [0, 1). */
export function pickTint(species: TreeSpecies, r1: number, r2: number, r3: number): THREE.Color {
  const [r, g, b] = species.tint
  return new THREE.Color(r[0] + r1 * (r[1] - r[0]), g[0] + r2 * (g[1] - g[0]), b[0] + r3 * (b[1] - b[0]))
}

/** A height (m) in the species' range from one uniform draw in [0, 1). */
export function pickHeight(species: TreeSpecies, r: number): number {
  return species.height[0] + r * (species.height[1] - species.height[0])
}

/** Advance the foliage / card clock and set the wind strength (0–1); the viewport calls it per frame. */
export function tickTrees(lib: TreeLibrary, dt: number, wind: number) {
  lib.time.value += dt
  lib.wind.value = wind
}

// ---------------------------------------------------------------------------------------------
// materials

interface Uniforms {
  time: { value: number }
  wind: { value: number }
}

/**
 * The bark of one pack texture set: the pack's albedo and normal map, flat roughness. The
 * per-instance tint (instanceColor, enabled by the InstancedMesh) is the foliage's — the bark
 * drops three's colour multiply so a sakura pink or a warmed sugi never stains the trunk.
 */
function barkMaterial(src: THREE.MeshStandardMaterial | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: src?.color.clone() ?? new THREE.Color(0x4a3a2a),
    map: src?.map ?? null,
    normalMap: src?.normalMap ?? null,
    roughness: 0.9,
    metalness: 0,
    side: src?.side ?? THREE.FrontSide,
  })
  if (src?.normalMap) m.normalScale.copy(src.normalScale)
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '// the per-instance tint (instanceColor) is the foliage\'s: the bark keeps the pack albedo')
  }
  m.customProgramCacheKey = () => 'tree|bark'
  m.userData.tree = true
  return m
}

/**
 * The foliage of one pack texture set at one species sway: a cutout (the tier's alphaTest /
 * alpha-to-coverage, never a blend — blended leaves sort wrongly between instances), double
 * sided, with three shader patches:
 *  - wind (vertex, object space, before the instance transform): the sway grows with the square
 *    of the vertex height in the normalised model (height 1, so it is scale independent and a
 *    taller tree sways more metres), two sines on a phase from the instance origin so neighbours
 *    are out of step, along the prevailing wind turned into the instance's frame;
 *  - translucency (fragment, after the direct lights): light from behind the leaf leaks a share
 *    of the albedo towards the camera — the glow of a backlit crown against the sun;
 *  - tint: three's own instanceColor multiply (color_vertex / color_fragment), enabled by
 *    `setColorAt`; the values are multipliers around 1 (Float32, so > 1 is fine).
 * The shadow pass is three's depth material, which copies map + alphaTest: leaf shadows are
 * cutouts, and follow the InstancedMesh's castShadow flag (see the module comment). It has no
 * wind patch, so a crown's shadow stands still while the crown sways — a swaying shadow would
 * need a custom depth material per foliage material for a motion nobody reads on the ground.
 */
function foliageMaterial(src: THREE.MeshStandardMaterial, q: Quality, sway: number, u: Uniforms): THREE.MeshStandardMaterial {
  const cut = cutoutParams(q)
  const m = new THREE.MeshStandardMaterial({
    color: src.color.clone(),
    map: src.map,
    normalMap: src.normalMap,
    alphaMap: src.alphaMap,
    side: THREE.DoubleSide,
    alphaTest: cut.alphaTest,
    alphaToCoverage: cut.alphaToCoverage,
    transparent: false,
    roughness: 0.85,
    metalness: 0,
  })
  if (src.normalMap) m.normalScale.copy(src.normalScale)
  const uSway = { value: sway * SWAY_M }
  const uTranslucency = { value: TRANSLUCENCY }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.time
    shader.uniforms.uWind = u.wind
    shader.uniforms.uSway = uSway
    shader.uniforms.uTranslucency = uTranslucency
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWind;
        uniform float uSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          // the world wind in the instance's frame: the columns of the yaw × scale matrix are the
          // object axes in world space, so dot() projects (the uniform scale cancels in normalize)
          mat3 im = mat3(instanceMatrix);
          vec2 wd = normalize(vec2(dot(im[0], ${WIND_DIR_GLSL}), dot(im[2], ${WIND_DIR_GLSL})) + vec2(1e-4, 0.0));
          vec3 io = (modelMatrix * instanceMatrix)[3].xyz;
          float phase = dot(io.xz, vec2(0.173, 0.291));
          float g = clamp(position.y, 0.0, 1.5);
          g *= g;
          float sway = 0.6 * sin(1.1 * uTime + phase) + 0.25 * sin(2.7 * uTime + 1.9 * phase);
          transformed.xz += wd * (uWind * uSway * g * sway);
        }
        #endif`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTranslucency;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {
          // directionalLights[0].direction points TOWARDS the sun (view space); vViewPosition
          // points towards the camera: both aligned against each other = the sun behind the leaf
          vec3 toCam = normalize(vViewPosition);
          float back = pow(clamp(dot(-toCam, directionalLights[0].direction), 0.0, 1.0), 4.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * uTranslucency * back * directionalLights[0].color;
        }
        #endif`)
  }
  m.customProgramCacheKey = () => 'tree|foliage'
  m.userData.tree = true
  return m
}

/** the identity of a pack texture set: the maps, not the material object (GLTFLoader clones materials per primitive flags) */
function textureSetKey(src: THREE.MeshStandardMaterial | null): string {
  return `${src?.map?.uuid ?? '-'}|${src?.normalMap?.uuid ?? '-'}|${src?.alphaMap?.uuid ?? '-'}`
}

// ---------------------------------------------------------------------------------------------
// prototypes

interface MaterialCache {
  bark: Map<string, THREE.MeshStandardMaterial>
  foliage: Map<string, THREE.MeshStandardMaterial>
}

/**
 * One LOD of one variant: the pack's meshes under the node path the species regex selects,
 * bark and foliage split by material name (`species.leafRe`), both non-indexed with position /
 * normal / uv, world-baked, the trunk base at the origin. null when the GLB is not in the
 * registry, the regex matches nothing, or the foliage part is empty (a crownless tree is a
 * regex mistake) — the variant is then skipped. A missing bark part is allowed: the bush pack's
 * small bushes are foliage only.
 */
function lodParts(reg: AssetRegistry, species: TreeSpecies, lod: { key: string; nodes: RegExp }): { bark: THREE.BufferGeometry | null; leaf: THREE.BufferGeometry; barkSrc: THREE.MeshStandardMaterial | null; leafSrc: THREE.MeshStandardMaterial | null; height: number } | null {
  const proto = modelPrototype(reg, lod.key, {
    nodes: lod.nodes,
    partOf: (m) => (species.leafRe.test(m.name) ? 'leaf' : 'bark'),
    origin: { part: 'bark' },
  })
  if (!proto) return null
  const bark = proto.parts.bark ?? null, leaf = proto.parts.leaf
  if (!leaf) {
    for (const p of Object.values(proto.parts)) p.geometry.dispose()
    return null
  }
  return { bark: bark?.geometry ?? null, leaf: leaf.geometry, barkSrc: bark?.source ?? null, leafSrc: leaf.source, height: proto.footprint.height }
}

/** bark + foliage as one geometry with two groups (0 = bark, 1 = foliage; an absent bark is an empty group), scaled by `k`, the parts released */
function twoGroups(bark: THREE.BufferGeometry | null, leaf: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  leaf.scale(k, k, k)
  if (!bark) {
    leaf.clearGroups()
    leaf.addGroup(0, 0, 0)
    leaf.addGroup(0, leaf.getAttribute('position').count, 1)
    leaf.computeBoundingSphere()
    return leaf
  }
  bark.scale(k, k, k)
  const merged = mergeGeometries([bark, leaf], true)
  bark.dispose()
  leaf.dispose()
  if (!merged) throw new Error('[trees] bark and foliage geometries differ in attributes')
  merged.computeBoundingSphere()
  return merged
}

/**
 * The three LODs of one pack variant, normalised to height 1 by LOD0's bbox height (one scale
 * for all three, so the switch does not resize the tree), each with its pack's shared bark and
 * foliage materials. A species whose LOD2 is null reuses LOD1. null when any LOD is missing.
 */
function packPrototype(reg: AssetRegistry, species: TreeSpecies, variant: TreeVariant, index: number, q: Quality, u: Uniforms, cache: MaterialCache): TreeProto | null {
  const lods: TreeGeo[] = []
  let k = 0
  for (let i = 0; i < 3; i++) {
    const lod = variant.lods[i]
    if (lod === null || lod === undefined) {
      const prev = lods[i - 1]
      if (!prev) return null
      lods.push(prev)
      continue
    }
    const parts = lodParts(reg, species, lod)
    if (!parts) {
      for (const g of new Set(lods)) g.geometry.dispose()
      return null
    }
    if (i === 0) {
      if (!(parts.height > 0)) return null
      k = 1 / parts.height
    }
    const barkKey = textureSetKey(parts.barkSrc)
    let bark = cache.bark.get(barkKey)
    if (!bark) cache.bark.set(barkKey, (bark = barkMaterial(parts.barkSrc)))
    const leafSrc = parts.leafSrc ?? new THREE.MeshStandardMaterial({ color: species.crown })
    const leafKey = `${textureSetKey(leafSrc)}|${species.wind}`
    let foliage = cache.foliage.get(leafKey)
    if (!foliage) cache.foliage.set(leafKey, (foliage = foliageMaterial(leafSrc, q, species.wind, u)))
    const geometry = twoGroups(parts.bark, parts.leaf, k)
    lods.push({ geometry, materials: [bark, foliage], triangles: geometry.getAttribute('position').count / 3 })
  }
  if (lods[0]!.triangles > HERO_LOD0_MAX_TRIS && lods[1] !== lods[0]) {
    lods[0]!.geometry.dispose()
    lods[0] = lods[1]!
  }
  return { species, variant: index, lods: lods as [TreeGeo, TreeGeo, TreeGeo] }
}

/**
 * The impostor card material: `tex/tree_atlas` through the shared impostor shader with two
 * pitch bands (the 10° and 45° cameras of the bake), the 'body' mask mode (mask R = foliage, so
 * aTint0 tints the crown and leaves the trunk), a gentle sway on the card clock.
 */
function treeCardMaterial(map: THREE.Texture, mask: THREE.Texture, q: Quality, u: Uniforms, camPos: { value: THREE.Vector3 }): THREE.MeshStandardMaterial {
  const m = impostorMaterial({ map, mask }, TREE_LAYOUT, {
    pitchBands: 2, cheer: false, sway: 0.12, maskMode: 'body', cutout: cutoutParams(q), cacheKey: 'impostor|tree', time: u.time, camPos, roughness: 0.9, normal: [0, 1, 0.3],
  })
  m.userData.tree = true
  return m
}

/**
 * Build the library for this scene: the pack prototypes and their materials (synchronously, so
 * the viewport's material setup covers them), the card material, the cone stand-ins. In Node,
 * on the low tier, without the pack or with `lodM = [0, 0]` no prototype is extracted and the
 * library is in 'cone' mode.
 */
export function buildTreeLibrary(ctx: EnvBuildContext): TreeLibrary {
  const { assets, quality: q } = ctx
  const t = q.farField.trees
  const u: Uniforms = { time: { value: 0 }, wind: { value: 0.5 } }
  const camPos = { value: new THREE.Vector3() }
  const protos: Partial<Record<TreeRole, TreeProto[]>> = {}
  if (assets && t.lodM[1] > 0) {
    const cache: MaterialCache = { bark: new Map(), foliage: new Map() }
    for (const species of Object.values(TREE_SPECIES)) {
      const list: TreeProto[] = []
      species.variants.forEach((v, i) => {
        const p = packPrototype(assets, species, v, i, q, u, cache)
        if (p) list.push(p)
      })
      if (list.length) protos[species.role] = list
    }
  }
  const mode: TreeLibrary['mode'] = Object.keys(protos).length ? 'pack' : 'cone'
  let card: TreeLibrary['card'] = null
  if (mode === 'pack' && t.cards && assets) {
    const map = assets.texture('tex/tree_atlas/diff')
    const mask = assets.texture('tex/tree_atlas/mask')
    if (map && mask) card = { geometry: impostorGeometry(TREE_LAYOUT), material: treeCardMaterial(map, mask, q, u, camPos) }
  }
  // the cone stand-ins: the forest's 'mid' stems, vertex-coloured trunk, per-instance crown colour
  const cone = { evergreen: treePrototype('evergreen', 'mid'), deciduous: treePrototype('deciduous', 'mid') }
  const coneHeight = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!.max.y }
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true })
  const lib: TreeLibrary = {
    protos,
    mode,
    card,
    time: u.time,
    wind: u.wind,
    hasRole: (role) => !!protos[role]?.length,
  }
  INTERNALS.set(lib, {
    q,
    camPos,
    cone: { geometry: cone, height: { evergreen: coneHeight(cone.evergreen), deciduous: coneHeight(cone.deciduous) }, material: coneMat },
  })
  return lib
}

// ---------------------------------------------------------------------------------------------
// emit

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], matrices: THREE.Matrix4[], colors: THREE.Color[] | null, name: string, castShadow: boolean): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(geometry, material, matrices.length)
  matrices.forEach((m, i) => {
    inst.setMatrixAt(i, m)
    if (colors) inst.setColorAt(i, colors[i]!)
  })
  inst.instanceMatrix.needsUpdate = true
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  inst.castShadow = castShadow
  inst.receiveShadow = true
  inst.frustumCulled = true
  inst.computeBoundingSphere()
  inst.name = name
  return inst
}

/** the bounds of a cell's placements: the centre of their box, the radius to the farthest tree plus its crown */
function cellSphere(list: TreePlacement[]): THREE.Sphere {
  const box = new THREE.Box3()
  for (const p of list) box.expandByPoint(_p.set(p.x, p.y + p.height / 2, p.z))
  const centre = box.getCenter(new THREE.Vector3())
  let r = 0
  for (const p of list) r = Math.max(r, _p.set(p.x, p.y + p.height / 2, p.z).distanceTo(centre) + p.height * 0.6)
  return new THREE.Sphere(centre, r)
}

/** the crown colour of a cone stand-in: the species' mean crown, jittered per tree */
function coneColour(species: TreeSpecies, h: number): THREE.Color {
  const c = new THREE.Color(species.crown)
  return c.offsetHSL(((h & 0xff) / 255 - 0.5) * 0.04, (((h >>> 8) & 0xff) / 255 - 0.5) * 0.12, (((h >>> 16) & 0xff) / 255 - 0.5) * 0.08)
}

/** one cone InstancedMesh of one cone kind for these placements (any roles), scaled to each tree's height, sunk a little into the slope */
function coneMesh(internals: Internals, kind: TreeSpecies['cone'], list: TreePlacement[], name: string, castShadow: boolean): { mesh: THREE.InstancedMesh; triangles: number } {
  const geo = internals.cone.geometry[kind]
  const h0 = internals.cone.height[kind]
  const matrices: THREE.Matrix4[] = [], colours: THREE.Color[] = []
  for (const p of list) {
    const k = p.height / h0
    _q.setFromAxisAngle(Y_UP, p.yaw)
    _s.set(k, k, k)
    matrices.push(new THREE.Matrix4().compose(_p.set(p.x, p.y - 0.05 - 0.02 * p.height, p.z), _q, _s))
    colours.push(coneColour(TREE_SPECIES[p.role], hashU(p.seed)))
  }
  const mesh = instanced(geo, internals.cone.material, matrices, colours, name, castShadow)
  return { mesh, triangles: (geo.getAttribute('position').count / 3) * list.length }
}

/**
 * The impostor cards of a cell's trees: one InstancedMesh, the atlas row from the species, the
 * facing yaw from the placement (the bake's yaw 0 faces the camera; the shader takes the
 * camera's bearing relative to it), a per-tree phase for the sway, the tint on aTint0.
 * Scale convention: the bake fits every species to `TREE_CARD_ROW_HEIGHT_M[row]` metres in a
 * `TREE_LAYOUT.cellM` cell with the trunk base `padM` above the bottom edge, and
 * `impostorGeometry` is that cell in metres with the base at the origin — so a uniform scale
 * of height / rowHeight shows the tree at the placement's height, base on the ground.
 */
function cardMesh(lib: TreeLibrary, internals: Internals, list: TreePlacement[], name: string): THREE.InstancedMesh {
  const card = lib.card!
  const n = list.length
  const geo = card.geometry.clone()
  const inst = new THREE.InstancedMesh(geo, card.material, n)
  const arrays = IMPOSTOR_ATTRIBUTES.map((a) => new Float32Array(n * a.size))
  const info = arrays[0]!, tint0 = arrays[1]!, tint1 = arrays[2]!
  list.forEach((p, i) => {
    const species = TREE_SPECIES[p.role]
    const k = p.height / (TREE_CARD_ROW_HEIGHT_M[species.row] ?? TREE_CARD_ROW_HEIGHT_M[0]!)
    _q.identity()
    _s.setScalar(k)
    inst.setMatrixAt(i, _m.compose(_p.set(p.x, p.y, p.z), _q, _s))
    const h = hashU(p.seed)
    info[i * 4] = species.row
    info[i * 4 + 1] = -1
    info[i * 4 + 2] = p.yaw
    info[i * 4 + 3] = (h >>> 8) / 16777216
    tint0[i * 4] = p.tint.r
    tint0[i * 4 + 1] = p.tint.g
    tint0[i * 4 + 2] = p.tint.b
    tint0[i * 4 + 3] = 1
    tint1[i * 3] = tint1[i * 3 + 1] = tint1[i * 3 + 2] = 0
  })
  inst.instanceMatrix.needsUpdate = true
  IMPOSTOR_ATTRIBUTES.forEach((a, i) => geo.setAttribute(a.name, new THREE.InstancedBufferAttribute(arrays[i]!, a.size)))
  inst.castShadow = false
  inst.receiveShadow = true
  inst.frustumCulled = true
  inst.computeBoundingSphere()
  inst.name = name
  // the shader billboards towards uCamPos: whichever camera is drawing this pass
  const camPos = internals.camPos
  inst.onBeforeRender = (_r, _sc, camera) => { camPos.value.setFromMatrixPosition(camera.matrixWorld) }
  return inst
}

/**
 * Register one cell's trees (see the module comment). Per role with prototypes: one entry
 * `<name>-<role>-<cell>` whose level 0 (range lodM[0]) holds the heroes' LOD0 and the plain
 * trees' LOD1 meshes and whose level 1 (range lodM[1]) the heroes' LOD1 and the plain trees'
 * LOD2 — one InstancedMesh per (hero / plain, variant), at most VARIANTS_PER_CELL variants of
 * a role in one cell (chosen by the cell, so neighbouring cells differ). Then ONE entry
 * `<name>Cards-<cell>` for every tree of those roles: level 0 an empty group to lodM[1], level
 * 1 the impostor cards (or the cone stand-ins without the atlas) to `cardsRange` with
 * `cardsRamp`. The roles without prototypes (every role in 'cone' mode) are one cone entry per
 * cone kind, `<name>-evergreen-<cell>` / `<name>-deciduous-<cell>`, over the whole range with
 * the ramp — the forest's stem buckets as before. The entries are pinned to `cell` whatever the
 * placements' coordinates say, so two calls never collide on a name. Returns the counts.
 */
export function emitTrees(lib: TreeLibrary, ctx: EnvBuildContext, name: string, cell: number, list: TreePlacement[], opts: EmitOptions): EmitCounts {
  const internals = INTERNALS.get(lib)
  if (!internals) throw new Error('[trees] emitTrees: the library was not built by buildTreeLibrary')
  // A dense cell is split into quadrants (by the placements' median x and z), each with its own
  // entries and sphere: the registry switches an entry as a whole, so with one sphere per 250 m
  // cell a camera near a cell corner drew every tree of four cells as meshes — the perf probe
  // read 5–6 M triangles a frame in the follow modes (2.4–3 M before the trees). A quadrant's
  // sphere is half the size, so a wood the camera skirts stays on cards. Cone mode (Node, the
  // low tier) never splits: its entries are what the static budgets count, and cones are cheap.
  if (lib.mode === 'pack' && list.length >= SUBCELL_MIN) {
    const xs = list.map((p) => p.x).sort((a, b) => a - b), zs = list.map((p) => p.z).sort((a, b) => a - b)
    const mx = xs[xs.length >> 1]!, mz = zs[zs.length >> 1]!
    const parts: TreePlacement[][] = [[], [], [], []]
    for (const p of list) parts[(p.x < mx ? 0 : 1) + (p.z < mz ? 0 : 2)]!.push(p)
    const total: EmitCounts = { entries: 0, triangles: 0, cards: 0, cones: 0 }
    parts.forEach((part, k) => {
      if (!part.length) return
      const c = emitTreesPart(lib, internals, ctx, `${name}q${k}`, cell, part, opts)
      total.entries += c.entries
      total.triangles += c.triangles
      total.cards += c.cards
      total.cones += c.cones
    })
    return total
  }
  return emitTreesPart(lib, internals, ctx, name, cell, list, opts)
}

/** placements per cell from which `emitTrees` splits the cell into quadrants (pack mode only) */
const SUBCELL_MIN = 40

function emitTreesPart(lib: TreeLibrary, internals: Internals, ctx: EnvBuildContext, name: string, cell: number, list: TreePlacement[], opts: EmitOptions): EmitCounts {
  const { farField, quality: q } = ctx
  const t = q.farField.trees
  const counts: EmitCounts = { entries: 0, triangles: 0, cards: 0, cones: 0 }
  if (!list.length) return counts
  const byRole = new Map<TreeRole, TreePlacement[]>()
  for (const p of list) {
    let slot = byRole.get(p.role)
    if (!slot) byRole.set(p.role, (slot = []))
    slot.push(p)
  }
  const farLevel = (object: THREE.Object3D): FarLevel => {
    const level: FarLevel = { object, range: opts.cardsRange }
    if (opts.cardsRamp !== undefined) level.ramp = opts.cardsRamp
    return level
  }
  // ONE sphere for every entry of the call: the registry measures the camera's distance to an
  // entry's sphere, so entries with their own spheres (a role's few trees, the cards of all)
  // would cross the lodM[1] boundary at different camera positions and a role would vanish
  // before its cards appear (or overlap them); a shared sphere makes every switch simultaneous
  const sphere = cellSphere(list)
  const meshed: TreePlacement[] = []
  const cellHash = hashU(cell + 1)
  // the roles without a prototype (every role in 'cone' mode): one cone entry per cone KIND, not
  // per role — the stand-in only differs per tree by height and crown colour, and the low tier's
  // entry / InstancedMesh budgets are counted on this path
  const byCone = new Map<TreeSpecies['cone'], TreePlacement[]>()
  for (const [role, placements] of byRole) {
    if (lib.mode === 'pack' && lib.protos[role]?.length) continue
    const kind = TREE_SPECIES[role].cone
    let slot = byCone.get(kind)
    if (!slot) byCone.set(kind, (slot = []))
    for (const p of placements) slot.push(p)
    byRole.delete(role)
  }
  for (const [kind, placements] of byCone) {
    const casts = opts.castShadow && placements.some((p) => TREE_SPECIES[p.role].casts)
    const { mesh, triangles } = coneMesh(internals, kind, placements, `${name}-${kind}-${cell}`, casts)
    farField.register({ kind: 'forest', name: `${name}-${kind}-${cell}`, cell, sphere, levels: [farLevel(mesh)] })
    counts.entries++
    counts.cones += placements.length
    counts.triangles += triangles
  }
  for (const [role, placements] of byRole) {
    const species = TREE_SPECIES[role]
    const protos = lib.protos[role]!
    const casts = opts.castShadow && species.casts
    // group by (hero, variant): each is one InstancedMesh per level
    const nv = Math.min(protos.length, VARIANTS_PER_CELL)
    const groups = new Map<string, { proto: TreeProto; hero: boolean; matrices: THREE.Matrix4[]; colours: THREE.Color[] }>()
    for (const p of placements) {
      const h = hashU(p.seed)
      const variant = (cellHash + (h % nv)) % protos.length
      const key = `${p.hero ? 'hero' : 'plain'}-v${variant}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { proto: protos[variant]!, hero: p.hero, matrices: [], colours: [] }))
      _q.setFromAxisAngle(Y_UP, p.yaw)
      _s.setScalar(p.height)
      // sunk a little: the lowest vertex sits at the origin, and on a slope the downhill side of
      // the base would float
      g.matrices.push(new THREE.Matrix4().compose(_p.set(p.x, p.y - 0.05 - 0.01 * p.height, p.z), _q, _s))
      g.colours.push(p.tint)
    }
    const levels: FarLevel[] = []
    for (let k = 0; k < 2; k++) {
      const range = t.lodM[k]!
      const cast = casts && range <= t.leafShadowM
      const root = new THREE.Group()
      root.name = `${name}-${role}-${cell}-L${k}`
      for (const [key, g] of groups) {
        // heroes: LOD0 then LOD1; plain: LOD1 then LOD2
        const geo = g.proto.lods[g.hero ? k : k + 1]!
        root.add(instanced(geo.geometry, geo.materials, g.matrices, g.colours, `${name}-${role}-${cell}-L${k}-${key}`, cast))
        if (k === 0) counts.triangles += geo.triangles * g.matrices.length
      }
      levels.push({ object: root, range })
    }
    farField.register({ kind: 'forest', name: `${name}-${role}-${cell}`, cell, sphere, levels })
    counts.entries++
    for (const p of placements) meshed.push(p)
  }
  if (meshed.length) {
    // beyond the mesh range: the cards (every role in one InstancedMesh), or the cones without an atlas
    const empty = new THREE.Group()
    empty.name = `${name}Cards-${cell}-L0`
    let far: THREE.Object3D
    if (lib.card) {
      far = cardMesh(lib, internals, meshed, `${name}Cards-${cell}`)
      counts.cards += meshed.length
    } else {
      // the stand-ins are one mesh per cone kind (one geometry each)
      const group = new THREE.Group()
      group.name = `${name}Cards-${cell}-L1`
      const farCones = new Map<TreeSpecies['cone'], TreePlacement[]>()
      for (const p of meshed) {
        const kind = TREE_SPECIES[p.role].cone
        let slot = farCones.get(kind)
        if (!slot) farCones.set(kind, (slot = []))
        slot.push(p)
      }
      for (const [kind, placements] of farCones) group.add(coneMesh(internals, kind, placements, `${name}Cards-${cell}-${kind}`, false).mesh)
      far = group
      counts.cones += meshed.length
    }
    farField.register({ kind: 'forest', name: `${name}Cards-${cell}`, cell, sphere, levels: [{ object: empty, range: t.lodM[1] }, farLevel(far)] })
    counts.entries++
  }
  return counts
}
