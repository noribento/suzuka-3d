import { computed, reactive } from 'vue'
import type { Compound } from '~/data/drivers'
import type { RaceEvent } from '~/sim/race'

export type CameraMode = 'overview' | 'heli' | 'chase' | 'onboard' | 'tv' | 'director'
export type RaceStatus = 'loading' | 'grid' | 'lights' | 'racing' | 'finished'

// --- broadcast (world-feed) graphics state, only rendered in the tv / director camera modes ---
/** what the timing tower's right column shows (cycled by the graphics director) */
export type TowerMode = 'interval' | 'leader' | 'tyre' | 'gained' | 'stops'
export type StrapKind = 'fastest' | 'pit' | 'speed' | 'leader' | 'flag'
export type PaneKind = 'tracker' | 'weather' | 'strategy'
/** the tower header's LAP block: plain, DRS ENABLED (green) or the chequered flag */
export type HeaderState = 'lap' | 'drs' | 'chequered'
/** race events forwarded to the graphics director (RaceSim events plus the HUD's speed trap) */
export type FeedEvent = RaceEvent | { type: 'speedTrap'; car: number; kmh: number; t: number }
export interface FeedItem { id: number; t: number; ev: FeedEvent }
/** the single alert strap launched beside the tower header */
export interface Strap {
  id: number
  kind: StrapKind
  driver: number
  /** wall-clock launch time and hold (ms) */
  t: number
  hold: number
  time?: number
  stationary?: number
  from?: Compound
  to?: Compound
  entryPosition?: number
  /** rejoin position: live while the car is still in the lane, frozen at the pit exit */
  rejoin?: number
  kmh?: number
}
export interface BroadcastState {
  towerMode: TowerMode
  /** dev / test override: pins the tower mode (null = the director cycles it) */
  towerLock: TowerMode | null
  header: HeaderState
  headerUntil: number
  strap: Strap | null
  /** lower third; `key` changes on every launch so a re-cut to the same driver replays the entrance */
  nameStrap: { driver: number; t: number; hold: number; key: number } | null
  pane: { kind: PaneKind; t: number; hold: number } | null
  /** hysteresis-filtered battle for the bottom-centre widget (the classic store.battle is untouched) */
  battle: { position: number; ahead: number; behind: number; t: number } | null
  /** keeps the onboard cluster up briefly after a cut away so a hard cut does not pop it */
  onboardUntil: number
  /** M key in broadcast mode: keep the driver tracker on air whenever the pane slot is free */
  trackerPinned: boolean
  /** wall clock at which the classic classification panel may appear in broadcast mode */
  classificationAt: number | null
}

export interface HudDriver {
  idx: number
  code: string
  firstName: string
  lastName: string
  number: number
  team: string
  teamName: string
  color: string
  position: number
  lapsCompleted: number
  gapText: string
  intervalText: string
  gapSec: number
  intervalSec: number
  lastLap: number
  bestLap: number
  currentLap: number
  speedKmh: number
  gear: number
  rpm: number
  throttle: number
  brake: number
  drs: boolean
  drsEligible: boolean
  compound: Compound
  tyreAge: number
  pitState: string
  pitStops: number
  sectors: (number | null)[]
  sectorFlags: number[]
  location: string
  finished: boolean
  inPit: boolean
  mapX: number
  mapY: number
  hasFastestLap: boolean
  positionDelta: number
  /** grid position at the start */
  gridPosition: number
  /** tyre history: one entry per stint */
  stints: { compound: Compound; laps: number }[]
  /** best speed-trap reading (km/h) */
  trapKmh: number
  /** road-wheel steer angle (rad, + = left) — written for the selected driver only */
  steer: number
  /** brake disc temperatures (°C, hotter wheel of the axle) — selected driver only */
  brakeTempF: number
  brakeTempR: number
  // --- broadcast tower fields (stepped per 200 m mini-sector, one truncated decimal) ---
  tvGap: string
  tvInterval: string
  /** floor(s / 200) at the last tvGap refresh (−1 = never) */
  miniSector: number
  /** car index ahead at the last refresh (an interval never refers to a car that is no longer ahead) */
  aheadIdx: number
  /** last committed position change: direction and a token that re-keys the chip flash animation */
  posFlash: { dir: 1 | -1; key: number } | null
  /** wall clock until which the row reads OUT after leaving the pit lane */
  pitOutUntil: number
}

export interface Battle {
  /** position being fought for */
  position: number
  ahead: number
  behind: number
  gapSec: number
  drs: boolean
}

export interface HudEvent {
  id: number
  kind: 'fastest' | 'overtake' | 'pit' | 'drs' | 'flag' | 'info'
  title: string
  text: string
  color: string
  t: number
  ttl: number
}

export interface RaceStore {
  ready: boolean
  /** 0..1 start-up progress behind the loading screen (asset downloads 0–0.7, scene build to 1); 0 = indeterminate */
  loadProgress: number
  status: RaceStatus
  lights: number
  lap: number
  totalLaps: number
  elapsed: number
  drivers: HudDriver[]
  order: number[]
  selected: number
  cameraMode: CameraMode
  simSpeed: number
  paused: boolean
  labels: boolean
  showMap: boolean
  events: HudEvent[]
  fastestLap: { driver: number; time: number } | null
  tvCamName: string
  gapMode: 'gap' | 'interval'
  restartToken: number
  weather: { air: number; track: number; wind: number; humidity: number }
  /** local time of day (hours) driving the sun position */
  timeOfDay: number
  /** engine / crowd audio on */
  audio: boolean
  /**
   * The user has clicked or pressed a key at least once. Browsers only allow audio after such a
   * gesture, so the start sequence waits for it (with a fallback) so the countdown can be heard.
   */
  interacted: boolean
  /** the closest fight in the top ten, if any within a second */
  battle: Battle | null
  /** driver card shown for a few seconds after a selection (driver index) */
  lowerThird: { driver: number; until: number } | null
  /** session-best speed trap */
  speedTrap: { driver: number; kmh: number } | null
  fps: number
  winner: number | null
  /** coarse wall clock (performance.now(), written from the render loop at ~4 Hz) for timed HUD elements */
  nowMs: number
  /** the shot actually on air: rig.mode (the director's sub-shot while cameraMode is 'director') */
  shot: CameraMode
  /** wall clock until which the control bar stays visible in broadcast mode (any input extends it) */
  uiUntil: number
  /** race events for the graphics director (newest 16) and a counter that bumps on every push */
  feed: FeedItem[]
  feedSeq: number
  /** bumps on every selection; `selectSource` says whether a person or the director chose */
  selectSeq: number
  selectSource: 'manual' | 'director'
  bc: BroadcastState
}

export function initialBroadcastState(): BroadcastState {
  return { towerMode: 'interval', towerLock: null, header: 'lap', headerUntil: 0, strap: null, nameStrap: null, pane: null, battle: null, onboardUntil: 0, trackerPinned: false, classificationAt: null }
}

const store = reactive<RaceStore>({
  ready: false,
  loadProgress: 0,
  status: 'loading',
  lights: 0,
  lap: 1,
  totalLaps: 53,
  elapsed: 0,
  drivers: [],
  order: [],
  selected: -1,
  cameraMode: 'overview',
  simSpeed: 1,
  paused: false,
  labels: true,
  showMap: true,
  events: [],
  fastestLap: null,
  tvCamName: '',
  gapMode: 'gap',
  restartToken: 0,
  // late-March race afternoon (spec SEASONS.spring.weather)
  weather: { air: 15, track: 26, wind: 2.4, humidity: 45 },
  timeOfDay: 14,
  audio: true,
  interacted: false,
  battle: null,
  lowerThird: null,
  speedTrap: null,
  fps: 0,
  winner: null,
  nowMs: 0,
  shot: 'overview',
  uiUntil: 0,
  feed: [],
  feedSeq: 0,
  selectSeq: 0,
  selectSource: 'manual',
  bc: initialBroadcastState(),
})

/** Broadcast (world-feed) graphics are on air in the tv and director camera modes. */
const broadcast = computed(() => store.cameraMode === 'tv' || store.cameraMode === 'director')

let eventId = 0
let feedId = 0

export function useRaceStore() {
  const pushEvent = (e: Omit<HudEvent, 'id' | 't'>) => {
    store.events.push({ ...e, id: ++eventId, t: performance.now() })
    if (store.events.length > 4) store.events.splice(0, store.events.length - 4)
  }
  /** Forward a race event to the graphics director (cheap in every mode; only read in broadcast). */
  const pushFeed = (ev: FeedEvent) => {
    store.feed.push({ id: ++feedId, t: performance.now(), ev })
    if (store.feed.length > 16) store.feed.splice(0, store.feed.length - 16)
    store.feedSeq++
  }
  /** Any input keeps the control bar visible for 3 s in broadcast mode. */
  const wake = () => {
    store.uiUntil = performance.now() + 3000
  }
  const select = (idx: number, source: 'manual' | 'director' = 'manual') => {
    store.selected = idx
    store.selectSource = source
    store.selectSeq++
    if (idx >= 0 && source === 'manual') store.lowerThird = { driver: idx, until: performance.now() + 6000 }
  }
  const setCamera = (mode: CameraMode) => {
    wake()
    store.cameraMode = mode
    if (mode !== 'overview' && store.selected < 0) store.selected = store.order[0] ?? 0
  }
  const selectByPosition = (delta: number) => {
    const order = store.order
    if (!order.length) return
    const cur = store.selected >= 0 ? order.indexOf(store.selected) : -1
    const next = Math.min(order.length - 1, Math.max(0, cur + delta))
    store.selected = order[next] ?? store.selected
    store.selectSource = 'manual'
    store.selectSeq++
  }
  const restart = () => {
    store.restartToken++
  }
  const resetBroadcast = () => {
    store.bc = initialBroadcastState()
    store.feed = []
    store.shot = 'overview'
  }
  return { store, broadcast, pushEvent, pushFeed, wake, select, setCamera, selectByPosition, restart, resetBroadcast }
}
