#!/usr/bin/env node
/**
 * Regenerates app/data/suzuka-facilities.ts from OpenStreetMap.
 *
 *   node scripts/facilities/build-facilities.mjs            # query Overpass, write the file
 *   node scripts/facilities/build-facilities.mjs --offline  # reuse the cached Overpass response
 *   node scripts/facilities/build-facilities.mjs --dry-run  # print the summary, do not write
 *   node scripts/facilities/build-facilities.mjs --add-ways 175231859,34096664
 *       # fetch just those ways (`way(id:…)`) and INSERT them into the existing OSM_FEATURES array
 *       # with role 'road', touching no other feature and not the header's base timestamp (an
 *       # `additions:` header line records the date and ids). For the tunnel / bridge roads the
 *       # bbox query does not select (UNDERPASSES in suzuka-facilities-spec.ts); EXTRA_WAYS keeps
 *       # them across a full regeneration.
 *   node scripts/facilities/build-facilities.mjs --add-ways-from .cache/overpass/surroundings.json \
 *       --role "apron:467386920,467913438;parking:469079400;tunnel:184101996;footbridge:184103165"
 *       # the same incremental splice, but the ways are read by id from a cached Overpass
 *       # response (`out body geom`, e.g. build-surroundings' cache) — no network — and each gets
 *       # the role named in front of its id list. This is how the paddock service aprons, the
 *       # car parks and the pedestrian tunnels / bridges inside the fence got in (SPLICED_WAYS
 *       # keeps them across a full regeneration). `--role` also works with `--add-ways`.
 *
 * Caches live in .cache/overpass/ (gitignored): facilities.json for the full query,
 * facilities-ways-<ids>.json for --add-ways.
 *
 * Pipeline (the same one the research reports used, so the numbers agree with them):
 *   lon/lat → local EN metres (equirectangular, origin = mean of the 172 jp-1962 GeoJSON
 *   vertices, R = 6378137) → world (× Track.enScale, z = −N) → track coordinates by the
 *   nearest segment of the app's own sampled centreline (s along the lap, signed lateral,
 *   +left). Everything within 130 m of the centreline is kept, plus named buildings and
 *   attractions further out (the Motopia skyline behind the main grandstand).
 *
 * The output is a derived database of OpenStreetMap data and is therefore ODbL 1.0; the
 * header it writes carries the attribution. Hand-authored dimensions live in
 * app/data/suzuka-facilities-spec.ts instead, so they are not mixed into the ODbL file.
 */
import '../ts-hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Track } = await import('../../app/sim/track.ts')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'app/data/suzuka-facilities.ts')
const CACHE_DIR = path.join(ROOT, '.cache/overpass')
const CACHE = path.join(CACHE_DIR, 'facilities.json')
const args = process.argv.slice(2)
const OFFLINE = args.includes('--offline')
const DRY = args.includes('--dry-run')
const argAfter = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? '') : null
}
const parseIds = (text) => text.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
/** `--add-ways <id,…>`: incremental mode (see the header) */
const ADD_WAYS = args.includes('--add-ways') ? parseIds(argAfter('--add-ways')) : null
if (ADD_WAYS && !ADD_WAYS.length) {
  console.error('--add-ways needs a comma-separated list of OSM way ids')
  process.exit(2)
}
/** `--add-ways-from <json>`: the same splice, elements read from a cached Overpass response */
const ADD_FROM = argAfter('--add-ways-from')
if (ADD_FROM !== null && !fs.existsSync(ADD_FROM)) {
  console.error(`--add-ways-from: ${ADD_FROM} does not exist`)
  process.exit(2)
}
/**
 * `--role <role>:<id,…>[;<role>:<id,…>]` — the role each spliced way gets (required with
 * --add-ways-from, optional with --add-ways where it defaults to 'road').
 */
const ROLE_ARG = argAfter('--role')
const ROLE_BY_ID = new Map()
if (ROLE_ARG !== null) {
  for (const part of ROLE_ARG.split(';')) {
    const [role, list] = part.split(':')
    const ids = parseIds(list ?? '')
    if (!role?.trim() || !ids.length) {
      console.error(`--role: cannot parse "${part}" (expected <role>:<id,…>)`)
      process.exit(2)
    }
    for (const id of ids) ROLE_BY_ID.set(id, role.trim())
  }
}
if (ADD_FROM !== null && !ROLE_BY_ID.size) {
  console.error('--add-ways-from needs --role "<role>:<id,…>[;<role>:<id,…>]"')
  process.exit(2)
}
/**
 * Ways outside the bbox query's tag filter that the data still needs: the roads that pass under
 * the lap (tunnel=yes) and the chicane service bridge (UNDERPASSES). Fetched with the full query
 * so a regeneration keeps them; `--add-ways` inserts them without regenerating.
 */
const EXTRA_WAYS = [175231859, 34096664, 411291884, 467219905, 183309812, 34096665]
/**
 * Ways inside the fence that the tag filter does not select either, spliced in from the cached
 * surroundings response with `--add-ways-from … --role …` (2026-09-11) and kept by id across a
 * full regeneration. roleOf() classifies them the same way the --role argument did:
 *   apron      highway=service + area=yes — the paddock / pit-exit / chicane hard-standings
 *   parking    amenity=parking — the paddock and west / south course car parks
 *   tunnel     highway=footway|service + tunnel=yes — the pedestrian and service tunnels under the lap
 *   footbridge highway=footway + bridge=yes — the three footbridges over the county-road cutting behind Q2
 */
const SPLICED_WAYS = {
  apron: [467386920, 467913438, 467945733, 184253118, 467417584, 467223464, 474099240, 469065002, 469451642, 469451657, 469657637, 468377672, 467572919, 467572920, 468377676, 468750061, 469010265],
  parking: [469079400, 469896634, 184423997, 474537492, 184415332, 184415335, 469650858, 469896636, 184429450, 183953784, 184410563],
  tunnel: [184101996, 184105032, 183969196, 184417647, 467945734, 469010267, 941604835],
  footbridge: [184103165, 184103564, 184103565],
}
const SPLICED_IDS = Object.values(SPLICED_WAYS).flat()

// ---------------------------------------------------------------- projection
// Exact inverse of the projection CENTERLINE_EN was made with (max error ≤ 0.005 m; see the
// research report §1). The origin is the arithmetic mean of ALL 172 GeoJSON coordinates,
// i.e. the duplicated closing vertex counts twice — using the 171 unique ones is 4 m off.
const LAT0 = 34.844581633720921
const LON0 = 136.53282038953489
const R = 6378137
const D = Math.PI / 180
const KX = Math.cos(LAT0 * D) * R * D
const KY = R * D
const toLocal = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY]

// ---------------------------------------------------------------- Overpass
const BBOX = '34.830,136.512,34.858,136.552'
const QUERY = `[out:json][timeout:180];
(
  way[grandstand](${BBOX});
  way[leisure=bleachers](${BBOX});
  way[amenity=grandstand](${BBOX});
  way[building](${BBOX});
  way[natural=sand](${BBOX});
  way[landuse=grass](${BBOX});
  way[landuse=basin](${BBOX});
  way[natural=water](${BBOX});
  way[barrier](${BBOX});
  way[highway=raceway](${BBOX});
  way[tourism=attraction](${BBOX});
  way[man_made](${BBOX});
  way[name~"サーキット"](${BBOX});
  node[name~"サーキット"](${BBOX});
  way(id:${EXTRA_WAYS.join(',')});
  way(id:${SPLICED_IDS.join(',')});
);
out body geom;`
/** the incremental query: just the listed ways */
const waysQuery = (ids) => `[out:json][timeout:60];\nway(id:${ids.join(',')});\nout body geom;`
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
const USER_AGENT = 'suzuka3d-facilities/1.0 (bhyg756@gmail.com)'

async function fetchOverpass(query = QUERY, cache = CACHE) {
  if (OFFLINE && fs.existsSync(cache)) {
    console.log(`using cached Overpass response ${cache}`)
    return JSON.parse(fs.readFileSync(cache, 'utf8'))
  }
  let lastErr = null
  for (const url of ENDPOINTS) {
    try {
      console.log(`querying ${url} …`)
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
      console.log(`  ${json.elements.length} elements (osm base ${json.osm3s?.timestamp_osm_base})`)
      return json
    } catch (e) {
      lastErr = e
      console.warn(`  failed: ${e.message}`)
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------- track coordinates
const track = new Track()
const L = track.length
const N = track.n
const DS = track.ds
const { px, pz, nx, nz } = track
const scale = track.enScale

/** Nearest point on the sampled centreline: s, signed lateral (+left) and the distance. */
function toTrack(X, Z) {
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

/**
 * Smallest arc of the lap that contains every sample s: sort, find the largest gap
 * (including the one across the start line) and take its complement. `fold` is set when
 * that arc is longer than half a lap — the feature sits in the figure-8 fold and the
 * nearest-segment mapping flips between the two legs, so only EN / centroid are reliable.
 */
function sRange(ss) {
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

// ---------------------------------------------------------------- roles
const STAND_WAYS = {
  V1: [184107052],
  V2: [183394522],
  VIP: [183394524],
  A1: [184120096],
  B2: [184143132],
  B1: [184143131],
  C: [184143133],
  D5: [469395390],
  D1_4: [469368057],
  E2: [467982372], // E-2 and E-1 share the one OSM outline (split by the spec)
  E1: [467982372],
  G_cross: [184102012, 184102013],
  H: [184004012], // UNVERIFIED: unnamed in OSM, identified as H (110R) from the ticket map
  I: [184105033],
  IJ: [183999779], // UNVERIFIED: unnamed bar between I and J
  J: [183999763],
  L: [184104828],
  M: [183953761],
  N: [183953758],
  O: [184415310],
  G_130R: [184102361, 184102368],
  P: [184419745],
  Q2: [183393102, 183393101, 183393103],
  Q1: [183393132],
  R: [183393129],
  S: [183394069],
}
const PIT_BUILDING_ID = 184422099
const FERRIS_WHEEL_ID = 184107083
const LEADER_TOWER_ID = 469636517
const STAND_ID_BY_WAY = new Map()
for (const [stand, ways] of Object.entries(STAND_WAYS)) for (const w of ways) STAND_ID_BY_WAY.set(w, stand)

function roleOf(el) {
  const t = el.tags ?? {}
  if (el.id === PIT_BUILDING_ID) return 'pit_building'
  if (el.id === FERRIS_WHEEL_ID) return 'ferris_wheel'
  if (el.id === LEADER_TOWER_ID) return 'leader_tower'
  if (STAND_ID_BY_WAY.has(el.id) || t.grandstand || t.leisure === 'bleachers' || t.amenity === 'grandstand') return 'stand'
  if (t.barrier === 'wall' && (/タイヤ/.test(t.name ?? '') || /tire|tyre/i.test(t['name:en'] ?? ''))) return 'tyre_barrier'
  if (t.barrier === 'wall' || t.barrier === 'retaining_wall' || t.barrier === 'guard_rail') return 'wall'
  if (t.barrier === 'fence') return 'fence'
  if (t.barrier) return 'barrier'
  if (t.highway === 'raceway') return 'raceway'
  // SPLICED_WAYS: the hard-standings, car parks, pedestrian tunnels and footbridges inside the fence
  if (t.highway === 'service' && t.area === 'yes') return 'apron'
  if (t.amenity === 'parking') return 'parking'
  if ((t.highway === 'footway' || t.highway === 'service') && t.tunnel) return 'tunnel'
  if (t.highway === 'footway' && t.bridge) return 'footbridge'
  // the tunnel / bridge roads of EXTRA_WAYS (the bbox query selects no other highway)
  if (t.highway) return 'road'
  if (t.natural === 'sand') return 'sand'
  if (t.landuse === 'grass') return 'grass'
  if (t.landuse === 'basin') return 'basin'
  if (t.natural === 'water') return 'water'
  if (t.building) return 'building'
  if (t.tourism === 'attraction') return 'attraction'
  if (t.man_made) return 'man_made'
  return 'named'
}

// tags worth shipping — the rest (addr:*, source, wikidata …) only inflate the bundle
const TAG_KEYS = [
  'name', 'name:en', 'grandstand', 'leisure', 'amenity', 'building', 'building:levels', 'height',
  'natural', 'landuse', 'water', 'barrier', 'highway', 'tourism', 'attraction', 'man_made', 'area',
  'tunnel', 'bridge', 'layer', 'covered', 'surface', 'sport', 'shop', 'office',
  'parking', 'service', 'oneway', 'raceway:corner_number',
]

// ---------------------------------------------------------------- convert
const NEAR = 130 // m from the centreline
const NEAR_NAMED = 700 // named buildings / attractions (Motopia skyline) are kept further out
const round1 = (v) => Math.round(v * 10) / 10

function convert(el) {
  const geom = el.type === 'node' ? [{ lon: el.lon, lat: el.lat }] : el.geometry
  if (!geom || geom.length === 0) return null
  let en = geom.map((g) => toLocal(g.lon, g.lat))
  const closed = en.length > 2 && Math.hypot(en[0][0] - en[en.length - 1][0], en[0][1] - en[en.length - 1][1]) < 1e-6
  if (closed) en = en.slice(0, -1)
  const tr = en.map(([e, n]) => toTrack(e * scale, -n * scale))
  const ss = tr.map((t) => t.s)
  const lats = tr.map((t) => t.lateral)
  const dmin = Math.min(...tr.map((t) => t.d))
  // polygon centroid (vertex mean is fine at these sizes) → track coordinates
  let ce = 0
  let cn = 0
  for (const [e, n] of en) {
    ce += e
    cn += n
  }
  ce /= en.length
  cn /= en.length
  const c = toTrack(ce * scale, -cn * scale)
  const { s, fold } = sRange(ss)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const side = minLat > 0 ? 1 : maxLat < 0 ? -1 : 0
  const tags = {}
  for (const k of TAG_KEYS) if (el.tags?.[k] !== undefined) tags[k] = el.tags[k]
  return {
    id: el.id,
    tags,
    en: en.map(([e, n]) => [round1(e), round1(n)]),
    s: [round1(s[0]), round1(s[1])],
    lateral: [round1(minLat), round1(maxLat)],
    side,
    role: roleOf(el),
    closed,
    centroid: [round1(c.s), round1(c.lateral)],
    dmin: round1(dmin),
    fold,
  }
}

// stable order: by role, then id
const ROLE_ORDER = ['stand', 'pit_building', 'leader_tower', 'ferris_wheel', 'building', 'attraction', 'man_made', 'named', 'raceway', 'road', 'apron', 'parking', 'tunnel', 'footbridge', 'sand', 'grass', 'basin', 'water', 'tyre_barrier', 'wall', 'fence', 'barrier']
/** the `export type OsmRole` union, 7 roles per line, from ROLE_ORDER (render and the splice both write it) */
const roleUnionText = () => {
  const lines = []
  for (let i = 0; i < ROLE_ORDER.length; i += 7) lines.push('  | ' + ROLE_ORDER.slice(i, i + 7).map((r) => `'${r}'`).join(' | '))
  return `export type OsmRole =\n${lines.join('\n')}`
}
/** the per-role convenience exports that follow OSM_RACEWAY, in this order */
const ROLE_EXPORTS = [['road', 'OSM_ROADS'], ['apron', 'OSM_APRONS'], ['parking', 'OSM_PARKING'], ['tunnel', 'OSM_TUNNELS'], ['footbridge', 'OSM_FOOTBRIDGES']]
/** the header note that explains where the roles the query's tag filters cannot select came from */
const SPLICED_NOTE = ` * Roles apron / parking / tunnel / footbridge are not selected by the query's tag filters: their
 * ways are listed by id (SPLICED_WAYS in build-facilities.mjs, way(id:…) in a regeneration) and were
 * first spliced offline from the cached surroundings response with --add-ways-from --role.`

// ---------------------------------------------------------------- emit
const bytes = (text) => Buffer.byteLength(text, 'utf8')
const q = (v) => '\'' + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\''

function featureLine(f) {
  const en = '[' + f.en.map(([e, n]) => `[${e},${n}]`).join(',') + ']'
  const tags = '{' + Object.entries(f.tags).map(([k, v]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : q(k)}: ${q(v)}`).join(', ') + '}'
  const extra = f.fold ? ', fold: true' : ''
  return `  { id: ${f.id}, role: '${f.role}', side: ${f.side}, s: [${f.s[0]}, ${f.s[1]}], lateral: [${f.lateral[0]}, ${f.lateral[1]}], centroid: [${f.centroid[0]}, ${f.centroid[1]}], dmin: ${f.dmin}, closed: ${f.closed}${extra}, tags: ${tags}, en: ${en} },`
}

// ---------------------------------------------------------------- --add-ways / --add-ways-from: incremental insert
if (ADD_WAYS || ADD_FROM !== null) {
  /** the ids to splice and the role each one gets ('road' unless --role says otherwise) */
  const wanted = ADD_WAYS ?? [...ROLE_BY_ID.keys()]
  const roleFor = (id) => ROLE_BY_ID.get(id) ?? 'road'
  for (const id of wanted) {
    if (!ROLE_ORDER.includes(roleFor(id))) {
      console.error(`--role: unknown role '${roleFor(id)}' for way ${id} (roles: ${ROLE_ORDER.join(', ')})`)
      process.exit(2)
    }
  }
  let json
  let source
  if (ADD_FROM !== null) {
    json = JSON.parse(fs.readFileSync(ADD_FROM, 'utf8'))
    if (!Array.isArray(json.elements)) throw new Error(`${ADD_FROM}: no elements array`)
    source = `--add-ways-from ${path.relative(ROOT, path.resolve(ADD_FROM))}`
    console.log(`reading ${json.elements.length} cached elements from ${ADD_FROM} (osm base ${json.osm3s?.timestamp_osm_base})`)
  } else {
    json = await fetchOverpass(waysQuery(wanted), path.join(CACHE_DIR, `facilities-ways-${wanted.join('-')}.json`))
    source = '--add-ways'
  }
  const base = json.osm3s?.timestamp_osm_base ?? new Date().toISOString()
  const date = base.slice(0, 10)
  const added = []
  for (const el of json.elements) {
    if (el.type !== 'way' || !wanted.includes(el.id)) continue
    if (!el.geometry) {
      console.warn(`way ${el.id}: no geometry in the response (needs "out body geom"), skipped`)
      continue
    }
    const f = convert(el)
    if (!f) continue
    const role = roleFor(el.id)
    if (f.role !== role) console.warn(`way ${el.id}: roleOf() says '${f.role}', --role says '${role}' (${JSON.stringify(el.tags ?? {})})`)
    f.role = role
    added.push(f)
  }
  const missing = wanted.filter((id) => !added.some((f) => f.id === id))
  if (missing.length) console.warn(`ways not in the ${ADD_FROM !== null ? 'cache' : 'Overpass response'}: ${missing.join(', ')}`)
  if (!added.length) {
    console.error('nothing to insert')
    process.exit(1)
  }
  added.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.id - b.id)
  for (const f of added) console.log(`${f.role.padEnd(10)} ${String(f.id).padEnd(10)} s ${f.s[0]}→${f.s[1]} lateral ${f.lateral[0]}..${f.lateral[1]} centroid ${f.centroid} dmin ${f.dmin} ${f.en.length} verts${f.closed ? ' closed' : ''}${f.fold ? ' FOLD' : ''}  ${f.tags.name ?? ''} ${f.tags.tunnel ? 'tunnel' : ''}${f.tags.bridge ? 'bridge' : ''}`)

  // splice into the existing file: the array's lines between `OSM_FEATURES: OsmFeature[] = [` and its `]`
  const src = fs.readFileSync(OUT, 'utf8')
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.startsWith('export const OSM_FEATURES: OsmFeature[] = ['))
  const end = lines.indexOf(']', start + 1)
  if (start < 0 || end < 0) throw new Error(`${OUT}: OSM_FEATURES array not found`)
  const addedIds = new Set(added.map((f) => f.id))
  const idOf = (l) => Number(/^\s*\{ id: (\d+),/.exec(l)?.[1] ?? NaN)
  const roleOf2 = (l) => /role: '([a-z_]+)'/.exec(l)?.[1] ?? ''
  // re-adding an id replaces its line; everything else is kept verbatim
  const body = lines.slice(start + 1, end).filter((l) => !addedIds.has(idOf(l)))
  // insert each in the stable order (role, then id): after the last line that sorts before it
  const replaced = lines.slice(start + 1, end).length - body.length
  for (const f of added) {
    const ri = ROLE_ORDER.indexOf(f.role)
    let at = 0
    for (let i = 0; i < body.length; i++) {
      const r = roleOf2(body[i])
      const bi = ROLE_ORDER.indexOf(r)
      if (bi < ri || (bi === ri && idOf(body[i]) < f.id)) at = i + 1
    }
    body.splice(at, 0, featureLine(f))
  }
  const out = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)]
  let text = out.join('\n')
  // header: one additions line per role after the base timestamp (the timestamp itself is not touched)
  const byRoleAdded = new Map()
  for (const f of added) byRoleAdded.set(f.role, [...(byRoleAdded.get(f.role) ?? []), f.id])
  const addLines = [...byRoleAdded]
    .map(([role, ids]) => ` * additions: ${date} ways ${ids.join(', ')} (role '${role}', ${source}${ADD_FROM !== null ? `, OSM base ${base}` : ''})`)
    .filter((l) => !text.includes(l)) // an identical re-run does not repeat itself
  if (addLines.length) text = text.replace(/^( \* Extract: Overpass API, OSM base timestamp [^\n]*\n)/m, `$1${addLines.join('\n')}\n`)
  // the note on the cache-spliced roles, once, before the query
  if (!text.includes(SPLICED_NOTE) && added.some((f) => f.role in SPLICED_WAYS)) text = text.replace(/^ \* Query:\n/m, `${SPLICED_NOTE}\n * Query:\n`)
  // the OsmRole union (always rewritten from ROLE_ORDER) and the per-role exports, once each
  text = text.replace(/^export type OsmRole =\n(?:  \|[^\n]*\n)+/m, roleUnionText() + '\n')
  let after = "export const OSM_RACEWAY = byRole('raceway')"
  for (const [role, name] of ROLE_EXPORTS) {
    const line = `export const ${name} = byRole('${role}')`
    if (!text.includes(line)) text = text.replace(after + '\n', `${after}\n${line}\n`)
    after = line
  }
  if (!DRY) {
    fs.writeFileSync(OUT, text)
    console.log(`\ninserted ${added.length} way(s) into ${path.relative(ROOT, OUT)} (${replaced} replaced; ${bytes(src)} → ${bytes(text)} bytes)`)
  } else console.log(`\n(dry run) would insert ${added.length} way(s) (${replaced} replaced; ${bytes(src)} → ${bytes(text)} bytes)`)
  process.exit(0)
}

// ---------------------------------------------------------------- full regeneration
const json = await fetchOverpass()
const extractDate = json.osm3s?.timestamp_osm_base ?? new Date().toISOString()
const seen = new Set()
let features = []
for (const el of json.elements) {
  if (seen.has(`${el.type}/${el.id}`)) continue
  seen.add(`${el.type}/${el.id}`)
  const f = convert(el)
  if (!f) continue
  const named = !!f.tags.name
  const far = ['building', 'attraction', 'man_made', 'named'].includes(f.role)
  if (f.dmin <= NEAR || STAND_ID_BY_WAY.has(f.id) || f.role === 'pit_building' || f.role === 'ferris_wheel' || f.role === 'leader_tower' || EXTRA_WAYS.includes(f.id) || SPLICED_IDS.includes(f.id)) features.push(f)
  else if (named && far && f.dmin <= NEAR_NAMED) features.push(f)
}
features.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.id - b.id)

function render(list) {
  const standWays = Object.entries(STAND_WAYS)
    .map(([k, v]) => `  ${k}: [${v.join(', ')}],`)
    .join('\n')
  return `/**
 * Suzuka Circuit — real-world facility footprints in the project's local frame.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with
 *   node scripts/facilities/build-facilities.mjs
 *
 * Data © OpenStreetMap contributors, licensed under the Open Data Commons Open Database
 * License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/. This file is a
 * derived database of OpenStreetMap data (footprints projected and re-expressed in track
 * coordinates) and is shared under the same licence. Attribution in the app: "Footprints
 * derived from OpenStreetMap data © OpenStreetMap contributors, ODbL 1.0".
 *
 * Extract: Overpass API, OSM base timestamp ${extractDate}
${SPLICED_NOTE}
 * Query:
${QUERY.split('\n').map((l) => ' *   ' + l).join('\n')}
 *
 * Frame: \`en\` is local metres of the jp-1962 equirectangular projection (origin
 * lat0 = 34.844581633720921, lon0 = 136.53282038953489, R = 6378137), i.e. the same frame as
 * CENTERLINE_EN — use Track.enToWorld() (× enScale, z = −N) to place it in the scene.
 * \`s\`/\`lateral\` were derived with the app's own Track (nearest segment of the sampled
 * centreline, +lateral = left of the driving direction); \`s\` is [start, end] in driving
 * direction and end < start when the feature spans the start line. Features marked
 * \`fold\` lie in the figure-8 fold where the nearest-segment mapping flips between the two
 * legs — trust \`en\` and \`centroid\` for those, not the s range. Only features within
 * ${NEAR} m of the centreline are kept (named buildings/attractions within ${NEAR_NAMED} m).
 * Coordinates are rounded to 0.1 m. Closed ways have the duplicated closing vertex removed.
 */

${roleUnionText()}

export interface OsmFeature {
  /** OSM way id (node id for the few named point features) */
  id: number
  tags: Record<string, string>
  /** local EN metres, 0.1 m; a polygon when \`closed\`, else a polyline (barriers, raceway, tunnels, footbridges) */
  en: [number, number][]
  /** [start, end] along the lap in driving direction (m); end < start across the start line */
  s: [number, number]
  /** [min, max] signed lateral offset of the vertices (m, +left) */
  lateral: [number, number]
  /** 1 = entirely left of the centreline, −1 = entirely right, 0 = straddles it */
  side: 1 | -1 | 0
  role: OsmRole
  closed: boolean
  /** track coordinates [s, lateral] of the vertex centroid — the reliable anchor in the fold */
  centroid: [number, number]
  /** nearest distance of any vertex to the centreline (m) */
  dmin: number
  /** set when the feature sits in the figure-8 fold and its s range is unreliable */
  fold?: true
}

export const OSM_EXTRACT_DATE = '${extractDate}'

export const OSM_FEATURES: OsmFeature[] = [
${list.map(featureLine).join('\n')}
]

/** Stand id (see STANDS in suzuka-facilities-spec.ts) → OSM way ids of its footprint. */
export const OSM_STAND_WAYS: Record<string, number[]> = {
${standWays}
}

const byRole = (...roles: OsmRole[]) => OSM_FEATURES.filter((f) => roles.includes(f.role))
const byId = new Map(OSM_FEATURES.map((f) => [f.id, f]))

export function osmFeature(id: number): OsmFeature | undefined {
  return byId.get(id)
}

/** Footprint polygons of a stand (several for the split stands G / Q2), or [] when unmapped. */
export function osmStandWays(standId: string): OsmFeature[] {
  return (OSM_STAND_WAYS[standId] ?? []).map((id) => byId.get(id)).filter((f): f is OsmFeature => !!f)
}

export const OSM_STANDS = byRole('stand')
export const OSM_PIT_BUILDING = byId.get(${PIT_BUILDING_ID})!
export const OSM_BUILDINGS = byRole('building')
export const OSM_SAND = byRole('sand')
export const OSM_GRASS = byRole('grass')
export const OSM_WATER = byRole('water', 'basin')
export const OSM_TYRE_BARRIERS = byRole('tyre_barrier')
export const OSM_WALLS = byRole('wall')
export const OSM_FENCES = byRole('fence')
export const OSM_RACEWAY = byRole('raceway')
${ROLE_EXPORTS.map(([role, name]) => `export const ${name} = byRole('${role}')`).join('\n')}
export const OSM_FERRIS_WHEEL = byId.get(${FERRIS_WHEEL_ID})!
export const OSM_LEADER_TOWER = byId.get(${LEADER_TOWER_ID})!
`
}

// keep the module under ~250 KB: drop the barriers/fences furthest from the track first
const LIMIT = 250 * 1024
let text = render(features)
if (bytes(text) > LIMIT) {
  const droppable = features
    .filter((f) => ['fence', 'wall', 'barrier'].includes(f.role))
    .sort((a, b) => b.dmin - a.dmin)
  let dropped = 0
  while (bytes(text) > LIMIT && droppable.length) {
    const f = droppable.shift()
    features = features.filter((g) => g !== f)
    dropped++
    text = render(features)
  }
  console.warn(`dropped ${dropped} far barriers/fences to stay under ${LIMIT} bytes`)
}

// ---------------------------------------------------------------- report
const counts = {}
for (const f of features) counts[f.role] = (counts[f.role] ?? 0) + 1
console.log(`enScale ${scale.toFixed(8)}, ${features.length} features, ${(bytes(text) / 1024).toFixed(1)} KB`)
console.log(counts)
console.log('\nstand         way        s-range          lateral          side centroid(s,lat)  fold')
const missing = []
for (const [stand, ways] of Object.entries(STAND_WAYS)) {
  for (const w of ways) {
    const f = features.find((g) => g.id === w)
    if (!f) {
      missing.push(`${stand}:${w}`)
      continue
    }
    console.log(
      `${stand.padEnd(13)} ${String(w).padEnd(10)} ${`${f.s[0]}→${f.s[1]}`.padEnd(16)} ${`${f.lateral[0]}..${f.lateral[1]}`.padEnd(16)} ${String(f.side).padStart(3)}  ${`${f.centroid[0]},${f.centroid[1]}`.padEnd(15)} ${f.fold ? 'FOLD' : ''}`,
    )
  }
}
if (missing.length) console.warn(`stand ways missing from the extract: ${missing.join(', ')}`)
for (const id of [PIT_BUILDING_ID, FERRIS_WHEEL_ID, LEADER_TOWER_ID]) {
  const f = features.find((g) => g.id === id)
  console.log(f ? `${f.role.padEnd(13)} ${id} s ${f.s[0]}→${f.s[1]} lateral ${f.lateral[0]}..${f.lateral[1]} centroid ${f.centroid}` : `MISSING ${id}`)
}

if (!DRY) {
  fs.writeFileSync(OUT, text)
  console.log(`\nwrote ${path.relative(ROOT, OUT)} (${bytes(text)} bytes)`)
}
