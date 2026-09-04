import { computed } from 'vue'
import { getTrack } from '~/sim/track'
import { toMap } from '~/sim/projection'
import { CIRCUIT } from '~/data/suzuka'

/**
 * SVG paths of the circuit in map space: the full outline, the three sectors, the start line
 * and the DRS zone. Shared by the classic track map and the broadcast driver tracker so the
 * two never disagree about the circuit's shape (the paths are built once from the track model).
 */
export function useTrackGeometry() {
  return computed(() => {
    const track = getTrack()
    const pts: { x: number; y: number; s: number }[] = []
    for (let i = 0; i < track.n; i += 2) {
      const m = toMap(track.px[i]!, track.pz[i]!)
      pts.push({ x: m.mx, y: m.my, s: i * track.ds })
    }
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const pad = 60
    const sectorPath = (from: number, to: number) => {
      const seg = pts.filter((p) => (from < to ? p.s >= from && p.s <= to : p.s >= from || p.s <= to))
      if (from > to) {
        // keep order continuous across the line
        const a = seg.filter((p) => p.s >= from), b = seg.filter((p) => p.s <= to)
        return [...a, ...b].map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      }
      return seg.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    }
    const full = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z'
    const s1 = sectorPath(0, CIRCUIT.sectors[0])
    const s2 = sectorPath(CIRCUIT.sectors[0], CIRCUIT.sectors[1])
    const s3 = sectorPath(CIRCUIT.sectors[1], track.length - 1)
    const drs = sectorPath(CIRCUIT.drs.start, CIRCUIT.drs.end)
    const start = toMap(track.px[0]!, track.pz[0]!)
    const sn = { x: track.nx[0]!, z: track.nz[0]! }
    const l = toMap(track.px[0]! + sn.x * 40, track.pz[0]! + sn.z * 40)
    const r = toMap(track.px[0]! - sn.x * 40, track.pz[0]! - sn.z * 40)
    return { viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`, full, s1, s2, s3, drs, start, startLine: { x1: l.mx, y1: l.my, x2: r.mx, y2: r.my } }
  })
}
