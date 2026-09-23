import type { AssetProgress } from './assets'
import type { QualityTier } from './quality'
import { buildClock, excludeFromBuildClock, type Steps } from './steps'

/**
 * The loading screen's model: which stage of the start-up runs, what it does, how far the bar is.
 *
 * The viewport announces every stage before it starts — its own (`renderer`, `assets`,
 * `trackMeshes` …) and the environment's (`environmentSteps` yields the `buildMs` keys and
 * `plan/<stage>` / `meshes/<stage>`) — and `LoadTracker.stage` repaints the screen before the ones
 * expected to take a while. Inside a stage the main thread is blocked, so nothing on the page can
 * change, except the bar: it glides to the stage's expected end as a `transform` transition,
 * which the compositor keeps running without the main thread.
 */

/** What the loading screen shows (`store.load`). */
export interface LoadState {
  /** 0..1 where the running stage starts (the percentage); 0 with an empty `stage` = not started */
  progress: number
  /** 0..1 where the bar glides to over `glideMs`: the stage's end if it takes as long as expected */
  target: number
  glideMs: number
  /** the running stage (the caption) and what it does */
  stage: string
  detail: string
  /** newest first: the last finished stages (or, while downloading, files), value preformatted */
  log: { label: string; value: string }[]
}

export function initialLoadState(): LoadState {
  return { progress: 0, target: 0, glideMs: 0, stage: '', detail: '', log: [] }
}

interface StageInfo {
  /** caption; for `parent/stage` keys the detail line under the parent's caption */
  label: string
  detail?: string
  /**
   * Expected wall-clock (ms) per tier: the stage's share of the bar and, scaled by how fast this
   * machine has been so far, how long the bar glides. Measured in the browser on the dev server
   * (`window.__suzuka.load`): high = `?fx=1&assets=1`, low = `?fx=0`, both under SwiftShader —
   * except `renderer` / `firstFrame` on the high tier, which are GPU work (a real GPU's guess),
   * and `assets`, a guess at the 71 MB pack over a fast connection (4 s from the local server).
   */
  ms: [high: number, low: number]
  /** a stage whose `parent/stage` children follow: its own (short) work is `detail`, and logged as that */
  head?: true
}

const STAGES: Record<string, StageInfo> = {
  renderer: { label: 'Renderer', detail: 'WebGL context, sky and image-based light', ms: [600, 115] },
  assets: { label: 'Asset pack', detail: 'Fetching the manifest', ms: [6000, 0] },
  landCover: { label: 'Land cover', detail: 'Forest, paddy and paving masks from OpenStreetMap', ms: [410, 120] },
  terrain: { label: 'Terrain', detail: 'Height field from the GSI elevation model', ms: [400, 290] },
  terrainFar: { label: 'Distant terrain', detail: 'Outer ring, mountain skyline and water', ms: [55, 27] },
  cuts: { label: 'Cuttings', detail: 'Cut corridors through the terrain', ms: [230, 136] },
  plan: { label: 'Ground plan', detail: 'Height field', ms: [2, 2], head: true },
  'plan/fold+bisector': { label: 'Fold and bisector limits', ms: [355, 300] },
  'plan/rings': { label: 'Extents and area rings', ms: [335, 275] },
  'plan/stations': { label: 'Stations along the lap', ms: [130, 90] },
  'plan/eval0': { label: 'Owner columns', ms: [375, 240] },
  'plan/passes': { label: 'Resolving column crossings', ms: [2440, 2050] },
  'plan/snap': { label: 'Snapping the last crossings', ms: [425, 355] },
  'plan/residue': { label: 'Residue check', ms: [40, 38] },
  meshes: { label: 'Ground meshes', detail: 'Surface materials', ms: [1420, 330], head: true },
  'meshes/cells': { label: 'Collecting cells', ms: [400, 315] },
  'meshes/raster': { label: 'Vertices and rasters', ms: [3140, 2530] },
  'meshes/stitch': { label: 'Stitch strips across the bisectors', ms: [2240, 1930] },
  'meshes/boundary': { label: 'Boundary of the covered ground', ms: [75, 80] },
  'meshes/world': { label: 'Areas beyond the road frame', ms: [2840, 2610] },
  'meshes/normals': { label: 'Normals', ms: [65, 150] },
  'meshes/geometry': { label: 'One mesh per surface kind', ms: [150, 175] },
  settle: { label: 'Settling the terrain', detail: 'The grid pushed under the drawn faces', ms: [265, 200] },
  treeLibrary: { label: 'Tree library', detail: 'Species prototypes and materials', ms: [400, 3] },
  figureLibrary: { label: 'Figures', detail: 'People impostors and prototypes', ms: [25, 1] },
  stands: { label: 'Grandstands', detail: 'Decks, seats and roofs from the real footprints', ms: [950, 720] },
  crowd: { label: 'Spectators', detail: 'A figure for every seat', ms: [215, 95] },
  pit: { label: 'Pit building', detail: 'Garages, podium and control tower', ms: [180, 85] },
  pitLane: { label: 'Pit lane', detail: 'Pit wall, entry and exit', ms: [80, 60] },
  paddock: { label: 'Paddock', detail: 'Buildings, fences, lamps and car parks', ms: [125, 90] },
  ops: { label: 'Operations', detail: 'Transporters, gantries and crews', ms: [175, 22] },
  trackside: { label: 'Marshal posts', detail: 'Marshal posts and TV camera towers', ms: [35, 22] },
  infield: { label: 'Infield', detail: 'Service roads, ponds and cuttings', ms: [870, 590] },
  lanes: { label: 'Escape roads', detail: 'Chicane and slip-road kerbs', ms: [4, 3] },
  props: { label: 'Trackside props', detail: 'Distance boards, braking marks and power lines', ms: [115, 100] },
  structures: { label: 'Bridges and signs', detail: 'Crossover bridge, underpass, screens and lamps', ms: [25, 20] },
  ferris: { label: 'Ferris wheel', ms: [1, 1] },
  surroundings: { label: 'Surroundings', detail: 'Roads, buildings and car parks — streamed in after loading', ms: [820, 860] },
  forest: { label: 'Forest', detail: 'Woodland — streamed in after loading', ms: [20, 15] },
  trees: { label: 'Trees', detail: 'Trackside planting', ms: [4, 4] },
  commit: { label: 'Terrain upload', ms: [15, 6] },
  trackMeshes: { label: 'Track details', detail: 'Sausage kerbs, painted aprons and DRS lines', ms: [180, 170] },
  barriers: { label: 'Barriers', detail: 'Walls, tyre stacks and debris fences', ms: [470, 225] },
  lines: { label: 'White lines', detail: 'Edge lines, pit lane and grid', ms: [660, 480] },
  freeze: { label: 'Scene graph', detail: 'Static matrices, frozen once', ms: [17, 9] },
  cars: { label: 'Cars', detail: '22 cars, 11 teams', ms: [3200, 885] },
  materials: { label: 'Materials', detail: 'Shadow and lighting set-up', ms: [65, 23] },
  firstFrame: { label: 'First frame', detail: 'Compiling shaders and uploading textures', ms: [3000, 6000] },
}

/** thrown by `LoadTracker.stage` when the page tore the viewport down while it painted */
export class LoadCancelled extends Error {}

/**
 * A stage expected (at this machine's pace) under this long gets no paint of its own — too short
 * to read, and each paint waits for a frame (≈ 17 ms, left out of the build clock but not of the wait)
 */
const PAINT_MIN_MS = 100
/** log lines kept on the screen */
const LOG_LINES = 5
/** stages timed by the network or the GPU, not by this machine's CPU: kept out of the pace */
const OFF_PACE = new Set(['renderer', 'assets', 'firstFrame'])

export class LoadTracker {
  /**
   * Every finished stage: its wall-clock on the build clock and the paint before it (0 = none) —
   * `window.__suzuka.load` in dev, where the STAGES estimates are re-measured.
   */
  readonly stages: { key: string; ms: number; paintMs: number }[] = []
  private total = 0
  /** expected ms of the finished stages (the bar's position) */
  private done = 0
  private key = ''
  private t0 = 0
  private paintMs = 0
  /** measured / expected over the finished stages: this machine's pace */
  private pace = { actual: 0, expected: 0 }
  /** downloaded files already in the log */
  private filesLogged = 0

  private readonly state: LoadState
  /** STAGES' `ms` column for the tier */
  private readonly col: 0 | 1
  private readonly cancelled: () => boolean

  /**
   * `state` is the store's (reactive) `load`; `downloads`: the asset pack will be fetched (its
   * stage gets a share of the bar); `cancelled` says the viewport was torn down, which ends the
   * start-up at the next paint (`LoadCancelled`).
   */
  constructor(state: LoadState, opts: { tier: QualityTier; downloads: boolean; cancelled: () => boolean }) {
    this.state = state
    this.col = opts.tier === 'high' ? 0 : 1
    this.cancelled = opts.cancelled
    for (const [key, s] of Object.entries(STAGES)) if (opts.downloads || key !== 'assets') this.total += s.ms[this.col]
  }

  /** A stage starts: caption, detail, bar. Repaints first when it is expected to take a while. */
  async stage(key: string): Promise<void> {
    if (!this.begin(key)) return
    this.paintMs = await paint()
    if (this.cancelled()) throw new LoadCancelled(`start-up cancelled at '${key}'`)
  }

  /** Drain a staged build (steps.ts), announcing each stage it yields. */
  async drain<T>(steps: Steps<T>): Promise<T> {
    for (;;) {
      const r = steps.next()
      if (r.done) return r.value
      await this.stage(r.value)
    }
  }

  /** the asset pack's progress (0..1 of the `assets` stage): the bar, the counts, the files as they arrive */
  downloads(p: number, info: AssetProgress) {
    // a tier without the pack still reports its immediate 1
    if (this.key !== 'assets') return
    const s = this.state
    s.progress = s.target = (this.done + STAGES.assets!.ms[this.col] * p) / this.total
    s.glideMs = 200
    if (info.total) s.detail = `${info.settled} / ${info.total} files · ${mb(info.bytes)} / ${mb(info.totalBytes)} MB`
    if (info.settled > this.filesLogged) {
      this.filesLogged = info.settled
      s.log.unshift({ label: info.last, value: `${mb(info.lastBytes)} MB` })
      s.log.length = Math.min(s.log.length, LOG_LINES)
    }
  }

  /** the screen goes away: the last stage ('firstFrame') runs after it, unmeasured */
  end() {
    this.key = ''
  }

  private close() {
    if (!this.key) return
    const ms = buildClock() - this.t0
    const info = STAGES[this.key]
    const expected = info?.ms[this.col] ?? 0
    this.stages.push({ key: this.key, ms, paintMs: this.paintMs })
    this.done += expected
    if (!OFF_PACE.has(this.key) && expected >= 50) {
      this.pace.actual += ms
      this.pace.expected += expected
    }
    // the file list gives way to the stages
    if (this.key === 'assets') this.state.log = []
    this.state.log.unshift({ label: (info?.head ? info.detail : info?.label) ?? this.key, value: duration(ms) })
    this.state.log.length = Math.min(this.state.log.length, LOG_LINES)
    this.key = ''
  }

  /** update the state for `key`; true when the stage deserves a paint of its own */
  private begin(key: string): boolean {
    this.close()
    this.key = key
    this.t0 = buildClock()
    this.paintMs = 0
    const info = STAGES[key]
    const slash = key.indexOf('/')
    const parent = slash > 0 ? STAGES[key.slice(0, slash)] : undefined
    const s = this.state
    s.stage = parent?.label ?? info?.label ?? key
    s.detail = (parent ? info?.label : info?.detail) ?? ''
    s.progress = this.done / this.total
    const pace = this.pace.expected > 0 ? Math.min(5, Math.max(0.2, this.pace.actual / this.pace.expected)) : 1
    // an unknown stage (a builder added without a row) moves nothing but still gets its paint
    const ms = info?.ms[this.col]
    s.target = ms !== undefined ? (this.done + ms) / this.total : s.progress
    s.glideMs = ms !== undefined ? Math.round(ms * pace) : 0
    return ms === undefined || ms * pace >= PAINT_MIN_MS
  }
}

/**
 * One painted frame: a rAF (the frame after the reactive DOM update) and a task after it, so the
 * paint has happened when the build resumes. The wait (ms, returned) is left out of the build
 * clock. Nothing while the page is hidden (no frames are produced; the build just runs through),
 * and a timeout in case the page is hidden while waiting.
 */
async function paint(): Promise<number> {
  if (typeof document === 'undefined' || document.hidden) return 0
  const t = performance.now()
  await new Promise<void>((resolve) => {
    let done = false
    const go = () => {
      if (done) return
      done = true
      setTimeout(resolve, 0)
    }
    requestAnimationFrame(go)
    setTimeout(go, 250)
  })
  const ms = performance.now() - t
  excludeFromBuildClock(ms)
  return ms
}

function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1)
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}
