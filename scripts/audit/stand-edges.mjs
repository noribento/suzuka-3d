#!/usr/bin/env node
/**
 * Front and back lateral breakpoints of a stand's OSM footprint, in track coordinates — the
 * numbers that go into `lateralFront` / `lateralBack` in app/data/suzuka-facilities-spec.ts.
 *
 *   node scripts/audit/stand-edges.mjs H D5 I IJ J Q1 R
 *   node scripts/audit/stand-edges.mjs --all
 *
 * The polygon is rasterised along its own s window (nearest sample restricted to it, so the
 * figure-8 fold cannot pull a vertex onto the other road) and the nearest / furthest crossing of
 * each cut is reported every `--step` metres.
 */
import '../ts-hooks.mjs'
const { Track } = await import('../../app/sim/track.ts')
const osm = await import('../../app/data/suzuka-facilities.ts')
const spec = await import('../../app/data/suzuka-facilities-spec.ts')

const args = process.argv.slice(2)
const step = Number(args[args.indexOf('--step') + 1]) || 10
const ids = args.includes('--all') ? spec.STANDS.map((d) => d.id) : args.filter((a) => !a.startsWith('--') && Number.isNaN(Number(a)))
const track = new Track()
const L = track.length
const wrap = (s) => ((s % L) + L) % L

for (const id of ids) {
  const def = spec.standById(id)
  if (!def) { console.log(`${id}: no StandDef`); continue }
  if (!def.osmWays.length) { console.log(`${id}: not mapped in OSM`); continue }
  const [s0, s1] = def.sRange
  const len = ((s1 - s0) % L + L) % L
  // every polygon vertex in this stand's own frame
  const rings = def.osmWays.map((wid) => osm.osmFeature(wid)).filter(Boolean).map((f) =>
    f.en.map(([e, n]) => {
      const x = e * track.enScale, z = -n * track.enScale
      const m = track.nearestOnRange(x, z, s0, s1, 120)
      return { s: m.s, lat: m.lateral }
    }))
  const rows = []
  for (let d = 0; d <= len; d += step) {
    const s = wrap(s0 + d)
    let near = Infinity, far = -Infinity
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length]
        const da = ((a.s - s) % L + L + L / 2) % L - L / 2
        const db = ((b.s - s) % L + L + L / 2) % L - L / 2
        if ((da > 0) === (db > 0) || Math.abs(da) > 200 || Math.abs(db) > 200) continue
        const t = da / (da - db)
        const lat = Math.abs(a.lat + (b.lat - a.lat) * t)
        near = Math.min(near, lat)
        far = Math.max(far, lat)
      }
    }
    if (Number.isFinite(near)) rows.push([Math.round(s), +near.toFixed(1), +far.toFixed(1)])
  }
  if (!rows.length) { console.log(`${id}: no crossings (check sRange ${s0}→${s1})`); continue }
  const sgn = def.side > 0 ? 1 : -1
  console.log(`${id} (${def.name}) s ${s0}→${s1}, side ${def.side}, ${rows.length} cuts`)
  console.log(`  front: ${rows.map(([s, n]) => `[${s}, ${(sgn * n).toFixed(1)}]`).join(', ')}`)
  console.log(`  back:  ${rows.map(([s, , f]) => `[${s}, ${(sgn * f).toFixed(1)}]`).join(', ')}`)
  const depth = rows.map(([, n, f]) => f - n)
  console.log(`  depth ${Math.min(...depth).toFixed(1)}–${Math.max(...depth).toFixed(1)} m, spec seating depth ${spec.seatingDepth(def).toFixed(1)} m`)
}
