import * as THREE from 'three'
import { CUT_KEEP_OFF, CUT_ROAD_HALF, CUT_WALL_FOOT, CUTS, type CutDef } from '~/data/suzuka-facilities-spec'
import type { Track } from '~/sim/track'
import type { Terrain } from './environment'
import { signedDelta } from '~/sim/track'
import { FLAT_STRIP, RUNOFF_LIFT, STRIP_DROP, projectGlobal, roadFrameReach } from './ground-plan'
import { BARRIERS } from '~/data/suzuka-barriers-spec'
import { osmWay, resolveLineCached } from './trackside'

/**
 * The ground FIELD: the one continuous height every field-frame ground face rides on, and the
 * only place the analytic terrain is sampled for the ground (plan rule R3).
 *
 *   off ≤ 2 m            the flat strip on the road plane, STRIP_DROP below the asphalt
 *   2 m < off < 8 m      a smoothstep from the strip to the terrain
 *   off ≥ 8 m            the analytic terrain + RUNOFF_LIFT
 *
 * and, since I6 (R6 revised), inside a declared CUT's corridor (`CutField`): the cut's floor,
 * rising to the rules above over the wall's 0.6 m foot. The cut is consulted after the road
 * plane (a corridor never holds a road-frame point) and before the strip.
 *
 * It used to be three functions in three files (ground.yAt with a 0.25 m memo and a switch to
 * the DRAWN terrain mesh past the verge width, surfaces.ts with its own blend, the mesh-frame
 * sheets on the drawn grid) that disagreed by up to 165 mm at the same point. One function on
 * shared vertices cannot disagree with itself.
 */
export interface GroundField {
  /** height at (s, lateral) on that stretch of road, world y */
  yAt(s: number, lateral: number): number
  /** height at world (x, z), projected onto the road within `window` when given, else crossover-aware nearest */
  y(x: number, z: number, window?: [number, number]): number
  /**
   * `y(x, z)` for a caller that already holds the point's crossover-aware projection
   * (`projectGlobal` / `plan.project(x, z)` without a window): the same arithmetic on the same
   * projection, so the same number — the mesh builder's refinement projects every midpoint for
   * its (s, lateral) anyway and reads the field on that instead of projecting twice.
   */
  yProjected(x: number, z: number, p: { s: number; lateral: number }): number
  /** the field's terrain term alone (no strip rule), for faces far from any road */
  terrainAt(x: number, z: number): number
  /** the cut floor at world (x, z) — null outside every CUT corridor (`CutField.at`) */
  cutAt(x: number, z: number): number | null
  /** the field as it would be without any cut (the outside of every corridor), for the cut tooling */
  yNoCut(x: number, z: number): number
}

const BLEND_TO = 8

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

// ================================================================ the cut field (I6, R6)

export interface CutSample {
  /** the floor's world y here */
  floor: number
  /** 1 on the floor, 0 at the wall's top edge (the corridor's polygon edge); the wall foot between */
  t: number
}

/** one corridor of the cut field, for the tooling (dem-profile --cuts, the smokes) */
export interface CutCorridor {
  id: string
  def: CutDef
  /** the portal as built: the world point and compass bearing (deg) the corridor leaves it by; `pushed` = metres it was moved out from the declared position */
  portal: { x: number; z: number; s: number; lateral: number; heading: number; pushed: number }
  /**
   * `track`: the corridor is square to the road (within SQUARE_DEG) and lives in the (s, lateral)
   * frame — its centreline is the portal's own station ray and its walls the rays at
   * `portal.s ± w`, exactly (the plan traces a wall ON a ray; one crossing the rays at a hair's
   * angle swept its column over every fill column between two stations). `world`: a straight line
   * (or the way's polyline) in world XZ with the walls offset square to it.
   */
  frame: 'track' | 'world'
  /** metres along the centreline where the corridor starts (0, or later where the portal sat in a road frame) and ends */
  startD: number
  endD: number
  /** why the corridor ended: it met the ground, the next road frame, its declared length, the end of its way (a cut between two tunnels) or the safety cap */
  end: 'daylight' | 'roadFrame' | 'length' | 'wayEnd' | 'cap'
  /** the field at the portal without the cut, the floor at the portal and at the end */
  fieldAtPortal: number
  floorStart: number
  floorEnd: number
  /** the centreline every CUT_STEP metres from the portal (world), with the floor and the wall half-widths there */
  samples: { x: number; z: number; d: number; floor: number; wl: number; wr: number }[]
}

export interface CutField {
  /** the floor at world (x, z), null outside every corridor (the polygon edge is the wall's top) */
  at(x: number, z: number): number | null
  /** the floor and the wall-foot weight at world (x, z), null outside every corridor */
  sample(x: number, z: number): CutSample | null
  /** a corridor's polygon (world XZ, closed, counter-clockwise or not — the caller winds it): the whole width, or the asphalt road inside it; [] for an unknown / empty cut */
  corridor(id: string, part?: 'road' | 'corridor'): { x: number; z: number }[]
  corridors: CutCorridor[]
}

/** centreline sample pitch (m) */
const CUT_STEP = 0.5
/** the longest corridor the field will dig (m): a cut that has not daylighted by then is reported, not extended */
const CUT_MAX_D = 160
/** the wall foot's pull-in step when an edge point lands in a road frame (m) */
const PULL_STEP = 0.25
/**
 * A heading within this many degrees of square to the road is built in the track frame (see
 * `CutCorridor.frame`): the works road is the pit straight's normal to 0.3°, and a world-straight
 * wall that crosses the plan's station rays at a hair's angle sweeps its column across every
 * fill column between two stations — the fills collapsed onto it and the raster kept 10–23 m
 * edges along the rays (G7); a wall exactly on the rays (the paddock car-park rectangles' ends)
 * is what the plan traces. A 3° skew (the 逆バンク ramps) crosses a fill column every 10 m of s
 * and the crossing passes station it.
 */
const SQUARE_DEG = 3
/** the lookup grid's cell (m): a cell knows which corridors' boxes touch it, so the field pays two integer divides outside every corridor */
const CELL = 32
/** a corridor starts outside the BARRIERS line of its side by this much: the wall the tunnel passes under stands on the headwall (I6-b), never in the cut */
const BARRIER_CLEAR = 0.6
/**
 * The start cap's corners lie at least this far beyond the road edge (m) — past the plan's
 * third fill column (FILL_OFFS 5.5): the plan parks a ring's OUT column on the fill column
 * below its first interval, and a cap whose near corner sat between the crossfall kink column
 * (ROLL_CAP − hw, 3.7–4.0 m) and that fill column made the parked column cross the kink — a
 * residual inversion the crossing passes cannot resolve (G12). Wider than the plan's
 * hw + CUT_KEEP_OFF + halfWidth for the stair pits alone (their 1.75 m); the road cuts' portals
 * are all further out.
 */
const CAP_MIN_OFF = 5.6
/**
 * The start cap keeps this much (m) beyond a road frame's reach: the cap is a column of the
 * raster, and on the frame's own column (the garage apron's outer edge for the works road's
 * south-west ramp) the two tie within a centimetre — a residual inversion (G12)
 */
const CAP_CLEAR = 0.3

type Pt = { x: number; z: number }

/** compass bearing (deg, 0 = north, 90 = east) of a world direction: world x = east, world z = −north */
const bearingOf = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
/** unit world direction of a compass bearing */
const dirOf = (heading: number): Pt => { const r = (heading * Math.PI) / 180; return { x: Math.sin(r), z: -Math.cos(r) } }

/**
 * Build the cut field: one corridor per CUT, computed from the portal, the heading, the grade
 * and the ground — the polygon is never authored. The road frame is `roadFrameReach` (the
 * plan's own rule: kerb / deck shoulder / pit lane / apron) plus the CUT_KEEP_OFF strip, read on
 * the crossover-aware global projection so a corridor stops at whichever road it meets.
 */
export function buildCutField(track: Track, terrain: Terrain, cuts: readonly CutDef[] = CUTS): CutField {
  const reach = roadFrameReach(track)
  const _p = new THREE.Vector3()
  /** the field without any cut (the rules above), at a world point on its global projection */
  const fieldNoCut = (x: number, z: number): number => {
    const p = projectGlobal(track, x, z)
    const hw = track.halfWidthAt(p.s)
    const off = Math.abs(p.lateral) - hw
    if (off >= BLEND_TO) return terrain.heightAt(x, z) + RUNOFF_LIFT
    track.pointAt(p.s, p.lateral, _p, 0)
    if (off <= 0) return _p.y
    const strip = _p.y + STRIP_DROP
    if (off <= FLAT_STRIP) return strip
    const t = terrain.heightAt(x, z) + RUNOFF_LIFT
    return strip + (t - strip) * smoothstep((off - FLAT_STRIP) / (BLEND_TO - FLAT_STRIP))
  }
  /** metres a world point may still move toward the nearest road before it enters what a cut may not touch (negative = inside) */
  const clearance = (x: number, z: number): number => {
    const p = projectGlobal(track, x, z)
    const hw = track.halfWidthAt(p.s)
    const side = p.lateral >= 0 ? 1 : -1
    return Math.abs(p.lateral) - hw - Math.max(CUT_KEEP_OFF, reach(p.s, side))
  }

  /** every BARRIERS run's resolved line as a world polyline: a corridor starts clear of them */
  const barrierLines: Pt[][] = []
  for (const run of BARRIERS) {
    const line = resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
    if (line.samples.length < 2) continue
    barrierLines.push(line.samples.map(([ss, lat]) => { track.pointAt(ss, lat, _p, 0); return { x: _p.x, z: _p.z } }))
  }
  const cross = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
    const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
  }
  const segDist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dz = b.z - a.z
    const l2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2))
    return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
  }
  /**
   * the point `w` metres to the left (+) or right (−) of centreline sample k: square to the local
   * direction in the world frame; on the ray at `portal.s ∓ w` in the track frame (`geom`)
   */
  type Geom = { frame: 'track' | 'world'; s: number; lateral: number; sign: 1 | -1 }
  const sideAt = (g: Geom, sm: CutCorridor['samples'], k: number, w: number): Pt => {
    const q = sm[k]!
    if (g.frame === 'track') {
      // +w = the left of the direction of travel: −s on the left side of the road (the ray
      // points away from the road), +s on the right
      track.pointAt(track.wrap(g.s - g.sign * w), g.lateral + g.sign * q.d, _p, 0)
      return { x: _p.x, z: _p.z }
    }
    const n = sm[Math.min(sm.length - 1, k + 1)]!, pv = sm[Math.max(0, k - 1)]!
    let dx = n.x - pv.x, dz = n.z - pv.z
    const l = Math.hypot(dx, dz) || 1
    dx /= l; dz /= l
    return { x: q.x - dz * w, z: q.z + dx * w }
  }
  /** the corridor's polygon from sample index i0 to i1 (left edge forward, right edge back), the half-widths capped at `half` */
  const polygonFrom = (g: Geom, sm: CutCorridor['samples'], i0: number, half = Infinity, i1 = sm.length - 1): Pt[] => {
    const left: Pt[] = [], right: Pt[] = []
    for (let k = i0; k <= i1; k++) {
      const q = sm[k]!
      left.push(sideAt(g, sm, k, Math.min(q.wl, half)))
      right.push(sideAt(g, sm, k, -Math.min(q.wr, half)))
    }
    return [...left, ...right.reverse()]
  }
  /**
   * the furthest sample index within the corridor's START (its first 2 · halfWidth + 1 m from
   * sample i0: the wall the tunnel passes under) whose polygon edge a BARRIERS line crosses or
   * comes within BARRIER_CLEAR of (−1 = clear): the corridor then starts after it. A line met
   * further along is not the portal's wall (the county-road cut ends 0.7 m short of the chicane
   * approach's guardrail, on purpose) — the smoke reports crossings there
   */
  const barrierReach = (g: Geom, sm: CutCorridor['samples'], i0: number, startM: number): number => {
    const poly = polygonFrom(g, sm, i0)
    const n = sm.length - i0
    const iMax = i0 + Math.ceil(startM / CUT_STEP)
    let worst = -1
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j]!, b = poly[(j + 1) % poly.length]!
      // polygon vertex j ↔ sample index: left edge j → i0 + j, right edge → i0 + (2n − 1 − j)
      const idx = j < n ? i0 + j : i0 + (2 * n - 1 - j)
      if (idx <= worst || idx > iMax) continue
      for (const line of barrierLines) {
        let hit = false
        for (let i = 0; i + 1 < line.length && !hit; i++) hit = cross(a, b, line[i]!, line[i + 1]!) || segDist(a, line[i]!, line[i + 1]!) < BARRIER_CLEAR
        if (hit) { worst = Math.max(worst, idx); break }
      }
    }
    return worst
  }

  const corridors: CutCorridor[] = []
  const geoms = new Map<string, Geom>()
  for (const def of cuts) {
    // --- the portal and the heading ------------------------------------------------------------------
    let s: number, lateral: number, heading: number
    const polyline: Pt[] = []
    if ('from' in def.portal) {
      const f = def.osmWay !== undefined ? osmWay(def.osmWay) : undefined
      if (!f || f.en.length < 2) { console.error(`[cuts] "${def.id}": OSM way ${def.osmWay} missing or too short for portal '${def.portal.from}'`); continue }
      const pts = f.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
      const n = pts.length
      const node = def.portal.from === 'first' ? pts[0]! : pts[n - 1]!
      const tunnel = f.tags.tunnel === 'yes'
      // a tunnel way ends at its portals: the corridor leaves it; an open way IS the road the
      // corridor follows from that node
      const inward = def.portal.from === 'first' ? pts[1]! : pts[n - 2]!
      if (tunnel) heading = bearingOf(node.x - inward.x, node.z - inward.z)
      else {
        heading = bearingOf(inward.x - node.x, inward.z - node.z)
        const rest = def.portal.from === 'first' ? pts.slice(1) : pts.slice(0, n - 1).reverse()
        polyline.push(...rest)
      }
      const pr = track.nearestOnRange(node.x, node.z, def.window[0], def.window[1], 60)
      s = pr.s
      lateral = pr.lateral
    } else ({ s, lateral, heading } = def.portal);
    // square to the road within SQUARE_DEG (and not along a way): the track frame, the heading
    // being the portal's outward ray
    const sign: 1 | -1 = lateral >= 0 ? 1 : -1
    let frame: CutCorridor['frame'] = 'world'
    {
      track.pointAt(track.wrap(s), 0, _p, 0)
      const ax = _p.x, az = _p.z
      track.pointAt(track.wrap(s), sign * 10, _p, 0)
      const normal = bearingOf(_p.x - ax, _p.z - az)
      const dh = ((heading - normal + 540) % 360) - 180
      if (Math.abs(dh) < SQUARE_DEG && !polyline.length) { heading = normal; frame = 'track' }
    }
    // a portal too close to the centreline is pushed out to hw + CUT_KEEP_OFF + halfWidth, and on
    // until both corners of its cap clear CAP_MIN_OFF (the corner nearest the road of a cap that
    // is not parallel to it)
    const hw0 = track.halfWidthAt(s)
    const minLat = hw0 + CUT_KEEP_OFF + def.halfWidth
    let pushed = 0
    if (Math.abs(lateral) < minLat) { pushed = minLat - Math.abs(lateral); lateral = Math.sign(lateral || 1) * minLat }
    {
      const u = dirOf(heading)
      const cornerOff = (lat: number): number => {
        track.pointAt(track.wrap(s), lat, _p, 0)
        let worst = Infinity
        for (const w of [-def.halfWidth, def.halfWidth]) {
          const x = _p.x - u.z * w, z = _p.z + u.x * w
          const p = track.nearestOnRange(x, z, def.window[0], def.window[1], 60)
          worst = Math.min(worst, Math.abs(p.lateral) - track.halfWidthAt(p.s))
        }
        return worst
      }
      for (let k = 0; k < 40 && cornerOff(lateral) < CAP_MIN_OFF; k++) { lateral += Math.sign(lateral || 1) * PULL_STEP; pushed += PULL_STEP }
    }
    track.pointAt(track.wrap(s), lateral, _p, 0)
    const portal = { x: _p.x, z: _p.z, s: track.wrap(s), lateral, heading, pushed }
    const geom: Geom = { frame, s: portal.s, lateral, sign }
    // --- the centreline every CUT_STEP: the portal's ray (track frame), or the portal along the
    //     heading / on along the way (world frame) --------------------------------------------------
    const centre: { x: number; z: number; d: number }[] = []
    if (frame === 'track') {
      for (let k = 0; k * CUT_STEP <= CUT_MAX_D; k++) {
        const d = k * CUT_STEP
        track.pointAt(portal.s, lateral + sign * d, _p, 0)
        centre.push({ x: _p.x, z: _p.z, d })
      }
    } else {
      const verts: Pt[] = [{ x: portal.x, z: portal.z }]
      if (polyline.length) verts.push(...polyline)
      else { const u = dirOf(heading); verts.push({ x: portal.x + u.x * CUT_MAX_D, z: portal.z + u.z * CUT_MAX_D }) }
      const cum: number[] = [0]
      for (let i = 1; i < verts.length; i++) cum.push(cum[i - 1]! + Math.hypot(verts[i]!.x - verts[i - 1]!.x, verts[i]!.z - verts[i - 1]!.z))
      const total = Math.min(CUT_MAX_D, cum[cum.length - 1]!)
      for (let k = 0, seg = 0; ; k++) {
        const d = k * CUT_STEP
        if (d > total + 1e-9) break
        while (seg + 1 < cum.length - 1 && d > cum[seg + 1]!) seg++
        const a = verts[seg]!, b = verts[seg + 1]!
        const len = cum[seg + 1]! - cum[seg]!
        if (len < 1e-9) continue
        const t = d - cum[seg]!
        centre.push({ x: a.x + ((b.x - a.x) / len) * t, z: a.z + ((b.z - a.z) / len) * t, d })
      }
    }
    // --- the floor and the end -----------------------------------------------------------------------
    const fieldAtPortal = fieldNoCut(portal.x, portal.z)
    const floorAt = (d: number) => fieldAtPortal - def.depth + def.grade * d
    const samples: CutCorridor['samples'] = []
    let startD = -1, endD = 0
    let end: CutCorridor['end'] = polyline.length ? 'wayEnd' : 'cap'
    // the side points of the sample being decided are read off the centreline itself (its
    // neighbours give the local direction in the world frame)
    const centreSm: CutCorridor['samples'] = centre.map((c) => ({ x: c.x, z: c.z, d: c.d, floor: 0, wl: 0, wr: 0 }))
    const sideClear = (k: number, w: number): number => { const q = sideAt(geom, centreSm, k, w); return clearance(q.x, q.z) }
    for (let k = 0; k < centre.length; k++) {
      const c = centre[k]!
      // the portal (or its first metres) inside a road frame or behind the wall the tunnel passes
      // under: the corridor starts where the frame ends / outside the wall
      if (startD < 0) {
        if (clearance(c.x, c.z) < CAP_CLEAR) continue
        startD = c.d
      } else if (clearance(c.x, c.z) < 0) { end = 'roadFrame'; break }
      const floor = floorAt(c.d)
      if (!def.level && floor >= terrain.heightAt(c.x, c.z) + RUNOFF_LIFT - 0.2) { end = 'daylight'; break }
      // the wall foot either side: pulled in where the edge would enter a road frame
      let wl = def.halfWidth, wr = def.halfWidth
      while (wl > 0 && sideClear(k, wl) < 0) wl -= PULL_STEP
      while (wr > 0 && sideClear(k, -wr) < 0) wr -= PULL_STEP
      samples.push({ x: c.x, z: c.z, d: c.d, floor, wl: Math.max(0, wl), wr: Math.max(0, wr) })
      endD = c.d
    }
    // the wall the tunnel passes under (a BARRIERS line: the pedestrian tunnels' nodes are
    // digitised inside their walls, the 200R portal a metre inside the outside wall): the
    // corridor starts BARRIER_CLEAR beyond the last sample a line reaches, and a level cut of a
    // declared length keeps its length from there
    let i0 = 0
    for (let pass = 0; pass < 8 && i0 < samples.length; pass++) {
      const reach = barrierReach(geom, samples, i0, 2 * def.halfWidth + 1)
      if (reach < 0) break
      i0 = reach + 1 + Math.ceil(BARRIER_CLEAR / CUT_STEP)
    }
    let kept = samples.slice(i0)
    const len = def.level ? def.length : undefined
    if (len !== undefined) { const d0 = kept[0]?.d ?? 0; kept = kept.filter((q) => q.d - d0 <= len + 1e-9) }
    if (kept.length < 2) {
      console.error(`[cuts] "${def.id}": the corridor resolves to nothing (portal at (${portal.s.toFixed(0)}, ${portal.lateral.toFixed(1)}) inside a road frame or behind a BARRIERS line for its whole length?)`)
      continue
    }
    if (i0 > 0) portal.pushed += kept[0]!.d - samples[0]!.d
    startD = kept[0]!.d
    endD = kept[kept.length - 1]!.d
    if (len !== undefined) end = 'length'
    corridors.push({ id: def.id, def, portal, frame, startD, endD, end, fieldAtPortal, floorStart: kept[0]!.floor, floorEnd: kept[kept.length - 1]!.floor, samples: kept })
    geoms.set(def.id, geom)
  }

  // --- the lookup grid over the corridors' boxes ----------------------------------------------------
  const boxes = corridors.map((c) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const q of c.samples) {
      const w = Math.max(q.wl, q.wr) + CUT_STEP
      x0 = Math.min(x0, q.x - w); x1 = Math.max(x1, q.x + w); z0 = Math.min(z0, q.z - w); z1 = Math.max(z1, q.z + w)
    }
    return [x0, x1, z0, z1] as const
  })
  let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity
  for (const b of boxes) { gx0 = Math.min(gx0, b[0]); gx1 = Math.max(gx1, b[1]); gz0 = Math.min(gz0, b[2]); gz1 = Math.max(gz1, b[3]) }
  const nx = corridors.length ? Math.ceil((gx1 - gx0) / CELL) + 1 : 0, nz = corridors.length ? Math.ceil((gz1 - gz0) / CELL) + 1 : 0
  const cells: (number[] | null)[] = new Array(nx * nz).fill(null)
  boxes.forEach((b, i) => {
    for (let jz = Math.floor((b[2] - gz0) / CELL); jz <= Math.floor((b[3] - gz0) / CELL); jz++) for (let jx = Math.floor((b[0] - gx0) / CELL); jx <= Math.floor((b[1] - gx0) / CELL); jx++) {
      const k = jz * nx + jx
      ;(cells[k] ??= []).push(i)
    }
  })

  /** a point's (d along, across to the left, the sample index at d) in a corridor's frame */
  const locateFrame = (c: CutCorridor, x: number, z: number): { k: number; a: number; across: number } | null => {
    const sm = c.samples
    const g = geoms.get(c.id)!
    if (g.frame === 'track') {
      // the (s, lateral) frame: d along the portal's ray, across = the s offset (−s is the left
      // of travel on the left side of the road, +s on the right)
      const p = track.nearestOnRange(x, z, c.def.window[0], c.def.window[1], 60)
      const d = g.sign * (p.lateral - g.lateral)
      const k = Math.round((d - sm[0]!.d) / CUT_STEP)
      if (k < 0 || k >= sm.length) return null
      return { k, a: d - sm[k]!.d, across: -g.sign * signedDelta(g.s, p.s, track.length) }
    }
    const first = sm[0]!, last = sm[sm.length - 1]!
    // along-distance from the first sample on the corridor's overall direction picks the sample
    const ux = last.x - first.x, uz = last.z - first.z
    const ul = Math.hypot(ux, uz) || 1
    const along = ((x - first.x) * ux + (z - first.z) * uz) / ul
    let i = Math.round(along / CUT_STEP)
    if (i < -1 || i > sm.length) return null
    i = Math.max(0, Math.min(sm.length - 1, i))
    // refine on the local segment direction (a corridor along a curving way)
    for (let k = Math.max(0, i - 2); k <= Math.min(sm.length - 1, i + 2); k++) {
      const q = sm[k]!
      const n = sm[Math.min(sm.length - 1, k + 1)]!, pv = sm[Math.max(0, k - 1)]!
      let dx = n.x - pv.x, dz = n.z - pv.z
      const l = Math.hypot(dx, dz) || 1
      dx /= l; dz /= l
      const a = (x - q.x) * dx + (z - q.z) * dz
      if (Math.abs(a) > CUT_STEP / 2 + 1e-6) continue
      return { k, a, across: -(x - q.x) * dz + (z - q.z) * dx }
    }
    return null
  }
  /** the corridor's floor and wall-foot distance at a world point, or null when it lies outside */
  const locate = (c: CutCorridor, x: number, z: number): { floor: number; edge: number } | null => {
    const at = locateFrame(c, x, z)
    if (!at) return null
    const sm = c.samples
    const { k, a, across } = at
    const q = sm[k]!
    const dEnd = c.endD - (q.d + a)
    // the wall foot's half-widths between this sample and the next one along (the polygon's
    // edge is the straight line between the two corners)
    const j = sm[Math.max(0, Math.min(sm.length - 1, a >= 0 ? k + 1 : k - 1))]!
    const f = Math.min(1, Math.abs(a) / CUT_STEP)
    const wl = q.wl + (j.wl - q.wl) * f, wr = q.wr + (j.wr - q.wr) * f
    const dStart = q.d + a - c.startD
    if (across > wl || across < -wr || dEnd < 0 || dStart < -1e-6) return null
    // the wall foot on every edge, the portal's cap included: the field is then continuous
    // across the whole polygon edge (a step exactly on the cap's column read one side on the
    // vertex and the other a float32 rounding away — G11 counted the mesh's drop as unexplained)
    return { floor: q.floor + c.def.grade * a, edge: Math.min(wl - across, across + wr, dEnd, dStart) }
  }
  const sample = (x: number, z: number): CutSample | null => {
    if (!corridors.length || x < gx0 || x > gx1 || z < gz0 || z > gz1) return null
    const list = cells[Math.floor((z - gz0) / CELL) * nx + Math.floor((x - gx0) / CELL)]
    if (!list) return null
    let out: CutSample | null = null
    for (const i of list) {
      const b = boxes[i]!
      if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue
      const hit = locate(corridors[i]!, x, z)
      if (!hit) continue
      const t = smoothstep(hit.edge / CUT_WALL_FOOT)
      // two corridors over one point: the deeper floor (the union of the excavations)
      if (!out || hit.floor < out.floor) out = { floor: hit.floor, t }
    }
    return out
  }
  const corridor = (id: string, part: 'road' | 'corridor' = 'corridor'): Pt[] => {
    const c = corridors.find((q) => q.id === id)
    if (!c) return []
    if (part !== 'road') return polygonFrom(geoms.get(c.id)!, c.samples, 0)
    // the road inside the corridor: ± CUT_ROAD_HALF, inside the wall foot (a stair pit's 3.5 m
    // leaves 2.1), starting a foot past the portal's cap and, for a level cut, stopping a foot
    // short of the end wall: the road ring's caps give the raster a column at the FOOT of those
    // walls (the corridor ring's cap is the wall's top); without them the floor was chorded up to
    // the top over the fill columns' 5 m
    const half = Math.min(CUT_ROAD_HALF, Math.max(0, c.def.halfWidth - CUT_WALL_FOOT - 0.15))
    const foot = Math.ceil((CUT_WALL_FOOT + 0.1) / CUT_STEP)
    const i1 = c.def.level ? Math.max(1, c.samples.length - 1 - foot) : c.samples.length - 1
    const i0 = Math.min(foot, Math.max(0, i1 - 1))
    return polygonFrom(geoms.get(c.id)!, c.samples, i0, half, i1)
  }
  return { at: (x, z) => sample(x, z)?.floor ?? null, sample, corridor, corridors }
}

// ================================================================ the field

export function makeField(track: Track, terrain: Terrain, cuts: CutField | null = null): GroundField {
  const _p = new THREE.Vector3()
  const cutSample = cuts ? cuts.sample : null
  /** the rules beyond the road plane (off > 0), given the road plane's y at the projection */
  const beyondRoad = (off: number, roadY: number, x: number, z: number): number => {
    const strip = roadY + STRIP_DROP
    if (off <= FLAT_STRIP) return strip
    const t = terrain.heightAt(x, z) + RUNOFF_LIFT
    if (off >= BLEND_TO) return t
    return strip + (t - strip) * smoothstep((off - FLAT_STRIP) / (BLEND_TO - FLAT_STRIP))
  }
  /** the cut's floor blended over the wall foot into the no-cut field (`outside` evaluated only inside the foot) */
  const withCut = (c: CutSample, outside: () => number): number => { if (c.t >= 1) return c.floor; const o = outside(); return o + (c.floor - o) * c.t }
  const yAt = (s: number, lateral: number): number => {
    const hw = track.halfWidthAt(s)
    const off = Math.abs(lateral) - hw
    track.pointAt(s, lateral, _p, 0)
    if (off <= 0) return _p.y
    const x = _p.x, z = _p.z, roadY = _p.y
    const c = cutSample ? cutSample(x, z) : null
    if (c) return withCut(c, () => beyondRoad(off, roadY, x, z))
    return beyondRoad(off, roadY, x, z)
  }
  const yProjected = (x: number, z: number, p: { s: number; lateral: number }): number => {
    const hw = track.halfWidthAt(p.s)
    const off = Math.abs(p.lateral) - hw
    const c = off > 0 && cutSample ? cutSample(x, z) : null
    if (!c && off >= BLEND_TO) return terrain.heightAt(x, z) + RUNOFF_LIFT
    // inside the blend the strip term comes from the projection; the terrain term from the point
    track.pointAt(p.s, p.lateral, _p, 0)
    if (off <= 0) return _p.y
    const roadY = _p.y
    if (c) return withCut(c, () => beyondRoad(off, roadY, x, z))
    return beyondRoad(off, roadY, x, z)
  }
  const yNoCut = (x: number, z: number): number => {
    const p = projectGlobal(track, x, z)
    const hw = track.halfWidthAt(p.s)
    const off = Math.abs(p.lateral) - hw
    if (off >= BLEND_TO) return terrain.heightAt(x, z) + RUNOFF_LIFT
    track.pointAt(p.s, p.lateral, _p, 0)
    if (off <= 0) return _p.y
    return beyondRoad(off, _p.y, x, z)
  }
  const y = (x: number, z: number, window?: [number, number]): number => yProjected(x, z, window ? track.nearestOnRange(x, z, window[0], window[1], 60) : projectGlobal(track, x, z))
  return { yAt, y, yProjected, terrainAt: (x, z) => terrain.heightAt(x, z) + RUNOFF_LIFT, cutAt: (x, z) => cuts?.at(x, z) ?? null, yNoCut }
}
