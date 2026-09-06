#!/usr/bin/env node
/**
 * Prints the track-side edge of OSM ways as (s, lateral) on a given stretch of the lap — the
 * helper used to author BARRIERS in app/data/suzuka-barriers-spec.ts.
 *
 *   node scripts/audit/osm-edge.mjs <s0> <s1> <side(1|-1)> <osmId> [<osmId> …]
 */
import '../ts-hooks.mjs'
const { Track } = await import('../../app/sim/track.ts')
const { osmEdgeSamples, osmWay } = await import('../../app/three/trackside.ts')
const [s0, s1, side, ...ids] = process.argv.slice(2).map(Number)
const track = new Track()
for (const id of ids) {
  const f = osmWay(id)
  if (!f) { console.log(`${id}: not in the extract`); continue }
  const pts = osmEdgeSamples(track, [id], [s0, s1], side)
  console.log(`${id} ${f.role} closed=${f.closed} stored s ${f.s} lat ${f.lateral}: ${pts.length} samples`)
  console.log('   ' + pts.map(([s, l]) => `(${s.toFixed(0)},${l >= 0 ? '+' : ''}${l.toFixed(1)})`).join(' '))
}
