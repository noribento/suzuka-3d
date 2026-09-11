import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SUR_FOREST, SUR_SCRUB, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing, type SurPolygon } from '~/data/en-codec'
import { FOREST } from '~/data/surroundings-spec'
import { TREE_MIX, TREE_SPECIES, type TreeMixKind, type TreeRole } from '~/data/tree-species'
import { FERRIS_WHEEL } from '~/data/suzuka-facilities-spec'
import type { EnvBuildContext } from './environment'
import { FAR_CELL_M } from './farfield'
import { cellClippedPolygon, inBBox, makeNodeCache, pointInRing, ringBBox, ringFromFlat, type GridShape, type NodeCache, type XZ } from './far-geometry'
import { inGrid, pathLength, resample } from './far-lines'
import { offsetAt, roadNetwork, walk, type RoadWay } from './road-section'
import { cached, makeTexture, mulberry, normalMapFrom, paint, scaled } from './textures'
import { emitTrees, pickHeight, pickRole, pickTint, type TreePlacement } from './trees'
import { treeSiteBlocked, type TreeSite } from './vegetation'

/**
 * The woods around the circuit, from the OSM forest / wood / scrub polygons of
 * app/data/suzuka-surroundings.ts (plan §2a, species and rows plan R Phase 2). Everything stands
 * on `ground.standY`, is built as deferred 'forest' jobs of `ctx.farField` (one job per 250 m
 * cell family, so no job holds the main thread for more than a few tens of ms) and is chosen per
 * cell by the registry's LOD pass:
 *
 *  - FAR — the canopy MASS (job A, `forest-<cell>`): the polygon cut along the terrain's own
 *    triangles (`cellClippedPolygon`, subdivided in two), its top at H0 (10 m natural=wood, 11 m
 *    landuse=forest plantations, 7 m the pruned garden woods inside Motopia, 3.5 m scrub) plus
 *    value noise, vertex colours from the species' mean crown colours (TREE_SPECIES, blended by
 *    the polygon kind's TREE_MIX: dark evergreen with ≈ 25 % warm grey-brown bare crowns in late
 *    March, the tones of the z16 aerial), and a skirt hanging to standY − 1 (standY + 0.5 inside
 *    80 m of the track, the camera band). An entry whose level 0 is an EMPTY group with the stem
 *    range and whose level 1 is the mass at range ∞ — so the registry hides the mass exactly
 *    while the stems of that cell are drawn. Lids and skirts stop 60 m from the centreline. The
 *    forest FLOOR (`forestFloor-<cell>`, a dark litter overlay 6 cm over the ground, 140 m out —
 *    beyond G8's 75 m band) shows at the stem range, under the stems.
 *  - INSIDE the stem range — the STEMS (job B, `forestStems-<cell>`): `Quality.farField.midTrees`
 *    allotted over the polygons by area × visibility; plantations (landuse=forest) in contour
 *    rows (FOREST.rows), natural woods and gardens on a stratified jittered lattice, scrub as
 *    shrubs; point-in-polygon, the scatter's exclusions (`treeSiteBlocked`), the species by
 *    `TREE_MIX[kind]` (a cherry only within `edgeM` of the edge — the aerial's pink fringes),
 *    bamboo clumps where the settlement mask is strong (the village edges), and the hedge shrubs
 *    along the polygon rings (FOREST.hedge, `Quality.farField.trees.shrubs`). The stems nearest
 *    the track (`heroPerCell` per cell, `nearTrees` in all) are the heroes. All of it goes
 *    through `emitTrees` (trees.ts): per species the LOD mesh buckets and one card mesh per
 *    cell on the high tier with the pack, the mid-detail cones otherwise (Node, the low tier).
 *  - the CHERRY ROWS (job C, `forestRows-<cell>`): a tree every FOREST.cherryRows.pitch m on both
 *    sides of サーキット道路 and of every road within `gateR` of a circuit gate, just outside the
 *    road's keep-out, TREE_MIX.roadside, heroes inside 300 m of the track.
 *
 * Draws: per visible cell 1 mass or (1 floor + ≤ species × 1 bucket + 1 card mesh). The
 * trackside scatter (vegetation.ts) stays the near band inside 500 m; it is denser inside these
 * polygons, so the wall of trees continues to the fence where the lids stop.
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
  /** m, the ring's length */
  perimeter: number
  /** the ring's centroid (world XZ) */
  cx: number
  cz: number
  /** ring winding: +1 when the signed area in XZ is positive (the outward normal of a tangent (tx, tz) is then (tz, −tx)) */
  winding: 1 | -1
  dmin: number
  h0: number
  /** share of bare crowns on the lid */
  bare: number
  /** the OSM area × the share of its bounding box inside the terrain grid (where stems can stand) */
  areaInGrid: number
  /** stems allotted to this polygon */
  stems: number
  /** hedge shrubs allotted to this polygon's ring */
  shrubs: number
  /** OSM says bamboo (wood=bamboo / leaf_type=bamboo) — every stem is a clump */
  bamboo: boolean
  seed: number
}

export interface ForestStats {
  polygons: number
  cells: number
  jobs: number
  stemsPlanned: number
  shrubsPlanned: number
  /** cherry-row candidates (both sides, before the site checks) and the ways they walk */
  rowSites: number
  rowWays: number
}

const _p = new THREE.Vector3()
const _c = new THREE.Color()

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
    let signed = 0, cx = 0, cz = 0
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, az] = ring[i]!, [bx, bz] = ring[(i + 1) % n]!
      signed += ax * bz - bx * az
      cx += ax
      cz += az
    }
    const bamboo = f.tags.wood === 'bamboo' || f.tags.leaf_type === 'bamboo'
    out.push({
      id: f.id, kind, ring, box: ringBBox(ring), area: f.area, perimeter: pathLength(ring, true), cx: cx / ring.length, cz: cz / ring.length,
      winding: signed >= 0 ? 1 : -1, areaInGrid: f.area, dmin: f.dmin, h0: FOREST.canopyH0[kind], bare: FOREST.bareShare[kind], stems: 0, shrubs: 0, bamboo, seed: f.id | 0,
    })
  }
  for (const f of SUR_FOREST) add(f, false)
  for (const f of SUR_SCRUB) add(f, true)
  return out
}

/** the share of a polygon's bounding box inside the terrain rectangle (where its stems can stand) */
function gridShare(p: ForestPoly, grid: GridShape): number {
  const [bx0, bz0, bx1, bz1] = p.box
  const ix = Math.max(0, Math.min(bx1, grid.x0 + grid.w) - Math.max(bx0, grid.x0))
  const iz = Math.max(0, Math.min(bz1, grid.z0 + grid.d) - Math.max(bz0, grid.z0))
  return ((bx1 - bx0) * (bz1 - bz0)) > 0 ? (ix * iz) / ((bx1 - bx0) * (bz1 - bz0)) : 0
}

/** visibility weight of a polygon: 1 at the track, falling to `floor` at `far` metres */
function visibility(p: ForestPoly): number {
  const { far, floor } = FOREST.visibility
  return Math.max(floor, 1 - p.dmin / far)
}

/**
 * `midTrees` over the polygons by area × visibility weight. Only the part of a polygon inside
 * the terrain rectangle counts (the share of its bounding box inside it — the stems are placed
 * there only), so a wood that is mostly beyond the grid does not take stems it cannot stand.
 * Scrub takes half the density of a wood (its stems are shrubs).
 */
function allotStems(polys: ForestPoly[], midTrees: number, grid: GridShape) {
  let sum = 0
  const w = polys.map((p) => {
    p.areaInGrid = Math.max(1, p.area * gridShare(p, grid))
    const v = visibility(p) * (p.kind === 'scrub' ? 0.5 : 1)
    sum += v * p.areaInGrid
    return v * p.areaInGrid
  })
  if (sum <= 0) return
  // the lattice's yield after the exclusions (drawn faces, the 44 m band, keep-outs, the bbox share) is ≈ 0.75
  polys.forEach((p, i) => { p.stems = Math.round((midTrees * w[i]!) / (sum * 0.75)) })
}

/** the tier's hedge shrubs over the polygons by perimeter × visibility (the ring's share inside the grid, like the stems) */
function allotShrubs(polys: ForestPoly[], shrubs: number, grid: GridShape) {
  let sum = 0
  const w = polys.map((p) => {
    const v = visibility(p) * p.perimeter * gridShare(p, grid)
    sum += v
    return v
  })
  if (sum <= 0) return
  polys.forEach((p, i) => { p.shrubs = Math.round((shrubs * w[i]!) / sum) })
}

// ---------------------------------------------------------------------------------------------
// the species per polygon kind

const MIX_OF: Record<ForestKind, TreeMixKind> = { wood: 'wood', plantation: 'plantation', garden: 'garden', scrub: 'scrub' }

/** the roles whose crown is not green in late March (the bare / blossom share of the lid mosaic) */
const BARE_ROLES: ReadonlySet<TreeRole> = new Set<TreeRole>(['keyakiBare', 'budding', 'sakura', 'sakuraB'])

interface HSL { h: number; s: number; l: number }

/**
 * The lid's two colour centres per polygon kind — the evergreen and the bare crowns — as the
 * TREE_MIX-weighted mean of the species' crown colours (linear working space, like the vertex
 * colours), so the mass beyond the stem range matches the cards it replaces. A kind whose mix
 * has no bare (or no evergreen) species borrows keyaki (sugi).
 */
const CENTRES = new Map<ForestKind, { ever: HSL; bare: HSL }>()
function centresOf(kind: ForestKind): { ever: HSL; bare: HSL } {
  let c = CENTRES.get(kind)
  if (c) return c
  const mean = (bare: boolean, fallback: TreeRole): HSL => {
    const acc = new THREE.Color(0, 0, 0)
    let sum = 0
    for (const [role, w] of Object.entries(TREE_MIX[MIX_OF[kind]]) as [TreeRole, number][]) {
      if (!(w > 0) || BARE_ROLES.has(role) !== bare) continue
      _c.set(TREE_SPECIES[role].crown)
      acc.r += _c.r * w
      acc.g += _c.g * w
      acc.b += _c.b * w
      sum += w
    }
    if (sum > 0) acc.multiplyScalar(1 / sum)
    else acc.set(TREE_SPECIES[fallback].crown)
    return acc.getHSL({ h: 0, s: 0, l: 0 })
  }
  const ever = mean(false, 'sugi'), bare = mean(true, 'keyakiBare')
  // hue and saturation follow the species; the LIGHTNESS stays the value calibrated against the
  // late-March z16 aerial (the lid is a lit canopy seen from above, not a card's albedo — the
  // crown hexes are ≈ 2 stops darker than what the aerial reads at that scale)
  const lit = LID_LIGHTNESS[kind]
  ever.l = lit.ever
  bare.l = lit.bare
  CENTRES.set(kind, (c = { ever, bare }))
  return c
}

/** the lid lightness centres (linear HSL L) per polygon kind, from the aerial calibration */
const LID_LIGHTNESS: Record<ForestKind, { ever: number; bare: number }> = {
  wood: { ever: 0.2, bare: 0.295 },
  plantation: { ever: 0.19, bare: 0.29 },
  garden: { ever: 0.21, bare: 0.3 },
  scrub: { ever: 0.25, bare: 0.31 },
}

// ---------------------------------------------------------------------------------------------
// the plantation rows

/** the lattice frame of a polygon's stems: origin, the row axis (unit) and the across axis (unit, ⊥) */
interface RowFrame { ox: number; oz: number; ax: number; az: number; bx: number; bz: number }

/**
 * The row frame of a plantation: rows follow the contour, i.e. the axis is ⊥ the ground's
 * gradient at the polygon centroid (`standY` sampled ± 30 m — the slope of the hillside, not of
 * one terrace); on flat ground (< 1 % over 60 m) the polygon's principal axis (the longer
 * covariance eigenvector of its vertices) so a field's rows run along the field.
 */
function rowFrame(p: ForestPoly, standY: (x: number, z: number) => number): RowFrame {
  const R = 30
  const gx = (standY(p.cx + R, p.cz) - standY(p.cx - R, p.cz)) / (2 * R)
  const gz = (standY(p.cx, p.cz + R) - standY(p.cx, p.cz - R)) / (2 * R)
  let ax: number, az: number
  const g = Math.hypot(gx, gz)
  if (g >= 0.01) {
    ax = -gz / g
    az = gx / g
  } else {
    let sxx = 0, szz = 0, sxz = 0
    for (const [x, z] of p.ring) {
      const dx = x - p.cx, dz = z - p.cz
      sxx += dx * dx
      szz += dz * dz
      sxz += dx * dz
    }
    // the eigenvector of the larger eigenvalue of [[sxx, sxz], [sxz, szz]]
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    ax = Math.cos(theta)
    az = Math.sin(theta)
  }
  return { ox: p.cx, oz: p.cz, ax, az, bx: -az, bz: ax }
}

// ---------------------------------------------------------------------------------------------
// the cherry rows (job C): the candidate sites, computed once and bucketed per cell

interface RowSite {
  x: number
  z: number
  /** 1-Lipschitz lower bound of the centreline distance (the way's dLo minus the offset) */
  lo: number
  /** hash seed */
  k: number
}

/**
 * The ways the cherry rows follow (FOREST.cherryRows: by name, or a public road — rank ≥
 * `minRank`, no raceway — whose centroid lies within `gateR` of a circuit gate) walked at the
 * pitch, both sides at hw + offset — just outside the road's own keep-out ribbon — bucketed by
 * the far-field cell. The network is memoised per context
 * (roads.ts built it in the 'paving' plan), so this is a few thousand samples, synchronous.
 */
function cherryRowSites(ctx: EnvBuildContext): { byCell: Map<number, RowSite[]>; sites: number; ways: number } {
  const { track, farField } = ctx
  const rows = FOREST.cherryRows
  const enScale = track.enScale
  const gates = SUR_SITES.filter((s) => s.role === 'gate').map((s) => [s.centroid[0] * enScale, -s.centroid[1] * enScale] as XZ)
  const names = new Set<string>(rows.names)
  const isRow = (way: RoadWay): boolean => {
    if (way.row.tags.name && names.has(way.row.tags.name)) return true
    // the gate approaches: public roads only (the service drives and the kart raceways share the
    // gates' surroundings and would take ten times the trees)
    if (way.section.rank < rows.minRank || way.kind === 'raceway') return false
    const cx = way.row.centroid[0] * enScale, cz = -way.row.centroid[1] * enScale
    for (const [gx, gz] of gates) if (Math.hypot(cx - gx, cz - gz) < rows.gateR) return true
    return false
  }
  const byCell = new Map<number, RowSite[]>()
  let sites = 0, ways = 0
  for (const way of roadNetwork(ctx).ways) {
    if (!way.inGrid || !isRow(way)) continue
    ways++
    const lat = way.hw + rows.offset
    let k = 0
    for (const s of walk(way, rows.pitch, rows.pitch / 2)) {
      for (const side of [1, -1] as const) {
        const [x, z] = offsetAt(s, side * lat)
        const cell = farField.cellOf(x, z)
        let list = byCell.get(cell)
        if (!list) byCell.set(cell, (list = []))
        list.push({ x, z, lo: s.dLo - lat, k: (way.row.id * 4 + k * 2 + (side > 0 ? 0 : 1)) | 0 })
        sites++
      }
      k++
    }
  }
  return { byCell, sites, ways }
}

// ---------------------------------------------------------------------------------------------

/**
 * Queue the forest's deferred jobs (see the module comment). The lid and floor materials are
 * made here, synchronously, so the viewport's material setup covers them (the species
 * materials are the library's, made by `buildTreeLibrary` before this); the geometry is built
 * in the jobs. Returns the plan's counts for the offline harness.
 */
export function buildForest(ctx: EnvBuildContext): ForestStats {
  const { track, terrain, ground, quality: q, farField } = ctx
  const grid: GridShape = terrain.grid()
  const polys = forestPolys(track.enScale)
  allotStems(polys, q.farField.midTrees, grid)
  allotShrubs(polys, q.farField.trees.shrubs, grid)

  // --- materials -----------------------------------------------------------------------------
  const canopy = canopyMaps()
  const canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: canopy.map, normalMap: canopy.normalMap, normalScale: new THREE.Vector2(0.55, 0.55) })
  canopyMat.map!.repeat.set(1 / FOREST.canopyTileM, 1 / FOREST.canopyTileM)
  canopyMat.normalMap!.repeat.copy(canopyMat.map!.repeat)
  const floorMat = new THREE.MeshStandardMaterial({ color: FOREST.floorColour, roughness: 1, metalness: 0, map: litterMap() })
  floorMat.map!.repeat.set(1 / FOREST.floorTileM, 1 / FOREST.floorTileM)
  const castShadow = q.farField.shadows

  // --- the cells -------------------------------------------------------------------------------
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M)), ncz = Math.max(1, Math.ceil(grid.d / FAR_CELL_M))
  const cache: NodeCache = makeNodeCache(grid)
  track.enToWorld(FERRIS_WHEEL.en[0], FERRIS_WHEEL.en[1], _p)
  const wheel = { x: _p.x, z: _p.z }
  const stemRange = FOREST.stems.range
  const stemLevel = { cardsRange: stemRange, cardsRamp: FOREST.stems.ramp, castShadow }
  let cells = 0, jobs = 0, stemsPlanned = 0, shrubsPlanned = 0
  for (const p of polys) {
    stemsPlanned += p.stems
    shrubsPlanned += p.shrubs
  }
  const rows = cherryRowSites(ctx)

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
  // the tier's hero total (`nearTrees`) goes to the cells nearest the track first, ≤ heroPerCell
  // each (the library ignores the flag in cone mode)
  if (q.farField.heroPerCell > 0) {
    let budget = q.farField.nearTrees
    const nearest = (c: CellPlan) => Math.min(...c.here.map((p) => (p.stems > 0 ? p.dmin : Infinity)))
    for (const c of plans.slice().sort((a, b) => nearest(a) - nearest(b))) {
      if (nearest(c) === Infinity) break
      c.heroAllow = Math.min(q.farField.heroPerCell, budget)
      budget -= c.heroAllow
      if (budget <= 0) break
    }
  }

  /** the placement of a stem: yaw, height, tint and seed from a generator seeded by its site */
  const placement = (role: TreeRole, x: number, y: number, z: number, hero: boolean, seedA: number, seedB: number): TreePlacement => {
    const rng = mulberry((seedA ^ Math.round(x * 7 + z * 13) ^ Math.imul(seedB, 0x9e3779b1)) >>> 0)
    const species = TREE_SPECIES[role]
    const yaw = rng() * Math.PI * 2
    const height = pickHeight(species, rng())
    const tint = pickTint(species, rng(), rng(), rng())
    return { role, x, y, z, yaw, height, tint, hero, seed: Math.floor(rng() * 0x7fffffff) }
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

      // --- job B: the stems, hedges and bamboo of this cell -----------------------------------
      if (!here.some((p) => p.stems > 0 || p.shrubs > 0)) continue
      jobs++
      farField.defer('forest', `forestStems-${cell}`, 20, () => {
        interface Stem { x: number; z: number; d: number; role: TreeRole; p: ForestPoly }
        const stems: Stem[] = []
        const settleMin = FOREST.bamboo.settleMin
        /** one lattice site: the shared rejections, then the species */
        const site = (p: ForestPoly, x: number, z: number, i: number, j: number) => {
          if (x < x0 || x >= x1 || z < z0 || z >= z1) return
          if (!inBBox(x, z, p.box) || !pointInRing(x, z, p.ring)) return
          if (farField.cellOf(x, z) !== cell) return
          if (ground.builtY(x, z)) return
          const near = ground.plan.project(x, z)
          if (near.d < FOREST.stems.minD || treeSiteBlocked(ctx, x, z, near, wheel)) return
          let role: TreeRole
          // bamboo where the polygon says so, or on the village edges of a wood / scrub
          if (p.bamboo || ((p.kind === 'wood' || p.kind === 'scrub') && ctx.landCover.weightAt(x, z, 'settle') >= settleMin)) role = 'bamboo'
          else {
            role = pickRole(TREE_MIX[MIX_OF[p.kind]], hash2(i, j, p.seed + 23))
            // cherries stand on the wood's edge (the aerial's pink fringes), never deep inside
            if ((role === 'sakura' || role === 'sakuraB') && distToRing(x, z, p.ring) > FOREST.stems.edgeM) role = 'keyakiBare'
          }
          stems.push({ x, z, d: near.d, role, p })
        }
        for (const p of here) {
          if (p.stems <= 0) continue
          const spacing = Math.max(FOREST.stems.minSpacing, Math.sqrt(p.areaInGrid / p.stems))
          const wx0 = Math.max(p.box[0], x0), wx1 = Math.min(p.box[2], x1)
          const wz0 = Math.max(p.box[1], z0), wz1 = Math.min(p.box[3], z1)
          if (p.kind === 'plantation') {
            // contour rows: the lattice lives in the polygon's row frame, the cell's window
            // mapped into it through its four corners
            const f = rowFrame(p, ground.standY)
            const pa = spacing * FOREST.rows.pitchAlong, pb = spacing * FOREST.rows.pitchAcross, jit = spacing * FOREST.rows.jitter
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
            for (const [cx, cz] of [[wx0, wz0], [wx1, wz0], [wx0, wz1], [wx1, wz1]] as const) {
              const dx = cx - f.ox, dz = cz - f.oz
              const u = dx * f.ax + dz * f.az, v = dx * f.bx + dz * f.bz
              if (u < u0) u0 = u
              if (u > u1) u1 = u
              if (v < v0) v0 = v
              if (v > v1) v1 = v
            }
            const i0 = Math.floor(u0 / pa), i1 = Math.ceil(u1 / pa), j0 = Math.floor(v0 / pb), j1 = Math.ceil(v1 / pb)
            for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) {
                const u = i * pa + (hash2(i, j, p.seed) - 0.5) * 2 * jit, v = j * pb + (hash2(i, j, p.seed + 11) - 0.5) * 2 * jit
                site(p, f.ox + u * f.ax + v * f.bx, f.oz + u * f.az + v * f.bz, i, j)
              }
            }
          } else {
            // natural woods, gardens, scrub: the stratified jittered lattice
            const i0 = Math.floor(wx0 / spacing), i1 = Math.ceil(wx1 / spacing)
            const j0 = Math.floor(wz0 / spacing), j1 = Math.ceil(wz1 / spacing)
            for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) {
                site(p, (i + 0.05 + 0.9 * hash2(i, j, p.seed)) * spacing, (j + 0.05 + 0.9 * hash2(i, j, p.seed + 11)) * spacing, i, j)
              }
            }
          }
        }
        // the heroes: the stems nearest the track, up to the cell's and the tier's budgets
        const heroN = Math.min(heroAllow, stems.length)
        if (heroN > 0) stems.sort((a, b) => a.d - b.d)
        const list: TreePlacement[] = []
        let bamboo = 0
        for (let k = 0; k < stems.length; k++) {
          const s = stems[k]!
          if (s.role === 'bamboo') bamboo++
          list.push(placement(s.role, s.x, ground.standY(s.x, s.z), s.z, k < heroN, s.p.seed, 0))
        }
        // the hedges: shrubs along the ring, outside the edge, the polygon's share of the tier's
        // budget spent as an acceptance rate over the ring's sites
        let hedges = 0
        const H = FOREST.hedge
        for (const p of here) {
          if (p.shrubs <= 0) continue
          const sites = resample(p.ring, H.pitch, true)
          if (!sites.length) continue
          const take = Math.min(H.share, p.shrubs / sites.length)
          for (let k = 0; k < sites.length; k++) {
            const r = hash2(k, p.id, p.seed + 41)
            if (r >= take) continue
            const sm = sites[k]!
            // outward from the edge, biased to it (a fringe, not a clipped hedge)
            const t = hash2(k, p.id, p.seed + 43)
            const off = H.offset + t * t * (H.edgeBand - H.offset)
            const x = sm.x + p.winding * sm.tz * off, z = sm.z - p.winding * sm.tx * off
            if (x < x0 || x >= x1 || z < z0 || z >= z1 || !inGrid(grid, x, z)) continue
            if (farField.cellOf(x, z) !== cell) continue
            if (inBBox(x, z, p.box) && pointInRing(x, z, p.ring)) continue
            if (ground.builtY(x, z)) continue
            const near = ground.plan.project(x, z)
            if (near.d < FOREST.stems.minD || treeSiteBlocked(ctx, x, z, near, wheel)) continue
            list.push(placement('bush', x, ground.standY(x, z), z, false, p.seed, k + 1))
            hedges++
          }
        }
        const root = new THREE.Group()
        root.name = `forestStems-${cell}`
        const emitted = list.length ? emitTrees(ctx.trees, ctx, 'forest', cell, list, stemLevel) : { entries: 0, triangles: 0, cards: 0, cones: 0 }
        root.userData.stems = { count: stems.length, heroes: heroN, hedges, bamboo, ...emitted }
        return root
      })
    }
  }

  // --- job C: the cherry rows along the roads, per cell --------------------------------------
  for (const [cell, sites] of rows.byCell) {
    if (cell === farField.outsideCell) continue
    jobs++
    farField.defer('forest', `forestRows-${cell}`, 5, () => {
      const list: TreePlacement[] = []
      const minD = 140
      for (const s of sites) {
        if (!inGrid(grid, s.x, s.z)) continue
        if (ground.builtY(s.x, s.z)) continue
        // the exact projection only where the 1-Lipschitz bound does not settle the distance
        // rule (or the hero band); a synthetic site beyond 300 m never enters the near-track tests
        const near: TreeSite = s.lo < 300 ? ground.plan.project(s.x, s.z) : { s: 0, lateral: 0, d: s.lo }
        if (near.d < minD || treeSiteBlocked(ctx, s.x, s.z, near, wheel)) continue
        const role = pickRole(TREE_MIX.roadside, hash2(s.k, 7, 61))
        list.push(placement(role, s.x, ground.standY(s.x, s.z), s.z, near.d < 300, s.k, 3))
      }
      const root = new THREE.Group()
      root.name = `forestRows-${cell}`
      const emitted = list.length ? emitTrees(ctx.trees, ctx, 'forestRows', cell, list, stemLevel) : { entries: 0, triangles: 0, cards: 0, cones: 0 }
      root.userData.rows = { count: list.length, candidates: sites.length, ...emitted }
      return root
    })
  }
  return { polygons: polys.length, cells, jobs, stemsPlanned, shrubsPlanned, rowSites: rows.sites, rowWays: rows.ways }
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
 * (warm grey-brown twigs, lighter than the evergreens from above), the rest evergreen with a
 * per-polygon hue drift. The two centres are the polygon kind's TREE_MIX-weighted mean crown
 * colours (`centresOf`, linear like every other reading of `crown`, so the mass matches the
 * cards and cones it replaces at the stem range); the jitter keeps the widths calibrated
 * against the late-March z16 aerial — absolute in hue, relative in saturation and lightness
 * (± 20–30 % of the centre), so the mosaic's contrast is the same whatever the centre.
 */
function crownColour(x: number, z: number, p: ForestPoly, out: THREE.Color): THREE.Color {
  const patch = fbm2(x, z, FOREST.patchPeriod, p.seed + 101)
  const j1 = hash2(Math.round(x * 4), Math.round(z * 4), p.seed + 5)
  const j2 = hash2(Math.round(x * 4), Math.round(z * 4), p.seed + 6)
  const hueDrift = (hash2(p.seed, 3, 9) - 0.5) * 0.03
  const { ever, bare: bareC } = centresOf(p.kind)
  // the noise clusters around 0.5: this threshold gives ≈ the wanted bare share
  const bare = patch > 0.5 + (0.5 - p.bare) * 0.45
  if (bare) return out.setHSL(bareC.h + (j1 - 0.5) * 0.03, bareC.s * (1 + (j2 - 0.5) * 0.6), bareC.l * (1 + (patch - 0.5) * 0.3))
  return out.setHSL(ever.h + (j1 - 0.5) * 0.07 + hueDrift, ever.s * (1 + (j2 - 0.5) * 0.42), ever.l * (1 + (patch - 0.5) * 0.27 + (j1 - 0.5) * 0.18))
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
