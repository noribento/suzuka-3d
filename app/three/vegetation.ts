import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FERRIS_WHEEL, SEASON, SEASONS } from '~/data/suzuka-facilities-spec'
import { SUR_FOREST } from '~/data/suzuka-surroundings'
import { worldRing } from '~/data/en-codec'
import type { EnvBuildContext } from './environment'
import { bucketedInstancedMeshes } from './instancing'
import { inBBox, pointInRing, ringBBox, ringFromFlat, type XZ } from './far-geometry'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

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

type TreeKind = 'evergreen' | 'bare' | 'blossom'

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
 * Where no tree may stand — the one rule the trackside scatter (`buildTrees`) and the forest's
 * stems (forest.ts) share: inside 44 m of the centreline, the pit / paddock band, the
 * grandstands' footprints (plus 26 m behind, 4 m for a spectator bank), 60 m around the Ferris wheel, and the keep-out
 * discs and polygons the building / paving builders leave in the context. `near` is the
 * candidate's projection (computed once by the caller, it is the expensive part).
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
  // buildings and paving placed by the other builders
  for (const k of ctx.keepOut) if (Math.hypot(x - k.x, z - k.z) < k.r) return true
  for (const k of ctx.keepOutPolys) if (inBBox(x, z, k.box) && pointInRing(x, z, k.ring)) return true
  return false
}

/** The forest polygons (SUR_FOREST) as world rings with their bounding boxes, decoded once per build. */
export function forestRings(enScale: number): { ring: XZ[]; box: [number, number, number, number] }[] {
  return SUR_FOREST.map((f) => {
    const ring = ringFromFlat(worldRing(f, enScale))
    return { ring, box: ringBBox(ring) }
  })
}

/**
 * The trackside scatter: trees in the season's palette (spec SEASONS[SEASON].trees; late March =
 * 60 % dark evergreen, 30 % bare or budding deciduous, 10 % cherry in full bloom) inside 500 m
 * of the centreline — the band the broadcast cameras see, where the far field's canopy masses
 * are not drawn (plan §2a: the lids stop 60 m out and hide inside the stem range). The cherries
 * are concentrated where the photos show them — around the hairpin, outside the S-curves, in
 * the park behind the main grandstand and the main gate — and rare elsewhere. `quality.trees`
 * instances, kept off the track, the pit / paddock zone, the grandstands, the Ferris wheel and
 * the keep-outs (`treeSiteBlocked`); a candidate inside a SUR_FOREST polygon is accepted eight
 * times as readily as one outside (× 4 inside, × 0.5 outside against the old uniform scatter),
 * so the woods stand as a dense wall up to the fence at Degner, Spoon and 130R while the open
 * ground stays open. Placement draws from `rng` in a fixed order, so the caller's seeded
 * generator decides the woods; run this after the Ferris wheel is placed.
 *
 * The work is a deferred 'forest' job (after the keep-out producers of the 'buildings' stage):
 * the instanced meshes are bucketed per terrain chunk and returned as the job's root, so the
 * viewport's attach hook gives them their materials and frozen matrices.
 */
export function buildTrees(ctx: EnvBuildContext, ferrisWheel: THREE.Group) {
  const { track, terrain, ground, quality, rng } = ctx
  const season = SEASONS[SEASON]
  const count = quality.trees
  const wheelPos = ferrisWheel.position
  ctx.farField.defer('forest', 'trees', 250, () => {
    const evergreenGeo = treePrototype('evergreen')
    const deciduousGeo = treePrototype('deciduous')
    const treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true })
    const evergreens: THREE.Matrix4[] = []
    const evergreenColors: THREE.Color[] = []
    const deciduous: THREE.Matrix4[] = []
    const deciduousColors: THREE.Color[] = []
    const blossom = new THREE.Color(season.blossom)
    const blossomDeep = new THREE.Color('#e9a9be')
    const b = track.bounds
    const forests = forestRings(track.enScale)
    let placed = 0
    let tries = 0
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
    const inForest = (x: number, z: number): boolean => {
      for (const f of forests) if (inBBox(x, z, f.box) && pointInRing(x, z, f.ring)) return true
      return false
    }
    while (placed < count && tries < count * 60) {
      tries++
      const x = rng.range(b.minX - 420, b.maxX + 420)
      const z = rng.range(b.minZ - 380, b.maxZ + 380)
      // density by land cover first (cheap), the projection (expensive) only for the survivors
      const wooded = inForest(x, z)
      if (!wooded && rng.next() < 0.875) continue
      const near = ground.plan.project(x, z)
      if (near.d >= 500) continue
      if (treeSiteBlocked(ctx, x, z, near, wheelPos)) continue
      // trees stand on bare terrain, never on a drawn ground face
      if (ground.builtY(x, z)) continue
      // thinner right beside the fences outside the woods
      if (!wooded && near.d < 120 && rng.next() < 0.55) continue
      // kind: the season's mix, with the cherries pulled into their zones (rare outside them)
      const r = rng.next()
      let kind: TreeKind
      if (season.trees.blossom > 0 && inCherryZone(x, z, near)) kind = r < 0.5 ? 'blossom' : r < 0.72 ? 'bare' : 'evergreen'
      else {
        const stray = season.trees.blossom * 0.3
        kind = r < stray ? 'blossom' : r < stray + season.trees.bare ? 'bare' : 'evergreen'
      }
      const y = ground.standY(x, z)
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * Math.PI * 2)
      if (kind === 'evergreen') {
        const sc = rng.range(0.7, 1.45)
        _s.set(sc, sc * rng.range(0.85, 1.2), sc)
        evergreens.push(new THREE.Matrix4().compose(_p.set(x, y - 0.3, z), _q, _s))
        // cedar / cypress / pine: dark, slightly blue-green, low saturation
        evergreenColors.push(new THREE.Color().setHSL(0.33 + rng.next() * 0.09, 0.26 + rng.next() * 0.18, 0.08 + rng.next() * 0.08))
      } else {
        const sc = kind === 'blossom' ? rng.range(0.75, 1.15) : rng.range(0.6, 1.05)
        _s.set(sc, sc * rng.range(0.9, 1.15), sc)
        deciduous.push(new THREE.Matrix4().compose(_p.set(x, y - 0.2, z), _q, _s))
        if (kind === 'blossom') deciduousColors.push(blossom.clone().lerp(blossomDeep, rng.next() * 0.6))
        // twigs and early buds: grey-brown, a hint of green on some
        else deciduousColors.push(new THREE.Color().setHSL(0.08 + rng.next() * 0.06, 0.12 + rng.next() * 0.14, 0.2 + rng.next() * 0.12))
      }
      placed++
    }
    // one InstancedMesh per terrain chunk (16) and prototype so the follow cameras and the cascades
    // cull the far side of the circuit; trees cast only where the tier allows
    const root = new THREE.Group()
    root.name = 'trees'
    const bucketOf = (_i: number, m: THREE.Matrix4) => terrain.chunkIndex(m.elements[12]!, m.elements[14]!)
    for (const inst of bucketedInstancedMeshes(evergreenGeo, treeMat, evergreens, evergreenColors, bucketOf, { castShadow: quality.treeShadows, name: 'evergreens' })) root.add(inst)
    for (const inst of bucketedInstancedMeshes(deciduousGeo, treeMat, deciduous, deciduousColors, bucketOf, { castShadow: quality.treeShadows, name: 'deciduous' })) root.add(inst)
    root.userData.trees = { placed, tries }
    return root
  })
}
