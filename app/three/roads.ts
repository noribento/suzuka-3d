import * as THREE from 'three'
import { ROAD_SECTION, ROADS } from '~/data/surroundings-spec'
import { signedDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { cellClippedStrip, makeNodeCache, StripSink, type GridShape, type NodeCache, type StripInput, type XZ } from './far-geometry'
import { TriSink } from './far-lines'
import { FAR_CELL_M, MERGE_CELLS } from './farfield'
import { CROSS_WINDOW, type GroundPlan } from './ground-plan'
import { pbr, repeatMetres, ROAD_ATTRIBUTES, ROAD_STYLE, roadRibbonMaterial } from './materials'
import { offsetAt, roadKeepOutQuads, roadNetwork, type RoadSample, type RoadWay } from './road-section'
import { concreteMaps } from './textures'

/**
 * The public roads outside the fences as GEOMETRY (plan R フェーズ Phase 1): every way of the road
 * network (road-section.ts) inside the terrain grid becomes a ribbon of terrain-cut quads
 * (`cellClippedStrip`, far-geometry.ts) draped on the settled mesh a few centimetres up, with the
 * Japanese 区画線 drawn analytically by `roadRibbonMaterial` from the per-vertex road frame
 * (ROAD_ATTRIBUTES). Before this the roads were a 3.3 m-texel band in the land-cover mask — a
 * 5 m road one or two texels wide, its "white line" a texel that flickered with the phase.
 *
 * What is built, and why this way:
 *  - the cross-section is a few ROWS per way (`Quality.farField.roads.rows`): the paved edges at
 *    ±hw, a centre row on marked roads that carries a 1.5 % crown, and on the high tier a soil
 *    verge row each side (ROADS.verge) whose vertex alpha fades 1 → 0 through alpha-to-coverage,
 *    so the asphalt edge is soft on the MSAA target instead of a hard 1 px line; the verge rows
 *    sit 3 cm under the paved rows (ROADS.vergeLift) so the edge reads as a kerb. The low tier
 *    ('lean') has no verge and no MSAA — a hard edge, and half the vertices;
 *  - the ribbon is lifted `ROADS.lift` + the class rung (ROAD_SECTION.lift: track 0 … trunk
 *    24 mm, every step ≥ LAYER_MIN_STEP): where two roads overlap at a junction the higher class
 *    is on top by geometry, which holds under the low tier's logarithmic depth where
 *    polygonOffset does nothing (README 地面の契約);
 *  - the ribbons stop `ROADS.minD` (76 m) from the GP centreline — outside surface-check's 75 m
 *    band, so no ALLOWANCE is needed — and never cover a drawn ground face (the strip's drop
 *    rule reads `ground.builtY`); inside that band the mask still paints the road;
 *  - bridge ways (`bridge` tag) are RIGID planks: the deck is the lerp of `standY` at the two ends
 *    plus ROADS.bridge.deck, never under the ground, tapered to the draped height over the last
 *    metres so the approach road meets it without a step; concrete parapets and a fascia skirt
 *    (a second mesh per block, `bridgeWalls-b<n>`) hide the deck's edge over the river bed;
 *  - one deferred 'paving' job per 1 km block of far-field cells (the stage that runs first, so
 *    the car parks and the forest see the keep-outs), each producing ONE mesh per material
 *    registered static at any range — the overview sees every block anyway, so per-cell entries
 *    would only cost registry entries and draw calls; the follow cameras frustum-cull the blocks;
 *  - on the high tier the tertiary+ roads continue onto the coarse ring (`roads.ring`) as two-row
 *    ribbons draped on the ring's own triangles (`drape: 'nodes'` — `standY` is bilinear there
 *    while the ring mesh draws the b–c diagonal), one job per side of the ring;
 *  - every way's outline at hw + KEEP_OUT_M is pushed into `ctx.keepOutPolys` synchronously, so
 *    the parked cars' bays (vehicles.ts, KeepOutGrid) and the trees (vegetation.ts) stay off the
 *    ribbons; car-park aisles are exempt (road-section.ts `roadKeepOutQuads`).
 *
 * Heights are read through `ground.standY` / `ground.builtY` / `ground.plan.project` only (R3);
 * nothing here touches the terrain grid or `ctx.boxes` (the jobs run after the flush).
 */

// ---------------------------------------------------------------------------------------------
// statistics

export interface RoadJobStats {
  /** ways that poured at least one quad */
  ways: number
  quads: number
  triangles: number
  /** quads dropped by the minD / builtY rule, and skipped as folded / degenerate */
  dropped: number
  folded: number
  /** bridge ways drawn and the parapet + fascia triangles of the block */
  bridges: number
  wallTriangles: number
}

export interface RoadStats {
  /** ways the network decoded / of those inside the grid / on the ring */
  ways: number
  inGrid: number
  onRing: number
  /** keep-out quads pushed into ctx.keepOutPolys */
  keepOuts: number
  /** block jobs and ring jobs queued */
  blocks: number
  ringJobs: number
  /** totals over the jobs that ran (the ring included) */
  quads: number
  triangles: number
  dropped: number
  folded: number
  bridges: number
  wallTriangles: number
  /** per job, by job name, filled in as the jobs run */
  jobs: Record<string, RoadJobStats>
  /** the network's build time (ms, synchronous) */
  netMs: number
}

// ---------------------------------------------------------------------------------------------
// tuning that is not a road-design number (those live in surroundings-spec ROADS)

/** the ribbon's alpha fades to 0 over this length before its ROADS.minD cut (m) */
const CUT_FADE_M = 14
/** the keep-out reaches this far beyond the paved edge (m): a tree trunk or a parked car clear of the verge */
const KEEP_OUT_M = 1.5
/** the sample-pair pre-reject: a quad whose samples are both inside the job's window expanded by hw + verge + this (m) may reach the window; ≥ the longest quad (16 m on the low tier) */
const WINDOW_PAD_M = 20
/** a bridge deck rises from the draped height to its full lift over this many metres at each end (≤ half the span) */
const DECK_RAMP_M = 10
/** the concrete tile (textures.ts concreteMaps) is 4 m; the walls' uv is in metres */
const CONCRETE_TILE_M = 4
/** the fascia skirt hangs at least this far under the deck, and at least this far under the ground where the deck is clamped to it (m) */
const FASCIA_UNDER_DECK = 1
const FASCIA_UNDER_GROUND = 0.3
/** the land-cover classes a (non-bridge) sample pair is skipped on: a car park's aisle keeps the lot's surface, a solar farm its rows, water its bridge */
const SKIP_CLASSES = new Set(['parking', 'solar'])
/** 1000 = no stop bar / crossing within reach (road-section.ts SPECIAL_NONE) */
const SPECIAL_NONE = 1000

type Rect4 = [number, number, number, number]

/** the rows of one way's cross-section: laterals (+ = left of travel), which rows are verge, the centre row (−1 = none) */
interface Section {
  laterals: number[]
  verge: boolean[]
  centre: number
}

function inRect(x: number, z: number, r: Rect4, pad: number): boolean {
  return x >= r[0] - pad && x < r[2] + pad && z >= r[1] - pad && z < r[3] + pad
}

function overlaps(b: readonly [number, number, number, number], r: Rect4, pad: number): boolean {
  return b[2] + pad > r[0] && b[0] - pad < r[2] && b[3] + pad > r[1] && b[1] - pad < r[3]
}

/**
 * The cross-section rows. A marked road (a centre line or edge lines) gets a centre row (the
 * crown); 'full' adds a verge row each side except on a bridge, where the parapet stands at the
 * paved edge and a strip of soil would hang in the air beside the deck.
 */
function sectionOf(way: RoadWay, rows: 'full' | 'lean'): Section {
  const hw = way.hw
  const marked = way.section.centre !== 'none' || way.section.edgeLines
  const laterals: number[] = marked ? [-hw, 0, hw] : [-hw, hw]
  const verge: boolean[] = laterals.map(() => false)
  if (rows === 'full' && !way.bridge) {
    const v = ROADS.verge
    laterals.unshift(-hw - v)
    laterals.push(hw + v)
    verge.unshift(true)
    verge.push(true)
  }
  return { laterals, verge, centre: marked ? laterals.indexOf(0) : -1 }
}

/** the edge lines' shoulders (m) on the left / right of travel: a one-way trunk carriageway keeps its wide stopping lane on the left (Japan drives on the left) */
function shouldersOf(way: RoadWay): [number, number] {
  if (way.section.oneway && way.kind === 'trunk') return [ROAD_SECTION.onewayTrunkShoulders[0], ROAD_SECTION.onewayTrunkShoulders[1]]
  return [way.section.shoulder, way.section.shoulder]
}

/**
 * The network's samples thinned to about `step` metres for the ring: every sample at least
 * `step` past the last kept one, both ends, and BOTH twins of every marking cut — a twin pair
 * (two samples at one s) is how an integer marking changes without interpolating across a quad,
 * so a resampler that walked the way at a fixed pitch (`walk`) would put the change inside a
 * 15 m quad and let the style bits blend.
 */
function thin(samples: readonly RoadSample[], step: number): RoadSample[] {
  const out: RoadSample[] = []
  const n = samples.length
  for (let i = 0; i < n; i++) {
    const s = samples[i]!
    const prev = samples[i - 1]
    const last = out[out.length - 1]
    if (prev && s.s - prev.s < 1e-6) {
      if (last !== prev) out.push(prev)
      out.push(s)
      continue
    }
    if (!last || i === n - 1 || s.s - last.s >= step - 1e-6) out.push(s)
  }
  return out
}

/**
 * The L-gutter flag per sample (a gutter class inside the settle mask), with the sample
 * DUPLICATED wherever the flag changes between two consecutive samples — the network's own
 * twin mechanism (road-section.ts): both corners of every quad then carry one style, and the
 * gutter bits never interpolate across a quad (the strip's pool key keeps the twins apart).
 * Ways without the class permission get no gutter and no twins.
 */
function withGutter(way: RoadWay, samples: readonly RoadSample[], landCover: EnvBuildContext['landCover']): { samples: RoadSample[]; gutter: Uint8Array } {
  if (!way.section.gutter) return { samples: [...samples], gutter: new Uint8Array(samples.length) }
  const out: RoadSample[] = []
  const flags: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    const g = landCover.weightAt(s.x, s.z, 'settle') >= 0.5 ? 1 : 0
    const prev = samples[i - 1]
    if (prev && s.s - prev.s >= 1e-6 && g !== flags[flags.length - 1]) {
      // the cut: this position once more with the state before it, then with the new state
      out.push(s)
      flags.push(flags[flags.length - 1]!)
    }
    out.push(s)
    flags.push(g)
  }
  return { samples: out, gutter: Uint8Array.from(flags) }
}

/**
 * The plan with a `project` whose distance is to the NEAREST road at the crossover. The ground
 * partition's projection (ground-plan.ts projectGlobal) maps a point inside the crossover box
 * to the lower road even when the deck is nearer — its verge belongs to that road — so a public
 * road 56 m from the deck's approach came back as 111 m from the underpass and its ribbon ran
 * inside surface-check's 75 m band (G8 measures the nearest track sample). The drop rule wants
 * the nearest of the two stretches: where the plan's answer lies within reach of either end of
 * the crossover, both stretches are projected through their s windows and the smaller distance
 * wins. Everywhere else the plan's projection is already the nearest point.
 */
function nearestRoadPlan(plan: GroundPlan, track: Track): GroundPlan {
  const { sOver, sUnder } = track.crossing
  const L = track.length
  // the plan's windowed projection pads its window by 60 m; a result this close to either end may hide a nearer stretch
  const reach = CROSS_WINDOW + 60
  const nearCross = (s: number) => Math.abs(signedDelta(sOver, s, L)) < reach || Math.abs(signedDelta(sUnder, s, L)) < reach
  const project: GroundPlan['project'] = (x, z, window) => {
    if (window) return plan.project(x, z, window)
    let p = plan.project(x, z)
    if (!nearCross(p.s)) return p
    for (const c of [sOver, sUnder]) {
      const q = plan.project(x, z, [c - CROSS_WINDOW, c + CROSS_WINDOW])
      if (q.d < p.d) p = q
    }
    return p
  }
  return { ...plan, project }
}

/** the lift of row r over the drape (or the deck): the paved rows at ROADS.lift + the class rung, the centre row crowned, the verge rows 3 cm lower */
function liftOf(way: RoadWay, sec: Section): (r: number, i: number) => number {
  const base = ROADS.lift + way.section.lift
  const vergeLift = way.section.lift + ROADS.vergeLift
  const crown = ROADS.crown * way.hw
  return (r) => (sec.verge[r] ? vergeLift : base + (r === sec.centre ? crown : 0))
}

// ---------------------------------------------------------------------------------------------

/**
 * Plan the road ribbons: the network, the keep-outs (now), the materials (now, so the viewport's
 * material setup and the attach hook both cover them) and one deferred 'paving' job per 1 km
 * block plus the ring jobs. Returns the statistics the jobs fill in; they are also on
 * `ctx.farField.group.userData.roads` for the offline harness.
 */
export function buildRoads(ctx: EnvBuildContext): RoadStats {
  const { terrain, ground, quality: q, farField, landCover, assets } = ctx
  const plan = nearestRoadPlan(ground.plan, ctx.track)
  const R = q.farField.roads
  const net = roadNetwork(ctx, { stepScale: R.stepScale, ring: R.ring })
  const stats: RoadStats = {
    ways: net.ways.length, inGrid: 0, onRing: 0, keepOuts: 0, blocks: 0, ringJobs: 0,
    quads: 0, triangles: 0, dropped: 0, folded: 0, bridges: 0, wallTriangles: 0, jobs: {}, netMs: net.stats.buildMs,
  }
  farField.group.userData.roads = stats

  // --- keep-outs, synchronously: the car parks plan their bays in the 'buildings' stage -----------
  for (const way of net.ways) {
    if (way.onRing) stats.onRing++
    if (!way.inGrid) continue
    stats.inGrid++
    const quads = roadKeepOutQuads(way, KEEP_OUT_M, landCover)
    for (const k of quads) ctx.keepOutPolys.push(k)
    stats.keepOuts += quads.length
  }

  // --- materials --------------------------------------------------------------------------------
  const road = roadRibbonMaterial(assets, q)
  const concrete = concreteWalls()

  const grid = terrain.grid()
  const gridRect: Rect4 = [grid.x0, grid.z0, grid.x0 + grid.w, grid.z0 + grid.d]
  /** the centreline-distance cache over the grid nodes, shared by every block job (the same nodes) */
  const cache = makeNodeCache(grid)

  /** the drop rule at one point for the walls (the strip applies the same to its quads): outside minD and on no drawn face */
  const siteFree = (x: number, z: number, lo: number): boolean => (lo >= ROADS.minD || plan.project(x, z).d >= ROADS.minD) && !ground.builtY(x, z)

  /** the ribbon input of one way over `samples` (gutter twins already inserted, `gutter` per sample) — the rows, lifts, attributes, pool keys and the pre-rejects */
  const ribbon = (way: RoadWay, samples: readonly RoadSample[], gutter: Uint8Array, sec: Section, window: Rect4, rigid: ((r: number, i: number) => number) | null): StripInput => {
    const n = samples.length
    const { laterals, verge } = sec
    const hw = way.hw
    const rows: XZ[][] = laterals.map((lat) => samples.map((s) => offsetAt(s, lat)))
    const [shL, shR] = shouldersOf(way)
    const fixed = (way.section.unsealed ? ROAD_STYLE.unsealed : 0) | (way.bridge ? ROAD_STYLE.bridge : 0)
    // per sample: the style, and the pool key — the style, the specials' presence and the count
    // of cuts passed so far, so the twins of a cut (same XZ, new markings) never share a vertex
    const style = new Float64Array(n)
    const key = new Float64Array(n)
    let cuts = 0
    for (let i = 0; i < n; i++) {
      const s = samples[i]!
      style[i] = s.centre | (s.edgeL ? ROAD_STYLE.edgeL : 0) | (s.edgeR ? ROAD_STYLE.edgeR : 0) | fixed | (gutter[i] ? ROAD_STYLE.gutterL | ROAD_STYLE.gutterR : 0)
      if (i > 0 && s.s - samples[i - 1]!.s < 1e-6) cuts++
      key[i] = style[i]! | (s.stop !== SPECIAL_NONE ? 256 : 0) | (s.zebra !== SPECIAL_NONE ? 512 : 0) | (cuts << 10)
    }
    const pad = hw + ROADS.verge + WINDOW_PAD_M
    // the ribbon's alpha near its minD cut: a road that runs on towards the circuit is cut at
    // ROADS.minD as a hard quad edge on bare ground; fading the vertex alpha over the last
    // CUT_FADE_M (A2C on the high tier) dissolves the ribbon into the mask's own paved band
    // underneath instead. Only samples whose bound says they may be that near are projected.
    const cutFade = new Float64Array(n).fill(1)
    for (let i = 0; i < n; i++) {
      const s = samples[i]!
      if (s.dLo - hw - ROADS.verge >= ROADS.minD + CUT_FADE_M) continue
      const d = plan.project(s.x, s.z).d
      cutFade[i] = Math.max(0, Math.min(1, (d - ROADS.minD) / CUT_FADE_M))
    }
    const input: StripInput = {
      rows,
      lift: liftOf(way, sec),
      attr: (r, i, out) => {
        const s = samples[i]!
        out[0] = s.s
        out[1] = laterals[r]!
        out[2] = hw
        out[3] = style[i]!
        out[4] = shL
        out[5] = shR
        out[6] = s.stop
        out[7] = s.zebra
        out[8] = verge[r] ? 0 : cutFade[i]!
      },
      okAt: (i) => {
        const a = samples[i]!, b = samples[i + 1]!
        // a twin pair has no length (the cut); a pair beyond the window's reach cannot touch it
        if (b.s - a.s < 1e-6) return false
        if (!inRect(a.x, a.z, window, pad) || !inRect(b.x, b.z, window, pad)) return false
        const c = landCover.classAt((a.x + b.x) / 2, (a.z + b.z) / 2)
        return !(SKIP_CLASSES.has(c) || (c === 'water' && !way.bridge))
      },
      poolKey: (i) => key[i]!,
      dLo: (i) => samples[i]!.dLo,
    }
    if (rigid) input.rigidY = rigid
    return input
  }

  /**
   * The rigid heights of a bridge way's corners. The deck is the lerp of `standY` at the two
   * ends plus ROADS.bridge.deck — a plank across the dip — clamped never under the ground it
   * crosses, and tapered back to the draped height over DECK_RAMP_M at each end so the approach
   * road (draped at its own end) meets it without a 25 cm step; the row's lift (crown, rung) is
   * added on top as on the draped rows. Cached per corner: the parapets read the same numbers.
   */
  const bridgeDeck = (way: RoadWay, samples: readonly RoadSample[], sec: Section, lift: (r: number, i: number) => number): { rigid: (r: number, i: number) => number; y: Float64Array } => {
    const n = samples.length
    const nr = sec.laterals.length
    const first = samples[0]!, last = samples[n - 1]!
    const y0 = ground.standY(first.x, first.z), y1 = ground.standY(last.x, last.z)
    const len = Math.max(1e-6, last.s - first.s)
    const ramp = Math.min(DECK_RAMP_M, len / 2)
    const y = new Float64Array(nr * n).fill(NaN)
    const rigid = (r: number, i: number): number => {
      const k = r * n + i
      let v = y[k]!
      if (Number.isNaN(v)) {
        const s = samples[i]!
        const p = offsetAt(s, sec.laterals[r]!)
        const g = ground.standY(p[0], p[1])
        const t = (s.s - first.s) / len
        let k2 = Math.min(1, Math.min(s.s - first.s, last.s - s.s) / ramp)
        k2 = k2 * k2 * (3 - 2 * k2)
        const deck = Math.max(y0 + (y1 - y0) * t + ROADS.bridge.deck, g)
        v = g + (deck - g) * k2 + lift(r, i)
        y[k] = v
      }
      return v
    }
    return { rigid, y }
  }

  /**
   * The parapets and the fascia of one bridge way into `walls`: along both paved edges, a
   * ROADS.bridge.parapetT × parapetH box (outer face, inner face, top, end caps) standing on the
   * deck, and a skirt from the outer face down to under the ground / a metre under the deck. Only
   * the pairs the strip could keep (its pre-rejects, the window by centroid, the site rule at the
   * outer corners) get walls. uv = (s along, metres up / across).
   */
  const bridgeWalls = (way: RoadWay, samples: readonly RoadSample[], sec: Section, input: StripInput, deckY: Float64Array, window: Rect4, walls: TriSink): number => {
    const n = samples.length
    const T = ROADS.bridge.parapetT, H = ROADS.bridge.parapetH
    const hw = way.hw
    const before = walls.triangles
    for (const side of [1, -1] as const) {
      const r = side > 0 ? sec.laterals.length - 1 : 0
      const lat = sec.laterals[r]!
      let capStart: { p: XZ; q: XZ; y: number; s: number } | null = null
      let capEnd: { p: XZ; q: XZ; y: number; s: number } | null = null
      for (let i = 0; i < n - 1; i++) {
        if (input.okAt && !input.okAt(i)) continue
        const a = samples[i]!, b = samples[i + 1]!
        if (!inRect((a.x + b.x) / 2, (a.z + b.z) / 2, window, 0)) continue
        const ai = offsetAt(a, lat), bi = offsetAt(b, lat)
        const ao = offsetAt(a, lat + side * T), bo = offsetAt(b, lat + side * T)
        const loA = a.dLo - hw - T, loB = b.dLo - hw - T
        if (!siteFree(ai[0], ai[1], loA) || !siteFree(ao[0], ao[1], loA) || !siteFree(bi[0], bi[1], loB) || !siteFree(bo[0], bo[1], loB)) continue
        const ya = deckY[r * n + i]!, yb = deckY[r * n + i + 1]!
        if (Number.isNaN(ya) || Number.isNaN(yb)) continue
        // +lateral is (tz, −tx) in world (road-section.ts offsetAt); the wall faces away from the road on `side`
        const out = [side * a.tz, 0, -side * a.tx] as const
        const inward = [-out[0], 0, -out[2]] as const
        const AO = [ao[0], ya, ao[1]], BO = [bo[0], yb, bo[1]], AOt = [ao[0], ya + H, ao[1]], BOt = [bo[0], yb + H, bo[1]]
        const AI = [ai[0], ya, ai[1]], BI = [bi[0], yb, bi[1]], AIt = [ai[0], ya + H, ai[1]], BIt = [bi[0], yb + H, bi[1]]
        walls.quad(AO, BO, BOt, AOt, out, [[a.s, ya], [b.s, yb], [b.s, yb + H], [a.s, ya + H]])
        walls.quad(AI, BI, BIt, AIt, inward, [[a.s, ya], [b.s, yb], [b.s, yb + H], [a.s, ya + H]])
        walls.quad(AIt, BIt, BOt, AOt, [0, 1, 0], [[a.s, 0], [b.s, 0], [b.s, T], [a.s, T]])
        // the fascia: from the outer face down to under the ground (or a metre under a high deck)
        const botA = Math.min(ya - FASCIA_UNDER_DECK, ground.standY(ao[0], ao[1]) - FASCIA_UNDER_GROUND)
        const botB = Math.min(yb - FASCIA_UNDER_DECK, ground.standY(bo[0], bo[1]) - FASCIA_UNDER_GROUND)
        walls.quad(AO, BO, [bo[0], botB, bo[1]], [ao[0], botA, ao[1]], out, [[a.s, ya], [b.s, yb], [b.s, botB], [a.s, botA]])
        if (!capStart) capStart = { p: ai, q: ao, y: ya, s: a.s }
        capEnd = { p: bi, q: bo, y: yb, s: b.s }
      }
      // the parapet's end faces, so the box is closed where the approach road meets it
      for (const cap of [capStart, capEnd]) {
        if (!cap) continue
        const dir = cap === capStart ? -1 : 1
        const s0 = samples[0]!
        const along = [dir * s0.tx, 0, dir * s0.tz] as const
        walls.quad([cap.p[0], cap.y, cap.p[1]], [cap.q[0], cap.y, cap.q[1]], [cap.q[0], cap.y + H, cap.q[1]], [cap.p[0], cap.y + H, cap.p[1]], along, [[0, cap.y], [T, cap.y], [T, cap.y + H], [0, cap.y + H]])
      }
    }
    return walls.triangles - before
  }

  // --- one 'paving' job per 1 km block of far-field cells ---------------------------------------
  // the blocks are laid out as the far field merges them (farfield.ts consolidate, road-section.ts
  // blockOf): MERGE_CELLS × MERGE_CELLS cells of FAR_CELL_M over the grid, column-major in x then z
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M)), ncz = Math.max(1, Math.ceil(grid.d / FAR_CELL_M))
  const blockCols = Math.ceil(ncx / MERGE_CELLS), blockRows = Math.ceil(ncz / MERGE_CELLS)
  const inGridWays = net.ways.filter((w) => w.inGrid && w.samples.length >= 2)
  for (let bz = 0; bz < blockRows; bz++) {
    for (let bx = 0; bx < blockCols; bx++) {
      const b = bx + bz * blockCols
      const x0 = grid.x0 + bx * MERGE_CELLS * FAR_CELL_M, z0 = grid.z0 + bz * MERGE_CELLS * FAR_CELL_M
      const window: Rect4 = [x0, z0, Math.min(x0 + MERGE_CELLS * FAR_CELL_M, gridRect[2]), Math.min(z0 + MERGE_CELLS * FAR_CELL_M, gridRect[3])]
      // every way whose rows can reach the block — not only the ways with a sample inside it:
      // a way running just outside the block's edge still has its verge inside
      const here = inGridWays.filter((w) => overlaps(w.bbox, window, w.hw + ROADS.verge + 1))
      if (!here.length) continue
      stats.blocks++
      const name = `roads-b${b}`
      farField.defer('paving', name, 60, () => {
        const sink = new StripSink(ROAD_ATTRIBUTES)
        const walls = new TriSink()
        const js: RoadJobStats = { ways: 0, quads: 0, triangles: 0, dropped: 0, folded: 0, bridges: 0, wallTriangles: 0 }
        for (let wi = 0; wi < here.length; wi++) {
          const way = here[wi]!
          const sec = sectionOf(way, R.rows)
          const { samples, gutter } = withGutter(way, way.samples, landCover)
          const deck = way.bridge ? bridgeDeck(way, samples, sec, liftOf(way, sec)) : null
          const input = ribbon(way, samples, gutter, sec, window, deck ? deck.rigid : null)
          sink.begin(wi)
          const st = cellClippedStrip(sink, input, { grid, drape: 'mesh', ground, plan, minD: ROADS.minD, window, cache })
          js.quads += st.quads
          js.triangles += st.triangles
          js.dropped += st.dropped
          js.folded += st.folded
          if (st.quads) js.ways++
          if (deck && st.quads) {
            js.bridges++
            js.wallTriangles += bridgeWalls(way, samples, sec, input, deck.y, window, walls)
          }
        }
        stats.jobs[name] = js
        stats.quads += js.quads
        stats.triangles += js.triangles
        stats.dropped += js.dropped
        stats.folded += js.folded
        stats.bridges += js.bridges
        stats.wallTriangles += js.wallTriangles
        const geo = sink.build()
        let root: THREE.Object3D | null = null
        if (geo) {
          const mesh = new THREE.Mesh(geo, road)
          mesh.name = name
          mesh.castShadow = false
          mesh.receiveShadow = true
          mesh.userData.roads = { ...js, block: b }
          farField.register({ kind: 'roads', name, levels: [{ object: mesh, range: Infinity, static: true }] })
          root = mesh
        }
        const wallGeo = walls.build()
        if (wallGeo) {
          const mesh = new THREE.Mesh(wallGeo, concrete)
          mesh.name = `bridgeWalls-b${b}`
          // no shadow: the far field trims its casters to what a cascade can resolve (C5)
          mesh.castShadow = false
          mesh.receiveShadow = true
          mesh.userData.roads = { block: b, bridges: js.bridges, wallTriangles: js.wallTriangles }
          farField.register({ kind: 'roads', name: mesh.name, levels: [{ object: mesh, range: Infinity, static: true }] })
          root ??= mesh
        }
        return root
      })
    }
  }

  // --- the ring: tertiary+ roads beyond the grid, on the ring's own triangles (high tier) --------
  if (R.ring) {
    const ring = terrain.ring
    const rg: GridShape = { x0: ring.x0, z0: ring.z0, dx: ring.dx, dz: ring.dz, nx: ring.nx - 1, nz: ring.nz - 1, w: (ring.nx - 1) * ring.dx, d: (ring.nz - 1) * ring.dz }
    const ringCache: NodeCache = makeNodeCache(rg)
    const nodeY = (i: number, j: number) => ring.heights[j * ring.nx + i]!
    // the four bands around the inner rectangle partition the ring's cells (cell centres decide)
    const bands: Record<string, Rect4> = {
      n: [rg.x0, rg.z0, rg.x0 + rg.w, gridRect[1]],
      s: [rg.x0, gridRect[3], rg.x0 + rg.w, rg.z0 + rg.d],
      w: [rg.x0, gridRect[1], gridRect[0], gridRect[3]],
      e: [gridRect[2], gridRect[1], rg.x0 + rg.w, gridRect[3]],
    }
    const ringWays = net.ways.filter((w) => w.onRing && w.samples.length >= 2 && ROADS.ring.kinds.includes(w.kind))
    for (const [k, window] of Object.entries(bands)) {
      const here = ringWays.filter((w) => overlaps(w.bbox, window, w.hw + 1))
      if (!here.length) continue
      stats.ringJobs++
      const name = `roads-ring-${k}`
      farField.defer('paving', name, 20, () => {
        const sink = new StripSink(ROAD_ATTRIBUTES)
        const js: RoadJobStats = { ways: 0, quads: 0, triangles: 0, dropped: 0, folded: 0, bridges: 0, wallTriangles: 0 }
        for (let wi = 0; wi < here.length; wi++) {
          const way = here[wi]!
          // two rows at the paved edges, the network's samples thinned to the ring pitch; a bridge
          // out here is draped like the rest (its style bit still darkens the deck)
          const sec: Section = { laterals: [-way.hw, way.hw], verge: [false, false], centre: -1 }
          const { samples, gutter } = withGutter(way, thin(way.samples, ROADS.ring.step), landCover)
          const input = ribbon(way, samples, gutter, sec, window, null)
          sink.begin(wi)
          const st = cellClippedStrip(sink, input, { grid: rg, drape: 'nodes', nodeY, ground, plan, minD: 0, window, hole: gridRect, cache: ringCache })
          js.quads += st.quads
          js.triangles += st.triangles
          js.dropped += st.dropped
          js.folded += st.folded
          if (st.quads) js.ways++
        }
        stats.jobs[name] = js
        stats.quads += js.quads
        stats.triangles += js.triangles
        stats.dropped += js.dropped
        stats.folded += js.folded
        const geo = sink.build()
        if (!geo) return null
        const mesh = new THREE.Mesh(geo, road)
        mesh.name = name
        mesh.castShadow = false
        mesh.receiveShadow = true
        mesh.userData.roads = { ...js, ring: k }
        farField.register({ kind: 'roads', name, levels: [{ object: mesh, range: Infinity, static: true }] })
        return mesh
      })
    }
  }

  if (import.meta.dev) console.info(`[roads] ${stats.inGrid} of ${stats.ways} ways in the grid (${stats.onRing} on the ring), ${stats.keepOuts} keep-out quads, ${stats.blocks} block jobs + ${stats.ringJobs} ring jobs deferred (network ${stats.netMs.toFixed(0)} ms)`)
  return stats
}

/** the bridge walls' concrete: the shared procedural tile on its own clones, 4 m per tile so the walls' metre uv lands on it */
function concreteWalls(): THREE.MeshStandardMaterial {
  const maps = concreteMaps()
  const world: readonly [number, number] = [1, 1]
  return pbr({
    map: repeatMetres(maps.map.clone(), CONCRETE_TILE_M, world),
    normalMap: maps.normalMap && repeatMetres(maps.normalMap.clone(), CONCRETE_TILE_M, world),
    roughnessMap: maps.roughnessMap && repeatMetres(maps.roughnessMap.clone(), CONCRETE_TILE_M, world),
  }, { roughness: 0.9, color: 0xcfcdc6 }, 0.6)
}
