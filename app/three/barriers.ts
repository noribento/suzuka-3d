import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { AD_PANELS, BARRIERS, FENCE_BACK_SETBACK, FENCE_BLACK, FENCE_GREEN, MARSHAL_POSTS, type BarrierKind, type BarrierRun } from '~/data/suzuka-barriers-spec'
import { forwardDelta, type Track } from '~/sim/track'
import { profileRibbonGeometry, ribbonGeometry, wallGeometry } from './track-mesh'
import { GROUND_OBJECTS, markObject, type Ground } from './ground'
import { BIG_PANEL_CELLS, BOARD_TILE_M, PAINTED_BLOCK_TILE_M, TYRE_WALL_H, TYRE_WALL_TILE_M, armco3Maps, armcoMaps, bigPanelTexture, boardTexture, chainLinkTexture, concreteMaps, paintedBlockTexture, tricolourWallTexture, tyreWallTexture } from './textures'
import type { Quality } from './quality'
import type { AssetRegistry } from './assets'
import { bucketedInstancedMeshes } from './instancing'
import { cutoutFromAssets, cutoutParams, pbr, pbrFromAssets, tileMetres } from './materials'
import { resolveLineCached } from './trackside'
import { glbOr, makePropCache, procProp, type PropProto } from './props-pack'
import { registerPropSet, type PropPlacement } from './infield-lod'
import type { FarField } from './farfield'
import type { EnvBuildContext } from './environment'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()

/**
 * Dimensions of each barrier kind: `bottom`/`top` above the ground it stands on, the depth of the
 * top cap, and how many metres of the texture one tile spans along the run.
 */
export const BARRIER_KIND = {
  armco: { bottom: 0.32, top: 0.78, cap: 0, tile: 4, posts: true },
  guardrail: { bottom: 0.34, top: 0.8, cap: 0, tile: 4, posts: true },
  /** the 130R triple beam (r130.jpg): three beams from 0.25 to 0.95 m on the same posts */
  guardrail3: { bottom: 0.25, top: 0.95, cap: 0, tile: 4, posts: true },
  concrete: { bottom: 0, top: 1.05, cap: 0.35, tile: 4, posts: false },
  /** 1.95 → 1.5 at I4-c: the photos read 1.2–1.5 m of belted stack (A10 screens by the fence, not the wall) */
  tyre: { bottom: 0, top: TYRE_WALL_H, cap: 0.7, tile: TYRE_WALL_TILE_M, posts: false },
  fence: { bottom: 0, top: 0, cap: 0, tile: 4, posts: false },
} as const satisfies Record<BarrierKind, { bottom: number; top: number; cap: number; tile: number; posts: boolean }>
const KIND = BARRIER_KIND

/** how far behind a run's line its back face is (m): the tyre stacks' depth, the wall's thickness, a rail's post */
export function barrierDepth(run: Pick<BarrierRun, 'kind'>): number {
  return run.kind === 'tyre' ? 1.3 : run.kind === 'concrete' ? 0.35 : run.kind === 'fence' ? 0.05 : 0.14
}

/** height of a bare chain-link run (`kind: 'fence'`, no wall under it): the car-park fences, and the spectator-side fence of a `fenceSide: 'both'` run (m) */
export const BARE_FENCE_HEIGHT = 3.0
/** a bare fence's mesh starts this far above the ground (the concrete plinth / kick board) */
const BARE_FENCE_BOTTOM = 0.8
/**
 * Metres one tile of the fence003 mesh covers. The manifest carries no `tile` for fence003
 * (scripts/assets/sources.mjs lists none), so this is the documented fallback: the photo's
 * mesh pitch is ≈ 50 mm and one 1024² tile shows ≈ 40 diamonds → 2.0 m. The procedural
 * chain-link tile (20 cm diamonds) is repeated to the same metre UVs.
 */
export const FENCE_TILE_M = 2.0
const CHAIN_LINK_TILE_M = 0.2
/** the fence posts' pitch along a run (m); the marshal boards and panels snap to it (marshal-posts.ts) */
export const FENCE_POST_PITCH = 4
/** the boards hang this far off the wall face, towards the track (m) */
const BOARD_OFFSET = 0.03
/** a photographers' window in the fence mesh: width along the run, height, and its sill above the fence's foot (m; I4-c, unverified) */
export const FENCE_WINDOW = { w: 1.2, h: 0.8, sill: 0.5 } as const
/** the loudspeaker horns on the fence posts: pitch along the fence and the box (m) */
export const FENCE_HORN = { pitch: 40, size: [0.3, 0.3, 0.4] as const, drop: 0.35 } as const
/** the foam sponge blocks in front of the chicane exit tyres (I4-c): the box, the pitch, the gap to the wall, the top row's shift along s */
export const SPONGE = { size: [1.5, 1.0, 1.0] as const, pitch: 1.5, gap: 0.3, shift: 0.4, run: 'chicane-exit-tyres' } as const
/** the tyre stacks behind the tyre walls: two per fence-post position, this far apart along s, their edge against the wall's back */
export const TYRE_STACK = { dS: 0.45, radius: 0.42, tyres: 5, tyreH: 0.24 } as const

/**
 * A barrier vertex takes the height of the ground beside ITS road. Where the crossover puts one
 * road on the embankment of the other, `ground.standAt` returns that embankment and the wall would
 * climb onto the deck above (the pre-2026-09 audit's "Degner wall on the 130R bridge"), so the
 * rise over the road plane is capped.
 */
const MAX_RISE = 3

/** What the smoke reads back (`group.userData.barriers`): counts per part, not restated from the table. */
export interface BarrierStats {
  runs: number
  fencePosts: number
  fencePostsDark: number
  windows: number
  gates: number
  tyreStacks: number
  sponges: number
  horns: number
  panels: number
  /** the runs drawn with the triple beam */
  guardrail3: string[]
  /** [s0, s1] per window cut in the fence mesh, by run id */
  windowCuts: Record<string, [number, number][]>
}

/** reverse the winding of an indexed geometry (a FrontSide wall that must face the other way) */
function flipWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.getIndex()
  if (!idx) return g
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1)
    idx.setX(i, b)
    idx.setX(i + 1, a)
  }
  idx.needsUpdate = true
  g.computeVertexNormals()
  return g
}

/**
 * `wallGeometry`'s winding faces +lateral (the driver's left). A FrontSide sheet meant to face
 * −lateral is flipped here; DoubleSide materials never care.
 */
function facing(g: THREE.BufferGeometry, towardsPositiveLateral: boolean): THREE.BufferGeometry {
  return towardsPositiveLateral ? g : flipWinding(g)
}

/** Square (or triangular) tube along the track: a rail or a cable following a fence top. */
function tube(track: Track, s0: number, s1: number, lat: Fn, y: Fn, r: number, sides: 3 | 4 = 4, step = 2): THREE.BufferGeometry {
  const edges: [Fn, Fn][] = sides === 4
    ? [[(s) => lat(s) - r, (s) => y(s) - r], [(s) => lat(s) - r, (s) => y(s) + r], [(s) => lat(s) + r, (s) => y(s) + r], [(s) => lat(s) + r, (s) => y(s) - r], [(s) => lat(s) - r, (s) => y(s) - r]]
    : [[(s) => lat(s) - r, (s) => y(s) - r], [(s) => lat(s), (s) => y(s) + r], [(s) => lat(s) + r, (s) => y(s) - r], [(s) => lat(s) - r, (s) => y(s) - r]]
  return profileRibbonGeometry(track, s0, s1, edges, step, 4)
}

/** Split [a, b] (forward along the lap, `len` long) around the cuts, returning the kept intervals as forward distances from `a`. */
function keepOutside(len: number, cuts: [number, number][]): [number, number][] {
  const sorted = cuts.filter(([c0, c1]) => c1 > 0 && c0 < len).map(([c0, c1]): [number, number] => [Math.max(0, c0), Math.min(len, c1)]).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  let from = 0
  for (const [c0, c1] of sorted) {
    if (c0 > from + 0.05) out.push([from, c0])
    from = Math.max(from, c1)
  }
  if (len > from + 0.05) out.push([from, len])
  return out
}

/**
 * Barriers around the whole lap, from the hand-authored table in `app/data/suzuka-barriers-spec.ts`
 * (BARRIERS): concrete walls, tyre walls, Armco / white guard rails / the 130R triple beam and
 * the chain-link debris fences above them, each run resolved to a lateral offset along its OWN
 * stretch of road from the OpenStreetMap ways it is mapped from (road-facing edge) and from the
 * samples read off the aerial.
 *
 * I4-c (plan §I4-c): the fences carry their colour (`fenceColour`: dark green, or the 2024 black
 * repaint — posts and rails in the same two buckets), a top rail and two mid cables, the
 * photographers' windows cut in the mesh, the marshals' gates with a leaf, and a second
 * spectator-side fence where `fenceSide: 'both'`; the tyre walls are 1.5 m of segmented belting
 * with real tyre stacks behind them; the chicane exit has its sponge blocks; the concrete walls
 * take the concrete046 photo PBR (FrontSide, a back-face ribbon); the hoardings are the
 * BOARD_TEXTS words (wall-face boards, wall-top ad bands, the free-standing AD_PANELS); the
 * loudspeaker horns hang on the fence posts every FENCE_HORN.pitch.
 *
 * Nothing here is derived from the run-off table any more: the old code placed the rail at the far
 * edge of whatever gravel trap was nearby, which put it through the C, D, O and S grandstands, over
 * the 130R bridge and onto the Dunlop road at the chicane. Geometry is merged per material, and the
 * rail posts are instanced in 500 m buckets so a follow camera only draws the ones around it.
 * Built in the viewport after the environment (no EnvBuildContext): the ground is read through
 * `ground.standAt`, the GLB tyre stack through `glbOr` on a local prop cache. With `farField`
 * (the viewport passes `env.farField`) the tyre stacks are a prop set on the far-field registry
 * (`infield-tyreStacks`, the pack's stack near / the tori far, `Quality.infield` ranges) instead
 * of 500 m buckets in this group: 815 stacks × 960 GLB triangles want a distance cut.
 */
export function buildBarriers(track: Track, quality: Quality, ground: Ground, assets: AssetRegistry | null = null, farField: FarField | null = null): THREE.Group {
  const group = new THREE.Group()
  group.name = 'barriers'
  const L = track.length
  const stats: BarrierStats = { runs: BARRIERS.length, fencePosts: 0, fencePostsDark: 0, windows: 0, gates: 0, tyreStacks: 0, sponges: 0, horns: 0, panels: 0, guardrail3: [], windowCuts: {} }

  // --- materials -------------------------------------------------------------------------------
  const armco = armcoMaps()
  const railMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide })
  const guardMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xdfe2e4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })
  const armco3 = armco3Maps()
  const guard3Mat = new THREE.MeshStandardMaterial({ map: armco3.map, normalMap: armco3.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xe4e6e8, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })
  // the concrete walls: concrete046 (diff / nor_gl / arm) FrontSide — the back is its own ribbon
  // (plan §横断 7: the DoubleSide variant would be one more program); the procedural concrete
  // when the pack is off (concreteMaps carries no roughness map: `undefined` through the
  // constructor warns)
  const concreteTile = tileMetres(assets, 'tex/concrete046/diff', 4)
  const concreteFallback = () => pbr(concreteMaps(), { color: 0xd8d8d4, roughness: 0.95 }, 0.5)
  const concreteMat = assets ? pbrFromAssets(assets, 'concrete046', { fallback: concreteFallback, handBuiltUv: true, normalScale: 0.5, extra: { color: 0xd8d8d4 } }) : concreteFallback()
  const capMat = new THREE.MeshStandardMaterial({ map: concreteMaps().map, color: 0xcfcfca, roughness: 0.95 })
  const tyreMat = new THREE.MeshStandardMaterial({ map: tyreWallTexture(), roughness: 0.9, side: THREE.DoubleSide })
  const paintedMat = new THREE.MeshStandardMaterial({ map: paintedBlockTexture(), roughness: 0.85, side: THREE.DoubleSide })
  const tricolourMat = new THREE.MeshStandardMaterial({ map: tricolourWallTexture(), roughness: 0.85, side: THREE.DoubleSide })
  // Suzuka wraps its tyre stacks in white conveyor belting that folds over the top, so from above
  // they read as WHITE lines (the 国土地理院 aerial samples them at luminance 172-206). The old
  // near-black cap was 1.3 m wide, which is every black line in a top-down render of the chicane.
  const tyreTopMat = new THREE.MeshStandardMaterial({ color: 0xd9d7cf, roughness: 0.9 })
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.6, metalness: 0.7 })
  /** the fence posts, rails, cables and gate frames, painted like their mesh: the two colour buckets */
  const fencePostMats: Record<'green' | 'dark', THREE.MeshStandardMaterial> = {
    green: new THREE.MeshStandardMaterial({ color: FENCE_GREEN, roughness: 0.6, metalness: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: FENCE_BLACK, roughness: 0.6, metalness: 0.5 }),
  }
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.5 })
  const tarpMat = new THREE.MeshStandardMaterial({ color: 0x9a9b98, roughness: 0.95, metalness: 0 })
  // the debris-fence mesh: the fence003 photo (diff / normal / opacity) on the high tier, the
  // procedural chain-link otherwise — both in METRE uv (wallGeometry with 1 m tiles both ways)
  const fenceMat = cutoutFromAssets(assets, 'fence003', {
    quality,
    tile: FENCE_TILE_M,
    handBuiltUv: true,
    normalScale: 0.6,
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(1 / CHAIN_LINK_TILE_M, 1 / CHAIN_LINK_TILE_M)
      return new THREE.MeshStandardMaterial({ map, ...cutoutParams(quality), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 })
    },
  })
  /** tinted copies of the fence material per `fenceColour` (FENCE_GREEN by default, FENCE_BLACK where repainted) */
  const fenceMats = new Map<string, THREE.MeshStandardMaterial>()
  const fenceMatFor = (colour: string): string => {
    if (!fenceMats.has(colour)) {
      const m = fenceMat.clone()
      m.color.set(colour)
      fenceMats.set(colour, m)
    }
    return colour
  }
  const bucketOf = (colour: string): 'green' | 'dark' => (colour === FENCE_BLACK ? 'dark' : 'green')
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })
  const panelMat = new THREE.MeshStandardMaterial({ map: bigPanelTexture(), roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })

  const geos: Record<string, THREE.BufferGeometry[]> = { rail: [], guard: [], guard3: [], concrete: [], cap: [], tyre: [], tyreTop: [], painted: [], tricolour: [], boards: [], panelPosts: [], panels: [] }
  const fenceGeos = new Map<string, THREE.BufferGeometry[]>()
  const fenceRailGeos: Record<'green' | 'dark', THREE.BufferGeometry[]> = { green: [], dark: [] }
  const postMatrices: THREE.Matrix4[] = []
  const postS: number[] = []
  const fencePosts: Record<'green' | 'dark', { m: THREE.Matrix4[]; s: number[] }> = { green: { m: [], s: [] }, dark: { m: [], s: [] } }
  const hornMatrices: THREE.Matrix4[] = []
  const hornS: number[] = []
  const stackMatrices: THREE.Matrix4[] = []
  const stackS: number[] = []
  const spongeLow: THREE.Matrix4[] = []
  const spongeHigh: THREE.Matrix4[] = []

  /** the orientation at (s, lat, y): local +X = the driver's left, +Y up, +Z along the track */
  const frameAt = (s: number, lat: number, y: number, out: THREE.Matrix4, scale = new THREE.Vector3(1, 1, 1)) => {
    const h = track.headingAt(s)
    track.pointAt(s, lat, _p, y)
    _q.setFromRotationMatrix(_m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
    out.compose(_p, _q, scale)
  }
  const addPost = (s: number, lat: number, y: number, height: number, scale: number, into: { m: THREE.Matrix4[]; s: number[] }) => {
    const m = new THREE.Matrix4()
    frameAt(s, lat, y + height / 2, m, new THREE.Vector3(scale, height, scale))
    into.m.push(m)
    into.s.push(track.wrap(s))
  }

  // the tyre stack prototype: the pack's tire_stack behind glbOr, else five tori (the far level
  // and the low tier's); base-centred like every prop. 5 × 10 segments (100 tris a tyre, 500 a
  // stack): the plan's 6 × 12 would put 587 k triangles behind the 815 stacks, 5 × 10 puts 408 k
  const propCache = makePropCache()
  let stackProc: PropProto | null = null
  const stackProto = (() => {
    const parts: THREE.BufferGeometry[] = []
    for (let k = 0; k < TYRE_STACK.tyres; k++) {
      const t = new THREE.TorusGeometry(TYRE_STACK.radius - 0.12, 0.12, 5, 10)
      t.rotateX(Math.PI / 2)
      t.translate(0, 0.12 + k * TYRE_STACK.tyreH, 0)
      parts.push(t)
    }
    const geo = mergeGeometries(parts, false)!
    for (const g of parts) g.dispose()
    const proc = procProp('tyre-stack', [{ geometry: geo, material: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9, metalness: 0 }) }])
    stackProc = proc
    return glbOr({ assets, quality, props: propCache }, 'model/trackside/tire_stack', { id: 'tyre-stack-glb', scaleTo: { height: TYRE_STACK.tyres * TYRE_STACK.tyreH }, front: 'none' }, proc)
  })()

  const wallDepth = (run: BarrierRun) => barrierDepth(run)
  const postsOnSide = (run: BarrierRun) => MARSHAL_POSTS.filter((m) => Math.sign(m.lateral) === run.side && forwardDelta(run.sRange[0], m.s, L) <= forwardDelta(run.sRange[0], run.sRange[1], L))

  for (const run of BARRIERS) {
    const k = KIND[run.kind]
    const [s0, s1] = run.sRange
    const len = forwardDelta(s0, s1, L)
    if (len < 2) continue
    const { lat, base, top } = barrierProfile(track, ground, run)
    const bottom: Fn = (s) => base(s) + k.bottom
    const depth = wallDepth(run)
    const back: Fn = (s) => lat(s) + run.side * depth
    const towardsTrack = run.side < 0 // a face towards the track looks to +lateral on the right-hand side
    if (run.kind === 'guardrail3') stats.guardrail3.push(run.id)

    if (run.kind !== 'fence') {
      // the face towards the track: the painted stretches (`painted`) get their own sheet
      const painted = run.face === 'painted-rwg' ? (run.painted ?? []).map(([a, b]): [number, number] => [forwardDelta(s0, a, L), forwardDelta(s0, b, L)]) : []
      const plain = keepOutside(len, painted)
      const faceKey = run.kind === 'armco' ? 'rail' : run.kind === 'guardrail' ? 'guard' : run.kind === 'guardrail3' ? 'guard3' : run.kind === 'tyre' ? 'tyre' : 'concrete'
      const tile = run.kind === 'concrete' ? concreteTile : k.tile
      // uScale (metres per tile UP the wall): the tyre tile is drawn for the wall's height, the
      // concrete photo tiles square, the rails span one tile
      const up = run.kind === 'tyre' ? TYRE_WALL_H : run.kind === 'concrete' ? concreteTile : undefined
      for (const [a, b] of plain) {
        const g = wallGeometry(track, s0 + a, s0 + b, lat, bottom, top, 2, tile, up)
        geos[faceKey]!.push(run.kind === 'concrete' ? facing(g, towardsTrack) : g)
      }
      for (const [a, b] of painted) {
        if (b - a < 0.5) continue
        const g = wallGeometry(track, s0 + a, s0 + b, lat, bottom, top, 2, PAINTED_BLOCK_TILE_M, run.kind === 'tyre' ? TYRE_WALL_H : k.top - k.bottom)
        geos[run.kind === 'tyre' ? 'painted' : 'tricolour']!.push(g)
      }
      if (k.cap > 0) {
        const inner = run.side > 0 ? back : lat
        const outer = run.side > 0 ? lat : back
        geos[run.kind === 'tyre' ? 'tyreTop' : 'cap']!.push(ribbonGeometry(track, s0, s1, inner, outer, top, top, 2, 2))
        // the back face, so a wall seen from the paddock is not a one-sided sheet
        const g = wallGeometry(track, s0, s1, back, bottom, top, 4, tile, up)
        geos[run.kind === 'tyre' ? 'tyre' : 'concrete']!.push(run.kind === 'concrete' ? facing(g, !towardsTrack) : g)
      }
      if (k.posts) for (let d = 0; d <= len; d += FENCE_POST_PITCH) addPost(s0 + d, lat(s0 + d), base(s0 + d) + 0.1, k.top - 0.1, 0.14, { m: postMatrices, s: postS })
      // advertising boards on the track face of the grandstand front wall (`boards`, concrete
      // runs only): a band hung BOARD_OFFSET off the face, BOARD_TEXTS panels of 8 m per repeat
      if (run.boards) {
        const face: Fn = (s) => lat(s) - run.side * BOARD_OFFSET
        geos.boards!.push(wallGeometry(track, s0, s1, face, (s) => base(s) + 0.15, (s) => base(s) + k.top - 0.05, 2, BOARD_TILE_M))
      }
      // the wall-top ad band: a hoarding standing on the wall's top along its track face
      if (run.adBand) {
        const face: Fn = (s) => lat(s) - run.side * 0.05
        const h = run.adBand
        geos.boards!.push(wallGeometry(track, s0, s1, face, top, (s) => top(s) + h, 2, BOARD_TILE_M))
      }
      // the tyre stacks behind a tyre wall: two per fence-post position, standing on the ground
      // against the wall's back (the spare rows the spectator side sees), sunk GROUND_OBJECTS.tyreStack.sink
      if (run.kind === 'tyre' && quality.infield.detail) {
        const latStack: Fn = (s) => back(s) + run.side * TYRE_STACK.radius
        for (let d = 0; d <= len; d += FENCE_POST_PITCH) {
          for (const dS of [-TYRE_STACK.dS, TYRE_STACK.dS]) {
            const s = s0 + d + dS
            if (d + dS < 0 || d + dS > len) continue
            const m = new THREE.Matrix4()
            frameAt(s, latStack(s), ground.standAt(s, latStack(s)) - GROUND_OBJECTS.tyreStack.sink, m)
            stackMatrices.push(m)
            stackS.push(track.wrap(s))
          }
        }
      }
      // the sponge blocks: grey tarp boxes, two rows, in front of the chicane exit tyres. That
      // wall runs diagonally to the road (up to 40°), so the gap is measured square to the wall
      // and each box is turned along it
      if (run.id === SPONGE.run) {
        const [sl, sa, sh] = SPONGE.size
        const slope = (s: number) => (lat(s + 0.5) - lat(s - 0.5))
        const latSponge: Fn = (s) => lat(s) - run.side * ((SPONGE.gap + sa / 2) / Math.cos(Math.atan(slope(s))))
        const place = (s: number, y: number, into: THREE.Matrix4[]) => {
          const m = new THREE.Matrix4()
          frameAt(s, latSponge(s), y, m)
          m.multiply(new THREE.Matrix4().makeRotationY(Math.atan(slope(s))))
          into.push(m)
        }
        for (let d = sl / 2; d + sl / 2 <= len; d += SPONGE.pitch) {
          const s = s0 + d
          const y = ground.standAt(s, latSponge(s)) - GROUND_OBJECTS.sponge.sink
          place(s, y + sh / 2, spongeLow)
          if (d + SPONGE.shift + sl / 2 > len) continue
          place(s + SPONGE.shift, y + sh * 1.5, spongeHigh)
        }
      }
    }

    // chain-link above the barrier (or standing on the ground for a bare fence run)
    const fenceTop = run.kind === 'fence' ? BARE_FENCE_HEIGHT : run.fence ?? 0
    if (fenceTop > 0 && quality.fence) {
      const colour = run.fenceColour ?? FENCE_GREEN
      const key = fenceMatFor(colour)
      const bucket = bucketOf(colour)
      let list = fenceGeos.get(key)
      if (!list) fenceGeos.set(key, (list = []))
      const fenceList = list
      /**
       * One fence sheet along `latF` between the run's forward distances [a, b], from `from` up
       * `height`, with its posts every FENCE_POST_PITCH, the top rail and two mid cables, the
       * windows and gates cut out of the mesh (the run's own fence only).
       */
      const sheet = (a: number, b: number, latF: Fn, from: Fn, height: number, opts: { windows?: number[]; gates?: [number, number][]; horns?: boolean }) => {
        const to: Fn = (s) => from(s) + height
        const fa = s0 + a, fb = s0 + b
        const flen = b - a
        const windows = (opts.windows ?? []).map((w) => forwardDelta(fa, w, L)).filter((d) => d >= 0 && d <= flen)
        const gates = (opts.gates ?? []).map(([g0, g1]): [number, number] => [forwardDelta(fa, g0, L), forwardDelta(fa, g0, L) + forwardDelta(g0, g1, L)]).filter(([d0]) => d0 >= 0 && d0 <= flen)
        const cuts: [number, number][] = [...windows.map((d): [number, number] => [d - FENCE_WINDOW.w / 2, d + FENCE_WINDOW.w / 2]), ...gates]
        // metre uv: one unit = 1 m along and up; the material's repeat maps the tile onto it
        for (const [c, d] of keepOutside(flen, cuts)) fenceList.push(wallGeometry(track, fa + c, fa + d, latF, from, to, 4, 1, 1))
        // a window: the mesh under its sill and over its head stay
        for (const d of windows) {
          const w0 = fa + d - FENCE_WINDOW.w / 2, w1 = fa + d + FENCE_WINDOW.w / 2
          fenceList.push(wallGeometry(track, w0, w1, latF, from, (s) => from(s) + FENCE_WINDOW.sill, 1, 1, 1))
          fenceList.push(wallGeometry(track, w0, w1, latF, (s) => from(s) + FENCE_WINDOW.sill + FENCE_WINDOW.h, to, 1, 1, 1))
          // a frame round the opening: four bars of the post material
          const yS: Fn = (s) => from(s) + FENCE_WINDOW.sill, yH: Fn = (s) => from(s) + FENCE_WINDOW.sill + FENCE_WINDOW.h
          fenceRailGeos[bucket].push(tube(track, w0, w1, latF, yS, 0.02, 4, 1), tube(track, w0, w1, latF, yH, 0.02, 4, 1))
          for (const ws of [w0, w1]) addPost(ws, latF(ws), yS(ws), FENCE_WINDOW.h, 0.04, fencePosts[bucket])
          stats.windows++
          ;(stats.windowCuts[run.id] ??= []).push([track.wrap(w0), track.wrap(w1)])
        }
        // a gate: posts either side, a framed leaf of mesh inside the cut (closed)
        for (const [g0, g1] of gates) {
          const ga = fa + g0, gb = fa + g1
          const leafFrom: Fn = (s) => from(s) + 0.08
          const leafTo: Fn = (s) => to(s) - 0.12
          const latLeaf: Fn = (s) => latF(s) + run.side * 0.06
          fenceList.push(wallGeometry(track, ga + 0.08, gb - 0.08, latLeaf, leafFrom, leafTo, 1, 1, 1))
          fenceRailGeos[bucket].push(tube(track, ga + 0.08, gb - 0.08, latLeaf, leafFrom, 0.02, 4, 1), tube(track, ga + 0.08, gb - 0.08, latLeaf, leafTo, 0.02, 4, 1))
          for (const gs of [ga + 0.08, gb - 0.08]) addPost(gs, latLeaf(gs), leafFrom(gs), leafTo(gs) - leafFrom(gs), 0.04, fencePosts[bucket])
          for (const gs of [ga, gb]) addPost(gs, latF(gs), from(gs) - 0.15, height + 0.15, 0.1, fencePosts[bucket])
          stats.gates++
        }
        for (let d = 0; d <= flen; d += FENCE_POST_PITCH) {
          const s = fa + d
          if (gates.some(([g0, g1]) => d > g0 - 0.3 && d < g1 + 0.3)) continue
          addPost(s, latF(s), from(s) - 0.15, height + 0.15, 0.09, fencePosts[bucket])
        }
        if (run.topRail) {
          fenceRailGeos[bucket].push(tube(track, fa, fb, latF, to, 0.03, 4))
          for (const f of [1 / 3, 2 / 3]) fenceRailGeos[bucket].push(tube(track, fa, fb, latF, (s) => from(s) + height * f, 0.008, 3))
        }
        // the loudspeaker horns: on a post every FENCE_HORN.pitch, hung under the fence top on the spectator side
        if (opts.horns) {
          for (let d = FENCE_HORN.pitch / 2; d <= flen; d += FENCE_HORN.pitch) {
            const dp = Math.round(d / FENCE_POST_PITCH) * FENCE_POST_PITCH
            if (dp > flen) continue
            const s = fa + dp
            const m = new THREE.Matrix4()
            frameAt(s, latF(s) + run.side * (FENCE_HORN.size[0] / 2 + 0.06), to(s) - FENCE_HORN.drop, m, new THREE.Vector3(FENCE_HORN.size[0], FENCE_HORN.size[1], FENCE_HORN.size[2]))
            hornMatrices.push(m)
            hornS.push(track.wrap(s))
            stats.horns++
          }
        }
      }
      // the run's own fence: on the wall's top (or from the ground for a bare run), over `fenceRange` when given
      const fr = run.fenceRange ?? run.sRange
      const a = forwardDelta(s0, fr[0], L), b = a + forwardDelta(fr[0], fr[1], L)
      const from: Fn = (s) => base(s) + (run.kind === 'fence' ? BARE_FENCE_BOTTOM : k.top)
      sheet(a, Math.min(b, len), lat, from, fenceTop, { windows: run.windows, gates: run.gates, horns: quality.infield.detail })
      // the spectator-side fence of a double-fenced run: a bare 3 m fence FENCE_BACK_SETBACK behind the wall's back
      if (run.fenceSide === 'both') {
        const lat2: Fn = (s) => back(s) + run.side * FENCE_BACK_SETBACK
        const from2: Fn = (s) => Math.min(ground.standAt(s, lat2(s)), MAX_RISE) + 0.1
        sheet(0, len, lat2, from2, BARE_FENCE_HEIGHT - 0.1, {})
      }
    }
  }

  // --- the free-standing hoarding panels (AD_PANELS): a 12 × 4 m board on two posts ----------
  for (const [i, p] of AD_PANELS.entries()) {
    const cell = i % BIG_PANEL_CELLS
    const board = new THREE.PlaneGeometry(p.width, p.boardHeight)
    const uv = board.attributes.uv as THREE.BufferAttribute
    for (let v = 0; v < uv.count; v++) uv.setXY(v, uv.getX(v), (cell + uv.getY(v)) / BIG_PANEL_CELLS)
    // the plane faces +z; turn its face to `facing` (local +X = +lateral, +Z = +s)
    const yaw = p.facing === '+s' ? 0 : p.facing === '-s' ? Math.PI : p.facing === '+lat' ? Math.PI / 2 : -Math.PI / 2
    board.rotateY(yaw)
    board.translate(0, p.height + p.boardHeight / 2, 0)
    const y = ground.standAt(p.s, p.lateral)
    const frame = new THREE.Matrix4()
    frameAt(p.s, p.lateral, y, frame)
    geos.panels!.push(board.applyMatrix4(frame))
    const along = p.facing === '+s' || p.facing === '-s' ? 'x' : 'z'
    for (const o of [-p.width * 0.4, p.width * 0.4]) {
      const post = new THREE.BoxGeometry(0.15, p.height + p.boardHeight * 0.9, 0.15)
      post.translate(along === 'x' ? o : 0, (p.height + p.boardHeight * 0.9) / 2, along === 'z' ? o : 0)
      geos.panelPosts!.push(post.applyMatrix4(frame))
    }
    stats.panels++
  }

  const add = (key: string, mat: THREE.Material, name: string, cast: boolean) => {
    const list = geos[key]!
    if (!list.length) return
    const merged = mergeGeometries(list, false)
    for (const g of list) g.dispose()
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = true
    group.add(mesh)
  }
  add('rail', railMat, 'armco', true)
  add('guard', guardMat, 'guardrails', true)
  add('guard3', guard3Mat, 'guardrails3', true)
  add('concrete', concreteMat, 'barrierWalls', true)
  add('cap', capMat, 'barrierWallTops', false)
  add('tyre', tyreMat, 'tyreWalls', true)
  add('painted', paintedMat, 'tyreWallsPainted', true)
  add('tricolour', tricolourMat, 'barrierWallsPainted', true)
  add('tyreTop', tyreTopMat, 'tyreWallTops', false)
  add('boards', boardMat, 'barrierBoards', false)
  add('panels', panelMat, 'adPanels', true)
  add('panelPosts', postMat, 'adPanelPosts', true)
  for (const [key, list] of fenceGeos) {
    geos[`fence${key}`] = list
    add(`fence${key}`, fenceMats.get(key)!, key === FENCE_BLACK ? 'debrisFenceDark' : 'debrisFence', false)
  }
  for (const bucket of ['green', 'dark'] as const) {
    geos[`fenceRails-${bucket}`] = fenceRailGeos[bucket]
    add(`fenceRails-${bucket}`, fencePostMats[bucket], bucket === 'dark' ? 'fenceRailsDark' : 'fenceRails', false)
  }

  const postGeo = new THREE.BoxGeometry(1, 1, 1.15)
  for (const inst of bucketedInstancedMeshes(postGeo, postMat, postMatrices, null, (i) => Math.floor(postS[i]! / 500), { name: 'railPosts' })) group.add(inst)
  const fencePostGeo = new THREE.BoxGeometry(1, 1, 1)
  for (const bucket of ['green', 'dark'] as const) {
    const fp = fencePosts[bucket]
    if (!fp.m.length) continue
    for (const inst of bucketedInstancedMeshes(fencePostGeo, fencePostMats[bucket], fp.m, null, (i) => Math.floor(fp.s[i]! / 500), { name: bucket === 'dark' ? 'fencePostsDark' : 'fencePosts' })) group.add(inst)
    if (bucket === 'dark') stats.fencePostsDark = fp.m.length
    else stats.fencePosts = fp.m.length
  }
  if (hornMatrices.length) {
    const hornGeo = new THREE.BoxGeometry(1, 1, 1)
    for (const inst of bucketedInstancedMeshes(hornGeo, hornMat, hornMatrices, null, (i) => Math.floor(hornS[i]! / 500), { name: 'pitHorns' })) group.add(inst)
  }
  if (stackMatrices.length) {
    if (farField) {
      // a prop set on the registry: the GLB near, the tori far, `infield-tyreStacks-<protoId>-L<k>-<cell>`
      const placements: PropPlacement[] = stackMatrices.map((m) => ({ m }))
      const ctx = { farField, quality, infieldStats: {} } as Pick<EnvBuildContext, 'farField' | 'quality' | 'infieldStats'> as EnvBuildContext
      const { entries } = registerPropSet(ctx, 'infield', 'infield-tyreStacks', [{ proto: stackProto, far: stackProc ?? stackProto, placements, casts: false }], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM })
      for (const e of entries) for (const level of e.levels) level.object.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) markObject(o, 'tyreStack', (o as THREE.InstancedMesh).count * GROUND_OBJECTS.tyreStack.maxWidth) })
    } else {
      for (const inst of bucketedInstancedMeshes(stackProto.geometry, stackProto.materials, stackMatrices, null, (i) => Math.floor(stackS[i]! / 500), { name: 'tyreStacks', receiveShadow: true })) {
        markObject(inst, 'tyreStack', inst.count * GROUND_OBJECTS.tyreStack.maxWidth)
        group.add(inst)
      }
    }
    stats.tyreStacks = stackMatrices.length
  }
  if (spongeLow.length) {
    const [sl, sa, sh] = SPONGE.size
    const spongeGeo = new THREE.BoxGeometry(sa, sh, sl)
    const low = new THREE.InstancedMesh(spongeGeo, tarpMat, spongeLow.length)
    spongeLow.forEach((m, i) => low.setMatrixAt(i, m))
    low.instanceMatrix.needsUpdate = true
    low.name = 'spongeBlocks'
    low.castShadow = true
    low.receiveShadow = true
    markObject(low, 'sponge', spongeLow.length * sl)
    group.add(low)
    const high = new THREE.InstancedMesh(spongeGeo, tarpMat, spongeHigh.length)
    spongeHigh.forEach((m, i) => high.setMatrixAt(i, m))
    high.instanceMatrix.needsUpdate = true
    high.name = 'spongeBlocksTop'
    high.castShadow = true
    high.receiveShadow = true
    group.add(high)
    stats.sponges = spongeLow.length + spongeHigh.length
  }
  group.userData.barriers = stats

  if (import.meta.dev) {
    console.info(`[barriers] ${stats.runs} runs, ${postMatrices.length} rail posts, ${stats.fencePosts + stats.fencePostsDark} fence posts (${stats.fencePostsDark} dark), ${stats.windows} windows, ${stats.gates} gates, ${stats.tyreStacks} tyre stacks, ${stats.sponges} sponges, ${stats.horns} horns, ${stats.panels} panels`)
  }
  return group
}

/** The resolved line of a run and the heights it stands at (`base`: the ground under it, capped by MAX_RISE; `top`: the top of the wall / rail). */
export function barrierProfile(track: Track, ground: Ground, run: BarrierRun): { lat: Fn; base: Fn; top: Fn } {
  const k = KIND[run.kind]
  const line = resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
  const lat: Fn = (s) => line.lat(s)
  /** ground under the run, never more than MAX_RISE above the road plane (see MAX_RISE) */
  const base: Fn = (s) => Math.min(ground.standAt(s, lat(s)), MAX_RISE)
  const top: Fn = (s) => base(s) + k.top
  return { lat, base, top }
}

/** The BARRIERS row with this id (throws on a typo: the consumers are hand-written references). */
export function barrierRun(id: string): BarrierRun {
  const run = BARRIERS.find((r) => r.id === id)
  if (!run) throw new Error(`[barriers] no BARRIERS run '${id}'`)
  return run
}

/** Lateral offset of the barrier line on `side` at s, or null where the lap has none there (trackside.ts — the TV lenses read it without this module). */
export { barrierLateralAt } from './trackside'

export type { BarrierRun }
