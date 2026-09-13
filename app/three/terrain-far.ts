import * as THREE from 'three'
import { DEM_DATUM_ASL, DEM_FAR } from '~/data/suzuka-dem'
import { decodeI16Delta } from '~/data/dem-codec'
import type { AssetRegistry } from './assets'
import type { WaterBed } from './dem'
import type { Terrain } from './environment'
import type { CoverLayer } from './landcover'
import { grassSurfaceMaterial } from './materials'
import type { Quality } from './quality'
import { cached, mulberry, scaled } from './textures'

/**
 * The terrain beyond the height grid (plan §1c), all of it under `terrain.group` so the
 * viewport's setupMaterials / freezeStatic cover it like the chunks:
 *
 *  - `buildTerrainRing`: the coarse ring of `Terrain.ring` (K × the grid spacing, ≈ ±3.0 × ±2.6 km)
 *    as four quadrant meshes `terrainRing-0..3`, sharing the grid's boundary nodes (and their
 *    normals) so the seam has no T-junctions and no shading step. Same grass program as the
 *    chunks with the outer land-cover mask (landcover.ts).
 *  - `buildFarRidge`: the skyline `terrainFar` — DEM_FAR (500 m, ±35 km) meshed at
 *    `Quality.ridgeCellM`, the cells under the ring dropped, vertex-coloured by height and slope
 *    (sea / plains / the forested 30–200 m band / cedar and scree above 600 m), with a fog patch
 *    that compresses the fog depth beyond 4 km so the 20 km ridges keep ≈ 27 % of their contrast.
 *  - `buildWaterPlanes`: one merged mesh `water-far` over the DEM field's water beds (dem.ts), 0.3 m
 *    under each bed's shoreline; all of them are ≥ 150 m from the centreline (the partition owns
 *    everything nearer, README R1).
 *
 * Contract (README R3 / plan §1f): this module reads `terrain.ring`, `terrain.farField` and the
 * DEM field only — never heightAt / meshHeightAt / distanceToTrack — and adds no opaque ground
 * face inside the partition. The mesh names are on the G8 allow-list through the `terrain` group.
 */

/** the skyline's palette (sRGB); `plain` is also the skirt's colour (environment.ts) */
export const RIDGE_COLOURS = {
  /** Ise Bay: a grey-blue that reads as haze-covered water at 20 km */
  sea: '#6f8291',
  /** the Ise plain under 30 m ASL: settlement roofs, paddies and roads averaged to a warm grey */
  plain: '#8c8578',
  /** the 30–200 m band is the forested hill front west and south of the circuit */
  forest: '#4a5a3c',
  /** the Suzuka range above 600 m: cedar plantation green */
  cedar: '#3b4d33',
  /** deciduous slopes and rock, mixed in by steepness on the high ridges */
  scree: '#6b6152',
} as const

/** fog depth compression of the ridge: full fog to this depth, then 20 % of the distance beyond it */
export const RIDGE_FOG_KNEE_M = 4000
export const RIDGE_FOG_SLOPE = 0.2
/**
 * The skyline's vertices on the ring rectangle's edge sit this far under the LOWEST ring edge node
 * of the far cell they cover (see buildFarRidge): the ring is drawn on top, the ledge is invisible
 * at 3 km, and the 500 m chord between two such vertices can never rise through the 53 m ring.
 */
export const RIDGE_UNDER_RING_M = 2
/** the water plane sits this far under the bed's shoreline (dem.ts WaterBed.level) */
export const WATER_PLANE_DROP_M = 0.3
/** ASL bands of the palette, metres */
const PLAIN_TOP_ASL = 30
const FOREST_TOP_ASL = 200
const CEDAR_ASL = 600

export interface TerrainFarStats {
  ring: { triangles: number; meshes: number }
  ridge: { triangles: number; cells: number; skipped: number; moved: number; yMin: number; yMax: number }
  water: { triangles: number; beds: number; dropped: number }
  buildMs: number
}

// ---------------------------------------------------------------- the ring

/**
 * Mesh the coarse ring as four rectangles of cells in a pinwheel (north band, east band, south
 * band, west band) that tile the ring exactly. Every vertex is a `TerrainRing` node with the
 * node's precomputed normal, the uv is xz / 9 like the chunks, so the shared boundary nodes get
 * the same position, normal and texture coordinate from both meshes.
 */
export function buildTerrainRing(terrain: Terrain, assets: AssetRegistry | null, cover: CoverLayer | null): THREE.Mesh[] {
  const r = terrain.ring
  const cx = r.nx - 1, cz = r.nz - 1
  const mat = grassSurfaceMaterial(assets, [9, 9], [250, 250], 0.7, cover)
  // cell ranges [i0, i1) × [j0, j1) of the four bands
  const bands: [number, number, number, number][] = [
    [0, cx - r.cellsX, 0, r.cellsZ],
    [cx - r.cellsX, cx, 0, cz - r.cellsZ],
    [r.cellsX, cx, cz - r.cellsZ, cz],
    [0, r.cellsX, r.cellsZ, cz],
  ]
  const meshes: THREE.Mesh[] = []
  bands.forEach(([i0, i1, j0, j1], q) => {
    const nw = i1 - i0 + 1, nd = j1 - j0 + 1
    const n = nw * nd
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2)
    const idx = new Uint32Array((nw - 1) * (nd - 1) * 6)
    let t = 0
    for (let j = 0; j < nd; j++) {
      for (let i = 0; i < nw; i++) {
        const gi = i0 + i, gj = j0 + j
        const k = j * nw + i, g = gj * r.nx + gi
        const x = r.x0 + gi * r.dx, z = r.z0 + gj * r.dz
        pos[k * 3] = x
        pos[k * 3 + 1] = r.heights[g]!
        pos[k * 3 + 2] = z
        nrm[k * 3] = r.normals[g * 3]!
        nrm[k * 3 + 1] = r.normals[g * 3 + 1]!
        nrm[k * 3 + 2] = r.normals[g * 3 + 2]!
        uv[k * 2] = x / 9
        uv[k * 2 + 1] = -z / 9
        if (i < nw - 1 && j < nd - 1) {
          const a = k, b = a + 1, c = a + nw, e = c + 1
          idx[t++] = a; idx[t++] = c; idx[t++] = b
          idx[t++] = b; idx[t++] = c; idx[t++] = e
        }
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = `terrainRing-${q}`
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    meshes.push(mesh)
  })
  return meshes
}

// ---------------------------------------------------------------- the skyline

/** `#include <fog_vertex>` with the depth compressed beyond RIDGE_FOG_KNEE_M (see the module comment). */
const RIDGE_FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  {
    float ridgeD = -mvPosition.z;
    vFogDepth = ridgeD <= ${RIDGE_FOG_KNEE_M.toFixed(1)} ? ridgeD : ${RIDGE_FOG_KNEE_M.toFixed(1)} + (ridgeD - ${RIDGE_FOG_KNEE_M.toFixed(1)}) * ${RIDGE_FOG_SLOPE.toFixed(3)};
  }
#endif
`

function smoothstep(a: number, b: number, t: number): number {
  t = (t - a) / (b - a)
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/**
 * The skyline mesh from DEM_FAR at `q.ridgeCellM` (a multiple of the grid's 500 m step; 500 on
 * the high tier, 1000 on the low). Heights in project metres (ASL − datum); the sea cells are
 * 0 m ASL and keep their sentinel for the colour.
 *
 * Under the ring: cells whose four nodes all lie inside the ring rectangle are skipped, and the
 * nodes inside it that the straddling cells still reference are MOVED onto the rectangle's edge
 * (the nearest edge; onto the corner when the node is the corner cell's only inner node — a
 * vertex on one edge joined to a node beyond the other edge would cut back into the rectangle)
 * at the lowest ring edge height along the far cell they cover, minus RIDGE_UNDER_RING_M. A
 * 500 m block mean sits up to ±15 m off the real ground at the ring's edge, so lowering the
 * nodes by a constant could not keep the straddling triangles under the ring; a vertex row on
 * the edge at the ring's own height can.
 */
export function buildFarRidge(terrain: Terrain, q: Quality): { mesh: THREE.Mesh; stats: TerrainFarStats['ridge'] } {
  const g = DEM_FAR
  const stride = Math.max(1, Math.round(q.ridgeCellM / g.step))
  const cellM = stride * g.step * terrain.enScale
  const raw = decodeI16Delta(g.data)
  const scale = terrain.enScale
  const r = terrain.ring
  const rx0 = r.x0, rz0 = r.z0, rx1 = r.x0 + (r.nx - 1) * r.dx, rz1 = r.z0 + (r.nz - 1) * r.dz
  const inRing = (x: number, z: number) => x >= rx0 && x <= rx1 && z >= rz0 && z <= rz1
  /**
   * The lowest ring node on the rectangle's edge nearest (x, z), over ± two far cells along it —
   * wide enough that every point of the edge between two moved vertices (up to 2 cells apart
   * next to a corner) lies in BOTH vertices' windows, so their chord stays under the ring.
   */
  const ringEdgeMin = (x: number, z: number, along: 'x' | 'z'): number => {
    let m = Infinity
    const win = 2 * cellM
    if (along === 'x') {
      const j = z <= rz0 ? 0 : r.nz - 1
      const i0 = Math.max(0, Math.floor((x - win - r.x0) / r.dx)), i1 = Math.min(r.nx - 1, Math.ceil((x + win - r.x0) / r.dx))
      for (let i = i0; i <= i1; i++) m = Math.min(m, r.heights[j * r.nx + i]!)
    } else {
      const i = x <= rx0 ? 0 : r.nx - 1
      const j0 = Math.max(0, Math.floor((z - win - r.z0) / r.dz)), j1 = Math.min(r.nz - 1, Math.ceil((z + win - r.z0) / r.dz))
      for (let j = j0; j <= j1; j++) m = Math.min(m, r.heights[j * r.nx + i]!)
    }
    return m
  }
  // node grid of the mesh: every `stride`-th DEM node, the last column / row included when it falls short
  const cols: number[] = []
  for (let i = 0; i < g.cols; i += stride) cols.push(i)
  if (cols[cols.length - 1] !== g.cols - 1) cols.push(g.cols - 1)
  const rows: number[] = []
  for (let j = 0; j < g.rows; j += stride) rows.push(j)
  if (rows[rows.length - 1] !== g.rows - 1) rows.push(g.rows - 1)
  const nw = cols.length, nd = rows.length
  const n = nw * nd
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3)
  const asl = new Float32Array(n), sea = new Uint8Array(n), origIn = new Uint8Array(n)
  let yMin = Infinity, yMax = -Infinity, moved = 0
  const rng = mulberry(4013)
  for (let j = 0; j < nd; j++) {
    for (let i = 0; i < nw; i++) {
      const k = j * nw + i
      const v = raw[rows[j]! * g.cols + cols[i]!]!
      const isSea = g.sea !== undefined && v === g.sea
      const h = isSea ? 0 : v * g.unit
      asl[k] = h
      sea[k] = isSea ? 1 : 0
      pos[k * 3] = (g.e0 + cols[i]! * g.step) * scale
      pos[k * 3 + 1] = h - DEM_DATUM_ASL
      pos[k * 3 + 2] = -(g.n0 - rows[j]! * g.step) * scale
      origIn[k] = inRing(pos[k * 3]!, pos[k * 3 + 2]!) ? 1 : 0
    }
  }
  // the nodes inside the ring rectangle: onto its edge (see above). A node's neighbours decide
  // whether it is a corner cell's only inner node: both the west/east and the north/south
  // neighbour outside the rectangle → the corner.
  const nodeIn = (i: number, j: number) => i >= 0 && i < nw && j >= 0 && j < nd && origIn[j * nw + i] === 1
  for (let j = 0; j < nd; j++) {
    for (let i = 0; i < nw; i++) {
      const k = j * nw + i
      const x = pos[k * 3]!, z = pos[k * 3 + 2]!
      if (!inRing(x, z)) continue
      const xOut = !nodeIn(i - 1, j) || !nodeIn(i + 1, j), zOut = !nodeIn(i, j - 1) || !nodeIn(i, j + 1)
      if (!xOut && !zOut) continue // interior: no straddling cell references it
      const dxEdge = Math.min(x - rx0, rx1 - x), dzEdge = Math.min(z - rz0, rz1 - z)
      const toX = xOut && (!zOut || dxEdge <= dzEdge) // move in x (onto the west / east edge)
      let nx = x, nz = z
      if (xOut && zOut) {
        // the corner cell's inner node: onto the corner
        nx = x - rx0 < rx1 - x ? rx0 : rx1
        nz = z - rz0 < rz1 - z ? rz0 : rz1
      } else if (toX) nx = x - rx0 < rx1 - x ? rx0 : rx1
      else nz = z - rz0 < rz1 - z ? rz0 : rz1
      const edgeMin = xOut && zOut ? Math.min(ringEdgeMin(nx, nz, 'x'), ringEdgeMin(nx, nz, 'z')) : ringEdgeMin(nx, nz, toX ? 'z' : 'x')
      pos[k * 3] = nx
      pos[k * 3 + 1] = Math.min(pos[k * 3 + 1]!, edgeMin) - RIDGE_UNDER_RING_M
      pos[k * 3 + 2] = nz
      moved++
    }
  }
  for (let k = 0; k < n; k++) {
    const y = pos[k * 3 + 1]!
    if (y < yMin) yMin = y
    if (y > yMax) yMax = y
  }
  // colours: height bands, slope from the neighbours (one-sided at the grid's edge)
  const cSea = new THREE.Color(RIDGE_COLOURS.sea), cPlain = new THREE.Color(RIDGE_COLOURS.plain)
  const cForest = new THREE.Color(RIDGE_COLOURS.forest), cCedar = new THREE.Color(RIDGE_COLOURS.cedar), cScree = new THREE.Color(RIDGE_COLOURS.scree)
  const c = new THREE.Color()
  for (let j = 0; j < nd; j++) {
    for (let i = 0; i < nw; i++) {
      const k = j * nw + i
      if (sea[k]) {
        c.copy(cSea)
      } else {
        const h = asl[k]!
        const il = Math.max(0, i - 1), ir = Math.min(nw - 1, i + 1), ju = Math.max(0, j - 1), jd = Math.min(nd - 1, j + 1)
        const dhx = (asl[j * nw + ir]! - asl[j * nw + il]!) / Math.abs(pos[(j * nw + ir) * 3]! - pos[(j * nw + il) * 3]! || 1)
        const dhz = (asl[jd * nw + i]! - asl[ju * nw + i]!) / Math.abs(pos[(jd * nw + i) * 3 + 2]! - pos[(ju * nw + i) * 3 + 2]! || 1)
        const slope = Math.hypot(dhx, dhz)
        // plains → forest over 30–60 m, forest → cedar over 200–600 m, scree by slope above 600 m
        c.copy(cPlain).lerp(cForest, smoothstep(PLAIN_TOP_ASL, PLAIN_TOP_ASL * 2, h))
        c.lerp(cCedar, smoothstep(FOREST_TOP_ASL, CEDAR_ASL, h))
        c.lerp(cScree, smoothstep(CEDAR_ASL, CEDAR_ASL + 300, h) * smoothstep(0.25, 0.7, slope))
        // a little per-node variation so the bands do not read as contour lines
        c.multiplyScalar(0.96 + rng() * 0.08)
      }
      col[k * 3] = c.r
      col[k * 3 + 1] = c.g
      col[k * 3 + 2] = c.b
    }
  }
  const idx: number[] = []
  let skipped = 0, cells = 0
  for (let j = 0; j < nd - 1; j++) {
    for (let i = 0; i < nw - 1; i++) {
      const a = j * nw + i, b = a + 1, d = a + nw, e = d + 1
      // a cell is under the ring when all four nodes were inside the rectangle before the move
      const inner = origIn[a]! + origIn[b]! + origIn[d]! + origIn[e]!
      if (inner === 4) {
        skipped++
        continue
      }
      cells++
      // the corner cell (one inner node, now on the corner): split along the diagonal through
      // it, so each triangle is the corner plus two nodes beyond the same edge and stays outside
      if (inner === 1 && (origIn[a] || origIn[e])) idx.push(a, d, e, a, e, b)
      else idx.push(a, d, b, b, d, e)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', RIDGE_FOG_VERTEX)
  }
  mat.customProgramCacheKey = () => 'ridge'
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'terrainFar'
  mesh.receiveShadow = false
  mesh.castShadow = false
  mesh.matrixAutoUpdate = false
  return { mesh, stats: { triangles: idx.length / 3, cells, skipped, moved, yMin, yMax } }
}

// ---------------------------------------------------------------- the water

/** proper crossing of two segments (shared endpoints and touching ends do not count) — facilities-check A9's test */
function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx)
  if (Math.abs(d) < 1e-12) return false
  const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d
  const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
}

/** true when no two non-adjacent edges of the ring cross */
export function isSimpleRing(ring: [number, number][]): boolean {
  const n = ring.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = ring[i]!, b = ring[(i + 1) % n]!, c = ring[j]!, d = ring[(j + 1) % n]!
      if (segmentsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return false
    }
  }
  return true
}

/**
 * A 4 m ripple normal for the still water: a few crossed low-amplitude waves, tileable, as a
 * DataTexture (no canvas, so the Node harness and the low tier see the same bytes). Tier-scaled
 * through `scaled`, which puts textureScale in the cache key.
 */
export function waterRippleNormal(): THREE.DataTexture {
  const [w, h] = scaled(128, 128)
  return cached(`water-ripple-${w}`, () => {
    const data = new Uint8Array(w * h * 4)
    const waves: [number, number, number][] = [[3, 1, 0.5], [-2, 4, 0.35], [5, -3, 0.2], [1, 7, 0.15]]
    const hgt = (u: number, v: number) => {
      let s = 0
      for (const [a, b, amp] of waves) s += Math.sin(2 * Math.PI * (a * u + b * v)) * amp
      return s
    }
    const eps = 1 / w
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h
        const dx = (hgt(u + eps, v) - hgt(u - eps, v)) / (2 * eps)
        const dy = (hgt(u, v + eps) - hgt(u, v - eps)) / (2 * eps)
        // 0.004: the height field is in "tile" units — keep the slopes a few degrees at most
        const nx = -dx * 0.004, ny = -dy * 0.004
        const inv = 1 / Math.hypot(nx, ny, 1)
        const k = (y * w + x) * 4
        data[k] = Math.round((nx * inv * 0.5 + 0.5) * 255)
        data[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255)
        data[k + 2] = Math.round((inv * 0.5 + 0.5) * 255)
        data[k + 3] = 255
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    tex.colorSpace = THREE.NoColorSpace
    tex.needsUpdate = true
    return tex
  })
}

/** the water planes' opacity: the bed shows a little through the surface at the shore */
export const WATER_OPACITY = 0.9

/**
 * The still-water material every water plane of the scene shares — the far beds (below) and
 * the infield ponds (infield-water.ts, I5-c): dark green-grey, low roughness, the 4 m ripple
 * normal, transparent at WATER_OPACITY without a depth write. ONE parameter set on purpose:
 * three keys its programs by the material's defines (map / normalMap / OPAQUE / …), so every
 * caller gets its own instance of the same combination and the whole scene's water is one
 * program. (The far water used to be opaque; `transparent` clears the OPAQUE define, so the
 * two would otherwise be two programs.)
 */
export function waterFarMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x33443f, roughness: 0.15, metalness: 0, normalMap: waterRippleNormal(), transparent: true, opacity: WATER_OPACITY, depthWrite: false })
  mat.normalScale.set(0.35, 0.35)
  return mat
}

/**
 * One mesh over every water bed: the ring triangulated with ShapeUtils (earcut) after the same
 * simple-polygon test facilities-check applies to the GROUND_AREAS outlines; a self-crossing ring
 * is dropped with a warning rather than drawn as overlapping faces. The plane sits
 * WATER_PLANE_DROP_M under the bed's shoreline; dem.ts sank the bed 1.5 m under it.
 */
export function buildWaterPlanes(beds: WaterBed[]): { mesh: THREE.Mesh | null; stats: TerrainFarStats['water'] } {
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  let dropped = 0, count = 0
  for (const b of beds) {
    if (b.ring.length < 3 || !isSimpleRing(b.ring)) {
      dropped++
      console.warn(`[terrain-far] water bed ${b.id}: ring is not a simple polygon, dropped`)
      continue
    }
    const contour = b.ring.map(([x, z]) => new THREE.Vector2(x, -z))
    const faces = THREE.ShapeUtils.triangulateShape(contour, [])
    if (!faces.length) {
      dropped++
      console.warn(`[terrain-far] water bed ${b.id}: no triangles, dropped`)
      continue
    }
    const base = pos.length / 3
    const y = b.level - WATER_PLANE_DROP_M
    for (const [x, z] of b.ring) {
      pos.push(x, y, z)
      uv.push(x / 4, -z / 4)
    }
    // earcut keeps the ring's winding, whichever it is: orient every face so its normal is +y
    for (const f of faces) {
      const a = b.ring[f[0]!]!, c1 = b.ring[f[1]!]!, c2 = b.ring[f[2]!]!
      const ny = (c1[1] - a[1]) * (c2[0] - a[0]) - (c1[0] - a[0]) * (c2[1] - a[1])
      if (ny >= 0) idx.push(base + f[0]!, base + f[1]!, base + f[2]!)
      else idx.push(base + f[0]!, base + f[2]!, base + f[1]!)
    }
    count++
  }
  if (!count) return { mesh: null, stats: { triangles: 0, beds: 0, dropped } }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  const mesh = new THREE.Mesh(geo, waterFarMaterial())
  mesh.name = 'water-far'
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  return { mesh, stats: { triangles: idx.length / 3, beds: count, dropped } }
}

// ---------------------------------------------------------------- all three

/**
 * Build the ring, the skyline and the water and add them under `terrain.group` (so the viewport's
 * setupMaterials / freezeStatic cover them). Called by buildEnvironment right after the Terrain,
 * before anything stands on the ground; the ring mesh material binds the OUTER land-cover layer.
 */
export function buildTerrainFar(terrain: Terrain, q: Quality, assets: AssetRegistry | null, outerCover: CoverLayer | null): TerrainFarStats {
  const t0 = performance.now()
  const ring = buildTerrainRing(terrain, assets, outerCover)
  let ringTris = 0
  for (const m of ring) {
    terrain.group.add(m)
    ringTris += m.geometry.index!.count / 3
  }
  let ridge: TerrainFarStats['ridge'] = { triangles: 0, cells: 0, skipped: 0, moved: 0, yMin: 0, yMax: 0 }
  if (q.ridge) {
    const built = buildFarRidge(terrain, q)
    terrain.group.add(built.mesh)
    ridge = built.stats
  }
  const water = buildWaterPlanes(terrain.demField.waterBeds)
  if (water.mesh) terrain.group.add(water.mesh)
  return { ring: { triangles: ringTris, meshes: ring.length }, ridge, water: water.stats, buildMs: performance.now() - t0 }
}
