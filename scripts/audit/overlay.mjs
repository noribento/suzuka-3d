#!/usr/bin/env node
/**
 * Draws what the app builds (warm colours) and what OpenStreetMap says is there (cool colours) on
 * the 国土地理院 aerial mosaic from scripts/audit/aerial.mjs, and crops one image per section of
 * sections.json. This is the check for the hand-authored trackside data
 * (app/data/suzuka-barriers-spec.ts) — run it after every edit of BARRIERS / KERBS / LINES.
 *
 *   node scripts/audit/aerial.mjs            # once: fetch tiles into .cache/audit
 *   node scripts/audit/overlay.mjs           # all sections → .cache/audit/sections/
 *   node scripts/audit/overlay.mjs --section 03-t2-b-c,10-200r-bike-chicane
 *   node scripts/audit/overlay.mjs --old     # draw the OLD procedural lines instead of the tables
 *
 * Warm = the app: yellow centreline, white road edges + s ticks, ORANGE barrier runs (dashed where
 * the source is hand-read), red/orange kerbs, lime green strips, white dashed lines, orange stand
 * fronts, purple stand backs, grey run-off / tan gravel edges, orange pit lane, cyan-white lanes.
 * Cool = OSM: cyan walls, magenta tyre barriers, green fences, blue stands, khaki sand, olive grass,
 * light blue water, grey non-lap raceways.
 */
import '../ts-hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HERE = path.join(ROOT, 'scripts/audit')
const require = createRequire(path.join(ROOT, 'package.json'))
const sharp = require('sharp')
const THREE = await import(path.join(ROOT, 'node_modules/three/build/three.module.js'))
const { Track, forwardDelta, signedDelta } = await import('../../app/sim/track.ts')
const tm = await import('../../app/three/track-mesh.ts')
const spec = await import('../../app/data/suzuka-facilities-spec.ts')
const bar = await import('../../app/data/suzuka-barriers-spec.ts')
const trackside = await import('../../app/three/trackside.ts')
const osm = await import('../../app/data/suzuka-facilities.ts')
const suz = await import('../../app/data/suzuka.ts')

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const only = flag('--section', null)?.split(',') ?? null
const OLD = args.includes('--old')
const CACHE = path.join(ROOT, '.cache/audit')
const meta = JSON.parse(fs.readFileSync(path.join(CACHE, 'meta.json'), 'utf8'))
const sections = JSON.parse(fs.readFileSync(path.join(HERE, 'sections.json'), 'utf8'))
const track = new Track()
const L = track.length
const D = Math.PI / 180
const NT = 2 ** meta.z
const _p = new THREE.Vector3()
const px = (x, z) => {
  const lon = meta.LON0 + x / meta.k / meta.KX
  const lat = meta.LAT0 + -z / meta.k / meta.KY
  const lr = lat * D
  return [(((lon + 180) / 360) * NT - meta.x0) * 256, (((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * NT - meta.y0) * 256]
}
const at = (s, lat) => {
  track.pointAt(s, lat, _p, 0)
  return px(_p.x, _p.z)
}
const f1 = (v) => v.toFixed(1)
const hwAt = (s) => track.halfWidthAt(s)

const svg = []
const line = (pts, stroke, w, dash, opacity = 1) => {
  if (pts.length < 2) return
  svg.push(`<polyline points="${pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-opacity="${opacity}" stroke-linejoin="round"/>`)
}
const poly = (pts, stroke, w, dash, fill = 'none') => {
  if (pts.length < 3) return
  svg.push(`<polygon points="${pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>`)
}
const text = (p, t, fill = '#ffffff', size = 11) => svg.push(`<text x="${f1(p[0])}" y="${f1(p[1])}" fill="${fill}" font-size="${size}" font-family="sans-serif" stroke="#000" stroke-width="2" paint-order="stroke">${t}</text>`)
const dot = (p, r, fill) => svg.push(`<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${r}" fill="${fill}" stroke="#000" stroke-width="0.5"/>`)
/** polyline of lat(s) over [s0, s1] forward */
const sLine = (s0, s1, latFn, stroke, w, dash, step = 4, skip = null, opacity = 1) => {
  const len = forwardDelta(s0, s1, L) || L
  let run = []
  for (let d = 0; d <= len; d += step) {
    const s = track.wrap(s0 + d)
    if (skip && skip(s)) {
      line(run, stroke, w, dash, opacity)
      run = []
      continue
    }
    run.push(at(s, latFn(s)))
  }
  line(run, stroke, w, dash, opacity)
}
const enPts = (f) => f.en.map(([e, n]) => px(e * meta.k, -n * meta.k))

// ---------------------------------------------------------------- OSM (cool)
for (const f of osm.OSM_FEATURES) {
  const pts = enPts(f)
  switch (f.role) {
    case 'sand': poly(pts, '#e8d27a', 1.2, '6,4'); break
    case 'grass': poly(pts, '#9acd32', 0.8, '3,5'); break
    case 'water': case 'basin': poly(pts, '#4fc3ff', 1, '6,3'); break
    case 'stand': poly(pts, '#3399ff', 1.8); text(pts[0], `OSM ${f.id}`, '#3399ff', 10); break
    case 'pit_building': poly(pts, '#3399ff', 1.5, '8,3'); break
    case 'tyre_barrier': f.closed ? poly(pts, '#ff66ff', 1.8) : line(pts, '#ff66ff', 1.8); text(pts[0], `tyre ${f.id}`, '#ff66ff', 9); break
    case 'wall': f.closed ? poly(pts, '#00e5ff', 1.6) : line(pts, '#00e5ff', 1.6); text(pts[0], `wall ${f.id}`, '#00e5ff', 9); break
    case 'fence': f.closed ? poly(pts, '#00cc44', 1) : line(pts, '#00cc44', 1); break
    case 'barrier': f.closed ? poly(pts, '#00cc44', 1, '4,3') : line(pts, '#00cc44', 1, '4,3'); break
    case 'raceway': if (f.tags.name === 'Pit Lane') line(pts, '#00e5ff', 2, '10,4'); else if (f.dmin > 3) (f.closed ? poly : line)(pts, '#8899aa', 1.2, '5,3'); break
    case 'building': if (f.dmin < 130) poly(pts, '#556677', 0.8); break
    default: break
  }
}

// ---------------------------------------------------------------- app (warm)
sLine(0, 0, () => 0, '#ffe100', 1, null, 4)
sLine(0, 0, (s) => hwAt(s), '#ffffff', 1, null, 4)
sLine(0, 0, (s) => -hwAt(s), '#ffffff', 1, null, 4)
for (let s = 0; s < L; s += 100) {
  line([at(s, -hwAt(s)), at(s, -hwAt(s) - 5)], '#ffffff', 1)
  text(at(s, -hwAt(s) - 7), `s${s}`, '#ffffff', 11)
}
// run-off from RUNOFF_ZONES
const layout = tm.runoffLayout(track)
for (const side of [1, -1]) {
  sLine(0, 0, (s) => side * layout.asphaltOuter(s, side), '#e0e0e0', 1, '5,4', 4, (s) => layout.asphaltOuter(s, side) <= hwAt(s) + 0.6)
  sLine(0, 0, (s) => side * (layout.gravel(s, side)?.[0] ?? 0), '#d2b48c', 1.4, '2,3', 4, (s) => !layout.gravel(s, side))
  sLine(0, 0, (s) => side * (layout.gravel(s, side)?.[1] ?? 0), '#d2b48c', 1.6, null, 4, (s) => !layout.gravel(s, side))
}

if (OLD) {
  // the pre-audit procedural barrier line, for before/after comparisons
  const cross = track.crossing
  const pit = suz.CIRCUIT.pit
  const gravel = tm.gravelRuns(track).map((r) => ({ ...r, outer: Math.min(40, Math.max(25, r.outer)) }))
  const inZone = (s, z) => forwardDelta(z.from, s, L) <= forwardDelta(z.from, z.to, L)
  const dist = (s, side) => {
    let d = 11
    for (const z of gravel) if (z.side === side && inZone(s, z)) d = Math.max(d, z.outer)
    if (side > 0 && (s > 5480 || s < 470)) d = 9
    if (side < 0 && inZone(s, { from: pit.entryS - 20, to: pit.exitS + 40 })) d = pit.laneWidth + 6
    return d
  }
  const nearBridge = (s) => Math.abs(signedDelta(s, cross.sOver, L)) < 175
  for (const side of [1, -1]) sLine(0, 0, (s) => side * (hwAt(s) + dist(s, side)), '#ff6b00', 2.2, null, 4, (s) => nearBridge(s) || (side < 0 && inZone(s, { from: pit.limitStartS - 40, to: pit.limitEndS })))
} else {
  // NEW: barrier runs from the table, resolved exactly as barriers.ts will
  const KIND_COLOUR = { armco: '#ff6b00', guardrail: '#ff9500', concrete: '#ffffff', tyre: '#ff3355', fence: '#c0ff00' }
  for (const run of bar.BARRIERS) {
    const r = trackside.resolveLine(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
    const hand = !!run.source.samples && !run.source.osm
    line(r.samples.map(([s, lat]) => at(s, lat)), KIND_COLOUR[run.kind], run.kind === 'tyre' ? 3 : 2.2, hand ? '7,4' : null)
    if (r.samples.length) text(at(r.samples[0][0], r.samples[0][1]), run.id, KIND_COLOUR[run.kind], 10)
  }
}

// NEW kerbs / green strips
for (const k of bar.KERBS) {
  const colour = k.kind === 'green' ? '#22dd55' : k.kind === 'sausage' ? '#ffe100' : '#ff2020'
  const w = k.kind === 'green' ? (k.width ?? 1.2) * 1.6 : 2.6
  if (k.kind === 'sausage') {
    const len = forwardDelta(k.sRange[0], k.sRange[1], L)
    for (let d = 0; d <= len; d += 1.7) dot(at(k.sRange[0] + d, k.side * (hwAt(k.sRange[0] + d) + 1.25)), 2.2, colour)
  } else sLine(k.sRange[0], k.sRange[1], (s) => k.side * (hwAt(s) + (k.kind === 'green' ? 2.2 : 0.65)), colour, w, null, 2, null, k.kind === 'green' ? 0.6 : 1)
  text(at(k.sRange[0], k.side * (hwAt(k.sRange[0]) + 3)), k.name, colour, 9)
}
// NEW white lines
for (const ln of bar.LINES) {
  if (ln.lateral === 'left-edge' || ln.lateral === 'right-edge') {
    const side = ln.lateral === 'left-edge' ? 1 : -1
    const gaps = bar.EDGE_LINE_GAPS.filter((g) => g.side === side)
    sLine(0, 0, (s) => side * (hwAt(s) - 0.15), '#ffffff', 1.4, '10,4', 4, (s) => gaps.some((g) => forwardDelta(g.sRange[0], s, L) <= forwardDelta(g.sRange[0], g.sRange[1], L)))
  } else if (ln.lateralTo !== undefined) {
    line([at(ln.sRange[0], ln.lateral), at(ln.sRange[0], ln.lateralTo)], '#ffffff', 2, null)
  } else {
    const lat = (s) => spec.alongAt(ln.lateral, s, ln.sRange)
    sLine(ln.sRange[0], ln.sRange[1], lat, '#ffffff', 1.6, ln.dash ? '5,4' : null, 3)
    text(at(ln.sRange[0], lat(ln.sRange[0])), ln.name, '#ffffff', 9)
  }
}
// NEW offset lanes
for (const lane of bar.OFFSET_LANES) {
  const pts = trackside.osmPathSamples(track, lane.osmWay, lane.sRange).filter(([, lat]) => !lane.latMax || Math.abs(lat) <= lane.latMax)
  line(pts.map(([s, lat]) => at(s, lat)), '#66ffff', 2.4, '4,3')
  if (pts.length) text(at(pts[0][0], pts[0][1]), lane.name, '#66ffff', 10)
}
// stands, aprons, pit lane, marshal posts, screens, wheel
for (const d of spec.STANDS) {
  if (d.id === 'Q2') continue
  sLine(d.sRange[0], d.sRange[1], (s) => spec.alongAt(d.lateralFront, s, d.sRange), '#ff9900', 2, d.chord ? '4,3' : null, 4)
  sLine(d.sRange[0], d.sRange[1], (s) => spec.alongAt(d.lateralBack, s, d.sRange), '#cc66ff', 1.6, d.chord ? '4,3' : null, 4)
  text(at(d.sRange[0], spec.alongAt(d.lateralFront, d.sRange[0], d.sRange)), `spec ${d.id}`, '#ff9900', 10)
}
for (const a of spec.PAINTED_APRONS) sLine(a.sRange[0], a.sRange[1], (s) => a.side * (hwAt(s) + 1.4 + a.width / 2), a.pattern === 'chevrons' ? '#2457a8' : '#3fb3b0', a.width * 1.6, null, 2, null, 0.55)
const pit = suz.CIRCUIT.pit
sLine(pit.entryS, pit.exitS, (s) => (track.pitLateralAt(s) ?? pit.laneOffset) + pit.laneWidth / 2, '#ffa500', 1.2, null, 3)
sLine(pit.entryS, pit.exitS, (s) => (track.pitLateralAt(s) ?? pit.laneOffset) - pit.laneWidth / 2, '#ffa500', 1.2, null, 3)
for (const m of bar.MARSHAL_POSTS) {
  const p = at(m.s, m.lateral)
  svg.push(`<rect x="${f1(p[0] - 3)}" y="${f1(p[1] - 3)}" width="6" height="6" fill="${m.unverified ? '#ffcc88' : '#ffffff'}" stroke="#000" stroke-width="0.5"/>`)
}
for (const sc of spec.SCREENS) {
  const p = at(sc.s, sc.lateral)
  svg.push(`<rect x="${f1(p[0] - 5)}" y="${f1(p[1] - 3)}" width="10" height="6" fill="#ffe100" stroke="#000" stroke-width="0.5"/>`)
}
const fw = px(spec.FERRIS_WHEEL.en[0] * meta.k, -spec.FERRIS_WHEEL.en[1] * meta.k)
svg.push(`<circle cx="${f1(fw[0])}" cy="${f1(fw[1])}" r="${24 / meta.mPerPx}" fill="none" stroke="#ffe100" stroke-width="1.5"/>`)

const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.W}" height="${meta.H}">${svg.join('\n')}</svg>`
const overlaid = path.join(CACHE, OLD ? 'mosaic-overlay-old.png' : 'mosaic-overlay.png')
await sharp(path.join(CACHE, 'mosaic.jpg')).composite([{ input: Buffer.from(svgDoc), top: 0, left: 0 }]).png({ compressionLevel: 6 }).toFile(overlaid)

const outDir = path.join(CACHE, 'sections')
fs.mkdirSync(outDir, { recursive: true })
const margin = 95 / meta.mPerPx
for (const sec of sections) {
  if (only && !only.includes(sec.id)) continue
  const [a, b] = sec.s
  const len = forwardDelta(a, b, L)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let d = 0; d <= len; d += 4) {
    const p = at(track.wrap(a + d), 0)
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
  }
  const left = Math.max(0, Math.floor(minX - margin)), top = Math.max(0, Math.floor(minY - margin))
  const width = Math.min(meta.W - left, Math.ceil(maxX - minX + 2 * margin)), height = Math.min(meta.H - top, Math.ceil(maxY - minY + 2 * margin))
  const scale = Math.min(1.8, 2200 / Math.max(width, height))
  const w2 = Math.round(width * scale), h2 = Math.round(height * scale)
  await sharp(overlaid).extract({ left, top, width, height }).resize(w2, h2, { kernel: 'lanczos3' }).png().toFile(path.join(outDir, `${sec.id}-overlay${OLD ? '-old' : ''}.png`))
  if (!fs.existsSync(path.join(outDir, `${sec.id}-aerial.png`))) {
    await sharp(path.join(CACHE, 'mosaic.jpg')).extract({ left, top, width, height }).resize(w2, h2, { kernel: 'lanczos3' }).png().toFile(path.join(outDir, `${sec.id}-aerial.png`))
  }
  console.log(`${sec.id}: ${w2}×${h2} @ ${(meta.mPerPx / scale).toFixed(2)} m/px`)
}
await sharp(overlaid).resize(2048).png().toFile(path.join(CACHE, `overview-overlay${OLD ? '-old' : ''}.png`))
