import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FERRIS_WHEEL, SEASON, SEASONS } from '~/data/suzuka-facilities-spec'
import { SUR_FOREST } from '~/data/suzuka-surroundings'
import { TREE_MIX, TREE_SPECIES } from '~/data/tree-species'
import { worldRing } from '~/data/en-codec'
import { infieldTreePlacements, type InfieldTreePlacement } from '~/data/infield-trees'
import type { EnvBuildContext } from './environment'
import { inBBox, pointInRing, ringBBox, ringFromFlat, type XZ } from './far-geometry'
import { KeepOutGrid } from './far-lines'
import type { OwnerKind } from './ground-plan'
import { insideRing } from './infield-lod'
import { emitTrees, pickHeight, pickRole, pickTint, type TreePlacement } from './trees'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()

/**
 * Ferris wheel (the Suzuka landmark beside the main straight). The returned group is added to
 * `group`; its child named 'wheel' turns (the caller animates it), so it must be kept out of
 * `freezeStatic`.
 */
export function buildFerrisWheel(ctx: EnvBuildContext): THREE.Group {
  const { track, ground, group } = ctx
  const ferrisWheel = new THREE.Group()
  {
    // the real サーキットホイール: OSM footprint centroid behind the final-corner stands, 50.4 m
    // high, 48 m across, 36 gondolas (see FERRIS_WHEEL); it stands on ground ~7.6 m above the track
    track.enToWorld(FERRIS_WHEEL.en[0], FERRIS_WHEEL.en[1], _p)
    const groundY = ground.standY(_p.x, _p.z)
    ferrisWheel.position.set(_p.x, groundY, _p.z)
    // the wheel's plane faces NW–SE in the aerial; aligning it with the track heading turned it
    // ≈ 90° away from the real one (2026-09 audit)
    const b = (FERRIS_WHEEL.bearingDeg * Math.PI) / 180
    const along = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b))
    _m.makeBasis(new THREE.Vector3(-along.z, 0, along.x), new THREE.Vector3(0, 1, 0), along)
    ferrisWheel.quaternion.setFromRotationMatrix(_m)
    const R = FERRIS_WHEEL.diameter / 2
    const hub = FERRIS_WHEEL.height - R
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5, metalness: 0.3 })
    const wheel = new THREE.Group()
    wheel.name = 'wheel'
    wheel.position.set(0, hub, 0)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.7, 8, 48), whiteMat)
    const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 3, 0.4, 8, 48), whiteMat)
    rim.castShadow = true
    wheel.add(rim, rim2)
    const spokeGeo = new THREE.BoxGeometry(0.4, R * 2, 0.4)
    const gondolaGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6)
    const colors = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffb703, 0x8ecae6]
    for (let i = 0; i < 12; i++) {
      const spoke = new THREE.Mesh(spokeGeo, whiteMat)
      spoke.rotation.z = (i / 12) * Math.PI
      wheel.add(spoke)
    }
    for (let i = 0; i < FERRIS_WHEEL.gondolas; i++) {
      const a = (i / FERRIS_WHEEL.gondolas) * Math.PI * 2
      const g = new THREE.Mesh(gondolaGeo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.4 }))
      g.position.set(Math.cos(a) * R, Math.sin(a) * R, 0)
      g.name = 'gondola'
      wheel.add(g)
    }
    ferrisWheel.add(wheel)
    const legGeo = new THREE.BoxGeometry(1.2, hub * 1.08, 1.2)
    for (const [dx, dz] of [[-14, 3], [14, 3], [-14, -3], [14, -3]]) {
      const leg = new THREE.Mesh(legGeo, whiteMat)
      leg.position.set(dx! / 2, hub / 2, dz!)
      leg.rotation.z = dx! > 0 ? -0.3 : 0.3
      leg.castShadow = true
      ferrisWheel.add(leg)
    }
    group.add(ferrisWheel)
  }
  return ferrisWheel
}

/** Fill (or add) a constant `color` attribute so the merged prototype can carry a per-part tint mask. */
function tinted(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = (g.attributes.position as THREE.BufferAttribute).count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = r
    col[i * 3 + 1] = gr
    col[i * 3 + 2] = b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

/**
 * One instanced prototype per silhouette, trunk included. The trunk is merged into the canopy
 * and told apart by a vertex-colour mask that the per-instance tint multiplies: the canopy
 * vertices are white (so they take the instance colour as is) and the trunk a warm brown
 * (dark green × brown = a dark trunk, pink × brown = a cherry's dark bark). One geometry per
 * kind is what keeps the draw count at what the old single evergreen cost.
 *
 * `detail` 'mid' is the far field's stem (forest.ts): the same silhouette at a quarter of the
 * triangles (one open cone / one faceted crown on an open trunk, ≈ 20–40 triangles) for the
 * thousands of stems inside the stem range.
 */
export function treePrototype(kind: 'evergreen' | 'deciduous', detail: 'full' | 'mid' = 'full'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  if (detail === 'mid') {
    if (kind === 'evergreen') {
      const cone = new THREE.ConeGeometry(3.0, 9, 6, 1, true)
      cone.translate(0, 7.5, 0)
      parts.push(tinted(cone, 1, 1, 1))
      const trunk = new THREE.CylinderGeometry(0.3, 0.45, 3.5, 5, 1, true)
      trunk.translate(0, 1.75, 0)
      parts.push(tinted(trunk, 1.0, 0.72, 0.5))
    } else {
      const trunk = new THREE.CylinderGeometry(0.14, 0.24, 4.4, 5, 1, true)
      trunk.translate(0, 2.2, 0)
      parts.push(tinted(trunk, 0.42, 0.3, 0.22))
      const crown = new THREE.IcosahedronGeometry(1.9, 0)
      crown.scale(1.1, 0.9, 1)
      crown.translate(0, 5.8, 0)
      parts.push(tinted(crown, 1, 1, 1))
      const crown2 = new THREE.IcosahedronGeometry(1.2, 0)
      crown2.translate(0.9, 4.9, 0.7)
      parts.push(tinted(crown2, 1, 1, 1))
    }
    // the icosahedra are non-indexed, the cones / cylinders indexed: merge on one footing
    return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!
  }
  if (kind === 'evergreen') {
    // cedar / cypress: two stacked cones on a stout trunk
    const c1 = new THREE.ConeGeometry(3.2, 7, 7)
    c1.translate(0, 6.5, 0)
    const c2 = new THREE.ConeGeometry(2.4, 5, 7)
    c2.translate(0, 9.5, 0)
    parts.push(tinted(c1, 1, 1, 1), tinted(c2, 1, 1, 1))
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 6)
    trunk.translate(0, 2, 0)
    // lighter than the deciduous bark: it is multiplied by a very dark canopy tint
    parts.push(tinted(trunk, 1.0, 0.72, 0.5))
  } else {
    // bare / budding broadleaf or cherry: a thin trunk, three leaning branches and a loose
    // crown of four blobs — sparse enough to read as twigs when grey-brown, full enough to
    // read as blossom when pink
    const trunk = new THREE.CylinderGeometry(0.14, 0.24, 4.4, 6)
    trunk.translate(0, 2.2, 0)
    parts.push(tinted(trunk, 0.42, 0.3, 0.22))
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4
      const br = new THREE.CylinderGeometry(0.05, 0.1, 2.6, 5)
      br.translate(0, 1.3, 0)
      br.rotateZ(0.55)
      br.rotateY(a)
      br.translate(0, 4.1, 0)
      parts.push(tinted(br, 0.42, 0.3, 0.22))
    }
    const blobs: [number, number, number, number][] = [
      [0, 6.1, 0, 1.6],
      [1.15, 5.4, 0.3, 1.25],
      [-0.9, 5.6, -0.8, 1.2],
      [0.2, 5.3, 1.15, 1.1],
    ]
    for (const [x, y, z, r] of blobs) {
      const b = new THREE.SphereGeometry(r, 6, 4)
      b.translate(x, y, z)
      parts.push(tinted(b, 1, 1, 1))
    }
  }
  return mergeGeometries(parts, false)!
}

/** the trackside scatter's projection of a candidate (ground.plan.project) */
export interface TreeSite {
  s: number
  lateral: number
  d: number
}

/**
 * `ctx.keepOut` / `ctx.keepOutPolys` hashed per build context (far-lines.ts KeepOutGrid): the
 * road ribbons alone leave tens of thousands of quads, and the scatter tests every candidate.
 * `sync` is two length compares, so it runs per call — the producers push between the deferred
 * jobs, and the forest's jobs come after every producer's stage.
 */
const KEEP_OUTS = new WeakMap<EnvBuildContext, KeepOutGrid>()

function keepOutsOf(ctx: EnvBuildContext): KeepOutGrid {
  let g = KEEP_OUTS.get(ctx)
  if (!g) KEEP_OUTS.set(ctx, (g = new KeepOutGrid()))
  g.sync(ctx.keepOut, ctx.keepOutPolys)
  return g
}

/** land-cover classes no tree stands on: a road (the mask is narrowed under the ribbons but still paved), a car park, water */
const TREELESS_COVER = new Set(['paved', 'parking', 'water'])

/** The forest polygons per build context (decoded once; `treeSiteBlocked` and the scatter share them). */
const FOREST_RINGS = new WeakMap<EnvBuildContext, { ring: XZ[]; box: [number, number, number, number] }[]>()
function forestRingsOf(ctx: EnvBuildContext) {
  let r = FOREST_RINGS.get(ctx)
  if (!r) FOREST_RINGS.set(ctx, (r = forestRings(ctx.track.enScale)))
  return r
}

/** whether world (x, z) lies inside a SUR_FOREST polygon */
export function inForest(ctx: EnvBuildContext, x: number, z: number): boolean {
  for (const f of forestRingsOf(ctx)) if (inBBox(x, z, f.box) && pointInRing(x, z, f.ring)) return true
  return false
}

/**
 * Where no tree may stand — the one rule the trackside scatter (`buildTrees`) and the forest's
 * stems (forest.ts) share: inside 44 m of the centreline, the pit / paddock band, the
 * grandstands' footprints (plus 26 m behind, 4 m for a spectator bank), 60 m around the Ferris wheel, the keep-out
 * discs and polygons the building / paving builders leave in the context, and the paved /
 * parking / water classes of the land-cover mask. `near` is the candidate's projection
 * (computed once by the caller, it is the expensive part).
 */
export function treeSiteBlocked(ctx: EnvBuildContext, x: number, z: number, near: TreeSite, wheel: { x: number; z: number }): boolean {
  if (near.d < 44) return true
  if (near.d < 200) {
    const s = near.s
    const inPitZone = s >= 5540 || s <= 90
    if (inPitZone && near.lateral > -125 && near.lateral < 80) return true
    for (const { from, to, side, lateralBack, pad } of ctx.standZones) {
      const inS = from < to ? s >= from - 15 && s <= to + 15 : s >= from - 15 || s <= to + 15
      if (inS && Math.sign(near.lateral) === side && Math.abs(near.lateral) < lateralBack + (pad ?? 26)) return true
    }
  }
  if (Math.hypot(x - wheel.x, z - wheel.z) < 60) return true
  // inside the perimeter fence (the sports_centre ring 775428456) the trees are a table,
  // INFIELD_TREES (plan I5-c): the scatter only plants there inside the OSM woods
  if (insideRing(ctx.track, x, z) && !inForest(ctx, x, z)) return true
  // buildings and paving placed by the other builders
  if (keepOutsOf(ctx).hit(x, z)) return true
  // the mask's own roads, car parks and water (the ribbons' keep-outs stop at the grid; the mask reaches the ring)
  return TREELESS_COVER.has(ctx.landCover.classAt(x, z))
}

/** The forest polygons (SUR_FOREST) as world rings with their bounding boxes, decoded once per build. */
export function forestRings(enScale: number): { ring: XZ[]; box: [number, number, number, number] }[] {
  return SUR_FOREST.map((f) => {
    const ring = ringFromFlat(worldRing(f, enScale))
    return { ring, box: ringBBox(ring) }
  })
}

/**
 * The trackside scatter: trees inside 500 m of the centreline — the band the broadcast cameras
 * see, where the far field's canopy masses are not drawn (plan §2a: the lids stop 60 m out and
 * hide inside the stem range). Species by TREE_MIX.scatter (late March: pines, sugi, camphor,
 * bare and budding keyaki, a stray cherry), TREE_MIX.cherryZone where the photos show the
 * cherries — around the hairpin, outside the S-curves, in the park behind the main grandstand
 * and the main gate. `quality.trees` instances, kept off the track, the pit / paddock zone, the
 * grandstands, the Ferris wheel and the keep-outs (`treeSiteBlocked`); a candidate inside a
 * SUR_FOREST polygon is accepted eight times as readily as one outside (× 4 inside, × 0.5
 * outside against the old uniform scatter), so the woods stand as a dense wall up to the fence
 * at Degner, Spoon and 130R while the open ground stays open. Placement draws from `rng` in a
 * fixed order (position, density, thinning, role, yaw, height, tint × 3, seed — seven draws per
 * placed tree), so the caller's seeded generator decides the woods; run this after the Ferris
 * wheel is placed.
 *
 * The work is a deferred 'forest' job (after the keep-out producers of the 'buildings' stage):
 * the placements are bucketed per far-field cell and handed to `emitTrees` (trees.ts), which
 * registers the LOD buckets and the impostor cards — or, without the pack (Node, the low tier),
 * the mid-detail cones — so the follow cameras and the cascades cull the far side of the
 * circuit. Trees inside 120 m of the centreline are the heroes (LOD0 in the camera band).
 */
export function buildTrees(ctx: EnvBuildContext, ferrisWheel: THREE.Group) {
  const { track, ground, quality, rng, farField } = ctx
  const season = SEASONS[SEASON]
  const count = quality.trees
  const wheelPos = ferrisWheel.position
  const rows = infieldTreePlacements(track)
  farField.defer('forest', 'trees', 250, () => {
    const lib = ctx.trees
    const b = track.bounds
    const forests = forestRingsOf(ctx)
    const byCell = new Map<number, TreePlacement[]>()
    let placed = 0
    let tries = 0
    // the infield's own rows first (INFIELD_TREES, the same expansion the guard checks), so
    // their entries stand whatever the scatter's budget does
    const infield = emitInfieldTrees(ctx, 'infield-trees', rows.filter((p) => !p.row.deferred))
    // the park / main gate lie 150–450 m behind the main grandstand — beyond the 200 m reach of
    // the track search below, so they are tested against three anchor points instead
    const park = [5550, 5750, 80].map((s) => track.pointAt(s, 300, new THREE.Vector3()))
    const inCherryZone = (x: number, z: number, near: TreeSite): boolean => {
      if (near.d < 200) {
        if (near.s >= 2600 && near.s <= 2800) return true
        if (near.s >= 1000 && near.s <= 1400 && near.lateral > 0) return true
      }
      for (const p of park) if (Math.hypot(x - p.x, z - p.z) < 190) return true
      return false
    }
    const inForestAt = (x: number, z: number): boolean => {
      for (const f of forests) if (inBBox(x, z, f.box) && pointInRing(x, z, f.ring)) return true
      return false
    }
    while (placed < count && tries < count * 60) {
      tries++
      const x = rng.range(b.minX - 420, b.maxX + 420)
      const z = rng.range(b.minZ - 380, b.maxZ + 380)
      // density by land cover first (cheap), the projection (expensive) only for the survivors
      const wooded = inForestAt(x, z)
      if (!wooded && rng.next() < 0.875) continue
      const near = ground.plan.project(x, z)
      if (near.d >= 500) continue
      if (treeSiteBlocked(ctx, x, z, near, wheelPos)) continue
      // trees stand on bare terrain, never on a drawn ground face
      if (ground.builtY(x, z)) continue
      // thinner right beside the fences outside the woods
      if (!wooded && near.d < 120 && rng.next() < 0.55) continue
      // species: the scatter mix, the cherry mix inside the zones (a cherry is rare elsewhere)
      const mix = season.trees.blossom > 0 && inCherryZone(x, z, near) ? TREE_MIX.cherryZone : TREE_MIX.scatter
      const role = pickRole(mix, rng.next())
      const species = TREE_SPECIES[role]
      const y = ground.standY(x, z)
      const yaw = rng.next() * Math.PI * 2
      const height = pickHeight(species, rng.next())
      const tint = pickTint(species, rng.next(), rng.next(), rng.next())
      const seed = Math.floor(rng.next() * 0x7fffffff)
      // the camera band: the trees the follow cameras pass at close range take the full LOD0
      const hero = near.d < 120
      const cell = farField.cellOf(x, z)
      let list = byCell.get(cell)
      if (!list) byCell.set(cell, (list = []))
      list.push({ role, x, y, z, yaw, height, tint, hero, seed })
      placed++
    }
    // one bucket set per cell and species so the follow cameras and the cascades cull the far
    // side of the circuit; the cards reach any distance (the scatter has no canopy mass behind it)
    const root = new THREE.Group()
    root.name = 'trees'
    const sum = { entries: 0, triangles: 0, cards: 0, cones: 0 }
    for (const [cell, list] of byCell) {
      const r = emitTrees(lib, ctx, 'trees', cell, list, { cardsRange: Infinity, castShadow: quality.treeShadows })
      sum.entries += r.entries
      sum.triangles += r.triangles
      sum.cards += r.cards
      sum.cones += r.cones
    }
    root.userData.trees = { placed, tries, cells: byCell.size, mode: lib.mode, infield, ...sum }
    return root
  })
  // the south course's rows: the one deferred job of the infield (plan §横断 3), after the scatter
  farField.defer('forest', 'infield-south-trees', 400, () => {
    const root = new THREE.Group()
    root.name = 'infield-south-trees'
    root.userData.trees = emitInfieldTrees(ctx, 'infield-south-trees', rows.filter((p) => p.row.deferred === 'south'))
    return root
  })
}

/**
 * The drawn ground kinds no infield tree stands on (a row that lands on one is a data fault;
 * counted, not planted): every paved, lane, water and gravel face — the car parks ('paddock')
 * and the gravel pads / shore paths ('gravelArea') included since the I5 review (F3: five rows
 * planted on them). A 'grassArea' island is plantable.
 */
const TREELESS_FACES = new Set<OwnerKind>(['road', 'kerb', 'deckShoulder', 'pitLane', 'pitApron', 'lane', 'asphaltArea', 'turf', 'helipad', 'water', 'gravelBand', 'asphaltBand', 'paddock', 'gravelArea'])

/**
 * Plant INFIELD_TREES placements (app/data/infield-trees.ts) under `name`: one `emitTrees`
 * call per far-field cell, the species' height / tint / yaw drawn from the placement's own
 * seed (so a row is the same in every build, and the scatter's rng is untouched), heroes
 * inside 120 m of the lap like the scatter's (or the row's `hero`). A placement over a paved,
 * lane or water face (TREELESS_FACES), or inside an INFIELD_FACILITIES footprint
 * (`ctx.infieldFootprints`: no tree grows through a marquee or a hut — the I5 review, F3), is
 * skipped and counted in `stats.infield['<name>Skipped']`.
 */
function emitInfieldTrees(ctx: EnvBuildContext, name: string, placements: InfieldTreePlacement[]): { placed: number; skipped: number; cells: number; entries: number; triangles: number } {
  const { ground, quality, farField } = ctx
  const lib = ctx.trees
  const inFacility = (x: number, z: number) => ctx.infieldFootprints.some((f) => x >= f.box[0] && x <= f.box[2] && z >= f.box[1] && z <= f.box[3] && pointInRing(x, z, f.ring))
  const byCell = new Map<number, TreePlacement[]>()
  let placed = 0, skipped = 0
  const u = (seed: number, k: number) => {
    let t = (seed + k * 0x9e3779b1) | 0
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (const p of placements) {
    const face = ground.builtY(p.x, p.z)
    if ((face && TREELESS_FACES.has(face.kind)) || inFacility(p.x, p.z)) { skipped++; continue }
    const species = TREE_SPECIES[p.role]
    const y = ground.standY(p.x, p.z)
    const height = pickHeight(species, u(p.seed, 1))
    const tint = pickTint(species, u(p.seed, 2), u(p.seed, 3), u(p.seed, 4))
    const hero = p.row.hero ?? p.d < 120
    const cell = farField.cellOf(p.x, p.z)
    let list = byCell.get(cell)
    if (!list) byCell.set(cell, (list = []))
    list.push({ role: p.role, x: p.x, y, z: p.z, yaw: u(p.seed, 0) * Math.PI * 2, height, tint, hero, seed: p.seed })
    placed++
  }
  let entries = 0, triangles = 0
  for (const [cell, list] of byCell) {
    const r = emitTrees(lib, ctx, name, cell, list, { cardsRange: Infinity, castShadow: quality.treeShadows })
    entries += r.entries
    triangles += r.triangles
  }
  ctx.infieldStats[name] = (ctx.infieldStats[name] ?? 0) + placed
  ctx.infieldStats[`${name}Skipped`] = (ctx.infieldStats[`${name}Skipped`] ?? 0) + skipped
  return { placed, skipped, cells: byCell.size, entries, triangles }
}
