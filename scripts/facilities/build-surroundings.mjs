#!/usr/bin/env node
/**
 * Regenerates app/data/suzuka-surroundings.ts from OpenStreetMap: the land use, water, roads,
 * rail, parking, solar farms, buildings and named site outlines of the ~6.6 × 5.8 km around the
 * circuit that the DEM terrain (inner grid + ring) covers — plan "柵の外" §1d.
 *
 *   node scripts/facilities/build-surroundings.mjs            # query Overpass, write the file
 *   node scripts/facilities/build-surroundings.mjs --offline  # reuse .cache/overpass/surroundings.json
 *   node scripts/facilities/build-surroundings.mjs --dry-run  # print the report, do not write
 *
 * Pipeline: lon/lat → local EN metres (the CENTERLINE_EN frame, see osm-common.mjs) → clip to
 * SUR_RECT (Sutherland–Hodgman for polygons, segment cutting for polylines) → Douglas–Peucker
 * per layer → 0.1 m grid → int16-delta base64 (decimetres, per-feature origin) → track
 * coordinates (s / dmin) via the app's own Track. Hand-authored widths, tolerances and the
 * building-kind thresholds come from app/data/surroundings-spec.ts so the data cannot drift
 * from the rules; the ODbL header is the same text suzuka-facilities.ts carries.
 */
import '../ts-hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fetchOverpass, trackMapper, wayToEN, simplifyLine, simplifyRing, ringArea, ringCentroid, ringCrossings,
  clipRing, clipLine, splitLongSegments, encodeI16Delta, round1, tagsLiteral, odblHeader,
} from './osm-common.mjs'

const { Track } = await import('../../app/sim/track.ts')
const spec = await import('../../app/data/surroundings-spec.ts')
const codec = await import('../../app/data/en-codec.ts')
const facilities = await import('../../app/data/suzuka-facilities.ts')
const facSpec = await import('../../app/data/suzuka-facilities-spec.ts')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'app/data/suzuka-surroundings.ts')
const CACHE = path.join(ROOT, '.cache/overpass/surroundings.json')
const args = process.argv.slice(2)
const OFFLINE = args.includes('--offline')
const DRY = args.includes('--dry-run')
const LIMIT = 900 * 1024 // bytes — leaves the DEM file room under the 1 MB combined cap (facilities-check §11)

// ---------------------------------------------------------------- Overpass
const BBOX = '34.816,136.497,34.874,136.569'
// The way clauses of scratchpad overpass-wide.ql (its node clauses — power towers, point
// attractions, point parking — are not footprints and are left out) plus the site / land-use
// keys this extract needs. Nothing here duplicates build-power.mjs' power=line pull on purpose:
// only the solar plants / generators are read from the power keys.
const CLAUSES = [
  'way[natural=wood]', 'way[landuse=forest]', 'way[landuse=farmland]', 'way[landuse=residential]',
  'way[landuse=industrial]', 'way[landuse=commercial]', 'way[landuse=grass]', 'way[landuse=meadow]',
  'way[amenity=parking]', 'way[natural=water]', 'way[landuse=reservoir]', 'way[water]',
  'way[waterway=river]', 'way[waterway=stream]',
  'way[highway~"^(motorway|trunk|trunk_link|primary|secondary|tertiary|unclassified|residential|service|living_street|track)$"]',
  'way[highway=raceway]', 'way[building]', 'way[power=generator]', 'way[power=plant]',
  'way[attraction]', 'way[leisure]', 'way[railway=rail]', 'way[bridge]', 'way[tunnel]',
  'way[tourism~"^(theme_park|camp_site|hotel)$"]',
  'way[landuse~"^(greenhouse_horticulture|construction|brownfield|scrub)$"]', 'way[natural=scrub]',
]
const QUERY = `[out:json][timeout:180];\n(\n${CLAUSES.map((c) => `  ${c}(${BBOX});`).join('\n')}\n);\nout body geom;`

// ---------------------------------------------------------------- frame
const track = new Track()
const scale = track.enScale
const toTrack = trackMapper(track)
const L = track.length
// the DEM terrain rectangle: the 3400 × 2600 m inner grid ± the ring (1313 m) ± a 300 m margin,
// centred on track.center — world metres → EN by ÷ enScale, n = −z
const HALF_W = 1700 + 1313 + 300
const HALF_D = 1300 + 1313 + 300
const CE = track.center.x / scale
const CN = -track.center.z / scale
const RECT = [round1(CE - HALF_W / scale), round1(CN - HALF_D / scale), round1(CE + HALF_W / scale), round1(CN + HALF_D / scale)]

// ---------------------------------------------------------------- roles
/** ids owned by suzuka-facilities.ts / the facilities spec — never re-shipped as SUR_BUILDINGS */
const OWNED = new Set([
  ...Object.values(facilities.OSM_STAND_WAYS).flat(),
  facilities.OSM_PIT_BUILDING.id,
  facilities.OSM_FERRIS_WHEEL.id,
  facilities.OSM_LEADER_TOWER?.id,
  ...facSpec.BUILDINGS.map((b) => b.osmWay),
].filter((id) => typeof id === 'number'))

/** SUR_SITES by id — every one must be in the response with the expected tag (else exit 1) */
const SITE_WAYS = [
  { id: 775428456, role: 'circuit', key: 'leisure', value: 'sports_centre' },
  { id: 466005760, role: 'gate', key: 'building' }, // メインゲート (building=roof)
  { id: 466560666, role: 'gate', key: 'building' }, // 南ゲート
  { id: 466005785, role: 'gate', key: 'building' }, // ホテルゲート
  { id: 465595105, role: 'gate', key: 'building' }, // パーキングゲート
  { id: 465643274, role: 'pool', key: 'leisure', value: 'swimming_pool' },
  { id: 466312163, role: 'pool', key: 'leisure', value: 'swimming_pool' },
  { id: 308691933, role: 'coaster_station', key: 'building' }, // ロッキーコースター station
  { id: 466355451, role: 'coaster', key: 'highway', value: 'raceway' },
  { id: 659295251, role: 'coaster', key: 'highway', value: 'raceway' },
  { id: 659295252, role: 'coaster', key: 'highway', value: 'raceway' }, // layer=2
  { id: 659295253, role: 'coaster', key: 'highway', value: 'raceway' }, // layer=1
]
const SITE_BY_ID = new Map(SITE_WAYS.map((s) => [s.id, s]))
/** sites found by tag (Motopia, the family camp site) */
const SITE_BY_TAG = [
  { role: 'theme_park', key: 'tourism', value: 'theme_park' },
  { role: 'camp_site', key: 'tourism', value: 'camp_site' },
]

// tags worth shipping per layer; keys the row already expresses (highway → kind, lanes → width,
// waterway / railway → kind) are not repeated
const TAGS = {
  building: ['name', 'name:en', 'building', 'building:levels', 'height', 'roof:shape', 'roof:levels', 'roof:colour', 'amenity', 'shop', 'tourism', 'attraction', 'layer', 'man_made'],
  land: ['name', 'natural', 'landuse', 'leisure', 'water', 'amenity', 'power', 'plant:source', 'generator:source', 'parking'],
  road: ['name', 'bridge', 'layer', 'oneway'],
  stream: ['name', 'width'],
  rail: ['name', 'bridge', 'layer'],
  site: ['name', 'name:en', 'tourism', 'leisure', 'building', 'highway', 'layer', 'sport'],
}
const pick = (tags, keys) => {
  const out = {}
  for (const k of keys) if (tags?.[k] !== undefined) out[k] = tags[k]
  return out
}

// ---------------------------------------------------------------- geometry → feature
const MAX_SEG = 3000 // m — keeps every consecutive delta inside int16 at 0.1 m
const MAX_EXTENT = 6000 // m — keeps the first (origin-relative) delta inside int16
const warnings = []
const warn = (m) => warnings.push(m)
const dropped = { outsideRect: 0, tinyPolygons: 0, tunnelRoads: 0, tunnelStreams: 0, tunnelRail: 0, nearRaceway: 0, ownedBuildings: 0, notSimple: 0 }

/** rounded to the 0.1 m grid (integer decimetres), consecutive duplicates removed */
function toDm(pts, closed) {
  const out = []
  for (const [e, n] of pts) {
    const p = [Math.round(e * 10), Math.round(n * 10)]
    const q = out[out.length - 1]
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p)
  }
  if (closed && out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (a[0] === b[0] && a[1] === b[1]) out.pop()
  }
  return out
}

/** the common fields of a feature from its decimetre vertices; the whole-metre centroid is the stream origin */
function pack(dm, closed) {
  const m = dm.map(([e, n]) => [e / 10, n / 10])
  const c0 = closed ? ringCentroid(m) : m.reduce((a, p) => [a[0] + p[0] / m.length, a[1] + p[1] / m.length], [0, 0])
  const centroid = [Math.round(c0[0]), Math.round(c0[1])]
  const vals = new Array(dm.length * 2)
  for (let i = 0; i < dm.length; i++) {
    vals[i * 2] = dm[i][0] - centroid[0] * 10
    vals[i * 2 + 1] = dm[i][1] - centroid[1] * 10
  }
  const en = encodeI16Delta(vals, 2)
  // decode round-trip with the app's own decoder — the file is only as good as this
  const back = codec.decodeEN(en, centroid[0], centroid[1])
  for (let i = 0; i < dm.length; i++) {
    if (Math.abs(back[i * 2] * 10 - dm[i][0]) > 1e-6 || Math.abs(back[i * 2 + 1] * 10 - dm[i][1]) > 1e-6) throw new Error('codec round-trip mismatch')
  }
  let dmin = Infinity
  for (const [e, n] of m) {
    const d = toTrack(e * scale, -n * scale).d
    if (d < dmin) dmin = d
  }
  const c = toTrack(centroid[0] * scale, -centroid[1] * scale)
  return {
    en,
    n: dm.length,
    centroid,
    s: Math.round(c.s) % Math.round(L),
    dmin: Math.round(dmin),
    area: closed ? Math.round(Math.abs(ringArea(m))) : undefined,
  }
}

/** closed way → clipped, simplified, simple ring; null when nothing is left */
function polygon(el, tol, minArea) {
  const g = wayToEN(el)
  if (!g || !g.closed || g.en.length < 3) return null
  let ring = clipRing(g.en, RECT)
  if (ring.length < 3) {
    dropped.outsideRect++
    return null
  }
  if (ringArea(ring) < 0) ring.reverse()
  if (ringCrossings(ring) > 0) {
    warn(`way ${el.id}: outline self-intersects in OSM — dropped`)
    dropped.notSimple++
    return null
  }
  // simplify, backing off the tolerance when DP introduces a crossing
  let dm = null
  for (let t = tol; ; t /= 2) {
    const simp = t < 0.05 ? ring : simplifyRing(ring, t)
    const cand = toDm(splitLongSegments(simp, MAX_SEG, true), true)
    if (cand.length >= 3 && ringCrossings(cand) === 0) {
      dm = cand
      break
    }
    if (t < 0.05) {
      warn(`way ${el.id}: outline not simple after rounding — dropped`)
      dropped.notSimple++
      return null
    }
  }
  const area = Math.abs(ringArea(dm.map(([e, n]) => [e / 10, n / 10])))
  if (area < minArea) {
    dropped.tinyPolygons++
    return null
  }
  try {
    return pack(dm, true)
  } catch (e) {
    // a polygon wider than the int16 reach from its centroid (none expected inside SUR_RECT)
    warn(`way ${el.id}: ${e.message} — dropped`)
    return null
  }
}

/** way → clipped, simplified polyline pieces (closed ways become closed polylines) */
function polylines(el, tol) {
  const g = wayToEN(el)
  if (!g || g.en.length < 2) return []
  const pts = g.closed ? [...g.en, g.en[0]] : g.en
  const out = []
  const emit = (piece) => {
    const dm = toDm(splitLongSegments(simplifyLine(piece, tol), MAX_SEG, false), false)
    if (dm.length < 2) return
    const bw = Math.max(...dm.map((p) => p[0])) - Math.min(...dm.map((p) => p[0]))
    const bh = Math.max(...dm.map((p) => p[1])) - Math.min(...dm.map((p) => p[1]))
    // wider than the int16 reach from the centroid: halve at a vertex and try again
    if ((bw > MAX_EXTENT * 10 || bh > MAX_EXTENT * 10) && piece.length > 2) {
      const h = Math.floor(piece.length / 2)
      emit(piece.slice(0, h + 1))
      emit(piece.slice(h))
      return
    }
    try {
      out.push(pack(dm, false))
    } catch (e) {
      if (piece.length > 2) {
        const h = Math.floor(piece.length / 2)
        emit(piece.slice(0, h + 1))
        emit(piece.slice(h))
      } else warn(`way ${el.id}: ${e.message} — piece dropped`)
    }
  }
  const pieces = clipLine(pts, RECT)
  if (!pieces.length) dropped.outsideRect++
  for (const piece of pieces) emit(piece)
  return out
}

/** nearest distance of the raw way to the centreline (before clipping) */
function rawDmin(el) {
  let dmin = Infinity
  for (const g of el.geometry ?? []) {
    const [e, n] = wayToEN({ type: 'node', lon: g.lon, lat: g.lat }).en[0]
    const d = toTrack(e * scale, -n * scale).d
    if (d < dmin) dmin = d
  }
  return dmin
}

// ---------------------------------------------------------------- building kind (plan §2c)
const IN = (v, ...set) => v !== undefined && set.includes(v)
function pointInRing(e, n, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function buildingKind(el, area, centroid, industrialRings) {
  const t = el.tags ?? {}
  const override = spec.BUILDING_KIND_OVERRIDES[el.id]
  if (override) return override
  const b = t.building
  if (b === 'roof') return 'canopy'
  if (t.tourism === 'hotel' || b === 'hotel') return 'hotel'
  if (t.attraction || el.id === 308691933 || /コースター|ライド|ride/i.test(t.name ?? '')) return 'ride'
  if (IN(b, 'school', 'kindergarten', 'university', 'college') || IN(t.amenity, 'school', 'kindergarten', 'college', 'university')) return 'school'
  if (IN(b, 'temple', 'shrine', 'church') || t.amenity === 'place_of_worship' || t.religion) return 'temple'
  if (b === 'warehouse') return 'warehouse'
  if (IN(b, 'industrial', 'manufacture', 'factory') || t.man_made === 'storage_tank') return 'industrial'
  if (IN(b, 'retail', 'supermarket', 'kiosk', 'shop') || t.shop || IN(t.amenity, 'restaurant', 'fast_food', 'cafe', 'pharmacy', 'bank', 'fuel')) return 'retail'
  if (IN(b, 'commercial', 'office') || t.office) return 'commercial'
  if (IN(b, 'house', 'detached', 'residential', 'apartments', 'dormitory', 'terrace', 'semidetached_house', 'hut', 'garage', 'garages', 'shed')) return 'house'
  if (b === 'yes' && !t.name) {
    const { houseMaxArea, warehouseMinArea } = spec.BUILDING_KIND_RULES
    const inIndustrial = industrialRings.some((r) => pointInRing(centroid[0], centroid[1], r))
    if (inIndustrial) return area >= warehouseMinArea ? 'warehouse' : 'industrial'
    if (area <= houseMaxArea) return 'house'
    if (area >= warehouseMinArea) return 'warehouse'
  }
  return 'generic'
}

// ---------------------------------------------------------------- classify
const json = await fetchOverpass(QUERY, CACHE, { offline: OFFLINE })
const extractDate = json.osm3s?.timestamp_osm_base ?? new Date().toISOString()
const ways = []
const seen = new Set()
for (const el of json.elements) {
  if (el.type !== 'way' || seen.has(el.id)) continue
  seen.add(el.id)
  ways.push(el)
}
const byId = new Map(ways.map((w) => [w.id, w]))

// assert every SUR_SITES id is present with its expected tag before anything else is built
const missing = []
for (const s of SITE_WAYS) {
  const el = byId.get(s.id)
  const v = el?.tags?.[s.key]
  if (!el) missing.push(`way ${s.id} (${s.role}) is not in the Overpass response`)
  else if (v === undefined || (s.value !== undefined && v !== s.value)) missing.push(`way ${s.id} (${s.role}) lacks ${s.key}${s.value ? `=${s.value}` : ''} (has ${JSON.stringify(el.tags)})`)
}
for (const s of SITE_BY_TAG) {
  if (!ways.some((w) => w.tags?.[s.key] === s.value)) missing.push(`no way with ${s.key}=${s.value} (${s.role}) in the Overpass response`)
}
if (missing.length) {
  console.error(`build-surroundings: SUR_SITES assertions failed:\n  - ${missing.join('\n  - ')}`)
  process.exit(1)
}

const industrialRings = ways.filter((w) => w.tags?.landuse === 'industrial').map((w) => wayToEN(w)).filter((g) => g?.closed).map((g) => g.en)

const layers = {
  SUR_FOREST: [], SUR_FARMLAND: [], SUR_GRASS: [], SUR_SCRUB: [], SUR_BARE: [], SUR_WATER: [], SUR_STREAMS: [],
  SUR_PARKING: [], SUR_SOLAR: [], SUR_BUILDINGS: [], SUR_ROADS: [], SUR_RAIL: [], SUR_SITES: [],
}
const landLayer = (t) => {
  if (t.natural === 'wood' || t.landuse === 'forest') return 'SUR_FOREST'
  if (t.landuse === 'farmland') return 'SUR_FARMLAND'
  if (IN(t.landuse, 'grass', 'meadow') || IN(t.leisure, 'park', 'pitch', 'garden')) return 'SUR_GRASS'
  if (t.natural === 'scrub' || t.landuse === 'scrub') return 'SUR_SCRUB'
  if (IN(t.landuse, 'construction', 'brownfield', 'greenhouse_horticulture')) return 'SUR_BARE'
  if (t.natural === 'water' || t.landuse === 'reservoir' || t.water) return 'SUR_WATER'
  if (t.amenity === 'parking') return 'SUR_PARKING'
  if (IN(t.power, 'plant', 'generator') && (t['plant:source'] === 'solar' || t['generator:source'] === 'solar')) return 'SUR_SOLAR'
  return null
}
const DP_OF = { SUR_FOREST: 'forest', SUR_FARMLAND: 'farmland', SUR_GRASS: 'grass', SUR_SCRUB: 'scrub', SUR_BARE: 'bare', SUR_WATER: 'water', SUR_PARKING: 'parking', SUR_SOLAR: 'solar' }

const siteRoleOf = (el) => SITE_BY_ID.get(el.id)?.role ?? SITE_BY_TAG.find((s) => el.tags?.[s.key] === s.value)?.role ?? null

for (const el of ways) {
  const t = el.tags ?? {}
  const closedWay = wayToEN(el)?.closed ?? false

  // named sites (a way may also be a building / road below)
  const role = siteRoleOf(el)
  if (role) {
    const isLine = role === 'coaster'
    const tol = role === 'gate' || role === 'coaster_station' ? spec.SUR_DP.buildings : spec.SUR_DP.sites
    if (isLine) {
      for (const p of polylines(el, tol)) layers.SUR_SITES.push({ id: el.id, role, closed: false, tags: pick(t, TAGS.site), ...p })
    } else {
      const p = polygon(el, tol, 0)
      if (p) layers.SUR_SITES.push({ id: el.id, role, closed: true, tags: pick(t, TAGS.site), ...p })
      else warn(`site way ${el.id} (${role}) produced no polygon`)
    }
  }

  if (t.building && closedWay) {
    if (OWNED.has(el.id)) {
      dropped.ownedBuildings++
      continue
    }
    const p = polygon(el, spec.SUR_DP.buildings, spec.SUR_MIN_AREA.default)
    if (!p) continue
    layers.SUR_BUILDINGS.push({ id: el.id, kind: buildingKind(el, p.area, p.centroid, industrialRings), tags: pick(t, TAGS.building), ...p })
    continue
  }

  if (t.highway && !SITE_BY_ID.has(el.id)) {
    const width0 = spec.ROAD_WIDTH[t.highway]
    if (width0 === undefined || (closedWay && t.area === 'yes')) continue
    if (t.tunnel && t.tunnel !== 'no') {
      dropped.tunnelRoads++
      continue
    }
    if (t.highway === 'raceway' && rawDmin(el) < spec.RACEWAY_KEEP_OUT) {
      dropped.nearRaceway++
      continue
    }
    const lanes = parseInt(t.lanes, 10)
    const width = Number.isFinite(lanes) && lanes > 0 ? round1(lanes * spec.LANE_WIDTH + spec.LANE_EXTRA) : width0
    for (const p of polylines(el, spec.SUR_DP.roads)) layers.SUR_ROADS.push({ id: el.id, kind: t.highway, width, tags: pick(t, TAGS.road), ...p })
    continue
  }

  if (IN(t.waterway, 'river', 'stream')) {
    if (t.tunnel && t.tunnel !== 'no') {
      dropped.tunnelStreams++
      continue
    }
    for (const p of polylines(el, spec.SUR_DP.streams)) layers.SUR_STREAMS.push({ id: el.id, kind: t.waterway, width: spec.STREAM_WIDTH[t.waterway], tags: pick(t, TAGS.stream), ...p })
    continue
  }

  if (t.railway === 'rail') {
    if (t.tunnel && t.tunnel !== 'no') {
      dropped.tunnelRail++
      continue
    }
    for (const p of polylines(el, spec.SUR_DP.rail)) layers.SUR_RAIL.push({ id: el.id, kind: 'rail', width: spec.RAIL_WIDTH, tags: pick(t, TAGS.rail), ...p })
    continue
  }

  if (role) continue // theme park / camp site / pools are sites, not grass
  const layer = landLayer(t)
  if (!layer || !closedWay) continue
  const minArea = layer === 'SUR_FOREST' ? spec.SUR_MIN_AREA.forest : spec.SUR_MIN_AREA.default
  const p = polygon(el, spec.SUR_DP[DP_OF[layer]], minArea)
  if (!p) continue
  layers[layer].push({ id: el.id, tags: pick(t, TAGS.land), ...p })
}

for (const list of Object.values(layers)) list.sort((a, b) => a.id - b.id || a.centroid[0] - b.centroid[0])

// ---------------------------------------------------------------- emit
// one positional row per feature (the tuple shapes of en-codec.ts Sur*Row); the unpackers there
// turn them into the typed objects at module load
const ROW = {
  SurPolygon: (f) => [f.id, f.area, ...f.centroid, f.s, f.dmin, tagsLiteral(f.tags), `'${f.en}'`],
  SurBuilding: (f) => [f.id, `'${f.kind}'`, f.area, ...f.centroid, f.s, f.dmin, tagsLiteral(f.tags), `'${f.en}'`],
  SurWay: (f) => [f.id, `'${f.kind}'`, f.width, ...f.centroid, f.s, f.dmin, tagsLiteral(f.tags), `'${f.en}'`],
  SurSite: (f) => [f.id, `'${f.role}'`, f.closed ? 1 : 0, f.area ?? 0, ...f.centroid, f.s, f.dmin, tagsLiteral(f.tags), `'${f.en}'`],
}
const UNPACK = { SurPolygon: 'surPolygons', SurBuilding: 'surBuildings', SurWay: 'surWays', SurSite: 'surSites' }
const LAYER_TYPE = {
  SUR_FOREST: 'SurPolygon', SUR_FARMLAND: 'SurPolygon', SUR_GRASS: 'SurPolygon', SUR_SCRUB: 'SurPolygon', SUR_BARE: 'SurPolygon',
  SUR_WATER: 'SurPolygon', SUR_STREAMS: 'SurWay', SUR_PARKING: 'SurPolygon', SUR_SOLAR: 'SurPolygon', SUR_BUILDINGS: 'SurBuilding',
  SUR_ROADS: 'SurWay', SUR_RAIL: 'SurWay', SUR_SITES: 'SurSite',
}
const LAYER_DOC = {
  SUR_FOREST: 'natural=wood ∪ landuse=forest',
  SUR_FARMLAND: 'landuse=farmland (rice paddies; 30 × 90 m cells in the mask)',
  SUR_GRASS: 'landuse=grass|meadow, leisure=park|pitch|garden',
  SUR_SCRUB: 'natural=scrub / landuse=scrub',
  SUR_BARE: 'landuse=construction|brownfield|greenhouse_horticulture',
  SUR_WATER: 'natural=water, landuse=reservoir, water=* (ponds, reservoirs, basins)',
  SUR_STREAMS: 'waterway=river (10 m) / stream (3 m) polylines; culverted pieces dropped',
  SUR_PARKING: 'amenity=parking only (the camp site is in SUR_SITES)',
  SUR_SOLAR: 'power=plant|generator with *:source=solar',
  SUR_BUILDINGS: 'building=* outside the stands / pit building / spec-owned ids, with the generator\'s massing `kind`',
  SUR_ROADS: 'highway polylines with their drawn width (ROAD_WIDTH / lanes); tunnel pieces and raceway within RACEWAY_KEEP_OUT dropped',
  SUR_RAIL: 'railway=rail (伊勢鉄道), 4 m',
  SUR_SITES: 'circuit boundary, Motopia, the camp site, the four gates, the two pools, the coaster station and its track ways',
}

function renderLayer(name, list) {
  const type = LAYER_TYPE[name]
  const rows = list.map((f) => `  [${ROW[type](f).join(',')}],`).join('\n')
  return `/** ${LAYER_DOC[name]} */\nexport const ${name}: ${type}[] = ${UNPACK[type]}([\n${rows}\n])\n`
}

function render(layers) {
  const dp = Object.entries(spec.SUR_DP).map(([k, v]) => `${k} ${v}`).join(', ')
  const widths = Object.entries(spec.ROAD_WIDTH).map(([k, v]) => `${k} ${v}`).join(', ')
  const notes = `Rows: each feature is a positional tuple (see the Sur*Row types in ./en-codec) that the
unpackers turn into SurPolygon / SurBuilding / SurWay / SurSite objects at module load:
  polygon  [id, area m², ce, cn, s, dmin, tags, en]
  building [id, kind, area, ce, cn, s, dmin, tags, en]
  way      [id, kind, width m, ce, cn, s, dmin, tags, en]
  site     [id, role, closed 1|0, area, ce, cn, s, dmin, tags, en]
Frame: \`en\` is a base64 string of little-endian int16 DELTAS in DECIMETRES, interleaved e,n
and relative to the feature's centroid (ce, cn — EN whole metres, area-weighted for polygons,
the vertex mean for polylines) — decode with \`enRing(f)\` / \`enPairs(f)\` / \`enBBox(f)\` from
./en-codec (metres of the jp-1962 equirectangular projection, origin lat0 = 34.844581633720921,
lon0 = 136.53282038953489, R = 6378137, the CENTERLINE_EN frame; Track.enToWorld() (× enScale,
z = −N) places it in the scene). Polygons are counter-clockwise in EN with no repeated closing
vertex; polylines are open unless the way was a loop (then the first vertex is repeated at the
end). \`s\` / \`dmin\` come from the app's own Track (nearest segment of the sampled centreline,
world metres, whole); \`s\` is the centroid's. A polyline cut into pieces (SUR_RECT edge,
splitting) repeats its way id. Tags a row already expresses (highway → kind, lanes → width,
waterway / railway → kind) are not repeated in \`tags\`.

Extent: everything is clipped to SUR_RECT (the DEM terrain rectangle, track.center
± (${HALF_W}, ${HALF_D}) m in world metres = inner 3400 × 2600 grid + 1313 m ring + 300 m margin).
Douglas–Peucker per layer (m): ${dp}.
Polygons under ${spec.SUR_MIN_AREA.default} m² are dropped (forest ${spec.SUR_MIN_AREA.forest} m²). Road widths (m): ${widths};
with \`lanes\`: lanes × ${spec.LANE_WIDTH} + ${spec.LANE_EXTRA}. Tunnel pieces of roads / streams / rail are dropped
(they are underground), raceway ways within ${spec.RACEWAY_KEEP_OUT} m of the centreline are the circuit itself and
are dropped. Building \`kind\` follows plan §2c (surroundings-spec BUILDING_KIND_RULES).
Coordinates are on a 0.1 m grid. Size guard: ≤ ${LIMIT} bytes (facilities-check §11 caps this
file plus suzuka-dem.ts at 1 MB).`
  const header = odblHeader({
    title: 'Suzuka Circuit — the land use, water, roads, buildings and sites around the circuit, in the project\'s local frame.',
    command: 'node scripts/facilities/build-surroundings.mjs',
    extractDate,
    query: QUERY,
    notes,
  })
  const body = Object.entries(layers).map(([name, list]) => renderLayer(name, list)).join('\n')
  return `${header}import { surBuildings, surPolygons, surSites, surWays } from './en-codec'
import type { SurBuilding, SurPolygon, SurSite, SurWay } from './en-codec'

export const SUR_EXTRACT_DATE = '${extractDate}'

/** clip window [e0, n0, e1, n1] in EN metres — the DEM terrain rectangle (inner grid + ring + margin) */
export const SUR_RECT: [number, number, number, number] = [${RECT.join(', ')}]

${body}`
}

// ---------------------------------------------------------------- size guard
let text = render(layers)
const removed = []
const STEPS = [
  { what: 'farmland', pick: () => layers.SUR_FARMLAND, layer: 'SUR_FARMLAND' },
  { what: 'service/track roads beyond 1.5 km', pick: () => layers.SUR_ROADS.filter((r) => (r.kind === 'service' || r.kind === 'track') && r.dmin > 1500), layer: 'SUR_ROADS' },
  { what: 'water', pick: () => layers.SUR_WATER, layer: 'SUR_WATER' },
  { what: 'residential roads beyond 2 km', pick: () => layers.SUR_ROADS.filter((r) => r.kind === 'residential' && r.dmin > 2000), layer: 'SUR_ROADS' },
  { what: 'far buildings', pick: () => layers.SUR_BUILDINGS, layer: 'SUR_BUILDINGS' },
]
for (const step of STEPS) {
  if (text.length <= LIMIT) break
  const cands = step.pick().sort((a, b) => b.dmin - a.dmin)
  const total = cands.length
  let count = 0
  let nearest = Infinity
  while (text.length > LIMIT && cands.length) {
    const batch = cands.splice(0, 25)
    const set = new Set(batch)
    layers[step.layer] = layers[step.layer].filter((f) => !set.has(f))
    count += batch.length
    nearest = Math.min(nearest, ...batch.map((f) => f.dmin))
    text = render(layers)
  }
  if (count) removed.push(`${count} of ${total} ${step.what} (all with dmin ≥ ${nearest} m)`)
}
if (text.length > LIMIT) {
  console.error(`build-surroundings: ${text.length} bytes even after the drop order — over the ${LIMIT} byte guard`)
  process.exit(1)
}

// ---------------------------------------------------------------- report
console.log(`\nenScale ${scale.toFixed(8)}, SUR_RECT [${RECT.join(', ')}] (EN m), ${ways.length} ways in the extract (osm base ${extractDate})`)
console.log('\nlayer          count  vertices     KB')
let total = 0
let totalV = 0
for (const [name, list] of Object.entries(layers)) {
  const kb = renderLayer(name, list).length / 1024
  const v = list.reduce((a, f) => a + f.n, 0)
  total += list.length
  totalV += v
  console.log(`${name.padEnd(14)} ${String(list.length).padStart(5)}  ${String(v).padStart(8)}  ${kb.toFixed(1).padStart(6)}`)
}
console.log(`${'total'.padEnd(14)} ${String(total).padStart(5)}  ${String(totalV).padStart(8)}  ${(text.length / 1024).toFixed(1).padStart(6)}  (${text.length} bytes, guard ${LIMIT})`)

const kinds = {}
for (const b of layers.SUR_BUILDINGS) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1
console.log('\nbuilding kinds: ' + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '))
const roadKinds = {}
for (const r of layers.SUR_ROADS) roadKinds[r.kind] = (roadKinds[r.kind] ?? 0) + 1
console.log('road classes:   ' + Object.entries(roadKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '))
console.log('sites:          ' + layers.SUR_SITES.map((s) => `${s.role}:${s.id}`).join(', '))
console.log(`\nfiltered: ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}`)
console.log(removed.length ? `size guard dropped: ${removed.join('; ')}` : 'size guard: nothing dropped')
if (warnings.length) console.log(`\n${warnings.length} warning(s):\n  - ${warnings.join('\n  - ')}`)

if (!DRY) {
  fs.writeFileSync(OUT, text)
  console.log(`\nwrote ${path.relative(ROOT, OUT)} (${text.length} bytes)`)
}
