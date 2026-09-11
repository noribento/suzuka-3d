/**
 * Decoder for the packed integer arrays the generated data files ship (suzuka-surroundings.ts
 * today, the DEM grid alongside it): base64 of a little-endian Int16Array of DELTAS, with
 * value[i] = value[i − stride] + delta[i] and value[i − stride] = 0 for i < stride. `stride`
 * is 1 for a plain series (heights) and 2 for interleaved e,n vertex streams, where each axis
 * is its own running sum. The encoder (scripts/facilities/osm-common.mjs encodeI16Delta) asserts
 * every delta fits int16, so a decoded array never carries a wrapped value.
 *
 * Hand-written — not a generated file. Works in Node (Buffer) and the browser (atob).
 */

/** base64 → bytes, whichever runtime we are in */
function fromBase64(b64: string): Uint8Array {
  // Node's Buffer, reached through globalThis so the app's tsconfig needs no Node types
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: 'base64'): Uint8Array } }).Buffer
  if (nodeBuffer) {
    const buf = nodeBuffer.from(b64, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Decode an int16-delta base64 stream into absolute values. With `stride` > 1 the stream is
 * `stride` interleaved series (e.g. e,n,e,n …), each summed independently.
 */
export function decodeI16Delta(b64: string, stride = 1): Int32Array {
  const bytes = fromBase64(b64)
  if (bytes.byteLength % 2) throw new Error(`decodeI16Delta: odd byte length ${bytes.byteLength}`)
  const n = bytes.byteLength / 2
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const d = view.getInt16(i * 2, true)
    out[i] = (i >= stride ? out[i - stride]! : 0) + d
  }
  return out
}

/**
 * Decode an EN vertex stream: interleaved e,n deltas in DECIMETRES, relative to the feature's
 * origin (`oe`, `on` in metres — see `enOrigin`). Returns metres, interleaved [e0, n0, e1, n1, …].
 */
export function decodeEN(b64: string, oe = 0, on = 0): Float64Array {
  const dm = decodeI16Delta(b64, 2)
  const out = new Float64Array(dm.length)
  for (let i = 0; i < dm.length; i += 2) {
    out[i] = dm[i]! / 10 + oe
    out[i + 1] = dm[i + 1]! / 10 + on
  }
  return out
}

/**
 * The per-feature origin the vertex stream is relative to: the feature's centroid, which the
 * generator rounds to whole metres for exactly this purpose. Kept at the centre (not a corner)
 * so a feature up to ~6.5 km across still fits the ±3276.7 m reach of the first int16 delta;
 * the generator splits anything wider.
 */
export function enOrigin(f: SurFeatureBase): [number, number] {
  return f.centroid
}

/** Vertices of a feature in EN metres, interleaved [e, n, e, n, …] (length 2·n). */
export function enRing(f: SurFeatureBase): Float64Array {
  const [oe, on] = enOrigin(f)
  return decodeEN(f.en, oe, on)
}

/** Vertices of a feature as [e, n] pairs — the shape OsmFeature.en uses. */
export function enPairs(f: SurFeatureBase): [number, number][] {
  const v = enRing(f)
  const out: [number, number][] = new Array(v.length / 2)
  for (let i = 0; i < v.length; i += 2) out[i / 2] = [v[i]!, v[i + 1]!]
  return out
}

/** Vertices in WORLD xz (× enScale, z = −N), interleaved [x, z, x, z, …], the way Track.enToWorld maps them. */
export function worldRing(f: SurFeatureBase, enScale: number): Float64Array {
  const v = enRing(f)
  for (let i = 0; i < v.length; i += 2) {
    v[i] = v[i]! * enScale
    v[i + 1] = -v[i + 1]! * enScale
  }
  return v
}

/** [e0, n0, e1, n1] of the decoded vertices, EN metres. */
export function enBBox(f: SurFeatureBase): [number, number, number, number] {
  const v = enRing(f)
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity
  for (let i = 0; i < v.length; i += 2) {
    const e = v[i]!, n = v[i + 1]!
    if (e < e0) e0 = e
    if (e > e1) e1 = e
    if (n < n0) n0 = n
    if (n > n1) n1 = n
  }
  return [e0, n0, e1, n1]
}

/** vertex count of a stream without decoding it: 4 bytes per vertex, 4 base64 chars per 3 bytes */
function vertexCount(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return ((b64.length / 4) * 3 - pad) / 4
}

// ---------------------------------------------------------------- feature types

export type SurTags = Record<string, string>

/** What every surroundings feature carries. */
export interface SurFeatureBase {
  /** OSM way id — a polyline cut into several pieces (rect / tunnel) repeats its id */
  id: number
  /** the tag subset worth shipping (name, the classifying key, levels / height / roof …); the key `kind` expresses (highway / waterway / railway) is not repeated */
  tags: SurTags
  /** vertex stream, see `decodeEN` / `enRing`; polygons are counter-clockwise in EN with no repeated closing vertex */
  en: string
  /** vertex count (en decodes to 2·n numbers) */
  n: number
  /** EN whole metres — area-weighted for polygons, the vertex mean for polylines; also the stream origin */
  centroid: [number, number]
  /** s along the lap (m) of the centroid's nearest centreline point — only meaningful near the track */
  s: number
  /** nearest distance of any vertex to the centreline (m, world metres, whole) */
  dmin: number
}

/** A land-use / water / parking / solar polygon. */
export interface SurPolygon extends SurFeatureBase {
  /** m² (shoelace in EN, whole) */
  area: number
}

/** A road / stream / rail polyline with its drawn width. */
export interface SurWay extends SurFeatureBase {
  /** highway class (`trunk` … `track`, `raceway`), `river` / `stream`, or `rail` */
  kind: string
  /**
   * m — roads: `roadSectionOf(kind, tags).paved` (surroundings-spec ROAD_SECTION applied to the
   * shipped `oneway` / `lanes` / `surface` / `width` tags, so the runtime can recompute the whole
   * section from the row); streams / rail: STREAM_WIDTH / RAIL_WIDTH
   */
  width: number
}

/** Massing family the generator assigns from the tags and the footprint (plan §2c); `greenhouse` is building=greenhouse (an arched sheet tunnel, not a walled mass). */
export type SurBuildingKind =
  | 'house' | 'industrial' | 'warehouse' | 'retail' | 'commercial' | 'hotel' | 'ride' | 'canopy' | 'school' | 'temple' | 'greenhouse' | 'generic'

export interface SurBuilding extends SurPolygon {
  kind: SurBuildingKind
}

export type SurSiteRole = 'circuit' | 'theme_park' | 'camp_site' | 'gate' | 'pool' | 'coaster_station' | 'coaster'

/** Named site outlines: the circuit boundary, Motopia, the camp site, the gates, pools and the coaster. */
export interface SurSite extends SurFeatureBase {
  role: SurSiteRole
  /** false for the coaster track ways (polylines) */
  closed: boolean
  /** m², polygons only */
  area?: number
}

// ---------------------------------------------------------------- packed rows
// The generated file stores each feature as a positional tuple (≈ 70 bytes less per feature
// than an object literal — over 4,000 features that is the difference between 900 KB and
// 600 KB) and hands the arrays through these unpackers, so the app only sees the typed objects.

/** [id, area, ce, cn, s, dmin, tags, en] */
export type SurPolygonRow = [number, number, number, number, number, number, SurTags, string]
/** [id, kind, area, ce, cn, s, dmin, tags, en] */
export type SurBuildingRow = [number, SurBuildingKind, number, number, number, number, number, SurTags, string]
/** [id, kind, width, ce, cn, s, dmin, tags, en] */
export type SurWayRow = [number, string, number, number, number, number, number, SurTags, string]
/** [id, role, closed (1 / 0), area (0 for polylines), ce, cn, s, dmin, tags, en] */
export type SurSiteRow = [number, SurSiteRole, 0 | 1, number, number, number, number, number, SurTags, string]

export function surPolygons(rows: SurPolygonRow[]): SurPolygon[] {
  return rows.map(([id, area, ce, cn, s, dmin, tags, en]) => ({ id, area, centroid: [ce, cn], s, dmin, tags, en, n: vertexCount(en) }))
}

export function surBuildings(rows: SurBuildingRow[]): SurBuilding[] {
  return rows.map(([id, kind, area, ce, cn, s, dmin, tags, en]) => ({ id, kind, area, centroid: [ce, cn], s, dmin, tags, en, n: vertexCount(en) }))
}

export function surWays(rows: SurWayRow[]): SurWay[] {
  return rows.map(([id, kind, width, ce, cn, s, dmin, tags, en]) => ({ id, kind, width, centroid: [ce, cn], s, dmin, tags, en, n: vertexCount(en) }))
}

export function surSites(rows: SurSiteRow[]): SurSite[] {
  return rows.map(([id, role, closed, area, ce, cn, s, dmin, tags, en]) => {
    const f: SurSite = { id, role, closed: closed === 1, centroid: [ce, cn], s, dmin, tags, en, n: vertexCount(en) }
    if (closed === 1) f.area = area
    return f
  })
}
