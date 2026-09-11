import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SUR_FOREST, SUR_SCRUB, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing, type SurPolygon } from '~/data/en-codec'
import { FOREST } from '~/data/surroundings-spec'
import { FERRIS_WHEEL, SEASON, SEASONS } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import { FAR_CELL_M } from './farfield'
import { cellClippedPolygon, inBBox, makeNodeCache, pointInRing, ringBBox, ringFromFlat, type GridShape, type NodeCache, type XZ } from './far-geometry'
import { cutoutParams } from './materials'
import { cached, makeTexture, mulberry, normalMapFrom, paint, scaled } from './textures'
import { treePrototype, treeSiteBlocked } from './vegetation'

/**
 * The woods around the circuit, from the OSM forest / wood / scrub polygons of
 * app/data/suzuka-surroundings.ts (plan §2a). Three ranges, all standing on `ground.standY`,
 * all built as deferred 'forest' jobs of `ctx.farField` (one job per 250 m cell family, so no
 * job holds the main thread for more than a few tens of ms) and all chosen per cell by the
 * registry's LOD pass:
 *
 *  - FAR — the canopy MASS: the polygon cut along the terrain's own triangles
 *    (`cellClippedPolygon`, subdivided in two), its top at H0 (10 m natural=wood, 11 m
 *    landuse=forest plantations, 7 m the pruned garden woods inside Motopia, 3.5 m scrub) plus
 *    value noise, vertex colours calibrated against the z16 aerial (dark evergreen, HSL
 *    lightness 0.18–0.26, with ≈ 25 % warm grey-brown bare crowns in late March), and a skirt
 *    hanging to standY − 1 (standY + 0.5 inside 80 m of the track, the camera band). Merged
 *    per cell as `forest-<cell>`, an entry whose level 0 is an EMPTY group with the stem range
 *    and whose level 1 is the mass at range ∞ — so the registry hides the mass exactly while
 *    the stems of that cell are drawn. Lids and skirts stop 60 m from the centreline.
 *  - MIDDLE — procedural stems (`treePrototype` of vegetation.ts) inside the stem range:
 *    `Quality.farField.midTrees` allotted over the polygons by area × visibility, a stratified
 *    jittered lattice with point-in-polygon, the scatter's exclusions (`treeSiteBlocked`), the
 *    late-March mix 0.72 evergreen / 0.25 bare / 0.03 cherry (cherries only on the edges),
 *    registered per cell with the count ramp. The forest FLOOR (`forestFloor-<cell>`, a dark
 *    litter overlay 6 cm over the ground, 140 m out — beyond G8's 75 m band) is the companion
 *    that shows at the same range, under the stems.
 *  - NEAR — the shipped GLB trees (high tier with the asset pack): up to `heroPerCell` stems
 *    per cell, the ones nearest the track, drawn as bark + cutout-leaf InstancedMeshes per
 *    prototype (`forestHero-<cell>`, 260 m), each replaced by its procedural stem beyond that.
 *
 * Draws: per visible cell 1 mass or (1 floor + 2 stem buckets + 2 × prototypes of heroes).
 * The trackside scatter (vegetation.ts) stays the near band inside 500 m; it is denser inside
 * these polygons, so the wall of trees continues to the fence where the lids stop.
 *
 * Nothing here samples the terrain; heights are `ground.standY` (README 地面の契約 R3), and
 * the overlays never lie on a drawn ground face (`ground.builtY`, R1 / R11).
 */

type ForestKind = 'wood' | 'plantation' | 'garden' | 'scrub'

interface ForestPoly {
  id: number
  kind: ForestKind
  ring: XZ[]
  box: [number, number, number, number]
  /** m² (the OSM shoelace) */
  area: number
  dmin: number
  h0: number
  /** share of bare crowns on the lid */
  bare: number
  /** the OSM area × the share of its bounding box inside the terrain grid (where stems can stand) */
  areaInGrid: number
  /** stems allotted to this polygon (0 for scrub) */
  stems: number
  seed: number
}

export interface ForestStats {
  polygons: number
  cells: number
  jobs: number
  stemsPlanned: number
}

interface HeroProto {
  key: string
  bark: THREE.BufferGeometry | null
  leaf: THREE.BufferGeometry | null
  barkMat: THREE.Material
  leafMat: THREE.Material
  /** the procedural stand-in beyond the hero range */
  plain: 'evergreen' | 'deciduous'
  /** the crown's colour for the stand-in */
  plainColour: (rng: () => number) => THREE.Color
}

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _c = new THREE.Color()
const Y_UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------------------------------------
// hashing and noise (deterministic in world space, so every job places the same trees whatever
// the order the queue runs them in)

function hash2(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** smooth value noise 0..1 on the integer lattice of (x, z) */
function vnoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z)
  let fx = x - xi, fz = z - zi
  fx = fx * fx * (3 - 2 * fx)
  fz = fz * fz * (3 - 2 * fz)
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed), c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed)
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx
  return ab + (cd - ab) * fz
}

/** `vnoise` wrapping on a `px` × `pz` lattice (tileable textures) */
function vnoiseP(x: number, z: number, px: number, pz: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z)
  let fx = x - xi, fz = z - zi
  fx = fx * fx * (3 - 2 * fx)
  fz = fz * fz * (3 - 2 * fz)
  const x0 = ((xi % px) + px) % px, z0 = ((zi % pz) + pz) % pz
  const x1 = (x0 + 1) % px, z1 = (z0 + 1) % pz
  const a = hash2(x0, z0, seed), b = hash2(x1, z0, seed), c = hash2(x0, z1, seed), d = hash2(x1, z1, seed)
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx
  return ab + (cd - ab) * fz
}

/** two-octave value noise, 0..1, period `p` metres */
function fbm2(x: number, z: number, p: number, seed: number): number {
  return (vnoise(x / p, z / p, seed) * 2 + vnoise((x * 2) / p + 7.3, (z * 2) / p + 3.1, seed + 1)) / 3
}

// ---------------------------------------------------------------------------------------------
// textures (project helpers of textures.ts; `textureScale` in every key)

/** the crown mosaic on the lid: a bright, blotchy multiplier with dark crevices between crowns, plus its bumps */
function canopyMaps(): { map: THREE.Texture; normalMap: THREE.Texture } {
  const [w, h] = scaled(256, 256)
  return cached(`forest/canopy@${w}`, () => {
    const seed = 4021
    const height = new Float32Array(w * h)
    // tileable: the noise is addressed in normalised uv on wrapping lattices
    const P = 8
    const n2 = (u: number, v: number, s: number) => vnoiseP(u * P, v * P, P, P, s) * 0.6 + vnoiseP(u * P * 2, v * P * 2, P * 2, P * 2, s + 3) * 0.4
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h
      // crowns: bumps of the noise, crevices where it is low
      const k = n2(u, v, seed)
      height[y * w + x] = Math.pow(k, 1.4)
    }
    const c = paint(w, h, (x, y, out) => {
      const k = height[y * w + x]!
      const bright = 0.62 + 0.42 * k
      const speck = hash2(x, y, 99) * 0.08
      const v = 255 * Math.min(1, bright + speck)
      out[0] = v * 0.97
      out[1] = v
      out[2] = v * 0.93
    })
    const map = makeTexture(c, { srgb: true })
    const normalMap = normalMapFrom(height, w, h, 4)
    return { map, normalMap }
  })
}

/** leaf litter for the forest floor: a mottled brown-grey multiplier over the floor colour */
function litterMap(): THREE.Texture {
  const [w, h] = scaled(128, 128)
  return cached(`forest/litter@${w}`, () => {
    const rnd = mulberry(77)
    const P = 6
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      const k = vnoiseP(u * P, v * P, P, P, 12) * 0.5 + vnoiseP(u * P * 4, v * P * 4, P * 4, P * 4, 13) * 0.5
      const g = 0.7 + 0.5 * k + (rnd() - 0.5) * 0.12
      out[0] = 255 * Math.min(1, g * 1.04)
      out[1] = 255 * Math.min(1, g)
      out[2] = 255 * Math.min(1, g * 0.9)
    })
    return makeTexture(c, { srgb: true })
  })
}

// ---------------------------------------------------------------------------------------------
// the polygons

function classify(f: SurPolygon, scrub: boolean, motopia: { ring: XZ[]; box: [number, number, number, number] } | null, enScale: number): ForestKind {
  if (scrub) return 'scrub'
  const cx = f.centroid[0] * enScale, cz = -f.centroid[1] * enScale
  if (motopia && inBBox(cx, cz, motopia.box) && pointInRing(cx, cz, motopia.ring)) return 'garden'
  return f.tags.landuse === 'forest' ? 'plantation' : 'wood'
}

function forestPolys(enScale: number): ForestPoly[] {
  const site = SUR_SITES.find((s) => s.role === 'theme_park')
  const motopia = site ? (() => { const ring = ringFromFlat(worldRing(site, enScale)); return { ring, box: ringBBox(ring) } })() : null
  const out: ForestPoly[] = []
  const add = (f: SurPolygon, scrub: boolean) => {
    const ring = ringFromFlat(worldRing(f, enScale))
    if (ring.length < 3) return
    const kind = classify(f, scrub, motopia, enScale)
    out.push({ id: f.id, kind, ring, box: ringBBox(ring), area: f.area, areaInGrid: f.area, dmin: f.dmin, h0: FOREST.canopyH0[kind], bare: FOREST.bareShare[kind], stems: 0, seed: f.id | 0 })
  }
  for (const f of SUR_FOREST) add(f, false)
  for (const f of SUR_SCRUB) add(f, true)
  return out
}

/**
 * `midTrees` over the polygons by area × visibility weight (1 at the track, `floor` at `far`
 * metres). Only the part of a polygon inside the terrain rectangle counts (the share of its
 * bounding box inside it — the stems are placed there only), so a wood that is mostly beyond
 * the grid does not take stems it cannot stand.
 */
function allotStems(polys: ForestPoly[], midTrees: number, grid: GridShape) {
  const { far, floor } = FOREST.visibility
  let sum = 0
  const w = polys.map((p) => {
    if (p.kind === 'scrub') return 0
    const [bx0, bz0, bx1, bz1] = p.box
    const ix = Math.max(0, Math.min(bx1, grid.x0 + grid.w) - Math.max(bx0, grid.x0))
    const iz = Math.max(0, Math.min(bz1, grid.z0 + grid.d) - Math.max(bz0, grid.z0))
    const share = ((bx1 - bx0) * (bz1 - bz0)) > 0 ? (ix * iz) / ((bx1 - bx0) * (bz1 - bz0)) : 0
    p.areaInGrid = Math.max(1, p.area * share)
    const v = Math.max(floor, 1 - p.dmin / far)
    sum += v * p.areaInGrid
    return v * p.areaInGrid
  })
  if (sum <= 0) return
  // the lattice's yield after the exclusions (drawn faces, the 44 m band, keep-outs, the bbox share) is ≈ 0.75
  polys.forEach((p, i) => { p.stems = Math.round((midTrees * w[i]!) / (sum * 0.75)) })
}

// ---------------------------------------------------------------------------------------------
// the GLB prototypes (high tier with the pack)

/** widen a quantised attribute (KHR_mesh_quantization int16 / int8) to floats, so the node transform does not truncate it */
function widened(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.Float32BufferAttribute {
  const f = new THREE.Float32BufferAttribute(a.count * size, size)
  for (let i = 0; i < a.count; i++) {
    if (size === 2) f.setXY(i, a.getX(i), a.getY(i))
    else f.setXYZ(i, a.getX(i), a.getY(i), a.getZ(i))
  }
  return f
}

const LEAF_RE = /leaf|leaves|orange|green/i

/**
 * One prototype per model: the bark primitives merged, the leaf primitives merged, both at
 * metric scale (the packs ship in assorted units, so each is scaled to its FOREST.hero.heights
 * entry), the trunk base at the origin. The leaves are drawn as a cutout (alphaTest, double
 * sided) instead of the pack's alpha blend, which would sort wrongly between instances. null
 * when the model is not in the registry (the caller falls back to the procedural stem).
 */
function heroPrototype(reg: AssetRegistry, key: string, q: EnvBuildContext['quality'], blossom: THREE.Color | null): HeroProto | null {
  const m = reg.model(key)
  if (!m) return null
  m.scene.updateMatrixWorld(true)
  const bark: THREE.BufferGeometry[] = []
  const leaf: THREE.BufferGeometry[] = []
  let barkSrc: THREE.Material | null = null
  let leafSrc: THREE.Material | null = null
  const bbox = new THREE.Box3()
  const barkBox = new THREE.Box3()
  m.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
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
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(g.getAttribute('position')!.count * 2, 2))
      const idx = src.index
      if (idx) {
        const end = Math.min(idx.count, grp.start + grp.count)
        const sub: number[] = []
        for (let i = grp.start; i < end; i++) sub.push(idx.getX(i))
        g.setIndex(sub)
      } else if (grp.start > 0 || grp.count < g.getAttribute('position')!.count) {
        const sub: number[] = []
        for (let i = grp.start; i < grp.start + grp.count; i++) sub.push(i)
        g.setIndex(sub)
      }
      g.applyMatrix4(mesh.matrixWorld)
      const part = g.index ? g.toNonIndexed() : g
      part.computeBoundingBox()
      bbox.union(part.boundingBox!)
      if (LEAF_RE.test(mat.name)) {
        leaf.push(part)
        leafSrc ??= mat
      } else {
        bark.push(part)
        barkSrc ??= mat
        barkBox.union(part.boundingBox!)
      }
    }
  })
  if (!bark.length && !leaf.length) return null
  const height = bbox.max.y - bbox.min.y
  if (!(height > 0)) return null
  const k = (FOREST.hero.heights[key] ?? 9) / height
  const base = barkBox.isEmpty() ? bbox : barkBox
  const cx = (base.min.x + base.max.x) / 2, cz = (base.min.z + base.max.z) / 2
  const fit = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
    if (!parts.length) return null
    const merged = mergeGeometries(parts, false)
    for (const p of parts) p.dispose()
    if (!merged) return null
    merged.translate(-cx, -bbox.min.y, -cz)
    merged.scale(k, k, k)
    merged.computeBoundingSphere()
    return merged
  }
  const std = (src: THREE.Material | null): THREE.MeshStandardMaterial | null => (src && (src as THREE.MeshStandardMaterial).isMeshStandardMaterial ? (src as THREE.MeshStandardMaterial) : null)
  const barkStd = std(barkSrc)
  const barkMat = new THREE.MeshStandardMaterial({ color: barkStd?.color ?? new THREE.Color(0x4a3a2a), map: barkStd?.map ?? null, normalMap: barkStd?.normalMap ?? null, roughness: 0.9, metalness: 0 })
  const leafStd = std(leafSrc)
  const cut = cutoutParams(q)
  const leafMat = new THREE.MeshStandardMaterial({
    color: blossom ?? leafStd?.color ?? new THREE.Color(0x35502a),
    map: blossom && !leafStd?.map ? null : (leafStd?.map ?? null),
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: leafStd?.map ? cut.alphaTest : 0,
    alphaToCoverage: !!leafStd?.map && cut.alphaToCoverage,
    transparent: false,
  })
  const isBlossom = !!blossom
  return {
    key,
    bark: fit(bark),
    leaf: fit(leaf),
    barkMat,
    leafMat,
    plain: isBlossom ? 'deciduous' : 'evergreen',
    plainColour: isBlossom
      ? (rng) => blossom!.clone().lerp(new THREE.Color('#e9a9be'), rng() * 0.6)
      : (rng) => new THREE.Color().setHSL(0.31 + rng() * 0.08, 0.28 + rng() * 0.16, 0.09 + rng() * 0.07),
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Queue the forest's deferred jobs (see the module comment). Materials and the GLB prototypes
 * are made here, synchronously, so the viewport's material setup covers them; the geometry is
 * built in the jobs. Returns the plan's counts for the offline harness.
 */
export function buildForest(ctx: EnvBuildContext): ForestStats {
  const { track, terrain, ground, quality: q, farField, assets } = ctx
  const grid: GridShape = terrain.grid()
  const polys = forestPolys(track.enScale)
  allotStems(polys, q.farField.midTrees, grid)
  const season = SEASONS[SEASON]
  const blossom = new THREE.Color(season.blossom)

  // --- materials -----------------------------------------------------------------------------
  const canopy = canopyMaps()
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: canopy.map, normalMap: canopy.normalMap, normalScale: new THREE.Vector2(0.55, 0.55) })
  canopyMat.map!.repeat.set(1 / FOREST.canopyTileM, 1 / FOREST.canopyTileM)
  canopyMat.normalMap!.repeat.copy(canopyMat.map!.repeat)
  const floorMat = new THREE.MeshStandardMaterial({ color: FOREST.floorColour, roughness: 1, metalness: 0, map: litterMap() })
  floorMat.map!.repeat.set(1 / FOREST.floorTileM, 1 / FOREST.floorTileM)
  const stemMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true })
  const evergreenGeo = treePrototype('evergreen', 'mid')
  const deciduousGeo = treePrototype('deciduous', 'mid')
  const castShadow = q.farField.shadows

  // --- GLB prototypes (high tier with the pack) ------------------------------------------------
  const heroes: HeroProto[] = []
  let blossomHero: HeroProto | null = null
  if (q.farField.heroPerCell > 0 && assets) {
    for (const key of FOREST.hero.evergreen) {
      const p = heroPrototype(assets, key, q, null)
      if (p) heroes.push(p)
    }
    blossomHero = heroPrototype(assets, FOREST.hero.blossom, q, blossom)
  }
  // the lighter prototype is picked more often (the hero budget is triangles as much as trees)
  const heroWeights = heroes.map((h) => 1 / Math.max(1, (h.bark ? h.bark.getAttribute('position').count : 0) + (h.leaf ? h.leaf.getAttribute('position').count : 0)))
  const pickHero = (r: number): HeroProto => {
    let sum = 0
    for (const w of heroWeights) sum += w
    let acc = 0
    for (let i = 0; i < heroes.length; i++) {
      acc += heroWeights[i]! / sum
      if (r < acc) return heroes[i]!
    }
    return heroes[heroes.length - 1]!
  }

  // --- the cells -------------------------------------------------------------------------------
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M)), ncz = Math.max(1, Math.ceil(grid.d / FAR_CELL_M))
  const cache: NodeCache = makeNodeCache(grid)
  track.enToWorld(FERRIS_WHEEL.en[0], FERRIS_WHEEL.en[1], _p)
  const wheel = { x: _p.x, z: _p.z }
  const stemRange = FOREST.stems.range
  let cells = 0, jobs = 0, stemsPlanned = 0
  for (const p of polys) stemsPlanned += p.stems

  interface CellPlan { cell: number; window: [number, number, number, number]; here: ForestPoly[]; heroAllow: number }
  const plans: CellPlan[] = []
  for (let cj = 0; cj < ncz; cj++) {
    for (let ci = 0; ci < ncx; ci++) {
      const x0 = grid.x0 + ci * FAR_CELL_M, z0 = grid.z0 + cj * FAR_CELL_M
      const x1 = Math.min(x0 + FAR_CELL_M, grid.x0 + grid.w), z1 = Math.min(z0 + FAR_CELL_M, grid.z0 + grid.d)
      const here = polys.filter((p) => p.box[2] > x0 && p.box[0] < x1 && p.box[3] > z0 && p.box[1] < z1)
      if (!here.length) continue
      plans.push({ cell: farField.cellOf((x0 + x1) / 2, (z0 + z1) / 2), window: [x0, z0, x1, z1], here, heroAllow: 0 })
    }
  }
  // the tier's hero total (`nearTrees`) goes to the cells nearest the track first, ≤ heroPerCell each
  if (heroes.length) {
    let budget = q.farField.nearTrees
    const nearest = (c: CellPlan) => Math.min(...c.here.map((p) => (p.stems > 0 ? p.dmin : Infinity)))
    for (const c of plans.slice().sort((a, b) => nearest(a) - nearest(b))) {
      if (nearest(c) === Infinity) break
      c.heroAllow = Math.min(q.farField.heroPerCell, budget)
      budget -= c.heroAllow
      if (budget <= 0) break
    }
  }

  for (const { cell, window, here, heroAllow } of plans) {
    const [x0, z0, x1, z1] = window
    cells++
    {

      // --- job A: the canopy mass and the forest floor of this cell --------------------------
      if (q.farField.canopy) {
        jobs++
        farField.defer('forest', `forest-${cell}`, 30, () => {
          const lids: THREE.BufferGeometry[] = []
          const floors: THREE.BufferGeometry[] = []
          for (const p of here) {
            const amp = FOREST.canopyNoise.amp, period = FOREST.canopyNoise.period
            const yOf = (x: number, z: number) => p.h0 + (fbm2(x, z, period, p.seed) - 0.5) * 2 * amp
            // the clamp band only matters for polygons that reach it: a polygon's nearest point to
            // the centreline is on its boundary, and `dmin` is its nearest vertex (the chord sag
            // of an OSM edge is metres at most, hence the margin)
            const mayClamp = p.dmin < FOREST.skirt.clampD + 15
            const lid = cellClippedPolygon(p.ring, {
              grid, ground, plan: ground.plan, minD: FOREST.lidMinD, subdiv: 2, yOf, window, cache,
              skirt: {
                bottom: (x, z) => {
                  const y = ground.standY(x, z)
                  return mayClamp && ground.plan.project(x, z).d < FOREST.skirt.clampD ? y + FOREST.skirt.clamp : y - FOREST.skirt.drop
                },
              },
            })
            if (lid.top) {
              colourLid(lid.top, p)
              lids.push(lid.top)
              if (lid.skirt) {
                colourSkirt(lid.skirt, p)
                lids.push(lid.skirt)
              }
            }
            if (p.kind !== 'scrub') {
              const floor = cellClippedPolygon(p.ring, { grid, ground, plan: ground.plan, minD: FOREST.floorMinD, subdiv: 1, yOf: () => FOREST.floorLift, window, cache })
              if (floor.top) floors.push(floor.top)
            }
          }
          if (!lids.length && !floors.length) return null
          const root = new THREE.Group()
          root.name = `forest-${cell}`
          if (lids.length) {
            const geo = mergeGeometries(lids, false)
            for (const g of lids) g.dispose()
            if (geo) {
              geo.computeBoundingSphere()
              const mass = new THREE.Mesh(geo, canopyMat)
              mass.name = `forest-${cell}`
              // the lid is what shows beyond the stem range, which on the high tier equals
              // followMaxFar: in the follow modes it is never inside a cascade, and in the overview
              // its shadow is 2–3 px at 1.8 km for 80 shadow draws a frame — the stems cast instead
              mass.castShadow = false
              mass.receiveShadow = true
              const near = new THREE.Group()
              near.name = `forestNear-${cell}`
              root.add(near, mass)
              farField.register({ kind: 'forest', name: `forest-${cell}`, cell, levels: [{ object: near, range: stemRange }, { object: mass, range: Infinity }] })
            }
          }
          if (floors.length) {
            const geo = mergeGeometries(floors, false)
            for (const g of floors) g.dispose()
            if (geo) {
              geo.computeBoundingSphere()
              const floor = new THREE.Mesh(geo, floorMat)
              floor.name = `forestFloor-${cell}`
              floor.receiveShadow = true
              root.add(floor)
              farField.register({ kind: 'floor', name: `forestFloor-${cell}`, cell, levels: [{ object: floor, range: stemRange }] })
            }
          }
          return root
        })
      }

      // --- job B: the stems of this cell (procedural, and the GLB heroes nearest the track) ---
      if (!here.some((p) => p.stems > 0)) continue
      jobs++
      farField.defer('forest', `forestStems-${cell}`, 20, () => {
        interface Stem { x: number; z: number; y: number; d: number; kind: 'evergreen' | 'bare' | 'blossom'; r: number; p: ForestPoly }
        const stems: Stem[] = []
        const mix = FOREST.stems.mix
        for (const p of here) {
          if (p.stems <= 0) continue
          const spacing = Math.max(FOREST.stems.minSpacing, Math.sqrt(p.areaInGrid / p.stems))
          const i0 = Math.floor(Math.max(p.box[0], x0) / spacing), i1 = Math.ceil(Math.min(p.box[2], x1) / spacing)
          const j0 = Math.floor(Math.max(p.box[1], z0) / spacing), j1 = Math.ceil(Math.min(p.box[3], z1) / spacing)
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const r0 = hash2(i, j, p.seed), r1 = hash2(i, j, p.seed + 11), r2 = hash2(i, j, p.seed + 23)
              const x = (i + 0.05 + 0.9 * r0) * spacing, z = (j + 0.05 + 0.9 * r1) * spacing
              if (x < x0 || x >= x1 || z < z0 || z >= z1) continue
              if (!inBBox(x, z, p.box) || !pointInRing(x, z, p.ring)) continue
              if (farField.cellOf(x, z) !== cell) continue
              if (ground.builtY(x, z)) continue
              const near = ground.plan.project(x, z)
              if (near.d < FOREST.stems.minD || treeSiteBlocked(ctx, x, z, near, wheel)) continue
              let kind: Stem['kind'] = r2 < mix.evergreen ? 'evergreen' : r2 < mix.evergreen + mix.bare ? 'bare' : 'blossom'
              // cherries stand on the wood's edge (the aerial's pink fringes), never deep inside
              if (kind === 'blossom' && distToRing(x, z, p.ring) > FOREST.stems.edgeM) kind = 'bare'
              stems.push({ x, z, y: ground.standY(x, z), d: near.d, kind, r: hash2(i, j, p.seed + 31), p })
            }
          }
        }
        if (!stems.length) return null
        // the heroes: the stems nearest the track, up to the cell's and the tier's budgets
        const heroN = Math.min(heroAllow, stems.length)
        if (heroN > 0) stems.sort((a, b) => a.d - b.d)
        const root = new THREE.Group()
        root.name = `forestStems-${cell}`
        const plainE: THREE.Matrix4[] = [], plainEC: THREE.Color[] = []
        const plainD: THREE.Matrix4[] = [], plainDC: THREE.Color[] = []
        const byProto = new Map<HeroProto, { m: THREE.Matrix4[]; plain: THREE.Matrix4[]; colours: THREE.Color[] }>()
        for (let k = 0; k < stems.length; k++) {
          const s = stems[k]!
          const rng = mulberry((s.p.seed ^ Math.round(s.x * 7 + s.z * 13)) >>> 0)
          _q.setFromAxisAngle(Y_UP, rng() * Math.PI * 2)
          if (k < heroN) {
            const proto = s.kind === 'blossom' && blossomHero ? blossomHero : pickHero(rng())
            const sc = FOREST.hero.scale[0] + rng() * (FOREST.hero.scale[1] - FOREST.hero.scale[0])
            _s.set(sc, sc, sc)
            const m = new THREE.Matrix4().compose(_p.set(s.x, s.y - 0.05, s.z), _q, _s)
            let slot = byProto.get(proto)
            if (!slot) byProto.set(proto, (slot = { m: [], plain: [], colours: [] }))
            slot.m.push(m)
            // the stand-in beyond the hero range: the procedural stem, matched in height
            const ps = proto.plain === 'evergreen' ? sc * 0.85 : sc * 1.1
            _s.set(ps, ps, ps)
            slot.plain.push(new THREE.Matrix4().compose(_p.set(s.x, s.y - 0.2, s.z), _q, _s))
            slot.colours.push(proto.plainColour(rng))
            continue
          }
          if (s.kind === 'evergreen') {
            const sc = 0.75 + rng() * 0.65
            _s.set(sc, sc * (0.9 + rng() * 0.25), sc)
            plainE.push(new THREE.Matrix4().compose(_p.set(s.x, s.y - 0.3, s.z), _q, _s))
            plainEC.push(new THREE.Color().setHSL(0.31 + rng() * 0.09, 0.26 + rng() * 0.18, 0.08 + rng() * 0.08))
          } else {
            const sc = s.kind === 'blossom' ? 0.75 + rng() * 0.4 : 0.6 + rng() * 0.45
            _s.set(sc, sc * (0.9 + rng() * 0.25), sc)
            plainD.push(new THREE.Matrix4().compose(_p.set(s.x, s.y - 0.2, s.z), _q, _s))
            if (s.kind === 'blossom') plainDC.push(blossom.clone().lerp(_c.set('#e9a9be'), rng() * 0.6))
            else plainDC.push(new THREE.Color().setHSL(0.08 + rng() * 0.06, 0.12 + rng() * 0.14, 0.2 + rng() * 0.12))
          }
        }
        const level = [{ range: stemRange, ramp: FOREST.stems.ramp }]
        if (plainE.length) farField.registerBuckets('forest', 'forestEver', evergreenGeo, stemMat, plainE, plainEC, level, { castShadow })
        if (plainD.length) farField.registerBuckets('forest', 'forestDecid', deciduousGeo, stemMat, plainD, plainDC, level, { castShadow })
        if (byProto.size) {
          const heroGroup = new THREE.Group()
          heroGroup.name = `forestHero-${cell}`
          const plainGroup = new THREE.Group()
          plainGroup.name = `forestHeroPlain-${cell}`
          for (const [proto, slot] of byProto) {
            const n = slot.m.length
            for (const [geo, mat, part] of [[proto.bark, proto.barkMat, 'bark'], [proto.leaf, proto.leafMat, 'leaf']] as const) {
              if (!geo) continue
              const inst = new THREE.InstancedMesh(geo, mat, n)
              for (let i = 0; i < n; i++) inst.setMatrixAt(i, slot.m[i]!)
              inst.instanceMatrix.needsUpdate = true
              inst.castShadow = castShadow && part === 'bark'
              inst.receiveShadow = false
              inst.frustumCulled = true
              inst.computeBoundingSphere()
              inst.name = `forestHero-${cell}-${proto.key.slice(proto.key.lastIndexOf('/') + 1)}-${part}`
              heroGroup.add(inst)
            }
            const plainGeo = proto.plain === 'evergreen' ? evergreenGeo : deciduousGeo
            const plain = new THREE.InstancedMesh(plainGeo, stemMat, n)
            for (let i = 0; i < n; i++) {
              plain.setMatrixAt(i, slot.plain[i]!)
              plain.setColorAt(i, slot.colours[i]!)
            }
            plain.instanceMatrix.needsUpdate = true
            if (plain.instanceColor) plain.instanceColor.needsUpdate = true
            plain.castShadow = castShadow
            plain.frustumCulled = true
            plain.computeBoundingSphere()
            plain.name = `forestHeroPlain-${cell}-${proto.plain}`
            plainGroup.add(plain)
          }
          root.add(heroGroup, plainGroup)
          farField.register({ kind: 'forest', name: `forestHero-${cell}`, cell, levels: [{ object: heroGroup, range: FOREST.hero.range }, { object: plainGroup, range: stemRange, ramp: FOREST.stems.ramp }] })
        }
        root.userData.stems = { count: stems.length, heroes: heroN }
        return root.children.length ? root : null
      })
    }
  }
  return { polygons: polys.length, cells, jobs, stemsPlanned }
}

// ---------------------------------------------------------------------------------------------
// lid / skirt colours

/** distance from (x, z) to the nearest edge of the ring */
function distToRing(x: number, z: number, ring: readonly XZ[]): number {
  let best = Infinity
  for (let i = 0, n = ring.length; i < n; i++) {
    const [ax, az] = ring[i]!, [bx, bz] = ring[(i + 1) % n]!
    const ex = bx - ax, ez = bz - az
    const l2 = ex * ex + ez * ez
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0
    const dx = x - (ax + ex * t), dz = z - (az + ez * t)
    const d2 = dx * dx + dz * dz
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

/**
 * The lid's colour at (x, z): a mosaic of crowns on `FOREST.patchPeriod`, a share of them bare
 * (warm grey-brown twigs, lighter than the evergreens from above), the rest dark evergreen with
 * a per-polygon hue drift — the tones of the late-March z16 aerial.
 */
function crownColour(x: number, z: number, p: ForestPoly, out: THREE.Color): THREE.Color {
  const patch = fbm2(x, z, FOREST.patchPeriod, p.seed + 101)
  const j1 = hash2(Math.round(x * 4), Math.round(z * 4), p.seed + 5)
  const j2 = hash2(Math.round(x * 4), Math.round(z * 4), p.seed + 6)
  const hueDrift = (hash2(p.seed, 3, 9) - 0.5) * 0.03
  // the noise clusters around 0.5: this threshold gives ≈ the wanted bare share
  const bare = patch > 0.5 + (0.5 - p.bare) * 0.45
  if (p.kind === 'scrub') {
    if (bare) return out.setHSL(0.09 + j1 * 0.03, 0.14 + j2 * 0.1, 0.27 + patch * 0.08)
    return out.setHSL(0.19 + j1 * 0.06 + hueDrift, 0.26 + j2 * 0.12, 0.2 + patch * 0.1)
  }
  if (bare) return out.setHSL(0.07 + j1 * 0.03, 0.12 + j2 * 0.1, 0.25 + patch * 0.09)
  return out.setHSL(0.3 + j1 * 0.07 + hueDrift, 0.3 + j2 * 0.16, 0.17 + patch * 0.06 + j1 * 0.04)
}

function colourLid(geo: THREE.BufferGeometry, p: ForestPoly) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    crownColour(pos.getX(i), pos.getZ(i), p, _c)
    col[i * 3] = _c.r
    col[i * 3 + 1] = _c.g
    col[i * 3 + 2] = _c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
}

/** the skirt: the lid's colour darkened at the top, near black at the bottom (trunks in shade); quads are [aTop, bTop, bBottom, aBottom] */
function colourSkirt(geo: THREE.BufferGeometry, p: ForestPoly) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    crownColour(pos.getX(i), pos.getZ(i), p, _c)
    const k = i % 4 < 2 ? 0.55 : 0.28
    col[i * 3] = _c.r * k
    col[i * 3 + 1] = _c.g * k
    col[i * 3 + 2] = _c.b * k
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
}
