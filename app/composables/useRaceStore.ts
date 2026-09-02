import { reactive } from 'vue'
import type { Compound } from '~/data/drivers'

export type CameraMode = 'overview' | 'heli' | 'chase' | 'onboard' | 'tv' | 'director'
export type RaceStatus = 'loading' | 'grid' | 'lights' | 'racing' | 'finished'

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
  /** the closest fight in the top ten, if any within a second */
  battle: Battle | null
  /** driver card shown for a few seconds after a selection (driver index) */
  lowerThird: { driver: number; until: number } | null
  /** session-best speed trap */
  speedTrap: { driver: number; kmh: number } | null
  fps: number
  winner: number | null
}

const store = reactive<RaceStore>({
  ready: false,
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
  weather: { air: 27, track: 41, wind: 2.4, humidity: 58 },
  timeOfDay: 14,
  audio: true,
  battle: null,
  lowerThird: null,
  speedTrap: null,
  fps: 0,
  winner: null,
})

let eventId = 0

export function useRaceStore() {
  const pushEvent = (e: Omit<HudEvent, 'id' | 't'>) => {
    store.events.push({ ...e, id: ++eventId, t: performance.now() })
    if (store.events.length > 4) store.events.splice(0, store.events.length - 4)
  }
  const select = (idx: number) => {
    store.selected = idx
    if (idx >= 0) store.lowerThird = { driver: idx, until: performance.now() + 6000 }
  }
  const setCamera = (mode: CameraMode) => {
    store.cameraMode = mode
    if (mode !== 'overview' && store.selected < 0) store.selected = store.order[0] ?? 0
  }
  const selectByPosition = (delta: number) => {
    const order = store.order
    if (!order.length) return
    const cur = store.selected >= 0 ? order.indexOf(store.selected) : -1
    const next = Math.min(order.length - 1, Math.max(0, cur + delta))
    store.selected = order[next] ?? store.selected
  }
  const restart = () => {
    store.restartToken++
  }
  return { store, pushEvent, select, setCamera, selectByPosition, restart }
}
