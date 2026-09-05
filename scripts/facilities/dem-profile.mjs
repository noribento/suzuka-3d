#!/usr/bin/env node
/**
 * Derive the lap elevation profile (ELEVATION_KEYFRAMES) from the GSI DEM5A 5 m mesh.
 *
 *   node scripts/facilities/dem-profile.mjs [--dir <tile cache>] [--tol 0.5] [--centre]
 *
 * Reads the 16 z15 tiles that cover the circuit (downloaded into --dir on first run;
 * default $TMPDIR/suzuka-dem5a — the raw tiles are 基本測量成果 and must never be committed,
 * only the ~46 hand-checked keyframes printed by this script are), samples the DEM along
 * the app's own centreline and prints:
 *   - the repaired 5 m profile extremes and the crossover deck/road heights,
 *   - a Douglas–Peucker keyframe list in the project datum (s=0 → 21.0 m), ready to paste,
 *   - the diff against the current ELEVATION_KEYFRAMES,
 *   - the cross-slope table (h(+6) − h(−6)) / 12 every 100 m plus per-corner means, used to
 *     sanity-check CAMBER_KEYFRAMES.
 *
 * Method (matches the DEM study in the plan): the centreline is rebuilt with the exact
 * smoothCentreline(4, 8, 8) → centripetal Catmull-Rom pipeline of app/sim/track.ts, the
 * DEM is sampled at the *unscaled* E/N (the app scales the loop by officialLength/rawLength
 * ≈ 1.0012 to make one lap exactly 5807 m; the DEM lives in the raw frame), each 5 m station
 * takes the median of 13 bilinear samples at lateral −6…+6 m (robust to kerbs and verges),
 * and a downward-only Hampel filter repairs the four places where DEM5A (bare earth) shows the
 * spectator tunnel / crossover road *under* the track instead of the deck on top.
 *
 * 出典: 標高は「基盤地図情報 数値標高モデル（DEM5A）」（国土地理院）
 * （https://maps.gsi.go.jp/development/ichiran.html）をもとに作成。
 */
import '../ts-hooks.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as THREE from 'three'

const { Track } = await import('../../app/sim/track.ts')
const { CENTERLINE_EN, CIRCUIT, ELEVATION_KEYFRAMES } = await import('../../app/data/suzuka.ts')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const DIR = opt('dir', path.join(os.tmpdir(), 'suzuka-dem5a'))
const TOL = Number(opt('tol', 0.5))
// Pixel-corner mapping by default — the convention of the DEM study the keyframes were checked
// against; --centre treats each value as the pixel centre instead (a ~2 m horizontal shift, which
// moves the profile by ≤ 0.3 m; which one GSI intends is UNVERIFIED and immaterial here).
const CORNER = !args.includes('--centre')
const Z = 15
const XS = [28810, 28811, 28812, 28813]
const YS = [12995, 12996, 12997, 12998]
const UA = 'suzuka3d/0.1 (github.com/noribento/suzuka-3d)'

// ---------------------------------------------------------------- tiles
mkdirSync(DIR, { recursive: true })
const tiles = new Map() // `${x}/${y}` -> Float32Array(256*256), NaN = no data
for (const x of XS) {
  for (const y of YS) {
    const file = path.join(DIR, `dem5a_${Z}_${x}_${y}.txt`)
    if (!existsSync(file)) {
      const url = `https://cyberjapandata.gsi.go.jp/xyz/dem5a/${Z}/${x}/${y}.txt`
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
      writeFileSync(file, await res.text())
    }
    const rows = readFileSync(file, 'utf8').trim().split('\n')
    if (rows.length !== 256) throw new Error(`${file}: expected 256 rows, got ${rows.length}`)
    const data = new Float32Array(256 * 256)
    let gaps = 0
    rows.forEach((row, j) => {
      const cells = row.split(',')
      if (cells.length !== 256) throw new Error(`${file}: row ${j} has ${cells.length} cells`)
      cells.forEach((c, i) => {
        const v = c === 'e' ? NaN : Number(c)
        if (Number.isNaN(v)) gaps++
        data[j * 256 + i] = v
      })
    })
    tiles.set(`${x}/${y}`, { data, gaps })
  }
}
let gapTotal = 0
for (const t of tiles.values()) gapTotal += t.gaps
console.log(`tiles: ${tiles.size} × 256×256 from ${DIR}, no-data cells ${gapTotal} (${((100 * gapTotal) / (tiles.size * 65536)).toFixed(2)} %)`)

// ---------------------------------------------------------------- projection
// Inverse of the equirectangular projection used to build CENTERLINE_EN (metres about the
// circuit centroid) — the constants are the ones the GeoJSON import used.
const LON0 = 136.53282038953489, LAT0 = 34.844581633720921
const M_PER_DEG_LON = 91360.450501, M_PER_DEG_LAT = 111319.490793
const N_PIX = 256 * 2 ** Z

function pixelAt(E, N) {
  const lon = LON0 + E / M_PER_DEG_LON
  const lat = LAT0 + N / M_PER_DEG_LAT
  const phi = (lat * Math.PI) / 180
  const X = ((lon + 180) / 360) * N_PIX
  const Y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * N_PIX
  return CORNER ? [X, Y] : [X - 0.5, Y - 0.5]
}

function cell(gx, gy) {
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256)
  const t = tiles.get(`${tx}/${ty}`)
  if (!t) return NaN
  return t.data[(gy - ty * 256) * 256 + (gx - tx * 256)]
}

let fallbacks = 0
function sample(E, N) {
  const [X, Y] = pixelAt(E, N)
  const x0 = Math.floor(X), y0 = Math.floor(Y)
  const fx = X - x0, fy = Y - y0
  const v00 = cell(x0, y0), v10 = cell(x0 + 1, y0), v01 = cell(x0, y0 + 1), v11 = cell(x0 + 1, y0 + 1)
  const vs = [v00, v10, v01, v11]
  if (vs.every(Number.isFinite)) {
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  }
  // nearest valid neighbour — never triggered on the track itself, counted for the report
  fallbacks++
  const ok = vs.filter(Number.isFinite)
  if (ok.length === 0) throw new Error(`no DEM data at E=${E.toFixed(1)} N=${N.toFixed(1)}`)
  return ok.reduce((a, b) => a + b, 0) / ok.length
}

// ---------------------------------------------------------------- centreline (app pipeline)
// Mirror of smoothCentreline() in app/sim/track.ts (not exported): densify at 4 m, Gaussian
// σ = 8 m, decimate to 8 m. Cross-checked below against Track.curve so any drift in the app's
// pipeline is caught instead of silently sampling the DEM off-road.
function smoothCentreline(raw, spacing, sigma, outSpacing) {
  const dense = []
  const m = raw.length
  for (let i = 0; i < m; i++) {
    const a = raw[i], b = raw[(i + 1) % m]
    if (i === m - 1 && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) break
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(len / spacing))
    for (let k = 0; k < n; k++) {
      const t = k / n
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  const n = dense.length
  const half = Math.ceil((3 * sigma) / spacing)
  const weights = []
  for (let k = -half; k <= half; k++) weights.push(Math.exp(-0.5 * ((k * spacing) / sigma) ** 2))
  const wsum = weights.reduce((a, b) => a + b, 0)
  const smooth = []
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0
    for (let k = -half; k <= half; k++) {
      const p = dense[(i + k + n) % n]
      x += p[0] * weights[k + half]
      y += p[1] * weights[k + half]
    }
    smooth.push([x / wsum, y / wsum])
  }
  const stride = Math.max(1, Math.round(outSpacing / spacing))
  const out = []
  for (let i = 0; i < n; i += stride) out.push(smooth[i])
  return out
}

const track = new Track()
const L = track.length
const rawPts = smoothCentreline(CENTERLINE_EN, 4, 8, 8).map(([e, n]) => new THREE.Vector3(e, 0, -n))
const rawCurve = new THREE.CatmullRomCurve3(rawPts, true, 'centripetal', 0.5)
rawCurve.arcLengthDivisions = 6000
const rawLen = rawCurve.getLength()
const scale = track.enScale ?? CIRCUIT.officialLength / rawLen
{
  // the app's control points must be exactly our raw points × scale
  let worst = 0
  const pts = track.curve.points
  if (pts.length !== rawPts.length) throw new Error(`control point count ${pts.length} ≠ ${rawPts.length}: track.ts pipeline changed`)
  pts.forEach((p, i) => { worst = Math.max(worst, p.distanceTo(rawPts[i].clone().multiplyScalar(scale))) })
  if (worst > 1e-3) throw new Error(`centreline mismatch ${worst} m: track.ts pipeline changed`)
  console.log(`centreline: ${pts.length} control points, raw length ${rawLen.toFixed(2)} m, scale ${scale.toFixed(8)}${track.enScale ? ' (track.enScale)' : ''}, mismatch ${worst.toExponential(1)} m`)
}

const STEP = 5
const NS = Math.round(L / STEP)
const pos = new THREE.Vector3(), tan = new THREE.Vector3()
// heights per station: [lateral −6 … +6] in 1 m steps, absolute metres ASL
const lateral = []
for (let d = -6; d <= 6; d++) lateral.push(d)
const bands = []
for (let i = 0; i < NS; i++) {
  const s = i * STEP
  track.curve.getPointAt(s / L, pos)
  track.curve.getTangentAt(s / L, tan)
  // left normal in world (x, z): (tz, −tx), same as Track.nx/nz
  const nx = tan.z, nz = -tan.x
  const row = lateral.map((d) => sample((pos.x + nx * d) / scale, -(pos.z + nz * d) / scale))
  bands.push(row)
}
const median = (a) => {
  const b = [...a].sort((p, q) => p - q)
  const h = b.length >> 1
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2
}
const raw = bands.map(median)

// ---------------------------------------------------------------- underpass repair
// DEM5A is bare earth: where the track bridges a spectator tunnel or the crossover road the
// mesh shows the surface *below* the deck. Those are always dips, so a one-sided Hampel filter
// (replace a station that sits more than 1.2 m below the ±60 m window median) restores the
// deck without touching genuine crests. Two passes so the wider crossover dip (≈35 m) closes.
const prof = [...raw]
const repaired = []
for (let pass = 0; pass < 2; pass++) {
  const src = [...prof]
  for (let i = 0; i < NS; i++) {
    const w = []
    for (let k = -12; k <= 12; k++) w.push(src[(i + k + NS) % NS])
    const med = median(w)
    if (src[i] < med - 1.2) {
      prof[i] = med
      if (pass === 0) repaired.push(i * STEP)
    }
  }
}
const runs = []
for (const s of repaired) {
  const last = runs[runs.length - 1]
  if (last && s - last[1] <= STEP) last[1] = s
  else runs.push([s, s])
}
console.log(`underpass repair: ${repaired.length} stations in ${runs.length} runs → ${runs.map(([a, b]) => `${a}–${b}`).join(', ')}`)

// ---------------------------------------------------------------- datum + stats
const datum = prof[0] - 21 // project datum keeps the start line at 21.0 m
const proj = prof.map((h) => h - datum)
let iMin = 0, iMax = 0
for (let i = 1; i < NS; i++) {
  if (prof[i] < prof[iMin]) iMin = i
  if (prof[i] > prof[iMax]) iMax = i
}
const at = (s) => proj[Math.round(s / STEP) % NS]
console.log(`datum: proj = ASL − ${datum.toFixed(2)} (h(0) = ${prof[0].toFixed(2)} m ASL)`)
console.log(`extremes: min ${prof[iMin].toFixed(2)} ASL / ${proj[iMin].toFixed(2)} proj @ s=${iMin * STEP}, max ${prof[iMax].toFixed(2)} ASL / ${proj[iMax].toFixed(2)} proj @ s=${iMax * STEP}, range ${(prof[iMax] - prof[iMin]).toFixed(2)} m`)
console.log(`crossover: deck s=${track.crossing.sOver.toFixed(0)} → ${at(track.crossing.sOver).toFixed(2)} proj, road s=${track.crossing.sUnder.toFixed(0)} → ${at(track.crossing.sUnder).toFixed(2)} proj, separation ${(at(track.crossing.sOver) - at(track.crossing.sUnder)).toFixed(2)} m`)
console.log(`DEM fallbacks (nearest-valid): ${fallbacks}`)

// ---------------------------------------------------------------- keyframes
function douglasPeucker(pts, tol) {
  const keep = new Array(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [x0, y0] = pts[a], [x1, y1] = pts[b]
    let worst = -1, iw = -1
    for (let i = a + 1; i < b; i++) {
      const t = (pts[i][0] - x0) / (x1 - x0)
      const d = Math.abs(pts[i][1] - (y0 + (y1 - y0) * t))
      if (d > worst) { worst = d; iw = i }
    }
    if (worst > tol) {
      keep[iw] = true
      stack.push([a, iw], [iw, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}
// closed loop: anchor both ends at the start-line value so the wrap is continuous
const series = proj.map((h, i) => [i * STEP, h])
series.push([L, proj[0]])
let kf = douglasPeucker(series, TOL)
// Residual notches: a keyframe that dips ≥ 0.5 m below *both* neighbours within a ≤ 50 m span
// is the edge of a tunnel artefact the Hampel window only half-closed, not road geometry.
const notches = []
for (let changed = true; changed;) {
  changed = false
  for (let i = 1; i < kf.length - 1; i++) {
    const [sa, ha] = kf[i - 1], [s, h] = kf[i], [sb, hb] = kf[i + 1]
    if (sb - sa <= 50 && h < Math.min(ha, hb) - 0.5) {
      notches.push(s)
      kf.splice(i, 1)
      changed = true
      break
    }
  }
}
// prune keyframes made redundant by the notch removal (same tolerance, on the keyframe polyline)
kf = douglasPeucker(kf, TOL)
kf.pop() // drop the duplicated wrap point at s = L
console.log(`keyframes: tol ${TOL} m → ${kf.length} points, notches removed at ${notches.join(', ') || 'none'}`)
console.log('\nELEVATION_KEYFRAMES (paste into app/data/suzuka.ts):')
console.log(kf.map(([s, h]) => `  [${s}, ${Number(h.toFixed(1))}],`).join('\n'))

// fidelity of the linear keyframe polyline vs the repaired 5 m profile
{
  let worst = 0, sw = 0
  const closed = [...kf, [L, kf[0][1]]]
  let j = 0
  for (let i = 0; i < NS; i++) {
    const s = i * STEP
    while (closed[j + 1][0] < s) j++
    const [s0, h0] = closed[j], [s1, h1] = closed[j + 1]
    const h = h0 + ((h1 - h0) * (s - s0)) / (s1 - s0)
    const d = Math.abs(h - proj[i])
    if (d > worst) { worst = d; sw = s }
  }
  console.log(`polyline fidelity: worst |Δ| ${worst.toFixed(2)} m @ s=${sw} (the app's Hermite interpolation differs slightly again)`)
}

// ---------------------------------------------------------------- diff vs current app keyframes
console.log('\ndiff vs current ELEVATION_KEYFRAMES (s: app → DEM, Δ):')
{
  const rows = []
  for (let s = 0; s < L; s += 200) {
    const a = track.elevationAt(s), d = at(s)
    rows.push(`${String(s).padStart(4)}: ${a.toFixed(1).padStart(5)} → ${d.toFixed(1).padStart(5)} (${(d - a >= 0 ? '+' : '') + (d - a).toFixed(1)})`)
  }
  for (let i = 0; i < rows.length; i += 3) console.log('  ' + rows.slice(i, i + 3).join('   '))
  let worst = 0, sw = 0
  for (let i = 0; i < NS; i++) {
    const d = Math.abs(track.elevationAt(i * STEP) - proj[i])
    if (d > worst) { worst = d; sw = i * STEP }
  }
  console.log(`  current keyframes: ${ELEVATION_KEYFRAMES.length} points, worst |app − DEM| ${worst.toFixed(2)} m @ s=${sw}`)
}

// ---------------------------------------------------------------- cross-slope
// (h(+6) − h(−6)) / 12; + = left edge higher. Straights read −0.1…−0.8 % (crown/drainage);
// values beyond ±4 % only appear in corners. Underpass stations are flagged.
const slopeAt = (i) => (bands[i][12] - bands[i][0]) / 12
console.log('\ncross-slope every 100 m (s: h(−6) h(0) h(+6) slope):')
{
  const rows = []
  for (let s = 0; s < L; s += 100) {
    const i = s / STEP
    const flag = repaired.includes(s) ? '*' : ' '
    rows.push(`${String(s).padStart(4)}: ${bands[i][0].toFixed(2)} ${bands[i][6].toFixed(2)} ${bands[i][12].toFixed(2)} ${(100 * slopeAt(i)).toFixed(2).padStart(6)}%${flag}`)
  }
  for (let i = 0; i < rows.length; i += 2) console.log('  ' + rows.slice(i, i + 2).join('   '))
  console.log('  * = station inside a repaired underpass run (ignore)')
}

// per-corner means, expressed as banking into the corner (+ = outside edge higher) so they
// compare directly with CAMBER_KEYFRAMES; left-handers bank when the DEM slope is negative.
console.log('\ncorner banking from the DEM (mean over the corner, + = banked into the corner):')
for (const c of track.corners) {
  if (c.maxKappa < 1 / 200) continue
  let sum = 0, cnt = 0
  for (let s = Math.ceil(c.from / STEP) * STEP; s <= c.to; s += STEP) {
    const i = Math.round(track.wrap(s) / STEP) % NS
    if (repaired.includes(i * STEP)) continue
    sum += slopeAt(i) * (c.sign > 0 ? -1 : 1)
    cnt++
  }
  if (!cnt) continue
  const pct = (100 * sum) / cnt
  const deg = (Math.atan(sum / cnt) * 180) / Math.PI
  console.log(`  ${c.sign > 0 ? 'L' : 'R'} ${String(c.from.toFixed(0)).padStart(5)}-${String(c.to.toFixed(0)).padStart(5)} apex ${String(c.apex.toFixed(0)).padStart(5)}  ${pct.toFixed(2).padStart(6)} %  = ${deg.toFixed(1).padStart(5)}°  (app camber at apex ${((Math.abs(track.rollAt(c.apex)) * 180) / Math.PI).toFixed(1)}°)`)
}
