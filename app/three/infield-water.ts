import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BASINS } from '~/data/suzuka-barriers-spec'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal } from './ground'
import type { DecalQuad } from './ground-mesh'
import { cutoutParams } from './materials'
import { propMaterial } from './props-pack'
import { resolveBasin, type ResolvedBasin } from './stands'
import { isSimpleRing, waterFarMaterial } from './terrain-far'
import { cached, mulberry } from './textures'

/**
 * The ponds and the dry basins of the infield (plan I5-c). The ground itself is the BASINS
 * relief (stands.ts `facilityRelief`, a sunken floor with a bank) drawn by the GROUND_AREAS
 * 'water' rows; this builder only adds what lies on or over it:
 *
 *  - `surface` basins: ONE water plane each, the outline (island holes cut out) triangulated
 *    with earcut at WATER_PLANE_DROP under the shoreline — the material is terrain-far.ts's
 *    `waterFarMaterial()`, the same parameter set as the far beds, so the whole scene's water
 *    is one program (transparent, no depth write: G8 leaves it alone, and so does its
 *    `furniture-` name). A `platform` is a wooden deck on posts through the shared BoxPlacer
 *    (merged into the 'props' meshes), standing DECK_LIFT over the ground.
 *  - `dry` basins: reeds on the mud floor (REED_TOTAL clusters shared by area — three crossed
 *    1.2 m cards, one InstancedMesh per far-field cell through `registerBuckets`, kind
 *    'infield') and PUDDLES soft dark decals (`ground.decal` at LAYER.verge.paint, transparent
 *    without a depth write — the braking-rubber combination). The gravel shore paths are
 *    GROUND_AREAS rows, not this builder's.
 *
 * Materials (plan §横断 7): the reed cards are the ONE budgeted new program of I5-c —
 * MeshStandardMaterial { map, alphaMap, alphaTest (+ A2C on the high tier), DoubleSide } with
 * the pack's grass_medium_01 diff + opacity, or `reedTexture()` (a 64 × 128 DataTexture pair,
 * the same parameter set) on the low tier and in Node so the program count is the same on
 * every tier. The deck is a plain colour through `propMaterial` (a combination the props
 * already compile), the puddles are { map, alphaMap, transparent, depthWrite: false } like the
 * braking rubber.
 */

/** metres the water plane sits under the shoreline */
export const WATER_PLANE_DROP = 0.3
/** the deck's standing height over the ground it is built on */
const DECK_LIFT = 0.3
/** reed clusters over every dry basin, shared in proportion to the basins' areas */
const REED_TOTAL = 200
/** a reed cluster stands this far inside the shoreline: on the bank's foot and the floor's edge */
const REED_SHORE: [number, number] = [3, 14]
/** the card: width × height of a reed cluster at scale 1 */
const REED_CARD: [number, number] = [1.2, 1.2]
/** the puddles: [along, across] radii (m) and how many each dry basin gets, in BASINS order */
const PUDDLES: { a: number; b: number; per: number[] } = { a: 4.5, b: 2.6, per: [2, 1] }
/** puddle decal quads are cut to this size so every quad lies within a couple of raster cells of the face */
const PUDDLE_CELL = 2

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const Y_UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------------------------------------
// textures (DataTextures: the Node harness and the low tier see the same bytes)

/**
 * A procedural reed card: six tapering dry blades on a transparent ground, 64 × 128 — `diff`
 * (sRGB colour) and `alpha` (linear mask), the two maps the pack's grass_medium_01 provides.
 */
export function reedTexture(): { diff: THREE.DataTexture; alpha: THREE.DataTexture } {
  return cached('reed-card', () => {
    const w = 64, h = 128
    const diff = new Uint8Array(w * h * 4), alpha = new Uint8Array(w * h * 4)
    const rnd = mulberry(1707)
    const blades: { cx: number; top: number; base: number; lean: number; tone: number }[] = []
    for (let k = 0; k < 6; k++) blades.push({ cx: 8 + k * 9 + rnd() * 4, top: 0.66 + rnd() * 0.32, base: 2.2 + rnd() * 1.6, lean: (rnd() - 0.5) * 10, tone: rnd() })
    for (let y = 0; y < h; y++) {
      const v = 1 - y / h // 0 at the bottom row … 1 at the top
      for (let x = 0; x < w; x++) {
        let cover = 0, tone = 0
        for (const b of blades) {
          if (v > b.top) continue
          const t = v / b.top
          const half = b.base * (1 - t) + 0.35
          const cx = b.cx + b.lean * t * t
          const d = Math.abs(x + 0.5 - cx)
          const c = Math.max(0, Math.min(1, half - d + 0.5))
          if (c > cover) { cover = c; tone = b.tone }
        }
        const k = (y * w + x) * 4
        // dry reed: straw with a little green low down
        const g = 0.25 * (1 - v)
        diff[k] = Math.round(255 * (0.62 + 0.14 * tone - 0.08 * g))
        diff[k + 1] = Math.round(255 * (0.55 + 0.12 * tone + 0.12 * g))
        diff[k + 2] = Math.round(255 * (0.33 + 0.10 * tone))
        diff[k + 3] = 255
        const a = Math.round(255 * cover)
        alpha[k] = alpha[k + 1] = alpha[k + 2] = a
        alpha[k + 3] = 255
      }
    }
    const make = (data: Uint8Array, srgb: boolean) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
      return tex
    }
    return { diff: make(diff, true), alpha: make(alpha, false) }
  })
}

/**
 * A soft dark ellipse on a 64² tile: the puddle's colour (`diff`, a wet dark grey) and its mask
 * (`alpha`, opaque in the middle, feathered over the outer third — the alphaMap's green channel).
 */
export function puddleTexture(): { diff: THREE.DataTexture; alpha: THREE.DataTexture } {
  return cached('puddle', () => {
    const n = 64
    const diff = new Uint8Array(n * n * 4), alpha = new Uint8Array(n * n * 4)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n - 0.5
      const r = Math.hypot(u, v) * 2
      const a = Math.max(0, Math.min(1, (1 - r) / 0.35))
      const k = (y * n + x) * 4
      const tone = Math.round(255 * (0.16 + 0.06 * (1 - a)))
      diff[k] = tone
      diff[k + 1] = tone + 4
      diff[k + 2] = tone + 6
      diff[k + 3] = 255
      const m = Math.round(255 * a * a)
      alpha[k] = alpha[k + 1] = alpha[k + 2] = m
      alpha[k + 3] = 255
    }
    const make = (data: Uint8Array, srgb: boolean) => {
      const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType)
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
      return tex
    }
    return { diff: make(diff, true), alpha: make(alpha, false) }
  })
}

// ---------------------------------------------------------------------------------------------
// geometry

/** three crossed vertical cards, base at the origin, uv 0..1 over the whole texture */
function reedClusterGeometry(): THREE.BufferGeometry {
  const [w, h] = REED_CARD
  const parts: THREE.BufferGeometry[] = []
  for (let k = 0; k < 3; k++) {
    const g = new THREE.PlaneGeometry(w, h)
    g.translate(0, h / 2, 0)
    g.rotateY((k / 3) * Math.PI)
    parts.push(g.toNonIndexed())
  }
  const merged = mergeGeometries(parts, false)!
  for (const g of parts) g.dispose()
  return merged
}

/** distance from (x, z) to the nearest edge of a ring, and whether it is inside */
function edgeOf(ring: [number, number][], x: number, z: number): { inside: boolean; edge: number } {
  let inside = false, edge = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!, [xj, zj] = ring[j]!
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    const dx = xj - xi, dz = zj - zi
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)))
    edge = Math.min(edge, Math.hypot(x - (xi + dx * t), z - (zi + dz * t)))
  }
  return { inside, edge }
}

/** the outline's area (m²) */
function ringArea(ring: [number, number][]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; a += p[0] * q[1] - q[0] * p[1] }
  return Math.abs(a) / 2
}

/** the water plane of one basin: its outline with the island holes, earcut, flat at `y`; null for a ring earcut cannot take */
function waterPlane(r: ResolvedBasin, y: number): THREE.BufferGeometry | null {
  if (r.pts.length < 3 || !isSimpleRing(r.pts)) return null
  const contour = r.pts.map(([x, z]) => new THREE.Vector2(x, -z))
  const holes = r.holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, -z)))
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  if (!faces.length) return null
  const all: [number, number][] = [...r.pts, ...r.holes.flat()]
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  for (const [x, z] of all) { pos.push(x, y, z); uv.push(x / 4, -z / 4) }
  for (const f of faces) {
    const a = all[f[0]!]!, b = all[f[1]!]!, c = all[f[2]!]!
    const ny = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])
    if (ny >= 0) idx.push(f[0]!, f[1]!, f[2]!)
    else idx.push(f[0]!, f[2]!, f[1]!)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  return geo
}

// ---------------------------------------------------------------------------------------------

export function buildInfieldWater(ctx: EnvBuildContext): void {
  const { track, ground, group, quality, assets, boxes, farField } = ctx
  const stat = (key: string, n: number) => { ctx.infieldStats[key] = (ctx.infieldStats[key] ?? 0) + n }
  const rng = mulberry(4590)
  const basins = BASINS.map((def) => resolveBasin(track, def)).filter((r): r is ResolvedBasin => !!r)

  // --- the water planes and the decks ---------------------------------------------------------
  const waterMat = waterFarMaterial()
  let ponds = 0, decks = 0
  basins.forEach((r) => {
    if (!r.def.surface) return
    const geo = waterPlane(r, r.shoreY - WATER_PLANE_DROP)
    if (!geo) {
      console.warn(`[infield-water] pond '${r.def.name}': outline is not a simple polygon, no water plane`)
      return
    }
    const mesh = new THREE.Mesh(geo, waterMat)
    mesh.name = `furniture-infield-pond-${ponds}`
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    mesh.userData.basin = r.def.name
    group.add(mesh)
    ponds++
    const pf = r.def.platform
    if (pf) {
      // the deck: a plank slab on four posts, standing DECK_LIFT over the ground of its spot
      const deckMat = propMaterial(ctx.props, { color: 0x6e5a42, roughness: 0.85, metalness: 0 })
      boxes.place(pf.s, pf.lateral, pf.l, pf.w, 0.08, deckMat, DECK_LIFT, false, true)
      for (const [ds, dl] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) boxes.place(pf.s + ds * (pf.l / 2 - 0.2), pf.lateral + dl * (pf.w / 2 - 0.2), 0.14, 0.14, DECK_LIFT + 0.15, deckMat, -0.15, false, false)
      decks++
    }
  })
  stat('infield-ponds', ponds)
  stat('infield-pondDecks', decks)

  // --- the dry basins: reeds and puddles ---------------------------------------------------------
  const dry = basins.filter((r) => r.def.dry)
  const areas = dry.map((r) => ringArea(r.pts))
  const areaSum = areas.reduce((a, b) => a + b, 0) || 1
  const reedGeo = reedClusterGeometry()
  const packDiff = assets?.texture('tex/grass_medium_01/diff') ?? null
  const packAlpha = assets?.texture('tex/grass_medium_01/opacity') ?? null
  const maps = packDiff && packAlpha ? { diff: packDiff, alpha: packAlpha } : reedTexture()
  const reedMat = new THREE.MeshStandardMaterial({ map: maps.diff, alphaMap: maps.alpha, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, ...cutoutParams(quality) })
  const matrices: THREE.Matrix4[] = []
  let puddleN = 0
  const puddleQuads: DecalQuad[] = []
  dry.forEach((r, bi) => {
    const box = r.box
    // reeds: random points inside the ring, REED_SHORE metres in from the shore
    const want = Math.round((REED_TOTAL * areas[bi]!) / areaSum)
    let placed = 0, tries = 0
    while (placed < want && tries < want * 60) {
      tries++
      const x = box[0] + rng() * (box[1] - box[0]), z = box[2] + rng() * (box[3] - box[2])
      const e = edgeOf(r.pts, x, z)
      if (!e.inside || e.edge < REED_SHORE[0] || e.edge > REED_SHORE[1]) continue
      const y = ground.standY(x, z)
      const k = 0.8 + rng() * 0.5
      _q.setFromAxisAngle(Y_UP, rng() * Math.PI * 2)
      _s.set(k, k, k)
      matrices.push(new THREE.Matrix4().compose(_p.set(x, y - 0.05, z), _q, _s))
      placed++
    }
    // puddles: soft ellipses on the floor, well inside the bank
    const per = PUDDLES.per[bi] ?? 0
    for (let n = 0; n < per; n++) {
      let cx = 0, cz = 0, ok = false
      for (let t = 0; t < 200 && !ok; t++) {
        cx = box[0] + rng() * (box[1] - box[0]); cz = box[2] + rng() * (box[3] - box[2])
        const e = edgeOf(r.pts, cx, cz)
        ok = e.inside && e.edge > r.bank + PUDDLES.a + 1
      }
      if (!ok) continue
      const yaw = rng() * Math.PI
      const c = Math.cos(yaw), s = Math.sin(yaw)
      const { a, b } = PUDDLES
      const yHint = ground.decalY(cx, cz)
      // cells of PUDDLE_CELL in the puddle's own frame, corners rotated to world
      const world = (u: number, v: number): [number, number] => [cx + u * c - v * s, cz + u * s + v * c]
      for (let u0 = -a; u0 < a - 1e-6; u0 += PUDDLE_CELL) for (let v0 = -b; v0 < b - 1e-6; v0 += PUDDLE_CELL) {
        const u1 = Math.min(a, u0 + PUDDLE_CELL), v1 = Math.min(b, v0 + PUDDLE_CELL)
        const corners = [world(u0, v0), world(u1, v0), world(u1, v1), world(u0, v1)]
        puddleQuads.push({
          xz: corners.flat(),
          yHint,
          attrs: (x, z) => {
            const dx = x - cx, dz = z - cz
            const u = dx * c + dz * s, v = -dx * s + dz * c
            return [0.5 + u / (2 * a), 0.5 + v / (2 * b)]
          },
        })
      }
      puddleN++
    }
  })
  if (matrices.length) {
    farField.registerBuckets('infield', 'infield-reeds', reedGeo, reedMat, matrices, null, [{ range: quality.infield.propsFarM }], { castShadow: false, receiveShadow: true })
  }
  stat('infield-reeds', matrices.length)
  if (puddleQuads.length) {
    const tex = puddleTexture()
    const built = ground.decal(puddleQuads, LAYER.verge.paint, [{ name: 'uv', size: 2 }])
    if (built.geo) {
      const puddleMat = new THREE.MeshStandardMaterial({ map: tex.diff, alphaMap: tex.alpha, color: 0xffffff, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.8, depthWrite: false })
      const mesh = new THREE.Mesh(built.geo, puddleMat)
      mesh.name = 'infield-puddles'
      mesh.renderOrder = 2
      mesh.receiveShadow = true
      markDecal(mesh, LAYER.verge.paint, built.stats)
      group.add(mesh)
    }
  }
  stat('infield-puddles', puddleN)
}
