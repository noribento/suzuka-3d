/**
 * Shared helpers for the OSM → app/data generators (build-surroundings.mjs and, in time, the
 * others). The projection, the Overpass fetch and the track-coordinate mapping are COPIES of
 * the ones in build-facilities.mjs — that script stays untouched so suzuka-facilities.ts keeps
 * regenerating byte-for-byte; when its output is next allowed to move it can import from here.
 *
 * Also home to the int16-delta base64 encoder (`encodeI16Delta`), the inverse of
 * app/data/en-codec.ts `decodeI16Delta`: both the surroundings extract and the DEM grid ship
 * their integer arrays in this one scheme.
 */
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------- projection
// Exact inverse of the projection CENTERLINE_EN was made with (max error ≤ 0.005 m; see the
// research report §1). The origin is the arithmetic mean of ALL 172 GeoJSON coordinates,
// i.e. the duplicated closing vertex counts twice — using the 171 unique ones is 4 m off.
export const LAT0 = 34.844581633720921
export const LON0 = 136.53282038953489
export const R = 6378137
const D = Math.PI / 180
const KX = Math.cos(LAT0 * D) * R * D
const KY = R * D
/** lon/lat → local EN metres (equirectangular, the CENTERLINE_EN frame) */
export const toLocal = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY]

// ---------------------------------------------------------------- Overpass
export const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
export const USER_AGENT = 'suzuka3d-facilities/1.0 (bhyg756@gmail.com)'

/**
 * POST `query` to the Overpass endpoints in turn (first one that answers wins) and cache the
 * JSON at `cache`. With `offline` an existing cache is returned without touching the network;
 * without a cache `offline` falls through to the network like the facilities builder does.
 */
export async function fetchOverpass(query, cache, { offline = false, endpoints = ENDPOINTS, log = console.log } = {}) {
  if (offline && fs.existsSync(cache)) {
    log(`using cached Overpass response ${cache}`)
    return JSON.parse(fs.readFileSync(cache, 'utf8'))
  }
  if (offline) log(`--offline but no cache at ${cache}; querying`)
  let lastErr = null
  for (const url of endpoints) {
    try {
      log(`querying ${url} …`)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const json = await res.json()
      if (!Array.isArray(json.elements)) throw new Error('no elements in response')
      fs.mkdirSync(path.dirname(cache), { recursive: true })
      fs.writeFileSync(cache, JSON.stringify(json))
      log(`  ${json.elements.length} elements (osm base ${json.osm3s?.timestamp_osm_base})`)
      return json
    } catch (e) {
      lastErr = e
      console.warn(`  failed: ${e.message}`)
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- track coordinates
/**
 * Nearest-segment mapping onto the app's sampled centreline, built over a `Track` instance.
 * Returns `toTrack(X, Z)` → { s, lateral (+left), d } in WORLD coordinates (× enScale, z = −N),
 * exactly as build-facilities.mjs computes them.
 */
export function trackMapper(track) {
  const L = track.length
  const N = track.n
  const DS = track.ds
  const { px, pz, nx, nz } = track
  return function toTrack(X, Z) {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < N; i++) {
      const dx = X - px[i]
      const dz = Z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    let best = { s: bi * DS, lateral: 0, d: Infinity }
    for (const j of [(bi - 1 + N) % N, bi]) {
      const k = (j + 1) % N
      const ax = px[j]
      const az = pz[j]
      let ux = px[k] - ax
      let uz = pz[k] - az
      const ul = Math.hypot(ux, uz)
      ux /= ul
      uz /= ul
      let t = (X - ax) * ux + (Z - az) * uz
      t = Math.max(0, Math.min(ul, t))
      const qx = ax + ux * t
      const qz = az + uz * t
      const d = Math.hypot(X - qx, Z - qz)
      if (d < best.d) {
        // the track's own left normal, so the sign convention is exactly Track.poseAt's
        const f = t / ul
        const lnx = nx[j] * (1 - f) + nx[k] * f
        const lnz = nz[j] * (1 - f) + nz[k] * f
        const nl = Math.hypot(lnx, lnz) || 1
        const lateral = ((X - qx) * lnx + (Z - qz) * lnz) / nl
        best = { s: (((j * DS + t) % L) + L) % L, lateral, d }
      }
    }
    return best
  }
}

/**
 * Smallest arc of the lap that contains every sample s: sort, find the largest gap
 * (including the one across the start line) and take its complement. `fold` is set when
 * that arc is longer than half a lap — the feature sits in the figure-8 fold and the
 * nearest-segment mapping flips between the two legs, so only EN / centroid are reliable.
 */
export function sRange(ss, L) {
  const a = [...ss].sort((p, q) => p - q)
  if (a.length === 1) return { s: [a[0], a[0]], fold: false }
  let gapStart = a.length - 1
  let gap = a[0] + L - a[a.length - 1]
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i + 1] - a[i]
    if (g > gap) {
      gap = g
      gapStart = i
    }
  }
  const start = a[(gapStart + 1) % a.length]
  const end = a[gapStart]
  return { s: [start, end], fold: L - gap > L / 2 }
}

// ---------------------------------------------------------------- geometry
export const round1 = (v) => Math.round(v * 10) / 10

/** OSM way geometry → EN vertex list; closed ways lose the duplicated closing vertex. */
export function wayToEN(el) {
  const geom = el.type === 'node' ? [{ lon: el.lon, lat: el.lat }] : el.geometry
  if (!geom || geom.length === 0) return null
  let en = geom.map((g) => toLocal(g.lon, g.lat))
  const closed = en.length > 2 && Math.hypot(en[0][0] - en[en.length - 1][0], en[0][1] - en[en.length - 1][1]) < 1e-6
  if (closed) en = en.slice(0, -1)
  return { en, closed }
}

/** Douglas–Peucker on an open polyline (endpoints kept). */
export function simplifyLine(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    let worst = -1
    let wd = tol
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]
      const d = len < 1e-9 ? Math.hypot(x - ax, y - ay) : Math.abs((x - ax) * dy - (y - ay) * dx) / len
      if (d > wd) {
        wd = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Douglas–Peucker on a closed ring: split at vertex 0 and the vertex farthest from it. */
export function simplifyRing(ring, tol) {
  if (ring.length < 4 || tol <= 0) return ring.slice()
  let k = 1
  let kd = -1
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
    if (d > kd) {
      kd = d
      k = i
    }
  }
  const a = simplifyLine(ring.slice(0, k + 1), tol)
  const b = simplifyLine([...ring.slice(k), ring[0]], tol)
  const out = [...a, ...b.slice(1, -1)]
  return out.length >= 3 ? out : []
}

/** Signed shoelace area of an EN ring (positive = counter-clockwise in EN). */
export function ringArea(ring) {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % n]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** Area-weighted centroid of a ring (vertex mean when the area is degenerate). */
export function ringCentroid(ring) {
  const A = ringArea(ring)
  if (Math.abs(A) < 1e-6) {
    let e = 0
    let n = 0
    for (const [x, y] of ring) {
      e += x
      n += y
    }
    return [e / ring.length, n / ring.length]
  }
  let cx = 0
  let cy = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % n]
    const w = x0 * y1 - x1 * y0
    cx += (x0 + x1) * w
    cy += (y0 + y1) * w
  }
  return [cx / (6 * A), cy / (6 * A)]
}

/** Proper crossing of segments p1–q1 and p2–q2 (shared endpoints and collinear overlap do not count). */
export function segmentsCross(p1, q1, p2, q2) {
  const d = (q1[0] - p1[0]) * (q2[1] - p2[1]) - (q1[1] - p1[1]) * (q2[0] - p2[0])
  if (Math.abs(d) < 1e-12) return false
  const t = ((p2[0] - p1[0]) * (q2[1] - p2[1]) - (p2[1] - p1[1]) * (q2[0] - p2[0])) / d
  const u = ((p2[0] - p1[0]) * (q1[1] - p1[1]) - (p2[1] - p1[1]) * (q1[0] - p1[0])) / d
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
}

/** Number of proper self-crossings of a ring (0 for a simple polygon). O(n²). */
export function ringCrossings(ring) {
  const n = ring.length
  let crossings = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) crossings++
    }
  }
  return crossings
}

/** Sutherland–Hodgman clip of a ring against the axis-aligned window [e0, n0, e1, n1]. */
export function clipRing(ring, [e0, n0, e1, n1]) {
  const edges = [
    [(p) => p[0] >= e0, (a, b) => lerpAt(a, b, 0, e0)],
    [(p) => p[0] <= e1, (a, b) => lerpAt(a, b, 0, e1)],
    [(p) => p[1] >= n0, (a, b) => lerpAt(a, b, 1, n0)],
    [(p) => p[1] <= n1, (a, b) => lerpAt(a, b, 1, n1)],
  ]
  let out = ring
  for (const [inside, cross] of edges) {
    const inp = out
    out = []
    if (!inp.length) break
    let prev = inp[inp.length - 1]
    let prevIn = inside(prev)
    for (const cur of inp) {
      const curIn = inside(cur)
      if (curIn) {
        if (!prevIn) out.push(cross(prev, cur))
        out.push(cur)
      } else if (prevIn) out.push(cross(prev, cur))
      prev = cur
      prevIn = curIn
    }
  }
  // drop consecutive duplicates the clipping leaves behind
  const dedup = []
  for (const p of out) {
    const q = dedup[dedup.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) dedup.push(p)
  }
  if (dedup.length > 1) {
    const a = dedup[0]
    const b = dedup[dedup.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6) dedup.pop()
  }
  return dedup
}

function lerpAt(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis])
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  p[axis] = v
  return p
}

/** Cut an open polyline at the window: returns the pieces that lie inside (each ≥ 2 vertices). */
export function clipLine(pts, [e0, n0, e1, n1]) {
  const pieces = []
  let cur = []
  const inside = (p) => p[0] >= e0 && p[0] <= e1 && p[1] >= n0 && p[1] <= n1
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur)
    cur = []
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    // Liang–Barsky parameters of the visible part of a–b
    let t0 = 0
    let t1 = 1
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    let ok = true
    for (const [p, q] of [[-dx, a[0] - e0], [dx, e1 - a[0]], [-dy, a[1] - n0], [dy, n1 - a[1]]]) {
      if (p === 0) {
        if (q < 0) ok = false
        continue
      }
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
    }
    if (!ok || t0 > t1) {
      flush()
      continue
    }
    const pa = t0 === 0 ? a : [a[0] + dx * t0, a[1] + dy * t0]
    const pb = t1 === 1 ? b : [a[0] + dx * t1, a[1] + dy * t1]
    if (!cur.length || !inside(a) || t0 > 0) {
      flush()
      cur.push(pa)
    }
    cur.push(pb)
    if (t1 < 1) flush()
  }
  flush()
  return pieces
}

/** Insert midpoints so no segment is longer than `maxLen` (an int16 delta ceiling in dm). */
export function splitLongSegments(pts, maxLen, closed) {
  const out = []
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    out.push(a)
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const k = Math.ceil(len / maxLen)
    for (let j = 1; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
  }
  if (!closed) out.push(pts[n - 1])
  return out
}

// ---------------------------------------------------------------- int16-delta base64
/**
 * base64 of a little-endian Int16Array of deltas: value[i] = value[i − stride] + delta[i],
 * value[i − stride] = 0 for i < stride. Throws when a delta does not fit int16 — the caller
 * must pick units / split geometry so it does (build-surroundings.mjs splits long segments).
 */
export function encodeI16Delta(values, stride = 1) {
  const n = values.length
  const deltas = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (!Number.isInteger(v)) throw new Error(`encodeI16Delta: value[${i}] = ${v} is not an integer`)
    const prev = i >= stride ? values[i - stride] : 0
    const d = v - prev
    if (d < -32768 || d > 32767) throw new Error(`encodeI16Delta: delta[${i}] = ${d} does not fit int16`)
    deltas[i] = d
  }
  const bytes = new Uint8Array(n * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < n; i++) view.setInt16(i * 2, deltas[i], true)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

// ---------------------------------------------------------------- emit helpers
/** single-quoted TS string literal */
export const q = (v) => '\'' + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\''

/** `{ key: 'value', 'odd:key': 'value' }` for a tag subset */
export function tagsLiteral(tags) {
  const parts = Object.entries(tags).map(([k, v]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : q(k)}: ${q(v)}`)
  return '{' + parts.join(', ') + '}'
}

/**
 * The ODbL attribution block every OSM-derived data file carries — the same wording as
 * suzuka-facilities.ts, with the generator command, the extract timestamp and the query.
 */
export function odblHeader({ title, command, extractDate, query, notes }) {
  return `/**
 * ${title}
 *
 * GENERATED FILE — do not edit by hand. Regenerate with
 *   ${command}
 *
 * Data © OpenStreetMap contributors, licensed under the Open Data Commons Open Database
 * License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/. This file is a
 * derived database of OpenStreetMap data (footprints projected and re-expressed in track
 * coordinates) and is shared under the same licence. Attribution in the app: "Footprints
 * derived from OpenStreetMap data © OpenStreetMap contributors, ODbL 1.0".
 *
 * Extract: Overpass API, OSM base timestamp ${extractDate}
 * Query:
${query.split('\n').map((l) => ' *   ' + l).join('\n')}
 *
${notes.split('\n').map((l) => (l ? ' * ' + l : ' *')).join('\n')}
 */
`
}
