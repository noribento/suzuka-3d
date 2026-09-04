import { effectScope, watch, type EffectScope } from 'vue'
import { useRaceStore, type CameraMode, type FeedItem, type PaneKind, type Strap, type StrapKind, type TowerMode } from './useRaceStore'

/**
 * The graphics director of the broadcast package: what goes on air, when, for how long — the
 * job a gallery producer does on the real world feed. It observes the store (race events in
 * `store.feed`, cuts via `selectSeq` / `shot`, the 4 Hz `nowMs` clock) and writes `store.bc`.
 * One graphic per screen region: the header strap (top-left, one at a time, queued by
 * priority), the name strap / lower third (bottom-left), the battle widget (bottom-centre),
 * the onboard cluster (bottom-left, onboard shots only) and the right-hand pane. All holds are
 * wall-clock, like the classic banners: a paused picture keeps its graphics.
 */

const HOLD: Record<StrapKind, number> = { flag: 10000, leader: 6000, fastest: 5500, pit: 6000, speed: 5000 }
const PRIO: Record<StrapKind, number> = { flag: 100, leader: 80, fastest: 70, pit: 60, speed: 40 }
/** ms the retract animation takes, and the gap before the next strap may launch */
const STRAP_LEAVE = 350
const STRAP_GAP = 600
const STRAP_STALE = 15000
const QUEUE_MAX = 4
/** no strap launches this soon after a director cut: let the picture settle first */
const CUT_QUIET = 700
const NAME_HOLD = 6000
const NAME_HOLD_TV = 7000
/** the same driver is not identified twice within this window (manual selections excepted) */
const NAME_COOLDOWN = 25000
const PANE_HOLD: Record<PaneKind, number> = { tracker: 20000, weather: 8000, strategy: 10000 }
const TRACKER_EVERY = 120000
const STRATEGY_EVERY = 150000
/** tower right-column cycle from lap 3; STOPS is skipped until somebody has stopped */
const TOWER_CYCLE: [TowerMode, number][] = [['interval', 24000], ['leader', 20000], ['interval', 24000], ['tyre', 20000], ['stops', 12000]]
/** laps 1–2: positions gained versus the grid, alternating with the intervals */
const TOWER_START: [TowerMode, number][] = [['gained', 12000], ['interval', 12000]]
const WEATHER_LAPS = [15, 30, 45]

interface DirectorState {
  queue: Strap[]
  lastStrapEnd: number
  lastStrapLaunch: number
  feedCursor: number
  lastCut: number
  namePending: { driver: number; at: number; hold: number } | null
  nameLastAt: Map<number, number>
  towerIdx: number
  towerSince: number
  towerList: [TowerMode, number][] | null
  trackerNext: number
  strategyNext: number
  strategyAfterPitAt: number
  strategyAfterPitLast: number
  weatherShown: Set<number>
  preRaceWeather: boolean
  battleBehind: number
  battleSince: number
  battleLostAt: number
  battleRestUntil: number
  prevShot: CameraMode
}

function fresh(): DirectorState {
  return { queue: [], lastStrapEnd: 0, lastStrapLaunch: 0, feedCursor: 0, lastCut: 0, namePending: null, nameLastAt: new Map(), towerIdx: 0, towerSince: 0, towerList: null, trackerNext: 0, strategyNext: 0, strategyAfterPitAt: 0, strategyAfterPitLast: 0, weatherShown: new Set(), preRaceWeather: false, battleBehind: -1, battleSince: 0, battleLostAt: 0, battleRestUntil: 0, prevShot: 'overview' }
}

let scope: EffectScope | null = null
let d = fresh()
let strapId = 0
let nameKey = 0
/** dev counters read by the e2e suite through window.__suzuka (launches / drops / queue high-water) */
export const broadcastStats = { launches: 0, drops: 0, queueMax: 0, nameStraps: 0 }

export function useBroadcastGraphics() {
  const { store, broadcast } = useRaceStore()

  const now = () => performance.now()
  const racing = () => store.status === 'racing' || store.status === 'finished'

  // ---------------------------------------------------------------- straps
  const enqueue = (s: Strap) => {
    // coalesce: a newer strap of the same kind (same driver for pit stops) replaces the queued one
    const i = d.queue.findIndex((q) => q.kind === s.kind && (s.kind !== 'pit' || q.driver === s.driver))
    if (i >= 0) {
      d.queue.splice(i, 1)
      broadcastStats.drops++
    }
    d.queue.push(s)
    d.queue.sort((a, b) => PRIO[b.kind] - PRIO[a.kind] || a.t - b.t)
    while (d.queue.length > QUEUE_MAX) {
      d.queue.pop()
      broadcastStats.drops++
    }
    broadcastStats.queueMax = Math.max(broadcastStats.queueMax, d.queue.length)
  }
  const endStrap = (t: number) => {
    store.bc.strap = null
    d.lastStrapEnd = t + STRAP_LEAVE
  }
  const serviceStraps = (t: number) => {
    const active = store.bc.strap
    if (active && t >= active.t + active.hold) endStrap(t)
    // stale requests are dropped rather than shown late (the moment has passed)
    for (let i = d.queue.length - 1; i >= 0; i--) {
      const q = d.queue[i]!
      if (t - q.t > STRAP_STALE && q.kind !== 'flag' && q.kind !== 'leader') {
        d.queue.splice(i, 1)
        broadcastStats.drops++
      }
    }
    const next = d.queue[0]
    if (!next || !racing()) return
    const cur = store.bc.strap
    if (cur) {
      // a much bigger story pre-empts a strap that has had its moment
      if (PRIO[next.kind] >= PRIO[cur.kind] + 20 && t - cur.t >= 2000) endStrap(t)
      return
    }
    if (t < d.lastStrapEnd + STRAP_GAP || t - d.lastCut < CUT_QUIET) return
    d.queue.shift()
    next.t = t
    store.bc.strap = next
    d.lastStrapLaunch = t
    broadcastStats.launches++
    // the strategy pane follows a pit-stop strap once it has retracted
    if (next.kind === 'pit' && t - d.strategyAfterPitLast > 60000) {
      d.strategyAfterPitAt = t + next.hold + STRAP_LEAVE + 400
      d.strategyAfterPitLast = t
    }
  }

  // ---------------------------------------------------------------- feed
  const onFeed = (item: FeedItem) => {
    const ev = item.ev
    const t = now()
    const drv = 'car' in ev ? store.drivers[ev.car] : undefined
    switch (ev.type) {
      case 'fastestLap':
        // lap-1 fastest laps are the first cars across the line, not news
        if (store.lap >= 2) enqueue({ id: ++strapId, kind: 'fastest', driver: ev.car, t, hold: HOLD.fastest, time: ev.time })
        break
      case 'pit':
        enqueue({ id: ++strapId, kind: 'pit', driver: ev.car, t, hold: HOLD.pit, stationary: ev.stationary, from: ev.from, to: ev.compound, entryPosition: ev.entryPosition })
        break
      case 'pitOut': {
        // freeze the rejoin position on the strap that announced this stop
        const s = store.bc.strap
        if (s && s.kind === 'pit' && s.driver === ev.car) s.rejoin = ev.position
        for (const q of d.queue) if (q.kind === 'pit' && q.driver === ev.car) q.rejoin = ev.position
        break
      }
      case 'speedTrap':
        enqueue({ id: ++strapId, kind: 'speed', driver: ev.car, t, hold: HOLD.speed, kmh: ev.kmh })
        break
      case 'newLeader':
        if (store.lap >= 2) enqueue({ id: ++strapId, kind: 'leader', driver: ev.car, t, hold: HOLD.leader })
        break
      case 'drsEnabled':
        store.bc.header = 'drs'
        store.bc.headerUntil = t + 8000
        break
      case 'chequered':
        if (drv && drv.position === 1) {
          store.bc.header = 'chequered'
          store.bc.headerUntil = Infinity
          enqueue({ id: ++strapId, kind: 'flag', driver: ev.car, t, hold: HOLD.flag })
          d.namePending = { driver: ev.car, at: t + 2500, hold: 8000 }
          store.bc.classificationAt = t + 12000
        }
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------- name strap
  const launchName = (driver: number, hold: number, t: number) => {
    store.bc.nameStrap = { driver, t, hold, key: ++nameKey }
    d.nameLastAt.set(driver, t)
    broadcastStats.nameStraps++
  }
  const onSelection = () => {
    if (!broadcast.value || store.selected < 0 || !racing()) return
    const t = now()
    const driver = store.selected
    if (store.selectSource === 'director') {
      d.lastCut = t
      // the onboard cluster identifies the driver on onboard shots; a re-cut to the same driver is not news
      if (store.shot === 'onboard') return
      if (t - (d.nameLastAt.get(driver) ?? -1e9) < NAME_COOLDOWN) return
      d.namePending = { driver, at: t + 700, hold: store.shot === 'tv' ? NAME_HOLD_TV : NAME_HOLD }
    } else {
      if (store.shot === 'onboard') return
      const up = store.bc.nameStrap
      if (up && up.driver === driver) {
        // re-selecting the driver on air just extends the hold
        up.hold = t + NAME_HOLD - up.t
        return
      }
      // arrow-key scrubbing shows only the driver you land on
      d.namePending = { driver, at: t + 400, hold: NAME_HOLD }
    }
  }
  const serviceName = (t: number) => {
    const ns = store.bc.nameStrap
    if (ns && t >= ns.t + ns.hold) store.bc.nameStrap = null
    const p = d.namePending
    if (p && t >= p.at) {
      d.namePending = null
      if (store.shot !== 'onboard' && racing()) launchName(p.driver, p.hold, t)
    }
  }

  // ---------------------------------------------------------------- tower modes
  const serviceTower = (t: number) => {
    if (store.bc.towerLock) {
      store.bc.towerMode = store.bc.towerLock
      return
    }
    if (store.status === 'grid' || store.status === 'lights' || store.status === 'loading') {
      store.bc.towerMode = 'tyre'
      d.towerList = null
      return
    }
    if (store.status === 'finished') {
      store.bc.towerMode = 'leader'
      return
    }
    const list = store.lap <= 2 ? TOWER_START : TOWER_CYCLE
    if (d.towerList !== list) {
      d.towerList = list
      d.towerIdx = 0
      d.towerSince = t
      store.bc.towerMode = list[0]![0]
      return
    }
    const cur = list[d.towerIdx]!
    if (t - d.towerSince < cur[1]) return
    // a mode wipe would fight a strap launch or a name-strap entrance: wait for them
    if (t - d.lastStrapLaunch < 5000) return
    const ns = store.bc.nameStrap
    if (ns && t - ns.t < 3000) return
    let idx = (d.towerIdx + 1) % list.length
    const anyStop = store.drivers.some((x) => x.pitStops > 0)
    if (list[idx]![0] === 'stops' && !anyStop) idx = (idx + 1) % list.length
    d.towerIdx = idx
    d.towerSince = t
    store.bc.towerMode = list[idx]![0]
  }

  // ---------------------------------------------------------------- header
  const serviceHeader = (t: number) => {
    if (store.bc.header !== 'lap' && t >= store.bc.headerUntil) store.bc.header = 'lap'
  }

  // ---------------------------------------------------------------- right pane
  const PANE_PRIO: Record<PaneKind, number> = { weather: 3, strategy: 2, tracker: 1 }
  const showPane = (kind: PaneKind, t: number, hold = PANE_HOLD[kind]) => {
    const cur = store.bc.pane
    if (cur && cur.kind === kind) return
    if (cur && PANE_PRIO[cur.kind] >= PANE_PRIO[kind]) return
    store.bc.pane = { kind, t, hold }
  }
  const servicePane = (t: number) => {
    const cur = store.bc.pane
    if (cur && t >= cur.t + cur.hold) store.bc.pane = null
    if (store.status === 'grid' || store.status === 'lights') {
      // the conditions panel sits on air through the formation and the start
      if (!store.bc.pane) store.bc.pane = { kind: 'weather', t, hold: Infinity }
      d.preRaceWeather = true
      return
    }
    if (!racing()) return
    if (d.preRaceWeather) {
      d.preRaceWeather = false
      if (store.bc.pane?.kind === 'weather') store.bc.pane.hold = t + 8000 - store.bc.pane.t
      d.trackerNext = t + 30000
      d.strategyNext = t + 90000
    }
    if (store.status === 'finished') return
    // strategy after a pit stop > weather at set laps > periodic strategy > periodic / pinned tracker
    if (d.strategyAfterPitAt && t >= d.strategyAfterPitAt) {
      d.strategyAfterPitAt = 0
      showPane('strategy', t, 8000)
    }
    for (const lap of WEATHER_LAPS) {
      if (store.lap >= lap && !d.weatherShown.has(lap)) {
        d.weatherShown.add(lap)
        showPane('weather', t)
      }
    }
    if (store.lap >= 6 && t >= d.strategyNext && !store.bc.strap && !d.queue.length) {
      d.strategyNext = t + STRATEGY_EVERY
      showPane('strategy', t)
    }
    if (store.bc.trackerPinned) {
      if (!store.bc.pane) store.bc.pane = { kind: 'tracker', t, hold: Infinity }
    } else if (t >= d.trackerNext) {
      d.trackerNext = t + TRACKER_EVERY
      showPane('tracker', t)
    }
  }

  // ---------------------------------------------------------------- battle (hysteresis on the classic detector)
  const serviceBattle = (t: number) => {
    const src = store.battle
    const cur = store.bc.battle
    if (src && src.behind !== d.battleBehind) {
      d.battleBehind = src.behind
      d.battleSince = t
    }
    if (!src) d.battleBehind = -1
    if (cur) {
      const gone = !src || src.behind !== cur.behind
      if (gone) {
        if (!d.battleLostAt) d.battleLostAt = t
      } else {
        d.battleLostAt = 0
      }
      if ((gone && t - d.battleLostAt >= 3000) || t - cur.t > 25000) {
        store.bc.battle = null
        d.battleRestUntil = t + 15000
      }
      return
    }
    d.battleLostAt = 0
    if (src && t - d.battleSince >= 2000 && t >= d.battleRestUntil && racing() && store.bc.strap?.kind !== 'flag') {
      store.bc.battle = { position: src.position, ahead: src.ahead, behind: src.behind, t }
    }
  }

  const tick = () => {
    const t = now()
    serviceStraps(t)
    serviceName(t)
    serviceHeader(t)
    serviceTower(t)
    servicePane(t)
    serviceBattle(t)
  }

  const start = () => {
    if (scope) return
    d = fresh()
    const t = now()
    // never replay history: only events from now on go on air
    d.feedCursor = store.feed.length ? store.feed[store.feed.length - 1]!.id : 0
    d.prevShot = store.shot
    d.lastCut = t
    if (store.status === 'racing' && store.selected >= 0 && store.shot !== 'onboard') d.namePending = { driver: store.selected, at: t + 1500, hold: NAME_HOLD }
    scope = effectScope()
    scope.run(() => {
      watch(() => store.nowMs, tick)
      watch(() => store.feedSeq, () => {
        for (const item of store.feed) {
          if (item.id > d.feedCursor) {
            d.feedCursor = item.id
            onFeed(item)
          }
        }
      })
      watch(() => store.selectSeq, onSelection)
      watch(() => store.shot, (shot) => {
        const tt = now()
        if (d.prevShot === 'onboard' && shot !== 'onboard') store.bc.onboardUntil = tt + 300
        if (shot === 'onboard') {
          // the cluster owns the bottom-left band on onboard shots
          d.namePending = null
          store.bc.nameStrap = null
        }
        d.prevShot = shot
      })
      watch(() => store.restartToken, () => { d = fresh() })
    })
    tick()
  }
  const stop = () => {
    scope?.stop()
    scope = null
    d = fresh()
  }
  return { start, stop, tick, stats: broadcastStats }
}
