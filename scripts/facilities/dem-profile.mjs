#!/usr/bin/env node
/**
 * Derive the lap elevation profile (ELEVATION_KEYFRAMES) from the GSI DEM5A 5 m mesh, and
 * generate the committed terrain grids (app/data/suzuka-dem.ts) from DEM5A / DEM10B.
 *
 *   node scripts/facilities/dem-profile.mjs [--dir <tile cache>] [--tol 0.5] [--centre]
 *   node scripts/facilities/dem-profile.mjs --grid [--step 30] --far --write
 *   node scripts/facilities/dem-profile.mjs --verify
 *   node scripts/facilities/dem-profile.mjs --relief
 *   node scripts/facilities/dem-profile.mjs --cuts [--tier high|low]
 *
 * Without the grid flags (the keyframe path): reads the 16 z15 tiles that cover the circuit
 * (downloaded into --dir on first run; default .cache/dem, git-ignored — the raw tiles are
 * 基本測量成果 and must never be committed, only the ~46 hand-checked keyframes printed by this
 * script are), samples the DEM along the app's own centreline and prints:
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
 * Grid flags (the terrain data path, plan §1a):
 *   --grid [--step 30]  DEM_INNER: an EN-axis-aligned grid around track.center covering the
 *                       terrain rectangle + the outer ring + a 300 m fade band, each node the
 *                       Gaussian σ 20 m mean of bilinear DEM5A samples on a 5 m sub-grid
 *                       (DEM10B z14 where DEM5A has no data). Decimetres ASL, int16 deltas.
 *   --far               DEM_FAR: 地理院標高タイル 'dem' (DEM10B) z10, ±35 km, 500 m cells (block
 *                       mean; block MAX where the mean exceeds 600 m so the 鈴鹿山脈 skyline
 *                       keeps its peaks). Metres ASL, sea = sentinel.
 *   --write             write app/data/suzuka-dem.ts (needs --grid and --far).
 *   --verify            decode the committed file, check dimensions / ranges and the DEM at the
 *                       ELEVATION_KEYFRAMES stations (±2.5 m, embankment stations excluded).
 *                       Exits 1 on failure.
 *   --relief            report facilityRelief (stands.ts) vs the committed DEM at every zone's
 *                       outer fade, through scripts/audit/app-runtime.mjs's transpile hook.
 *   --cuts              the CUT corridors of the ground field (CUTS, ground-field.ts; README R6):
 *                       per corridor a table every metre along its centreline of the field WITH
 *                       the cut, WITHOUT it (`field.yNoCut`, the rules before I6) and the DEM, the
 *                       portal as built, the end distance and why, the depth; then the identity
 *                       assertion — on a 2 m grid over the terrain rectangle every point outside
 *                       every corridor reads the field bit-identical to the no-cut rules (a cut
 *                       changes nothing but its corridor), and inside no point reads higher.
 *                       Through app-runtime (the built scene). Exits 1 on a failure.
 *
 * 出典: 標高は「基盤地図情報 数値標高モデル（DEM5A）」および「地理院標高タイル（DEM10B）」（国土地理院）
 * （https://maps.gsi.go.jp/development/ichiran.html）をもとに作成。
 */
import '../ts-hooks.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const { Track } = await import('../../app/sim/track.ts')
const { CENTERLINE_EN, CIRCUIT, ELEVATION_KEYFRAMES } = await import('../../app/data/suzuka.ts')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const has = (name) => args.includes(`--${name}`)
const DIR = opt('dir', path.join(ROOT, '.cache', 'dem'))
const TOL = Number(opt('tol', 0.5))
// Pixel-corner mapping by default — the convention of the DEM study the keyframes were checked
// against; --centre treats each value as the pixel centre instead (a ~2 m horizontal shift, which
// moves the profile by ≤ 0.3 m; which one GSI intends is UNVERIFIED and immaterial here).
const CORNER = !has('centre')
const GRID = has('grid'), FAR = has('far'), WRITE = has('write'), VERIFY = has('verify'), RELIEF = has('relief'), CUTS_REPORT = has('cuts')
const REPORT = !(GRID || FAR || WRITE || VERIFY || RELIEF || CUTS_REPORT)
const GRID_STEP = Number(opt('step', 30))
const SIGMA = 20
const SUB = 5
if (WRITE && !(GRID && FAR)) throw new Error('--write needs both --grid and --far (the file holds both grids)')
const OUT_FILE = path.join(ROOT, 'app/data/suzuka-dem.ts')
const Z = 15
const XS = [28810, 28811, 28812, 28813]
const YS = [12995, 12996, 12997, 12998]
const UA = 'suzuka3d-facilities/1.0 (bhyg756@gmail.com)'

// ---------------------------------------------------------------- tiles
// One GSI elevation tile layer at one zoom: 256×256 CSV tiles, 'e' = no data. Missing tiles
// (HTTP 404: no data anywhere in the tile, e.g. DEM5A outside its coverage, sea at z10) are
// cached as an empty marker so the next run does not ask again.
mkdirSync(DIR, { recursive: true })
class TileSet {
  constructor(layer, z) {
    this.layer = layer
    this.z = z
    this.tiles = new Map() // `${x}/${y}` -> { data: Float32Array(256*256) (NaN = no data), gaps } | null
    this.missing = 0
    this.gaps = 0
  }
  async load(x0, x1, y0, y1) {
    const jobs = []
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y])
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++]
        await this.loadOne(x, y)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    return this
  }
  async loadOne(x, y) {
    const key = `${x}/${y}`
    if (this.tiles.has(key)) return
    const file = path.join(DIR, `${this.layer}_${this.z}_${x}_${y}.txt`)
    if (!existsSync(file)) {
      const url = `https://cyberjapandata.gsi.go.jp/xyz/${this.layer}/${this.z}/${x}/${y}.txt`
      let res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok && res.status !== 404) res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (res.status === 404) writeFileSync(file, '')
      else if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
      else writeFileSync(file, await res.text())
    }
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') {
      this.tiles.set(key, null)
      this.missing++
      return
    }
    const rows = text.trim().split('\n')
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
    this.gaps += gaps
    this.tiles.set(key, { data, gaps })
  }
  /** value of global pixel (gx, gy) at this zoom; NaN outside the loaded tiles or where 'e' */
  cell(gx, gy) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256)
    const t = this.tiles.get(`${tx}/${ty}`)
    if (!t) return NaN
    return t.data[(gy - ty * 256) * 256 + (gx - tx * 256)]
  }
  /** bilinear at EN metres; NaN when any of the four pixels is no-data */
  bilinear(E, N) {
    const [X, Y] = pixelAt(E, N, this.z)
    const x0 = Math.floor(X), y0 = Math.floor(Y)
    const fx = X - x0, fy = Y - y0
    const v00 = this.cell(x0, y0), v10 = this.cell(x0 + 1, y0), v01 = this.cell(x0, y0 + 1), v11 = this.cell(x0 + 1, y0 + 1)
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  }
  describe() {
    const xs = [], ys = []
    for (const k of this.tiles.keys()) {
      const [x, y] = k.split('/').map(Number)
      xs.push(x)
      ys.push(y)
    }
    return { layer: this.layer, z: this.z, x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)], count: this.tiles.size, missing: this.missing, noData: this.gaps }
  }
}

// ---------------------------------------------------------------- projection
// Inverse of the equirectangular projection used to build CENTERLINE_EN (metres about the
// circuit centroid) — the constants are the ones the GeoJSON import used.
const LON0 = 136.53282038953489, LAT0 = 34.844581633720921
const M_PER_DEG_LON = 91360.450501, M_PER_DEG_LAT = 111319.490793

/** EN metres → global Web-Mercator pixel at zoom z (pixel corner, or centre with --centre) */
function pixelAt(E, N, z = Z) {
  const nPix = 256 * 2 ** z
  const lon = LON0 + E / M_PER_DEG_LON
  const lat = LAT0 + N / M_PER_DEG_LAT
  const phi = (lat * Math.PI) / 180
  const X = ((lon + 180) / 360) * nPix
  const Y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * nPix
  return CORNER ? [X, Y] : [X - 0.5, Y - 0.5]
}

/** z tile range covering an EN rectangle (e0..e1 × n0..n1), padded by `padPx` pixels */
function tileRange(z, e0, e1, n0, n1, padPx = 2) {
  const [xa, ya] = pixelAt(e0, n1, z) // north-west corner
  const [xb, yb] = pixelAt(e1, n0, z) // south-east corner
  return [Math.floor((xa - padPx) / 256), Math.floor((xb + padPx) / 256), Math.floor((ya - padPx) / 256), Math.floor((yb + padPx) / 256)]
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
/** world xz → EN metres (the DEM frame) */
const toEN = (x, z) => [x / scale, -z / scale]

// ---------------------------------------------------------------- inner extent
// The terrain rectangle is centred on track.center (3400 × 2600 m); the inner grid must reach
// past it by the outer ring (≈ 1313 m) and a 300 m fade band, rounded outward to whole steps.
function innerExtent(step) {
  const halfX = 1700 + 1313 + 300, halfZ = 1300 + 1313 + 300
  const cx = track.center.x, cz = track.center.z
  const [eMin, nMin] = toEN(cx - halfX, cz + halfZ)
  const [eMax, nMax] = toEN(cx + halfX, cz - halfZ)
  const e0 = Math.floor(eMin / step) * step, e1 = Math.ceil(eMax / step) * step
  const n1 = Math.floor(nMin / step) * step, n0 = Math.ceil(nMax / step) * step
  return { e0, e1, n0, n1, step, cols: Math.round((e1 - e0) / step) + 1, rows: Math.round((n0 - n1) / step) + 1, halfX, halfZ }
}

// ---------------------------------------------------------------- profile (keyframe path)
/**
 * The DEM along the centreline: the 13-sample bands, the raw and repaired 5 m profiles and the
 * project datum. Shared by the keyframe report and the grid writer (the datum in the file must
 * be the one the keyframes were derived with).
 */
async function computeProfile() {
  const dem5a = new TileSet('dem5a', Z)
  if (GRID) {
    const ext = innerExtent(GRID_STEP)
    const pad = Math.ceil((3 * SIGMA) / SUB) * SUB
    await dem5a.load(...tileRange(Z, ext.e0 - pad, ext.e1 + pad, ext.n1 - pad, ext.n0 + pad))
  } else {
    await dem5a.load(XS[0], XS[XS.length - 1], YS[0], YS[YS.length - 1])
  }
  console.log(`tiles: ${dem5a.tiles.size} × 256×256 from ${DIR}, no-data cells ${dem5a.gaps} (${((100 * dem5a.gaps) / (dem5a.tiles.size * 65536)).toFixed(2)} %)${dem5a.missing ? `, ${dem5a.missing} tiles missing (404)` : ''}`)

  let fallbacks = 0
  function sample(E, N) {
    const [X, Y] = pixelAt(E, N)
    const x0 = Math.floor(X), y0 = Math.floor(Y)
    const fx = X - x0, fy = Y - y0
    const v00 = dem5a.cell(x0, y0), v10 = dem5a.cell(x0 + 1, y0), v01 = dem5a.cell(x0, y0 + 1), v11 = dem5a.cell(x0 + 1, y0 + 1)
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
  return { dem5a, STEP, NS, bands, raw, prof, proj, datum, repaired, runs, at, median }
}

// ---------------------------------------------------------------- keyframe report
function keyframeReport({ STEP, NS, bands, prof, proj, repaired, at }) {
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
  void prof
}

// ---------------------------------------------------------------- int16 delta codec (encoder)
// value[i] = value[i − 1] + delta[i], value[−1] = 0, deltas little-endian int16, base64.
// The decoder lives in app/data/dem-codec.ts (hand-written; the app and --verify use it).
function encodeI16Delta(values) {
  const buf = new ArrayBuffer(values.length * 2)
  const view = new DataView(buf)
  let prev = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isInteger(v)) throw new Error(`encodeI16Delta: value[${i}] = ${v} is not an integer`)
    const d = v - prev
    if (d < -32768 || d > 32767) throw new Error(`encodeI16Delta: delta ${d} at ${i} does not fit int16`)
    view.setInt16(2 * i, d, true)
    prev = v
  }
  return Buffer.from(buf).toString('base64')
}

// ---------------------------------------------------------------- --grid
async function buildInner(profile) {
  const step = GRID_STEP
  if (!Number.isInteger(step / SUB)) throw new Error(`--step ${step} must be a multiple of the ${SUB} m sub-grid`)
  const K = step / SUB
  const R = Math.ceil((3 * SIGMA) / SUB) // 3σ window, in sub-cells
  const ext = innerExtent(step)
  const { e0, e1, n0, n1, cols, rows } = ext
  console.log(`\n--grid: step ${step} m, σ ${SIGMA} m (±${R * SUB} m window on a ${SUB} m sub-grid)`)
  console.log(`  extent: track.center (${track.center.x.toFixed(1)}, ${track.center.z.toFixed(1)}) ± (${ext.halfX}, ${ext.halfZ}) m world → EN E [${e0}, ${e1}] × N [${n1}, ${n0}] (${e1 - e0} × ${n0 - n1} m), ${cols} × ${rows} = ${cols * rows} nodes`)
  const pad = R * SUB
  const dem10 = new TileSet('dem', 14)
  await dem10.load(...tileRange(14, e0 - pad, e1 + pad, n1 - pad, n0 + pad))
  const d5 = profile.dem5a.describe(), d10 = dem10.describe()
  console.log(`  tiles: dem5a z${d5.z} x ${d5.x[0]}–${d5.x[1]} × y ${d5.y[0]}–${d5.y[1]} (${d5.count}, ${d5.missing} missing, ${d5.noData} no-data cells); dem z${d10.z} x ${d10.x[0]}–${d10.x[1]} × y ${d10.y[0]}–${d10.y[1]} (${d10.count}, ${d10.missing} missing)`)

  // 5 m sub-grid over the extent plus the window margin, row 0 = north
  const W = (cols - 1) * K + 1 + 2 * R, H = (rows - 1) * K + 1 + 2 * R
  const sub = new Float32Array(W * H)
  let fallback = 0, nearest = 0
  const fbNodes = new Uint8Array(cols * rows)
  for (let b = 0; b < H; b++) {
    const N = n0 - (b - R) * SUB
    for (let a = 0; a < W; a++) {
      const E = e0 + (a - R) * SUB
      let v = profile.dem5a.bilinear(E, N)
      if (!Number.isFinite(v)) {
        fallback++
        v = dem10.bilinear(E, N)
        if (!Number.isFinite(v)) {
          // last resort: nearest valid DEM10B pixel within 3 pixels
          nearest++
          const [X, Y] = pixelAt(E, N, 14)
          let best = NaN, bd = Infinity
          for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const c = dem10.cell(Math.floor(X) + dx, Math.floor(Y) + dy)
            const d = dx * dx + dy * dy
            if (Number.isFinite(c) && d < bd) { bd = d; best = c }
          }
          if (!Number.isFinite(best)) throw new Error(`no DEM5A or DEM10B data at E=${E} N=${N}`)
          v = best
        }
        // mark the 30 m nodes whose window sees this sample
        const i0 = Math.max(0, Math.ceil((a - 2 * R) / K)), i1 = Math.min(cols - 1, Math.floor(a / K))
        const j0 = Math.max(0, Math.ceil((b - 2 * R) / K)), j1 = Math.min(rows - 1, Math.floor(b / K))
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fbNodes[j * cols + i] = 1
      }
      sub[b * W + a] = v
    }
  }
  // separable Gaussian: horizontal pass at the node columns only, then vertical at the node rows
  const wts = []
  for (let k = -R; k <= R; k++) wts.push(Math.exp(-0.5 * ((k * SUB) / SIGMA) ** 2))
  const wsum = wts.reduce((p, q) => p + q, 0)
  const hp = new Float32Array(cols * H)
  for (let b = 0; b < H; b++) {
    for (let i = 0; i < cols; i++) {
      const a = R + i * K
      let acc = 0
      for (let k = -R; k <= R; k++) acc += sub[b * W + a + k] * wts[k + R]
      hp[b * cols + i] = acc / wsum
    }
  }
  const vals = new Int32Array(cols * rows)
  let min = Infinity, max = -Infinity, sum = 0
  for (let j = 0; j < rows; j++) {
    const b = R + j * K
    for (let i = 0; i < cols; i++) {
      let acc = 0
      for (let k = -R; k <= R; k++) acc += hp[(b + k) * cols + i] * wts[k + R]
      const h = acc / wsum
      const dm = Math.round(h * 10)
      vals[j * cols + i] = dm
      if (h < min) min = h
      if (h > max) max = h
      sum += h
    }
  }
  let fbCount = 0
  for (const f of fbNodes) fbCount += f
  console.log(`  sub-grid: ${W} × ${H} = ${W * H} samples, DEM10B fallback samples ${fallback} (${((100 * fallback) / (W * H)).toFixed(2)} %, ${nearest} nearest-pixel), nodes touched by a fallback ${fbCount}`)
  console.log(`  ASL: min ${min.toFixed(2)} / max ${max.toFixed(2)} / mean ${(sum / (cols * rows)).toFixed(2)} m`)
  const data = encodeI16Delta(vals)
  console.log(`  encoded: ${(data.length / 1024).toFixed(1)} KB base64 (${cols * rows} × int16 dm)`)
  return { grid: { e0, n0, step, cols, rows, unit: 0.1, data }, tiles: { dem5a: d5, dem: d10 }, fallback, fbCount, min, max }
}

// ---------------------------------------------------------------- --far
async function buildFar() {
  const STEP_F = 500, HALF = 35000, ZF = 10, PEAK = 600, SEA = -1
  const cx = track.center.x, cz = track.center.z
  const [eMin, nMin] = toEN(cx - HALF, cz + HALF)
  const [eMax, nMax] = toEN(cx + HALF, cz - HALF)
  const e0 = Math.floor(eMin / STEP_F) * STEP_F, e1 = Math.ceil(eMax / STEP_F) * STEP_F
  const n1 = Math.floor(nMin / STEP_F) * STEP_F, n0 = Math.ceil(nMax / STEP_F) * STEP_F
  const cols = Math.round((e1 - e0) / STEP_F) + 1, rows = Math.round((n0 - n1) / STEP_F) + 1
  console.log(`\n--far: 'dem' (DEM10B) z${ZF}, ±${HALF / 1000} km, ${STEP_F} m cells (block mean; block max above ${PEAK} m)`)
  console.log(`  extent: EN E [${e0}, ${e1}] × N [${n1}, ${n0}], ${cols} × ${rows} = ${cols * rows} cells`)
  const ts = new TileSet('dem', ZF)
  await ts.load(...tileRange(ZF, e0 - STEP_F, e1 + STEP_F, n1 - STEP_F, n0 + STEP_F))
  const d = ts.describe()
  console.log(`  tiles: dem z${d.z} x ${d.x[0]}–${d.x[1]} × y ${d.y[0]}–${d.y[1]} (${d.count}, ${d.missing} missing, ${d.noData} no-data cells)`)
  const vals = new Int32Array(cols * rows)
  let sea = 0, peaks = 0, min = Infinity, max = -Infinity, pxPerCell = 0
  for (let j = 0; j < rows; j++) {
    const N = n0 - j * STEP_F
    for (let i = 0; i < cols; i++) {
      const E = e0 + i * STEP_F
      // the cell's pixel box: EN rectangles map to axis-aligned Mercator rectangles
      const [xa, ya] = pixelAt(E - STEP_F / 2, N + STEP_F / 2, ZF)
      const [xb, yb] = pixelAt(E + STEP_F / 2, N - STEP_F / 2, ZF)
      let sum = 0, mx = -Infinity, nValid = 0, nTotal = 0
      // a pixel belongs to the cell its centre falls in (no sharing between neighbours)
      for (let gy = Math.floor(ya); gy < Math.ceil(yb); gy++) {
        if (gy + 0.5 < ya || gy + 0.5 >= yb) continue
        for (let gx = Math.floor(xa); gx < Math.ceil(xb); gx++) {
          if (gx + 0.5 < xa || gx + 0.5 >= xb) continue
          nTotal++
          const v = ts.cell(gx, gy)
          if (!Number.isFinite(v)) continue
          nValid++
          sum += v
          if (v > mx) mx = v
        }
      }
      pxPerCell += nTotal
      let out
      if (nValid * 2 < nTotal) out = SEA
      else {
        const mean = sum / nValid
        if (mean <= 0) out = SEA
        else {
          if (mean > PEAK) peaks++
          out = Math.round(mean > PEAK ? mx : mean)
        }
      }
      if (out === SEA) sea++
      else {
        if (out < min) min = out
        if (out > max) max = out
      }
      vals[j * cols + i] = out
    }
  }
  console.log(`  cells: ${cols * rows}, sea ${sea} (${((100 * sea) / (cols * rows)).toFixed(1)} %), block-max cells ${peaks}, ${(pxPerCell / (cols * rows)).toFixed(1)} px/cell, land ASL min ${min} / max ${max} m`)
  const data = encodeI16Delta(vals)
  console.log(`  encoded: ${(data.length / 1024).toFixed(1)} KB base64 (${cols * rows} × int16 m)`)
  return { grid: { e0, n0, step: STEP_F, cols, rows, unit: 1, sea: SEA, data }, tiles: { dem: d }, sea, peaks, min, max, HALF, PEAK }
}

// ---------------------------------------------------------------- --write
function writeFile(profile, inner, far) {
  const now = new Date().toISOString()
  const t5 = inner.tiles.dem5a, t10 = inner.tiles.dem, tf = far.tiles.dem
  const cmd = 'node scripts/facilities/dem-profile.mjs --grid' + (GRID_STEP !== 30 ? ` --step ${GRID_STEP}` : '') + ' --far --write'
  const method = `inner: Gaussian σ ${SIGMA} m (±${3 * SIGMA} m window) of bilinear DEM5A samples on a ${SUB} m sub-grid, decimated to ${GRID_STEP} m; DEM10B z14 where DEM5A has no data. far: DEM10B z10 block mean per ${far.grid.step} m cell, block max where the mean exceeds ${far.PEAK} m, sea (no data or ≤ 0 m) = sentinel ${far.grid.sea}`
  const header = `/**
 * Suzuka Circuit — the surrounding terrain as two elevation grids in the project's local frame.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with
 *   ${cmd}
 *
 * 出典：基盤地図情報 数値標高モデル（DEM5A）および地理院標高タイル（DEM10B）（国土地理院）をもとに作成
 * （σ${SIGMA} m 平滑化・${GRID_STEP} m 間引き／${far.grid.step} m ブロック集約の派生データ。生タイルは含まない）。
 * 地理院タイル一覧: https://maps.gsi.go.jp/development/ichiran.html
 * Derived data: the raw tiles (基本測量成果) are not part of the repository; every value here is a
 * smoothed / block-reduced product of them.
 *
 * Tiles: dem5a z${t5.z} x ${t5.x[0]}–${t5.x[1]} × y ${t5.y[0]}–${t5.y[1]} (${t5.count} tiles, ${t5.missing} missing, ${t5.noData} no-data cells),
 *        dem (DEM10B) z${t10.z} x ${t10.x[0]}–${t10.x[1]} × y ${t10.y[0]}–${t10.y[1]} (${t10.count} tiles, inner fallback for ${inner.fallback} sub-grid samples),
 *        dem (DEM10B) z${tf.z} x ${tf.x[0]}–${tf.x[1]} × y ${tf.y[0]}–${tf.y[1]} (${tf.count} tiles, far grid).
 * Method: ${method}.
 * Datum: DEM_DATUM_ASL = h_repaired(s = 0) − 21.0 = ${profile.datum.toFixed(3)} m ASL, the rule the ELEVATION_KEYFRAMES
 *        were derived with (project height = ASL − DEM_DATUM_ASL; the start line sits at 21.0 m).
 * Frame: EN metres of the CENTERLINE_EN projection (origin lat0 = 34.844581633720921, lon0 = 136.53282038953489);
 *        world = (E · enScale, y, −N · enScale). Rows run north → south (world z ascending), columns west → east.
 * Values: base64 of little-endian int16 DELTAS (value[i] = value[i − 1] + delta[i], value[−1] = 0), decoded by
 *        app/data/dem-codec.ts. Inner unit 0.1 m (ASL ${inner.min.toFixed(1)}…${inner.max.toFixed(1)} m), far unit 1 m (land ${far.min}…${far.max} m, sea ${far.sea} cells).
 * Generated: ${now} by ${cmd}
 */
import type { DemGrid } from './dem-codec'

/** project datum in metres ASL: project y = ASL − DEM_DATUM_ASL */
export const DEM_DATUM_ASL = ${profile.datum.toFixed(3)}

/** ${GRID_STEP} m grid around track.center (± ${innerExtent(GRID_STEP).halfX} × ${innerExtent(GRID_STEP).halfZ} m world), decimetres ASL */
export const DEM_INNER: DemGrid = ${fmtGrid(inner.grid)}

/** ${far.grid.step} m grid, ± ${far.HALF / 1000} km around track.center, metres ASL, sea = ${far.grid.sea} */
export const DEM_FAR: DemGrid = ${fmtGrid(far.grid)}

export const DEM_META = {
  generated: '${now}',
  command: '${cmd}',
  tiles: {
    dem5a: ${fmtTile(t5)},
    dem10bInner: ${fmtTile(t10)},
    dem10bFar: ${fmtTile(tf)},
  },
  method: '${method.replace(/'/g, "\\'")}',
} as const
`
  writeFileSync(OUT_FILE, header)
  console.log(`\nwrote ${path.relative(ROOT, OUT_FILE)}: ${(header.length / 1024).toFixed(1)} KB (inner ${(inner.grid.data.length / 1024).toFixed(1)} KB, far ${(far.grid.data.length / 1024).toFixed(1)} KB)`)
}
const fmtTile = (t) => `{ layer: '${t.layer}', z: ${t.z}, x: [${t.x[0]}, ${t.x[1]}], y: [${t.y[0]}, ${t.y[1]}], count: ${t.count} }`
function fmtGrid(g) {
  const fields = Object.entries(g).filter(([k]) => k !== 'data').map(([k, v]) => `${k}: ${v}`).join(', ')
  return `{\n  ${fields},\n  data:\n    '${g.data}',\n}`
}

// ---------------------------------------------------------------- --verify
/**
 * Keyframe stations the smoothed DEM cannot be expected to match: the track there stands on an
 * embankment / deck the σ 20 m bare-earth mean averages away, or inside a repaired underpass run
 * (the keyframe carries the repaired deck height, the grid the ground below it). Kept explicit
 * so a regression elsewhere cannot hide behind a blanket tolerance.
 */
const VERIFY_EXCLUDE = new Map([
  [4675, 'crossover deck: the keyframe carries the repaired deck (s 4691, +6 m over the road below, repaired run 4675–4710), the grid the bare earth'],
  [4025, 'Spoon exit cutting: the road runs in a cut and the σ 20 m mean sees the banks either side (+3.9 m; s 3945 reads +2.2 for the same reason)'],
])
async function verify() {
  const codec = await import('../../app/data/dem-codec.ts')
  const dem = await import('../../app/data/suzuka-dem.ts')
  let ok = true
  const fail = (msg) => { ok = false; console.log(`  FAIL ${msg}`) }
  console.log(`\n--verify: ${path.relative(ROOT, OUT_FILE)} (${(readFileSync(OUT_FILE, 'utf8').length / 1024).toFixed(1)} KB), datum ${dem.DEM_DATUM_ASL} m ASL`)
  for (const [name, g, lo, hi] of [['DEM_INNER', dem.DEM_INNER, 0, 130], ['DEM_FAR', dem.DEM_FAR, -1, 1400]]) {
    const raw = codec.decodeI16Delta(g.data)
    if (raw.length !== g.cols * g.rows) fail(`${name}: ${raw.length} values ≠ ${g.cols} × ${g.rows}`)
    let min = Infinity, max = -Infinity, sum = 0, n = 0, sea = 0
    for (const v of raw) {
      if (g.sea !== undefined && v === g.sea) { sea++; continue }
      const m = v * g.unit
      if (m < min) min = m
      if (m > max) max = m
      sum += m
      n++
    }
    console.log(`  ${name}: ${g.cols} × ${g.rows} @ ${g.step} m, E [${g.e0}, ${g.e0 + (g.cols - 1) * g.step}] N [${g.n0 - (g.rows - 1) * g.step}, ${g.n0}], ASL min ${min.toFixed(1)} / max ${max.toFixed(1)} / mean ${(sum / n).toFixed(1)} m${g.sea !== undefined ? `, sea ${sea} (${((100 * sea) / raw.length).toFixed(1)} %)` : ''}, ${(g.data.length / 1024).toFixed(1)} KB`)
    if (min < lo || max > hi) fail(`${name}: ASL range ${min.toFixed(1)}…${max.toFixed(1)} outside ${lo}…${hi}`)
    const dec = codec.decodeDem(g)
    if (dec.length !== raw.length) fail(`${name}: decodeDem length ${dec.length}`)
  }
  // the inner grid at the keyframe stations
  const g = dem.DEM_INNER
  const vals = codec.decodeDem(g)
  const p = new THREE.Vector3()
  console.log(`  keyframes (s: kf proj → ASL | DEM ASL | Δ):`)
  const rows = []
  let worst = 0, sw = 0, nEx = 0, nBad = 0
  for (const [s, h] of ELEVATION_KEYFRAMES) {
    track.pointAt(s, 0, p)
    const [E, N] = toEN(p.x, p.z)
    const d = codec.demSample(g, vals, E, N)
    const asl = h + dem.DEM_DATUM_ASL
    const delta = d - asl
    const ex = VERIFY_EXCLUDE.has(s)
    if (ex) nEx++
    else if (Math.abs(delta) > 2.5) { nBad++; fail(`keyframe s=${s}: |Δ| ${Math.abs(delta).toFixed(2)} m > 2.5`) }
    if (!ex && Math.abs(delta) > worst) { worst = Math.abs(delta); sw = s }
    rows.push(`${String(s).padStart(4)}: ${h.toFixed(1).padStart(5)} → ${asl.toFixed(1).padStart(5)} | ${d.toFixed(1).padStart(5)} | ${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(5)}${ex ? ' x' : Math.abs(delta) > 2.5 ? ' !' : '  '}`)
  }
  for (let i = 0; i < rows.length; i += 3) console.log('    ' + rows.slice(i, i + 3).join('   '))
  console.log(`  ${ELEVATION_KEYFRAMES.length} stations, ${nEx} excluded (x), ${nBad} over ±2.5 m, worst non-excluded |Δ| ${worst.toFixed(2)} m @ s=${sw}`)
  for (const [s, why] of VERIFY_EXCLUDE) console.log(`    excluded s=${s}: ${why}`)
  console.log(ok ? '  verify: PASS' : '  verify: FAIL')
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------- --relief
/**
 * facilityRelief (stands.ts) against the committed DEM. For each relief zone, every 10 m of s,
 * the lateral is scanned outward from the road on the zone's side (the left, or the right for
 * the paddock's `side: -1`) and the report prints the relief height where the
 * claim is still at full weight (the outer fade's start) and where it reaches zero (its end),
 * against the DEM at the same world xz — the plan makes the far branch of Terrain.heightAt the
 * DEM, so the fade end is where the relief has to meet real ground.
 */
async function reliefReport() {
  // app-runtime's transpile hook (parameter properties) + its DOM stubs; stands.ts imports the
  // texture generators at module scope
  const rt = await import('../audit/app-runtime.mjs')
  const stands = await import(path.join(rt.ROOT, 'app/three/stands.ts'))
  // the field Terrain.heightAt uses beyond the road blend (bicubic DEM_INNER, water beds), so the
  // table measures the join the terrain actually makes; the relief's outer fades land on it
  const { demFieldFor } = await import(path.join(rt.ROOT, 'app/three/dem.ts'))
  const demProj = (x, z) => demFieldFor(track).height(x, z)
  const { STANDS } = await import('../../app/data/suzuka-facilities-spec.ts')
  const { BASINS } = await import('../../app/data/suzuka-barriers-spec.ts')
  const { osmFeature } = await import('../../app/data/suzuka-facilities.ts')
  const by = (id) => STANDS.find((s) => s.id === id)
  const zones = []
  for (const id of ['C', 'D5', 'D1_4', 'E2', 'E1']) {
    const def = by(id)
    if (!def) continue
    if (id === 'D1_4') def.tiers.forEach((t, k) => zones.push({ name: `${id}/tier${k}`, range: t.sRange ?? def.sRange }))
    else zones.push({ name: id, range: def.sRange })
  }
  zones.push({ name: 'GP Square', range: [5560, 70] })
  // the paddock claims the RIGHT of the pit straight (TrackZone side −1): its scan goes out at −a,
  // and stops short of the NIPPO road (≥ 135 m out), whose D stands' zones lie beyond it
  zones.push({ name: 'paddock', range: [5536, 100], side: -1, latMax: 140 })
  const p = new THREE.Vector3()
  const NEAR = 140, LAT_MAX = 220, PAD = 60
  console.log(`\n--relief: facilityRelief vs DEM (proj m), lateral scan 0…${LAT_MAX} m every 1 m (to the zone's side: left, or right for side −1), s every 10 m (zone range ± ${PAD} m)`)
  console.log('  columns: s | full-weight edge: lat relief dem Δ | zero-weight edge: lat mode relief dem Δ eff | max w at near ≥ 140 m')
  console.log('  eff = the step the mode can leave at the edge: cut → |Δ|, fill → max(0, relief − dem), cap → max(0, dem − relief); ! = eff > 1.5 m')
  const summary = []
  const wArr = new Float64Array(LAT_MAX + 1), hArr = new Float64Array(LAT_MAX + 1), mArr = new Array(LAT_MAX + 1)
  const modeName = (m) => (m === true ? 'cut' : m === 'cap' ? 'cap' : 'fill')
  const effOf = (m, delta) => (m === true ? Math.abs(delta) : m === 'cap' ? Math.max(0, -delta) : Math.max(0, delta))
  for (const zone of zones) {
    const [s0, s1] = zone.range
    const side = zone.side ?? 1
    const latMax = zone.latMax ?? LAT_MAX
    const len = (s1 - s0 + L) % L || L
    console.log(`\n  zone ${zone.name} s [${s0}, ${s1}]${side < 0 ? ' (right side)' : ''}:`)
    let worstEnd = 0, worstEndS = 0, worstFull = 0, over = 0, rowsN = 0, maxWFar = 0, maxWFarAt = ''
    for (let ds = -PAD; ds <= len + PAD; ds += 10) {
      const s = track.wrap(s0 + ds)
      let wFar = 0, wFarAt = -1, any = false
      wArr.fill(0)
      for (let a = 0; a <= latMax; a++) {
        track.pointAt(s, side * a, p)
        const r = stands.facilityRelief(p.x, p.z, track)
        const w = r ? r[1] : 0
        wArr[a] = w
        hArr[a] = r ? r[0] : NaN
        mArr[a] = r ? r[2] : undefined
        if (w > 0) {
          any = true
          const near = Math.sqrt(track.nearestSample(p.x, p.z).d2)
          if (near >= NEAR && w > wFar) { wFar = w; wFarAt = a }
        }
      }
      if (!any) continue
      // the run of the claim: the contiguous w > 0 interval holding the outermost full-weight
      // point (the stand's own platform), else the first interval
      let aFull = -1
      for (let a = latMax; a >= 0; a--) if (wArr[a] >= 0.999) { aFull = a; break }
      let aEnd
      if (aFull >= 0) { aEnd = aFull; while (aEnd < latMax && wArr[aEnd + 1] > 0) aEnd++ }
      else { let a = 0; while (wArr[a] === 0) a++; aEnd = a; while (aEnd < latMax && wArr[aEnd + 1] > 0) aEnd++ }
      rowsN++
      const hFull = aFull >= 0 ? hArr[aFull] : NaN, hEnd = hArr[aEnd], mode = mArr[aEnd]
      track.pointAt(s, side * aFull, p)
      const dFull = aFull >= 0 ? demProj(p.x, p.z) : NaN
      track.pointAt(s, side * aEnd, p)
      const dEnd = demProj(p.x, p.z)
      const eFull = hFull - dFull
      const eEnd = hEnd - dEnd
      const eff = effOf(mode, eEnd)
      if (eff > worstEnd) { worstEnd = eff; worstEndS = s }
      if (Number.isFinite(eFull) && Math.abs(eFull) > worstFull) worstFull = Math.abs(eFull)
      if (eff > 1.5) over++
      if (wFar > maxWFar) { maxWFar = wFar; maxWFarAt = `s=${s.toFixed(0)} lat=${wFarAt}` }
      const f = (v, w = 6) => (Number.isFinite(v) ? v.toFixed(1) : '-').padStart(w)
      console.log(`    ${String(s.toFixed(0)).padStart(4)} | ${String(aFull >= 0 ? aFull : '-').padStart(3)} ${f(hFull)} ${f(dFull)} ${f(eFull)} | ${String(aEnd).padStart(3)} ${modeName(mode).padEnd(4)} ${f(hEnd)} ${f(dEnd)} ${f(eEnd)} ${f(eff, 5)}${eff > 1.5 ? ' !' : '  '} | ${wFar.toFixed(2)}${wFar > 0 ? ` @lat ${wFarAt}` : ''}`)
    }
    console.log(`    → ${rowsN} rows, zero-weight edge max eff ${worstEnd.toFixed(2)} m @ s=${worstEndS.toFixed(0)} (${over} rows > 1.5 m), full-weight edge max |Δ| ${worstFull.toFixed(2)} m, max weight at near ≥ ${NEAR} m: ${maxWFar.toFixed(2)}${maxWFar > 0 ? ` (${maxWFarAt})` : ''}`)
    summary.push({ zone: zone.name, rows: rowsN, worstEnd, over, worstFull, maxWFar })
  }
  // basins: the floor is a cap that only lowers the ground, weight 0 at the rim — report the
  // floor against the DEM inside each polygon
  for (const b of BASINS) {
    const f = osmFeature(b.osmWay)
    if (!f) continue
    let minD = Infinity, maxD = -Infinity, n = 0, maxWFar = 0
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [e, nn] of f.en) {
      track.enToWorld(e, nn, p)
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
    for (let z = minZ; z <= maxZ; z += 2) for (let x = minX; x <= maxX; x += 2) {
      const r = stands.facilityRelief(x, z, track)
      if (!r || r[2] !== 'cap') continue
      const d = r[0] - demProj(x, z)
      minD = Math.min(minD, d); maxD = Math.max(maxD, d); n++
      if (Math.sqrt(track.nearestSample(x, z).d2) >= NEAR) maxWFar = Math.max(maxWFar, r[1])
    }
    console.log(`\n  basin ${b.name} (way ${b.osmWay}): ${n} probe points, floor − DEM ${n ? `${minD.toFixed(1)}…${maxD.toFixed(1)}` : '-'} m, max weight at near ≥ ${NEAR} m: ${maxWFar.toFixed(2)}`)
    summary.push({ zone: `basin ${b.name}`, rows: n, worstEnd: NaN, over: 0, worstFull: NaN, maxWFar })
  }
  console.log('\n  summary (zone: rows, zero-weight edge max eff m, rows > 1.5 m, max w at near ≥ 140 m):')
  for (const s of summary) console.log(`    ${s.zone.padEnd(12)} ${String(s.rows).padStart(5)}  ${Number.isFinite(s.worstEnd) ? s.worstEnd.toFixed(2).padStart(6) : '     -'}  ${String(s.over).padStart(3)}  ${s.maxWFar.toFixed(2)}`)
}

// ---------------------------------------------------------------- --cuts
/**
 * The cut corridors (README 地面の契約 R6, I6): what the field does inside each CUT and the proof
 * that it does nothing outside. The scene is built through app-runtime (the terrain, the cut
 * field and the plan are the app's own), the DEM column is dem.ts's bicubic DEM_INNER — the
 * ground the cut's daylight end has to meet.
 */
async function cutsReport() {
  const rt = await import('../audit/app-runtime.mjs')
  const tier = opt('tier', 'high')
  const t0 = performance.now()
  const { env, track: tr, terrain, ground } = await rt.buildScene({ tier })
  const { demFieldFor } = await import(path.join(rt.ROOT, 'app/three/dem.ts'))
  const { CUTS, CUT_WALL_FOOT } = await import('../../app/data/suzuka-facilities-spec.ts')
  const dem = demFieldFor(tr)
  const field = ground.field
  const cuts = env.cuts
  let ok = true
  const fail = (msg) => { ok = false; console.log(`  FAIL ${msg}`) }
  console.log(`\n--cuts (tier ${tier}, built in ${((performance.now() - t0) / 1000).toFixed(1)} s, buildMs cuts ${env.buildMs.cuts?.toFixed(0)} / plan ${env.buildMs.plan?.toFixed(0)} / meshes ${env.buildMs.meshes?.toFixed(0)} ms): ${cuts.corridors.length} corridors of ${CUTS.length} CUTS`)
  console.log('  columns: d | floor (the corridor centreline\'s cut floor) | field WITH the cut | WITHOUT (yNoCut) | DEM | depth = without − with')
  const missing = CUTS.filter((c) => !cuts.corridors.some((q) => q.id === c.id))
  if (missing.length) fail(`CUTS with no corridor: ${missing.map((c) => c.id).join(', ')}`)
  const summary = []
  for (const c of cuts.corridors) {
    const p = c.portal
    console.log(`\n  ${c.id} (${c.def.name}): portal (${p.s.toFixed(1)}, ${p.lateral.toFixed(1)}) heading ${p.heading.toFixed(0)}°${p.pushed > 0 ? ` pushed ${p.pushed.toFixed(2)} m` : ''}, field at the portal ${c.fieldAtPortal.toFixed(2)}, depth ${c.def.depth} grade ${c.def.grade} halfWidth ${c.def.halfWidth}${c.def.level ? ' level' : ''}`)
    let maxDepth = 0, maxDepthD = 0
    const rows = []
    for (const q of c.samples) {
      if (Math.abs(q.d - Math.round(q.d)) > 1e-6) continue
      const withCut = field.y(q.x, q.z)
      const without = field.yNoCut(q.x, q.z)
      const depth = without - withCut
      if (depth > maxDepth) { maxDepth = depth; maxDepthD = q.d }
      rows.push(`${String(q.d).padStart(5)} | ${q.floor.toFixed(2).padStart(6)} | ${withCut.toFixed(2).padStart(6)} | ${without.toFixed(2).padStart(6)} | ${dem.height(q.x, q.z).toFixed(2).padStart(6)} | ${depth.toFixed(2).padStart(5)}`)
    }
    for (let i = 0; i < rows.length; i += 2) console.log('    ' + rows.slice(i, i + 2).join('     '))
    console.log(`    → starts at d ${c.startD}, ends at d ${c.endD} (${c.end}), floor ${c.floorStart.toFixed(2)} → ${c.floorEnd.toFixed(2)}, max depth ${maxDepth.toFixed(2)} m at d ${maxDepthD}`)
    if (c.samples.length < 2) fail(`${c.id}: fewer than 2 samples`)
    if (c.end === 'cap') fail(`${c.id}: the corridor hit the length cap without daylighting`)
    summary.push({ id: c.id, startD: c.startD, endD: c.endD, end: c.end, maxDepth })
  }
  // --- identity outside the corridors ---------------------------------------------------------------
  const g = terrain.grid()
  const x0 = g.x0, z0 = g.z0, x1 = g.x0 + (g.nx - 1) * g.dx, z1 = g.z0 + (g.nz - 1) * g.dz
  let outside = 0, inside = 0, differ = 0, higher = 0, worst = 0, worstAt = ''
  for (let z = z0; z <= z1; z += 2) for (let x = x0; x <= x1; x += 2) {
    const cut = field.cutAt(x, z)
    const a = field.y(x, z), b = field.yNoCut(x, z)
    if (cut === null) {
      outside++
      if (a !== b) { differ++; if (Math.abs(a - b) > worst) { worst = Math.abs(a - b); worstAt = `(${x.toFixed(0)}, ${z.toFixed(0)})` } }
    } else {
      inside++
      if (a > b + 1e-9) higher++
    }
  }
  console.log(`\n  identity: ${outside} grid points outside every corridor, ${differ} read a different field with the cuts than without (worst ${(worst * 1000).toFixed(1)} mm${worstAt ? ` at ${worstAt}` : ''}); ${inside} inside, ${higher} read higher than without`)
  if (differ) fail(`the field differs outside the corridors on ${differ} points (a cut may change nothing but its corridor + its ${CUT_WALL_FOOT} m foot, which lies inside the polygon)`)
  if (higher) fail(`the field is higher than without the cut on ${higher} points inside a corridor`)
  console.log('\n  summary (id: start d, end d, why, max depth):')
  for (const r of summary) console.log(`    ${r.id.padEnd(14)} ${String(r.startD).padStart(5)} ${String(r.endD).padStart(6)}  ${r.end.padEnd(9)} ${r.maxDepth.toFixed(2)}`)
  console.log(ok ? '  cuts: PASS' : '  cuts: FAIL')
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------- main
{
  let profile = null
  if (REPORT || GRID || WRITE) profile = await computeProfile()
  if (REPORT) keyframeReport(profile)
  let inner = null, far = null
  if (GRID) inner = await buildInner(profile)
  if (FAR) far = await buildFar()
  if (WRITE) writeFile(profile, inner, far)
  if (VERIFY) await verify()
  if (RELIEF) await reliefReport()
  if (CUTS_REPORT) await cutsReport()
}
