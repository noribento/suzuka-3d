import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MARSHAL_STAND, marshalSlots, marshalStairSign } from '~/data/ops-spec'
import { BARRIERS, MARSHAL_POSTS, TRACKSIDE_CCTV, marshalNumbers, type BarrierRun, type MarshalPostDef } from '~/data/suzuka-barriers-spec'
import { forwardDelta } from '~/sim/track'
import { BARRIER_KIND, barrierProfile } from './barriers'
import type { EnvBuildContext } from './environment'
import { registerPropSet, type PropSet } from './infield-lod'
import type { TracksideStats } from './infield'
import { cutoutFromAssets, cutoutParams, pbrFromAssets } from './materials'
import { frameAt } from './pit-geometry'
import { glbOr, procProp, propMaterial, type PropProto } from './props-pack'
import { cached, canvas, chainLinkTexture, makeTexture, scaled } from './textures'
import { resolveLineCached } from './trackside'

/**
 * The marshal posts v2 (plan I4-a), from MARSHAL_POSTS (app/data/suzuka-barriers-spec.ts):
 *
 *  - the CABIN on its stand (type 'cabin', r130_post.jpg / mlc_post.jpg): four 0.1² posts
 *    `platform` (2.0 m) tall under a 2.7 × 3.7 × 0.12 floor — the 2.5 m body at the row's
 *    (s, lateral) and a 1.1 m deck on the `stair` side, railed, with a 0.8 m stair of ten
 *    risers running on along s; the body's lower half and back are white-grey painted steel
 *    (`blue_metal_plate` normal / ARM over 0xe6e6e2 — the pit building's white-plaster recipe —
 *    or the plain colour), its upper front and sides are dark mesh openings (a tinted clone of
 *    the debris fence's material, so the same program as barriers.ts's fenceMat, over a dark
 *    interior box), a red / white band 0.25 m at body + 0.4 (`bandTexture` — the same trim
 *    atlas as the rolled flags, the rack, the extinguishers and the cabinets), a dark blue-grey
 *    roof 2.7 × 2.7 × 0.1 (0x3a4a5c). On the end wall a flag rack with five rolled flags
 *    (yellow / red / blue / green / white); two extinguishers at the stand's feet and one on the
 *    deck (`korean_fire_extinguisher_01` through `glbOr`, else a red cylinder). With the pack the
 *    body is the Small Guard Booth drop (`packProp` scaled to 2.5 m along; its glass
 *    transmission is dropped by `propMaterial`, which rebuilds every part as a plain Standard);
 *  - the LOW post (type 'low'): a 2.0 × 1.6 × 2.0 grey box (0xb9bcc0) with a dark roof;
 *  - the NUMBER BOARD: 1.2 × 0.8 m white, centre 2.4 m up, hung on the track side of the fence
 *    post nearest the post's s (`marshalNumbers()`; `facing` per row), cell of the 8 × 4
 *    `marshalNumberAtlas` (digits 0.67 m) — one merged mesh `marshalNumbers`;
 *  - the EM LIGHT PANEL, DARK: under a green flag the panels show nothing (lpfront.jpg), so the
 *    0.7 × 0.6 × 0.2 black housing carries a 64 × 48 LED-dot face (`emPanelTexture`, 0x2a1f1d)
 *    with NO emissive (EMISSIVE.digitalFlag is gone); it hangs 0.35 m on the track side of the
 *    fence post at `panel.s ?? s − 3.2` (snapped to the run's 4 m fence-post pitch) on a zinc
 *    arm, its beige control cabinet 0.5 × 0.4 × 0.7 on the ground behind the post — one
 *    InstancedMesh `emPanels` (housing + face), the arms / own poles merged into `marshalPoles`,
 *    the cabinets through `ctx.boxes`. Runs without a fence (quality.fence off, or a bare wall /
 *    rail) get a pole of their own at the line;
 *  - the PTZ CCTV: one 6 m pole (`cctvPoles`) behind the fence at every numbered post plus the
 *    TRACKSIDE_CCTV rows along the straights, a `security_camera_02` head (`glbOr`, else a
 *    0.25 × 0.15 × 0.2 box) on top (`cctvHeads`);
 *  - the MARSHALS: ops-spec `marshalSlots(post)` (section A) — the rows are part of
 *    `figuresAt()`, so ops-people.ts draws them with the rest of the ops figures (role marshal,
 *    white helmet); this builder only counts them (`slots`).
 *
 * Every row's cabin sits on the spectator side of its barrier run, its stand ≥ 0.6 m off the
 * resolved line (facilities-check O8; trackside-smoke `checkPosts`); the boards, panels and
 * cameras hang on the fence line itself (mount 'fencePost', O5 exempt). A 'building' row (the
 * 200R officials' building) gets only its panel and camera — INFIELD_FACILITIES draws it (I5);
 * a `secondary` row (the second hut of a post) gets the cabin and its marshals only.
 *
 * Cabins, lows and extinguishers are instanced per 250 m cell through
 * `registerPropSet(ctx, 'infield', 'infield-marshal-cabins', …)` (`Quality.infield.propsNearM` /
 * `propsFarM`): the near level casts shadows when `quality.farField.shadows` (building-class,
 * plan §横断 6); the boards, panels and cameras receive only. Materials: the white PBR (no map),
 * the fence cutout, three `{map}` canvases (trim atlas, number atlas, LED face) and plain
 * colours — no new program combination (§横断 7). `TRACKSIDE_TEXTS` lists every string the
 * canvases paint (scripts/textures-lint.mjs).
 *
 * Reports `posts` (= MARSHAL_POSTS.length), `cabins`, `lows`, `panels`, `slots` and leaves
 * `group.userData.trackside = { panels, numbers, cctv }` (world points) for the smoke.
 */

/** the words the trackside canvases paint: the post numbers only (textures-lint) */
export const TRACKSIDE_TEXTS: readonly string[] = Array.from({ length: 31 }, (_, i) => String(i + 1))

const S = MARSHAL_STAND
const Q = Math.PI / 2
const _p = new THREE.Vector3()
const _t = new THREE.Matrix4()
const _r = new THREE.Matrix4()

/** the number board (m): width along the fence, height, thickness; centre height over the ground */
const BOARD = { w: 1.2, h: 0.8, t: 0.06, centreY: 2.4 }
/** the EM light panel (m): housing width (across the track), height, depth (along s); face inset; arm length off the post; centre height */
const PANEL = { w: 0.7, h: 0.6, d: 0.2, faceW: 0.62, faceH: 0.52, arm: 0.35, centreY: 2.05, dS: -3.2 }
/** the panel's control cabinet: along s × across × high, standing 0.3 m over the ground behind the post */
const CABINET = { l: 0.5, w: 0.4, h: 0.7, lift: 0.3, gap: 0.3 }
/** the CCTV pole: height, radius; the head box (along s × across × high); pitch after the post's s */
const CCTV = { h: 6.0, r: 0.04, head: [0.25, 0.15, 0.2] as const, dS: 3.0 }
/** the fence posts' pitch along a run (barriers.ts places them at sRange[0] + 4 k) */
const FENCE_POST_PITCH = 4
/** the number atlas: 8 × 4 cells, cell 0 blank, cell n = post n */
const NUM_COLS = 8
const NUM_ROWS = 4

/** a barrier run and its resolved line at a post's side */
interface RunAt {
  run: BarrierRun
  lat: (s: number) => number
  base: (s: number) => number
  /** the run has fence posts (a debris fence or a bare fence, and the tier draws fences) */
  posts: boolean
  /** how far behind the line the run's back is (m): the wall / tyre depth, the rail's posts */
  back: number
}

export function buildMarshalPosts(ctx: EnvBuildContext, _opts: { flagTime: { value: number } }): Omit<TracksideStats, 'towers'> {
  const { track, ground, group, boxes, quality, assets } = ctx
  const L = track.length
  const numbers = marshalNumbers()

  // --- the runs: which barrier line a post hangs its board / panel / camera on ------------------
  const runCache = new Map<BarrierRun, RunAt>()
  const runAt = (run: BarrierRun): RunAt => {
    let r = runCache.get(run)
    if (!r) {
      const prof = barrierProfile(track, ground, run)
      const fenceTop = run.kind === 'fence' ? 1 : run.fence ?? 0
      const k = BARRIER_KIND[run.kind]
      r = { run, lat: prof.lat, base: prof.base, posts: fenceTop > 0 && quality.fence, back: run.kind === 'tyre' ? 1.3 : k.cap > 0 ? 0.35 : k.posts ? 0.14 : 0.05 }
      runCache.set(run, r)
    }
    return r
  }
  /** the run on `side` that covers s (the nearest line to `lateral` when several do), or null */
  const runFor = (s: number, side: 1 | -1, lateral: number): RunAt | null => {
    let best: RunAt | null = null
    let bd = Infinity
    for (const run of BARRIERS) {
      if (run.side !== side) continue
      if (forwardDelta(run.sRange[0], s, L) > forwardDelta(run.sRange[0], run.sRange[1], L)) continue
      const line = resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
      if (line.samples.length < 2) continue
      const d = Math.abs(line.lat(s) - lateral)
      if (d < bd) {
        bd = d
        best = runAt(run)
      }
    }
    return best
  }
  /** the s of the run's fence post nearest `s` (barriers.ts: sRange[0] + 4 k), or `s` itself without posts */
  const snapToPost = (r: RunAt | null, s: number): number => {
    if (!r || !r.posts) return track.wrap(s)
    const [s0, s1] = r.run.sRange
    const len = forwardDelta(s0, s1, L)
    const d = Math.min(len, Math.max(0, Math.round(forwardDelta(s0, s, L) / FENCE_POST_PITCH) * FENCE_POST_PITCH))
    return track.wrap(s0 + d)
  }
  /** a mount on the fence line: the line's lateral and the barrier's base there (the fence post's foot) */
  const mountAt = (r: RunAt | null, s: number, fallbackLat: number) => (r ? { lat: r.lat(s), base: r.base(s), posts: r.posts, back: r.back } : { lat: fallbackLat, base: ground.standAt(s, fallbackLat), posts: false, back: 0 })

  // --- materials --------------------------------------------------------------------------------
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const steel = plain(0x8a8d92, 0.5, 0.7)
  const floorMat = plain(0x4a4d52, 0.7, 0.4)
  const interior = plain(0x1a1c20, 0.9, 0)
  const roofMat = plain(0x3a4a5c, 0.6, 0.3)
  const lowMat = plain(0xb9bcc0, 0.7, 0.1)
  const housingMat = plain(0x15171a, 0.5, 0.3)
  const cabinetMat = plain(0xd6cdb0, 0.8, 0.1)
  const hutFallback = () => new THREE.MeshStandardMaterial({ color: 0xe6e6e2, roughness: 0.6, metalness: 0.2 })
  const hutMat = assets ? pbrFromAssets(assets, 'blue_metal_plate', { fallback: hutFallback, handBuiltUv: true, normalScale: 0.5, noMap: true, extra: { color: 0xe6e6e2 } }) : hutFallback()
  // the openings' mesh: the debris fence's material (fence003 cutout with the pack, the chain-link
  // tile otherwise — barriers.ts's define set), tinted dark so the openings read as shade behind wire
  const meshMat = cutoutFromAssets(assets, 'fence003', {
    quality,
    tile: 2.0,
    handBuiltUv: true,
    normalScale: 0.6,
    extra: { color: 0x3a3c40 },
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(5, 5)
      return new THREE.MeshStandardMaterial({ map, color: 0x3a3c40, ...cutoutParams(quality), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 })
    },
  })
  const trimMat = new THREE.MeshStandardMaterial({ map: trimAtlas(), roughness: 0.6, metalness: 0.1 })
  const ledMat = new THREE.MeshStandardMaterial({ map: emPanelTexture(), roughness: 0.4, metalness: 0.1 })
  const numberMat = new THREE.MeshStandardMaterial({ map: marshalNumberAtlas(), roughness: 0.5, metalness: 0.05 })

  // --- the prototypes ---------------------------------------------------------------------------
  type Part = { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }
  const box = (w: number, h: number, d: number, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0): Part => ({ geometry: new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), material })
  const cyl = (r: number, h: number, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0, seg = 8): Part => ({ geometry: new THREE.CylinderGeometry(r, r, h, seg).translate(x, y + h / 2, z), material })
  /** a box / cylinder painted with one swatch of the trim atlas */
  const swatch = (part: Part, cell: number): Part => {
    const uv = part.geometry.attributes.uv as THREE.BufferAttribute
    const [u, v] = TRIM.swatch(cell)
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v)
    return { geometry: part.geometry, material: trimMat }
  }
  /** parts of one material merged (one group = one draw per material) */
  const proc = (id: string, parts: Part[]): PropProto => {
    const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
    for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p.geometry.index ? p.geometry.toNonIndexed() : p.geometry])
    return procProp(id, [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0]! : mergeGeometries(geos, false)! })))
  }
  const platform = S.platform
  const F = platform + S.floor
  const half = S.body / 2
  const acrossHalf = S.across / 2
  /**
   * The stand with its deck and stair; `L` = the stair's direction in the prototype's frame
   * (+z / −z). Local +x = +lateral (the spectator side of a left-hand post), the FRONT of the
   * body (its mesh openings) faces −x; a right-hand post is placed with a half turn.
   */
  const standProto = (L: 1 | -1): PropProto => {
    const parts: Part[] = []
    const zFar = L * (half + S.deckS)
    // the four posts and their mid-height ties
    const zNear = -L * (half - 0.1), zPost = zFar - L * 0.1
    for (const x of [-acrossHalf + 0.1, acrossHalf - 0.1]) for (const z of [zNear, zPost]) parts.push(box(0.1, platform, 0.1, steel, x, 0, z))
    for (const x of [-acrossHalf + 0.1, acrossHalf - 0.1]) parts.push(box(0.06, 0.06, S.body - 0.2 + S.deckS, steel, x, platform * 0.5, (zNear + zPost) / 2))
    for (const z of [zNear, zPost]) parts.push(box(S.across - 0.2, 0.06, 0.06, steel, 0, platform * 0.5, z))
    // the floor: the body's footprint plus the deck on the stair side (0.1 m overhang at both ends)
    parts.push(box(S.across, S.floor, S.body + S.deckS + 0.2, floorMat, 0, platform, (L * S.deckS) / 2))
    // the deck rails: both long sides of the deck and the end, with the stair's gap in the middle
    const railY = F
    const railH = 1.0
    for (const x of [-acrossHalf + 0.02, acrossHalf - 0.02]) {
      parts.push(box(0.04, railH, 0.04, steel, x, railY, L * (half + 0.05)), box(0.04, railH, 0.04, steel, x, railY, zFar - L * 0.02))
      parts.push(box(0.04, 0.04, S.deckS, steel, x, railY + railH - 0.04, L * (half + S.deckS / 2)))
    }
    for (const x of [-acrossHalf + 0.02 + (acrossHalf - S.stairW / 2 - 0.04) / 2, acrossHalf - 0.02 - (acrossHalf - S.stairW / 2 - 0.04) / 2]) {
      parts.push(box(acrossHalf - S.stairW / 2 - 0.04, 0.04, 0.04, steel, x, railY + railH - 0.04, zFar - L * 0.02))
    }
    for (const x of [-S.stairW / 2 - 0.02, S.stairW / 2 + 0.02]) parts.push(box(0.04, railH, 0.04, steel, x, railY, zFar - L * 0.02))
    // the stair: ten risers of (platform + floor) / 10 running on from the deck's edge, two stringers, a handrail
    const risers = 10
    const rise = F / risers
    const run = S.stairLen / risers
    for (let k = 0; k < risers; k++) {
      const top = F - (k + 1) * rise
      parts.push(box(S.stairW, rise, run, floorMat, 0, top - rise, zFar + L * (run / 2 + k * run)))
    }
    const diag = Math.hypot(S.stairLen, F)
    const pitch = Math.atan2(F, S.stairLen)
    for (const x of [-S.stairW / 2 - 0.03, S.stairW / 2 + 0.03]) {
      const stringer = new THREE.BoxGeometry(0.05, 0.16, diag).rotateX(L * pitch).translate(x, F / 2 - 0.1, zFar + L * (S.stairLen / 2))
      parts.push({ geometry: stringer, material: steel })
      const rail = new THREE.BoxGeometry(0.04, 0.04, diag).rotateX(L * pitch).translate(x, F / 2 + 0.85, zFar + L * (S.stairLen / 2))
      parts.push({ geometry: rail, material: steel })
      parts.push(box(0.04, 0.9, 0.04, steel, x, 0, zFar + L * (S.stairLen - 0.05)))
    }
    return proc(`marshal-stand${L > 0 ? '-plus' : '-minus'}`, parts)
  }
  /** the cabin body on the floor (origin at the floor's top under the body's centre); `L` = the deck side (the rack goes on the other end) */
  const bodyProto = (L: 1 | -1): PropProto => {
    const parts: Part[] = []
    const lower = 1.3
    const upper = S.body - lower
    parts.push(box(S.body, lower, S.body, hutMat))
    // the upper half: the back wall, a dark interior box, the mesh openings on the front and both sides, the corner frame
    parts.push(box(0.06, upper, S.body, hutMat, half - 0.03, lower, 0))
    parts.push(box(S.body - 0.1, upper, S.body - 0.1, interior, 0.02, lower, 0))
    const meshPlane = (w: number, hgt: number): THREE.BufferGeometry => {
      const g = new THREE.PlaneGeometry(w, hgt)
      const uv = g.attributes.uv as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * hgt)
      return g
    }
    parts.push({ geometry: meshPlane(S.body, upper).rotateY(-Q).translate(-half, lower + upper / 2, 0), material: meshMat })
    for (const z of [-half, half]) parts.push({ geometry: meshPlane(S.body, upper).rotateY(z > 0 ? 0 : Math.PI).translate(0, lower + upper / 2, z), material: meshMat })
    for (const x of [-half + 0.03, half - 0.03]) for (const z of [-half + 0.03, half - 0.03]) parts.push(box(0.06, upper, 0.06, hutMat, x, lower, z))
    for (const z of [-half + 0.03, half - 0.03]) parts.push(box(S.body, 0.06, 0.06, hutMat, 0, S.body - 0.06, z))
    parts.push(box(0.06, 0.06, S.body, hutMat, -half + 0.03, S.body - 0.06, 0))
    // the red / white band round the body at +0.4 (the trim atlas's band row, 5 periods of 0.5 m)
    const band = new THREE.BoxGeometry(S.body + 0.02, 0.25, S.body + 0.02).translate(0, 0.4 + 0.125, 0)
    const buv = band.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i) * 5, TRIM.bandV[0] + buv.getY(i) * (TRIM.bandV[1] - TRIM.bandV[0]))
    parts.push({ geometry: band, material: trimMat })
    // the roof
    parts.push(box(S.across, 0.1, S.across, roofMat, 0, S.body, 0))
    // the flag rack on the end wall away from the deck: a white board and five rolled flags
    const zEnd = -L * (half + 0.03)
    parts.push(swatch(box(0.6, 0.9, 0.06, trimMat, 0, 0.75, zEnd), TRIM.white))
    const colours = [TRIM.yellow, TRIM.red, TRIM.blue, TRIM.green, TRIM.white]
    colours.forEach((c, i) => parts.push(swatch(cyl(0.025, 0.86, trimMat, -0.24 + i * 0.12, 0.77, zEnd - L * 0.055, 6), c)))
    return proc(`marshal-body${L > 0 ? '-plus' : '-minus'}`, parts)
  }
  const lowProto = (): PropProto => {
    const [l, w, h] = S.low
    return proc('marshal-low', [box(w, h - 0.08, l, lowMat), box(w + 0.1, 0.08, l + 0.1, roofMat, 0, h - 0.08, 0)])
  }
  const extinguisherProc = proc('marshal-extinguisher', [swatch(cyl(0.09, 0.5, trimMat, 0, 0.04, 0, 10), TRIM.red), swatch(cyl(0.03, 0.08, trimMat, 0, 0.54, 0, 6), TRIM.black), swatch(box(0.2, 0.04, 0.2, trimMat, 0, 0, 0), TRIM.black)])
  const extinguisher = glbOr(ctx, 'model/props/korean_fire_extinguisher_01', { id: 'marshal-extinguisher-glb', scaleTo: { height: 0.6 }, front: 'none' }, extinguisherProc)
  const bodies = new Map<1 | -1, PropSet>()
  const stands = new Map<1 | -1, PropSet>()
  const protoOf = (map: Map<1 | -1, PropSet>, L: 1 | -1, make: (L: 1 | -1) => PropSet): PropSet => {
    let ps = map.get(L)
    if (!ps) map.set(L, (ps = make(L)))
    return ps
  }
  const boothGlb = (L: 1 | -1, proc: PropProto): PropProto => {
    const glb = glbOr(ctx, 'model/trackside/guard_booth', { id: `marshal-booth${L > 0 ? '-plus' : '-minus'}`, scaleTo: { long: S.body }, front: 'moreArea' }, proc)
    // orientPack turned the booth's front to +z; the cabin's front is −x (a quarter turn once, on this id's own geometry)
    if (glb !== proc) glb.geometry.rotateY(-Q)
    return glb
  }
  const lowSet: PropSet = { proto: lowProto(), placements: [], casts: true }
  const extSet: PropSet = { proto: extinguisher, placements: [], ...(extinguisher.source === 'glb' ? { far: extinguisherProc } : {}) }

  // --- the fence-mounted pieces: boards, panels, cameras ------------------------------------------
  const numberGeos: THREE.BufferGeometry[] = []
  const poleGeos: THREE.BufferGeometry[] = []
  const panelMatrices: THREE.Matrix4[] = []
  const cctvMatrices: THREE.Matrix4[] = []
  const panelsOut: { s: number; lateral: number; x: number; y: number; z: number }[] = []
  const numbersOut: { s: number; lateral: number; number: number; x: number; y: number; z: number }[] = []
  const cctvOut: { s: number; lateral: number; x: number; y: number; z: number }[] = []
  /** a vertical pole (world) from the ground at (s, lat, base) to `top` over it */
  const pole = (s: number, lat: number, base: number, top: number, r: number) => {
    track.pointAt(s, lat, _p, base)
    poleGeos.push(new THREE.CylinderGeometry(r, r, top, 6).translate(_p.x, _p.y + top / 2, _p.z))
  }
  /** a horizontal arm (world) along the lateral axis from lat0 to lat1 at height y over base */
  const arm = (s: number, lat0: number, lat1: number, y: number) => {
    const m = frameAt(track, s, (lat0 + lat1) / 2, y, new THREE.Matrix4())
    const g = new THREE.CylinderGeometry(0.025, 0.025, Math.abs(lat1 - lat0), 6).rotateZ(Q)
    g.applyMatrix4(m)
    poleGeos.push(g)
  }
  const numberBoard = (post: MarshalPostDef, n: number, side: 1 | -1) => {
    const r = runFor(post.s, side, post.lateral)
    const sb = snapToPost(r, post.s)
    const m0 = mountAt(r, sb, post.lateral - side * (acrossHalf + 0.6))
    // on the track side of the fence post (0.045 half post + the board's half thickness), else on its own pole 0.3 m off the line
    const lat = m0.lat - side * (m0.posts ? 0.045 + BOARD.t / 2 + 0.005 : 0.3)
    const y = m0.base + BOARD.centreY
    const geo = new THREE.BoxGeometry(BOARD.t, BOARD.h, BOARD.w)
    numberUv(geo.attributes.uv as THREE.BufferAttribute, post.facing === '+s' ? 4 : 5, n)
    geo.applyMatrix4(frameAt(track, sb, lat, y, _t))
    numberGeos.push(geo)
    if (!m0.posts) pole(sb, lat, m0.base, BOARD.centreY + BOARD.h / 2, 0.02)
    track.pointAt(sb, lat, _p, y)
    numbersOut.push({ s: sb, lateral: lat, number: n, x: _p.x, y: _p.y, z: _p.z })
  }
  const lightPanel = (post: MarshalPostDef, side: 1 | -1) => {
    const ps = post.panel?.s ?? post.s + PANEL.dS
    const r = runFor(ps, side, post.lateral)
    const sp = snapToPost(r, ps)
    const m0 = mountAt(r, sp, post.panel?.lateral ?? post.lateral - side * (acrossHalf + 1.2))
    // the housing hangs on the track side of the post: its inner edge PANEL.arm off the line
    const lat = m0.lat - side * (PANEL.arm + PANEL.w / 2)
    const y = m0.base + PANEL.centreY
    panelMatrices.push(frameAt(track, sp, lat, y, new THREE.Matrix4()))
    if (m0.posts) arm(sp, m0.lat, m0.lat - side * PANEL.arm, y)
    else pole(sp + 0.15, lat, m0.base, PANEL.centreY + PANEL.h / 2, 0.025)
    // the control cabinet on the ground behind the post
    const cabLat = m0.lat + side * (m0.back + CABINET.gap + CABINET.w / 2)
    boxes.place(sp, cabLat, CABINET.l, CABINET.w, CABINET.h, cabinetMat, CABINET.lift, false, false)
    for (const x of [-0.18, 0.18]) for (const z of [-0.2, 0.2]) {
      const leg = new THREE.BoxGeometry(0.04, CABINET.lift, 0.04).translate(x, CABINET.lift / 2, z)
      leg.applyMatrix4(frameAt(track, sp, cabLat, ground.standAt(sp, cabLat), _t))
      poleGeos.push(leg)
    }
    track.pointAt(sp, lat, _p, y)
    panelsOut.push({ s: sp, lateral: lat, x: _p.x, y: _p.y, z: _p.z })
  }
  const cctv = (s: number, side: 1 | -1, fallbackLat: number) => {
    const r = runFor(s, side, fallbackLat)
    const sc = snapToPost(r, s)
    const m0 = mountAt(r, sc, fallbackLat)
    // behind the fence line: the wall / tyres / rail posts plus a clearance
    const lat = m0.lat + side * (m0.back + 0.25)
    const base = ground.standAt(sc, lat)
    cctvMatrices.push(frameAt(track, sc, lat, base, new THREE.Matrix4()))
    track.pointAt(sc, lat, _p, base + CCTV.h)
    cctvOut.push({ s: sc, lateral: lat, x: _p.x, y: _p.y, z: _p.z })
  }

  // --- the rows -------------------------------------------------------------------------------------
  let cabins = 0, lows = 0, panels = 0, slots = 0
  for (const post of MARSHAL_POSTS) {
    const side: 1 | -1 = post.lateral >= 0 ? 1 : -1
    const s = track.wrap(post.s)
    const base = ground.standAt(s, post.lateral)
    const yaw = side > 0 ? 0 : Math.PI
    const type = post.type ?? 'cabin'
    slots += marshalSlots(post).length
    if (type === 'cabin') {
      cabins++
      const L: 1 | -1 = (marshalStairSign(post) * side) as 1 | -1
      const at = (dy: number, dx = 0, dz = 0): THREE.Matrix4 => {
        const m = frameAt(track, s, post.lateral, base + dy, new THREE.Matrix4())
        m.multiply(_r.makeRotationY(yaw))
        if (dx || dz) m.multiply(_t.makeTranslation(dx, 0, dz))
        return m
      }
      protoOf(stands, L, (l) => ({ proto: standProto(l), placements: [], casts: true })).placements.push({ m: at(0) })
      const body = protoOf(bodies, L, (l) => {
        const proc = bodyProto(l)
        const glb = boothGlb(l, proc)
        return { proto: glb, placements: [], casts: true, ...(glb !== proc ? { far: proc } : {}) }
      })
      body.placements.push({ m: at(F) })
      // extinguishers: two at the stand's feet on the track side, one on the deck
      extSet.placements.push({ m: at(0, -acrossHalf - 0.15, -L * 0.6) }, { m: at(0, -acrossHalf - 0.15, L * 0.6) }, { m: at(F, acrossHalf - 0.25, L * (half + S.deckS - 0.25)) })
    } else if (type === 'low') {
      lows++
      const m = frameAt(track, s, post.lateral, base, new THREE.Matrix4())
      lowSet.placements.push({ m })
    }
    if (post.secondary) continue
    const n = numbers.get(post)
    if (n !== undefined) numberBoard(post, n, side)
    lightPanel(post, side)
    panels++
    cctv(s + CCTV.dS, side, post.lateral + side * 0.5)
  }
  for (const c of TRACKSIDE_CCTV) cctv(c.s, c.side, c.side * (track.halfWidthAt(c.s) + 3))

  // --- the meshes -------------------------------------------------------------------------------------
  const sets: PropSet[] = [...stands.values(), ...bodies.values(), lowSet, extSet]
  registerPropSet(ctx, 'infield', 'infield-marshal-cabins', sets, { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM })
  if (numberGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(numberGeos, false)!, numberMat)
    for (const g of numberGeos) g.dispose()
    mesh.name = 'marshalNumbers'
    mesh.receiveShadow = true
    group.add(mesh)
  }
  if (poleGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(poleGeos, false)!, steel)
    for (const g of poleGeos) g.dispose()
    mesh.name = 'marshalPoles'
    mesh.receiveShadow = true
    group.add(mesh)
  }
  if (panelMatrices.length) {
    // the housing and its dark LED face towards −s (the approaching cars), one geometry with two groups
    const housing = new THREE.BoxGeometry(PANEL.w, PANEL.h, PANEL.d).toNonIndexed()
    const face = new THREE.PlaneGeometry(PANEL.faceW, PANEL.faceH).rotateY(Math.PI).translate(0, 0, -PANEL.d / 2 - 0.003).toNonIndexed()
    const geo = mergeGeometries([housing, face], true)!
    const inst = new THREE.InstancedMesh(geo, [housingMat, ledMat], panelMatrices.length)
    panelMatrices.forEach((m, i) => inst.setMatrixAt(i, m))
    inst.instanceMatrix.needsUpdate = true
    inst.receiveShadow = true
    inst.name = 'emPanels'
    group.add(inst)
  }
  if (cctvMatrices.length) {
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(CCTV.r, CCTV.r, CCTV.h, 8).translate(0, CCTV.h / 2, 0), steel, cctvMatrices.length)
    const lens: Part = { geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8).rotateX(Q).translate(0, 0.1, -CCTV.head[0] / 2 - 0.02), material: trimMat }
    const headProc = proc('cctv-head', [box(CCTV.head[1], CCTV.head[2], CCTV.head[0], housingMat, 0, 0, 0), swatch(lens, TRIM.black)])
    const head = glbOr(ctx, 'model/props/security_camera_02', { id: 'cctv-head-glb', scaleTo: { long: CCTV.head[0] }, front: 'none' }, headProc)
    const heads = new THREE.InstancedMesh(head.geometry, head.materials.length === 1 ? head.materials[0]! : head.materials, cctvMatrices.length)
    cctvMatrices.forEach((m, i) => {
      poles.setMatrixAt(i, m)
      heads.setMatrixAt(i, _t.copy(m).multiply(_r.makeTranslation(0, CCTV.h, 0)))
    })
    poles.instanceMatrix.needsUpdate = true
    heads.instanceMatrix.needsUpdate = true
    poles.name = 'cctvPoles'
    heads.name = 'cctvHeads'
    poles.receiveShadow = true
    group.add(poles, heads)
  }
  group.userData.trackside = { panels: panelsOut, numbers: numbersOut, cctv: cctvOut }
  if (import.meta.dev) console.info(`[marshal-posts] ${MARSHAL_POSTS.length} posts: ${cabins} cabins, ${lows} low, ${numbersOut.length} number boards, ${panels} light panels (dark), ${cctvMatrices.length} cameras, ${slots} marshal slots`)
  return { posts: MARSHAL_POSTS.length, cabins, lows, panels, slots }
}

// ---------------------------------------------------------------------------------------------
// canvases

/**
 * The trim atlas (256 × 64): row 0 the red / white band (one 0.5 m period across the width),
 * row 1 eight flat swatches (yellow, red, blue, green, white, beige, zinc, black). `swatch(i)`
 * is the uv of swatch i's centre; `bandV` the v range of the band row's safe middle.
 */
const TRIM = {
  yellow: 0, red: 1, blue: 2, green: 3, white: 4, beige: 5, zinc: 6, black: 7,
  swatch: (i: number): [number, number] => [(i + 0.5) / 8, 0.625],
  bandV: [0.8, 0.95] as const,
}
const TRIM_COLOURS = ['#f2c400', '#c8201c', '#1d5bb5', '#2e8b57', '#f4f4f0', '#d6cdb0', '#9a9ea2', '#141414']

function trimAtlas(): THREE.Texture {
  return cached('marshal-trim', () => {
    const w = 256, h = 64
    const { c, ctx } = canvas(w, h)
    // row 0 (top quarter): red | white
    ctx.fillStyle = '#c8102e'
    ctx.fillRect(0, 0, w / 2, h / 4)
    ctx.fillStyle = '#f4f4f0'
    ctx.fillRect(w / 2, 0, w / 2, h / 4)
    // row 1: the swatches
    TRIM_COLOURS.forEach((col, i) => {
      ctx.fillStyle = col
      ctx.fillRect((i * w) / 8, h / 4, w / 8, h / 4)
    })
    ctx.fillStyle = '#9a9ea2'
    ctx.fillRect(0, h / 2, w, h / 2)
    const tex = makeTexture(c, { wrap: THREE.RepeatWrapping })
    tex.wrapT = THREE.ClampToEdgeWrapping
    return tex
  })
}

/** the light panel's face, dark: a 64 × 48 LED-dot matrix on 0x2a1f1d (no emissive — lpfront.jpg, green flag) */
function emPanelTexture(): THREE.Texture {
  return cached('marshal-em-panel', () => {
    const w = 256, h = 192
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#2a1f1d'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#3d2c29'
    const px = w / 64
    for (let j = 0; j < 48; j++) for (let i = 0; i < 64; i++) ctx.fillRect(i * px + px * 0.3, j * px + px * 0.3, px * 0.45, px * 0.45)
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** the number atlas: NUM_COLS × NUM_ROWS cells, cell 0 blank white, cell n the digits of post n (black on white, 66 % of the board's height) */
export function marshalNumberAtlas(): THREE.Texture {
  const [w, h] = scaled(1024, 512)
  return cached(`marshal-numbers|${w}x${h}`, () => {
    const { c, ctx } = canvas(w, h)
    const cw = w / NUM_COLS, ch = h / NUM_ROWS
    ctx.fillStyle = '#f6f6f3'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#141414'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `900 ${Math.round(ch * 0.5)}px 'Titillium Web', 'Segoe UI', Arial, sans-serif`
    for (let n = 1; n < NUM_COLS * NUM_ROWS; n++) {
      const x = (n % NUM_COLS) * cw, y = Math.floor(n / NUM_COLS) * ch
      ctx.fillText(TRACKSIDE_TEXTS[n - 1]!, x + cw / 2, y + ch / 2 + ch * 0.03)
    }
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/**
 * Remap a board box's uv so face `face` (BoxGeometry groups: +x, −x, +y, −y, +z, −z) shows cell
 * `n` of the number atlas and every other face the blank cell; the board is 1.5 : 1 while the
 * cells are square, so the face reads the middle 60 % of its cell's height (the digits are
 * drawn at 50 % of the cell's height, centred — the crop keeps them whole, 0.67 m on the board).
 */
function numberUv(uv: THREE.BufferAttribute, face: number, n: number) {
  const rect = (i: number) => {
    const col = i % NUM_COLS, row = Math.floor(i / NUM_COLS)
    return { u0: col / NUM_COLS, u1: (col + 1) / NUM_COLS, v0: 1 - (row + 1) / NUM_ROWS, v1: 1 - row / NUM_ROWS }
  }
  for (let f = 0; f < 6; f++) {
    const r = rect(f === face ? n : 0)
    for (let i = f * 4; i < f * 4 + 4; i++) {
      const u = 0.04 + uv.getX(i) * 0.92, v = 0.2 + uv.getY(i) * 0.6
      uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0))
    }
  }
  uv.needsUpdate = true
}
