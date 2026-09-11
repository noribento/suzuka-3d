import * as THREE from 'three'
import { SPECTATOR_BANKS, STANDS } from '~/data/suzuka-facilities-spec'
import { Rng } from '~/sim/random'
import { ROLL_CAP, type Track } from '~/sim/track'
import { makeGround, settleGround, type Ground } from './ground'
import { makeField, type GroundField } from './ground-field'
import { buildGroundPlan, type GroundPlan } from './ground-plan'
import { buildGroundMeshes, isGroundFace, type BuiltGround, type GroundFace } from './ground-mesh'
import { groundMaterials } from './ground-materials'
import { buildCrowd, type Crowd } from './crowd'
import { grassSurfaceMaterial } from './materials'
import { QUALITY, type Quality } from './quality'
import { BoxPlacer } from './boxes'
import type { AssetRegistry } from './assets'
import { buildStands, facilityRelief, lateralBackMax, type StandsStats } from './stands'
import { demFieldFor, type DemField } from './dem'
import { buildLandCover, type CoverLayer, type CoverRect, type LandCover } from './landcover'
import { buildTerrainFar, RIDGE_COLOURS, type TerrainFarStats } from './terrain-far'
import { buildPitComplex } from './pit-complex'
import { buildTracksideProps } from './props'
import { buildLanes } from './lanes'
import { buildFerrisWheel, buildTrees } from './vegetation'
import { buildStructures } from './structures'
import { buildForest } from './forest'
import { buildSurroundings } from './surroundings'
import { FarField } from './farfield'
import { buildTreeLibrary, tickTrees, type TreeLibrary } from './trees'

/** Which side of the track a trackside camera should stand on — lives with the props, re-exported for the camera rig. */
export { cameraSide } from './props'

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/** Softplus ramp: max(0, x) with the corner rounded over ±k metres (keeps the terrain mesh smooth). */
function softRamp(x: number, k: number): number {
  const t = x / k
  return t > 20 ? x : k * Math.log1p(Math.exp(t))
}

/** How far the terrain sits below the road plane next to the track. */
const ROAD_CUT = 0.12
/** Slope (rise per metre) of the embankment between a road and lower ground beside it. */
const FILL_SLOPE = 0.35
/** Radius of the road-plane blend, metres. */
const ROAD_R = 140
// NOTE (P6): rounding the crease where the cap meets the ground (a smooth minimum over ±2 m)
// was tried and reverted — the fillet's own curvature chorded the 2 m raster cells worse than
// the crease did (the asphalt band's median deviation went 2.7 → 9.3 mm).
/** Decay of the cross-fade towards the nearest road, metres: e^-5 for a road 30 m further away. */
const ROAD_FALLOFF = 6
/**
 * Where the road-plane IDW gives way to the real DEM (plan §1b): the blend weight is
 * smoothstep((near − DEM_BLEND[0]) / (DEM_BLEND[1] − DEM_BLEND[0])), 0 inside DEM_BLEND[0] of
 * the nearest centreline sample and 1 at ROAD_R. The inner edge is beyond surface-check's G5
 * reach (it samples the field out to hw 7.5 + 34 = 41.5 m), so the DEM never enters the road
 * verge and the partition's allowances move only where the ground really curves (P6s). The
 * plan's first choice was 45 m; at 45 the paddock apron behind the pit building took the DEM's
 * curvature at 50 % weight 90 m out and its G3 went 0.2 → 4.3 %, the "kind explodes" case the
 * plan answers by widening to 60 before raising the row.
 */
const DEM_BLEND: readonly [number, number] = [60, ROAD_R]
/** the coarse ring outside the height grid is meshed at K × the grid's spacing (terrain-far.ts) */
const RING_K = 4
/** the height grid's rectangle around track.center, metres */
const GRID_W = 3400
const GRID_D = 2600

/** The height grid's world rectangle for a track (what `Terrain.grid()` reports, before the Terrain exists). */
export function terrainRect(track: Track): CoverRect {
  return { x0: track.center.x - GRID_W / 2, z0: track.center.z - GRID_D / 2, w: GRID_W, d: GRID_D }
}

/** The coarse ring's world rectangle (terrain-far.ts): `ringCells` cells of K × the grid spacing beyond `inner` on every side. */
export function ringRect(inner: CoverRect, grid: [number, number], ringCells: number): CoverRect {
  const ex = (ringCells * RING_K * inner.w) / grid[0], ez = (ringCells * RING_K * inner.d) / grid[1]
  return { x0: inner.x0 - ex, z0: inner.z0 - ez, w: inner.w + 2 * ex, d: inner.d + 2 * ez }
}

/**
 * A registered ground face (`Terrain.addGroundFace`).
 *
 * Every drawn ground face MUST be registered: the height grid is 13.3 m (17.7 m on the low tier)
 * and the faces sit centimetres above it, so without the clamp the terrain rises straight through
 * them. Measured before this existed: the paddock apron behind the pit building was pierced over
 * 16.7 % of its area (worst 0.70 m), the secondary paving over 26.6 % (worst 2.75 m) and the
 * offset lanes over 13.6 % (worst 0.24 m).
 *
 * Only a GroundFace minted by ground-mesh.ts can register (plan rule R1): the partition is the one
 * source of opaque ground. Objects standing on it (ground.ts GROUND_OBJECTS) and decals are never
 * registered — they read the drawn faces through `Ground.standY` / `Ground.decalY`.
 */
interface GroundSheet {
  geo: THREE.BufferGeometry
  /** declared clearance the terrain must keep below the face (m) */
  margin: number
  /** cap on how far one grid node may be cut below its analytic height (m) */
  maxDrop: number
  /** for the dev diagnostics and the offline audit */
  name: string
}

/**
 * The coarse height grid that continues the terrain rectangle outward (plan §1c): K × the inner
 * spacing, `cellsX` / `cellsZ` cells beyond the rectangle on every side, and the nodes INSIDE the
 * rectangle too (they coincide with every K-th inner node, whose boundary run is snapped linear
 * so the two meshes share their edge without T-junctions). Heights are the far field with the
 * facility relief applied — the same numbers `heightAt` gives out there. Read-only: computed at
 * construction (before the settle cuts, which never reach the boundary; the nodes inside the
 * rectangle are the analytic heights and are not meshed), meshed by terrain-far.ts, sampled by
 * `meshHeightAt` outside the rectangle.
 */
export interface TerrainRing {
  k: number
  cellsX: number
  cellsZ: number
  /** node spacing (K × the inner grid's) */
  dx: number
  dz: number
  /** world position of node (0, 0) — cellsX / cellsZ cells outside the inner rectangle */
  x0: number
  z0: number
  /** node counts per axis (cells + 1) */
  nx: number
  nz: number
  /** row-major `heights[j * nx + i]` */
  heights: Float32Array
  /**
   * unit normal per node (`normals[3 * (j * nx + i)]`), central differences on the ring's own
   * nodes — except across the inner rectangle's edge, where the inward neighbour is the inner
   * grid's node one inner spacing in (the asymmetric difference `refresh` uses for the same
   * nodes), so both meshes shade the seam identically
   */
  normals: Float32Array
}

/** Terrain that hugs the track elevation and follows the real DEM (dem.ts) further out. */
export class Terrain {
  /** Terrain chunks (a 4×4 grid so follow cameras can frustum-cull the far side). */
  readonly group: THREE.Group
  /** the real height field the far term and the ring come from */
  private readonly dem: DemField
  /** the coarse ring around the height grid (see TerrainRing) */
  readonly ring: TerrainRing
  /**
   * The flat paddock / grandstand apron along the main straight.
   *
   * It has to cover every surface that is drawn ON the road plane out there, or that surface
   * stands on natural ground while its neighbours stand on the shelf. It used to stop at
   * s 5540-90 and lateral -100, which left the outer 25 m of the paddock apron
   * (`pit-complex.ts` drapes it to -125) and both ends of the pit concrete apron
   * (`track-mesh.ts`, s 5520-180) off the shelf.
   */
  private readonly flatZone = { from: 5500, to: 200, latMin: -130, latMax: 66 }
  private readonly NX: number
  private readonly NZ: number
  private readonly CH = 4
  private readonly x0: number
  private readonly z0: number
  private readonly dx: number
  private readonly dz: number
  private readonly heights: Float32Array
  private readonly chunks: THREE.Mesh[] = []
  /** tan(roll) and half-width + the embankment toe, per centreline sample (heightAt is hot) */
  private readonly tanRoll: Float64Array
  private readonly fillToe: Float64Array
  /** scratch for one heightAt call: the samples inside ROAD_R, gathered once */
  private readonly sDist = new Float64Array(4096)
  private readonly sPlane = new Float64Array(4096)
  private readonly sToe = new Float64Array(4096)
  private sN = 0
  private qx = 0
  private qz = 0
  private nearD2 = Infinity
  private nearI = -1

  /**
   * `assets`: the asset pack (null / empty on the low tier); the track meshes read it from here.
   * `cover`: the INNER land-cover layer (landcover.ts) the chunk material binds; the ring built
   * later by terrain-far.ts binds the outer one.
   */
  constructor(private track: Track, grid: [number, number] = [256, 192], readonly assets: AssetRegistry | null = null, ringCells = 25, cover: CoverLayer | null = null) {
    this.NX = grid[0]
    this.NZ = grid[1]
    // the boundary snap and the ring need every K-th node to be a real node of both grids
    if (this.NX % RING_K !== 0 || this.NZ % RING_K !== 0) throw new Error(`Terrain: grid ${this.NX} × ${this.NZ} must be a multiple of ${RING_K} (quality.ts terrain)`)
    this.dem = demFieldFor(track)
    const w = GRID_W, d = GRID_D
    const cx = track.center.x, cz = track.center.z
    // sample one height grid, then cut it into chunks that share edge vertices (and normals
    // computed from the full grid, so the chunk seams are invisible)
    const gx = this.NX + 1, gz = this.NZ + 1
    this.heights = new Float32Array(gx * gz)
    this.x0 = cx - w / 2
    this.z0 = cz - d / 2
    this.dx = w / this.NX
    this.dz = d / this.NZ
    this.tanRoll = new Float64Array(track.n)
    this.fillToe = new Float64Array(track.n)
    for (let i = 0; i < track.n; i++) {
      this.tanRoll[i] = Math.tan(track.roll[i]!)
      this.fillToe[i] = track.hw[i]! + 6
    }
    for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) this.heights[j * gx + i] = this.heightAt(this.x0 + i * this.dx, this.z0 + j * this.dz)
    this.snapBoundary()
    this.ring = this.buildRing(ringCells)
    // terrain uv = xz / 9; withered_grass at its 2 m tile on the high tier, the procedural SEASON
    // tile otherwise, one macro period every 250 m either way (materials.ts grassSurfaceMaterial)
    const mat = grassSurfaceMaterial(assets, [9, 9], [250, 250], 0.7, cover)
    this.group = new THREE.Group()
    this.group.name = 'terrain'
    const cw = this.NX / this.CH, cd = this.NZ / this.CH
    for (let cj = 0; cj < this.CH; cj++) {
      for (let ci = 0; ci < this.CH; ci++) {
        const n = (cw + 1) * (cd + 1)
        const idx: number[] = []
        const uv = new Float32Array(n * 2)
        for (let j = 0; j <= cd; j++) {
          for (let i = 0; i <= cw; i++) {
            const gi = ci * cw + i, gj = cj * cd + j
            const k = j * (cw + 1) + i
            uv[k * 2] = (this.x0 + gi * this.dx) / 9
            uv[k * 2 + 1] = -(this.z0 + gj * this.dz) / 9
            if (i < cw && j < cd) {
              const a = k
              const b = a + 1
              const c = a + cw + 1
              const e = c + 1
              idx.push(a, c, b, b, c, e)
            }
          }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
        geo.setIndex(idx)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.receiveShadow = true
        mesh.matrixAutoUpdate = false
        mesh.userData.chunk = [ci, cj]
        this.group.add(mesh)
        this.chunks.push(mesh)
      }
    }
    // a flat skirt far beyond the ring and the skyline: the overview camera looks past them, and
    // without ground there the Sky shader's below-horizon colours show through. It sits 1 m under
    // the lowest land node of DEM_FAR (the sea is lower still, but it is drawn by the skyline mesh)
    // in the skyline's plain colour — at 35 km it is fog anyway, a grass tile would only alias
    const skirtSize = 100000
    const skirtGeo = new THREE.PlaneGeometry(skirtSize, skirtSize, 1, 1)
    const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({ color: RIDGE_COLOURS.plain, roughness: 1, metalness: 0 }))
    skirt.rotation.x = -Math.PI / 2
    skirt.position.set(cx, this.dem.farLandMin - 1, cz)
    skirt.receiveShadow = false
    skirt.name = 'terrainSkirt'
    skirt.updateMatrix()
    skirt.matrixAutoUpdate = false
    this.group.add(skirt)
  }

  /**
   * Make the height grid's outermost run of nodes piecewise linear between every K-th node, so
   * the coarse ring (K × the spacing) shares the boundary exactly: every ring node on the
   * boundary IS an inner node, and between two of them both meshes interpolate linearly.
   */
  private snapBoundary() {
    const gx = this.NX + 1, gz = this.NZ + 1
    const H = this.heights
    const snapRun = (at: (t: number) => number, count: number) => {
      for (let a = 0; a + RING_K <= count - 1; a += RING_K) {
        const h0 = H[at(a)]!, h1 = H[at(a + RING_K)]!
        for (let s = 1; s < RING_K; s++) H[at(a + s)] = h0 + ((h1 - h0) * s) / RING_K
      }
    }
    snapRun((i) => i, gx)
    snapRun((i) => this.NZ * gx + i, gx)
    snapRun((j) => j * gx, gz)
    snapRun((j) => j * gx + this.NX, gz)
  }

  /**
   * Sample the coarse ring (see TerrainRing): `cells` cells beyond the rectangle on every side at
   * K × the inner spacing, every node from `heightAt` (the far field plus the facility relief).
   * The nodes inside the rectangle coincide with every K-th inner node; the dev build measures
   * the difference and prints it.
   */
  private buildRing(cells: number): TerrainRing {
    const k = RING_K
    const dx = this.dx * k, dz = this.dz * k
    const nx = this.NX / k + 2 * cells + 1, nz = this.NZ / k + 2 * cells + 1
    const x0 = this.x0 - cells * dx, z0 = this.z0 - cells * dz
    const heights = new Float32Array(nx * nz)
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = this.heightAt(x0 + i * dx, z0 + j * dz)
    // normals: central differences on the ring; across the inner rectangle's edge the inward
    // neighbour is the inner grid's node one inner spacing in (see TerrainRing.normals / refresh)
    const gx = this.NX + 1
    const H = this.heights
    const normals = new Float32Array(nx * nz * 3)
    const iW = cells, iE = cells + this.NX / k, jN = cells, jS = cells + this.NZ / k
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const g = j * nx + i
        const onEdgeZ = j >= jN && j <= jS, onEdgeX = i >= iW && i <= iE
        let sx: number, sz: number
        if (i === iW && onEdgeZ) {
          // west edge: the ring node one ring spacing out, the inner node one inner spacing in
          sx = (heights[g - 1]! - H[(j - jN) * k * gx + 1]!) / (dx + this.dx)
        } else if (i === iE && onEdgeZ) {
          sx = (H[(j - jN) * k * gx + this.NX - 1]! - heights[g + 1]!) / (this.dx + dx)
        } else {
          const il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1)
          sx = (heights[j * nx + il]! - heights[j * nx + ir]!) / ((ir - il) * dx)
        }
        if (j === jN && onEdgeX) {
          sz = (heights[g - nx]! - H[gx + (i - iW) * k]!) / (dz + this.dz)
        } else if (j === jS && onEdgeX) {
          sz = (H[(this.NZ - 1) * gx + (i - iW) * k]! - heights[g + nx]!) / (this.dz + dz)
        } else {
          const ju = Math.max(0, j - 1), jd = Math.min(nz - 1, j + 1)
          sz = (heights[ju * nx + i]! - heights[jd * nx + i]!) / ((jd - ju) * dz)
        }
        const inv = 1 / Math.hypot(sx, 1, sz)
        normals[g * 3] = sx * inv
        normals[g * 3 + 1] = inv
        normals[g * 3 + 2] = sz * inv
      }
    }
    if (import.meta.dev) {
      let worst = 0
      for (let j = 0; j <= this.NZ / k; j++) {
        for (let i = 0; i <= this.NX / k; i++) {
          const dh = Math.abs(heights[(j + cells) * nx + i + cells]! - this.heights[j * k * gx + i * k]!)
          if (dh > worst) worst = dh
        }
      }
      console.info(`[terrain] ring ${nx} × ${nz} nodes at ${dx.toFixed(1)} × ${dz.toFixed(1)} m, inner-node max |Δ| ${worst.toExponential(2)} m`)
    }
    return { k, cellsX: cells, cellsZ: cells, dx, dz, x0, z0, nx, nz, heights, normals }
  }

  /** world metres per EN metre of the track's projection (the DEM grids are in EN) */
  get enScale(): number {
    return this.track.enScale
  }

  /** The real height field beyond the road blend (dem.ts): the ring, the skyline and the water read this. */
  farField(x: number, z: number): number {
    return this.dem.height(x, z)
  }

  /** The DEM field itself, for the far-field builders that need its water beds or extent. */
  get demField(): DemField {
    return this.dem
  }

  // --- registered ground sheets ----------------------------------------------------------------
  private readonly sheets: GroundSheet[] = []
  private settled = false
  /** geometry uuids the clamp has been applied to — what the audit and the e2e check */
  readonly clamped = new Set<string>()
  /** dev diagnostics: nodes whose drop was capped by `maxDrop` (a sign of a sheet cutting a canyon) */
  readonly clampCapped: { name: string; x: number; z: number; needed: number }[] = []
  /** how long settle() took, surfaced through window.__suzuka and scripts/perf-probe.mjs */
  settleMs = 0

  /**
   * Register one drawn ground face (ground-mesh.ts): `settle()` then pushes every grid triangle
   * it covers at least 0.1 m underneath it. Only a face minted by `buildGroundMeshes` is accepted:
   * the partition is the one source of opaque ground, so nothing else can claim to be it.
   *
   * Registering is the ONLY thing that protects a face; the dev sweep in RaceViewport and
   * `scripts/audit/surface-check.mjs` (G6, G8) catch one that is not.
   */
  addGroundFace(face: GroundFace) {
    if (!isGroundFace(face)) {
      console.error('[terrain] addGroundFace: not a GroundFace minted by buildGroundMeshes — refused')
      return
    }
    const name = face.mesh.name
    if (this.settled) {
      console.error(`[terrain] addGroundFace('${name}') called after settle() — the face is unprotected`)
      return
    }
    // maxDrop 12: the deepest cut the ground needs is ~9.4 m, where the verge meets the relief
    // platform E-1 stands on; the cap bounds a runaway and surface-check reports what it refuses
    const reg: Omit<GroundSheet, 'geo'> = { margin: 0.1, maxDrop: 12, name }
    face.geo.userData.groundReg = reg
    this.sheets.push({ geo: face.geo, ...reg })
  }

  /** The registrations, for scripts/audit/surface-check.mjs. */
  get groundSheets(): readonly GroundSheet[] {
    return this.sheets
  }

  /**
   * Push the grid under every registered face. Called by buildEnvironment as soon as the ground
   * faces exist and BEFORE anything stands on the ground, so `Ground.standY` reads the settled
   * mesh; the stands cut the grid further under their decks afterwards (`clampUnder`), and
   * `commit()` uploads it once at the end.
   */
  settle() {
    if (this.settled) return
    const t0 = performance.now()
    this.settled = true
    this.clampUnderSheets()
    for (const s of this.sheets) this.clamped.add(s.geo.uuid)
    this.settleMs = performance.now() - t0
    if (import.meta.dev) {
      const capped = this.clampCapped.length
      console.info(`[terrain] settle: ${this.sheets.length} ground faces, ${this.settleMs.toFixed(1)} ms` + (capped ? `, ${capped} nodes hit maxDrop` : ''))
      if (capped) for (const c of this.clampCapped.slice(0, 8)) console.warn(`[terrain] ${c.name}: node at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) needed ${c.needed.toFixed(2)} m of cut`)
    }
  }

  private committed = false
  /**
   * First upload of the vertex data, once every cut is in (the faces' settle, the decks'
   * clampUnder). A later clampUnder re-uploads only the chunks it touches. The skirt stays where
   * the constructor put it (under the lowest land of DEM_FAR; no cut reaches that deep).
   */
  commit() {
    if (this.committed) return
    this.committed = true
    this.refresh()
  }

  /**
   * The height grid's geometry (origin, spacing, node counts, extent) — read-only, no heights.
   * The far field lays its 250 m cells over this rectangle.
   */
  grid(): { x0: number; z0: number; dx: number; dz: number; nx: number; nz: number; w: number; d: number } {
    return { x0: this.x0, z0: this.z0, dx: this.dx, dz: this.dz, nx: this.NX, nz: this.NZ, w: this.dx * this.NX, d: this.dz * this.NZ }
  }

  /** Index (0..15) of the 4×4 terrain chunk containing world (x, z) — the tree bucket key. */
  chunkIndex(x: number, z: number): number {
    const ci = THREE.MathUtils.clamp(Math.floor(((x - this.x0) / (this.dx * this.NX)) * this.CH), 0, this.CH - 1)
    const cj = THREE.MathUtils.clamp(Math.floor(((z - this.z0) / (this.dz * this.NZ)) * this.CH), 0, this.CH - 1)
    return ci + cj * this.CH
  }

  /** Re-upload vertex positions and normals from the height grid (only the chunks in `dirty` when given). */
  private refresh(dirty?: Set<number>) {
    const gx = this.NX + 1
    const H = this.heights
    const r = this.ring
    const cw = this.NX / this.CH, cd = this.NZ / this.CH
    for (const mesh of this.chunks) {
      const [ci, cj] = mesh.userData.chunk as [number, number]
      if (dirty && !dirty.has(ci + cj * this.CH)) continue
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
      const nrm = mesh.geometry.attributes.normal as THREE.BufferAttribute
      for (let j = 0; j <= cd; j++) {
        for (let i = 0; i <= cw; i++) {
          const gi = ci * cw + i, gj = cj * cd + j
          const k = j * (cw + 1) + i
          const x = this.x0 + gi * this.dx, z = this.z0 + gj * this.dz
          const y = H[gj * gx + gi]!
          // across the grid's edge the outward neighbour is the ring one ring spacing out (the
          // asymmetric difference of TerrainRing.normals), so the seam shades the same from both sides
          let nx: number, nz: number
          if (gi === 0) nx = (this.ringHeightAt(x - r.dx, z) - H[gj * gx + 1]!) / (r.dx + this.dx)
          else if (gi === this.NX) nx = (H[gj * gx + gi - 1]! - this.ringHeightAt(x + r.dx, z)) / (this.dx + r.dx)
          else nx = (H[gj * gx + gi - 1]! - H[gj * gx + gi + 1]!) / (2 * this.dx)
          if (gj === 0) nz = (this.ringHeightAt(x, z - r.dz) - H[gx + gi]!) / (r.dz + this.dz)
          else if (gj === this.NZ) nz = (H[(gj - 1) * gx + gi]! - this.ringHeightAt(x, z + r.dz)) / (this.dz + r.dz)
          else nz = (H[(gj - 1) * gx + gi]! - H[(gj + 1) * gx + gi]!) / (2 * this.dz)
          const inv = 1 / Math.hypot(nx, 1, nz)
          pos.setXYZ(k, x, y, z)
          nrm.setXYZ(k, nx * inv, inv, nz * inv)
        }
      }
      pos.needsUpdate = true
      nrm.needsUpdate = true
      mesh.geometry.computeBoundingSphere()
      mesh.geometry.computeBoundingBox()
    }
  }

  /**
   * Height of the rendered terrain mesh at (x, z) — the analytic surface sampled on the grid,
   * and outside the rectangle the coarse ring (bilinear on its cells, which is what terrain-far.ts
   * draws), clamped at the ring's outer edge.
   */
  meshHeightAt(x: number, z: number): number {
    const gx = this.NX + 1
    const H = this.heights
    const fu = (x - this.x0) / this.dx
    const fv = (z - this.z0) / this.dz
    if (fu < 0 || fv < 0 || fu > this.NX || fv > this.NZ) return this.ringHeightAt(x, z)
    const i = Math.min(this.NX - 1, Math.max(0, Math.floor(fu)))
    const j = Math.min(this.NZ - 1, Math.max(0, Math.floor(fv)))
    const u = Math.min(1, Math.max(0, fu - i)), v = Math.min(1, Math.max(0, fv - j))
    const a = j * gx + i, b = a + 1, c = a + gx, e = c + 1
    if (u + v <= 1) return H[a]! + u * (H[b]! - H[a]!) + v * (H[c]! - H[a]!)
    return H[e]! + (1 - u) * (H[c]! - H[e]!) + (1 - v) * (H[b]! - H[e]!)
  }

  /** Bilinear height on the coarse ring, clamped to its outer edge. */
  private ringHeightAt(x: number, z: number): number {
    const r = this.ring
    const cx = r.nx - 1, cz = r.nz - 1
    const fu = Math.min(cx, Math.max(0, (x - r.x0) / r.dx))
    const fv = Math.min(cz, Math.max(0, (z - r.z0) / r.dz))
    const i = Math.min(cx - 1, Math.floor(fu)), j = Math.min(cz - 1, Math.floor(fv))
    const u = fu - i, v = fv - j
    const k = j * r.nx + i
    const H = r.heights
    const a = H[k]! * (1 - u) + H[k + 1]! * u
    const b = H[k + r.nx]! * (1 - u) + H[k + r.nx + 1]! * u
    return a * (1 - v) + b * v
  }

  /**
   * Push the terrain below every registered ground sheet, exactly.
   *
   * The old point-sampled clamp (`clampUnder`) only lowered the ONE grid triangle that contained a
   * sample vertex, so a grid node inside a large sheet but far from any sample stayed high, and a
   * long thin sheet triangle could straddle a whole cell and violate in its interior. Here each
   * SHEET TRIANGLE is rasterised over the grid cells it covers: the grid triangle is clipped
   * against it in XZ (Sutherland-Hodgman, 3 half-planes) and the violation is evaluated at the
   * vertices of the intersection. Both surfaces are planar over that intersection, so their
   * difference is affine there and its maximum really is at a vertex — the result is exact, not a
   * sample. Lowering all three nodes of a grid triangle translates its plane down by that amount
   * everywhere, and lowering a shared node only lowers its other triangles further, so the pass is
   * monotone and one sweep suffices.
   *
   * The clip matters: lowering every node of the bounding box instead would drag the terrain down
   * by the sheet's extrapolated plane and cut a 13 m moat around every sheet edge. Clipped, the
   * pull is proportional to the actual overlap and vanishes at the boundary.
   */
  private clampUnderSheets() {
    const gx = this.NX + 1, gz = this.NZ + 1
    const H = this.heights
    const lower = new Float32Array(gx * gz)
    // scratch for the clipper: a triangle clipped by a triangle is a convex polygon of ≤ 6 vertices
    const inX = new Float64Array(8), inZ = new Float64Array(8)
    const outX = new Float64Array(8), outZ = new Float64Array(8)
    const ax = new Float64Array(3), az = new Float64Array(3)
    for (const sheet of this.sheets) {
      const pos = sheet.geo.attributes.position as THREE.BufferAttribute
      const index = sheet.geo.getIndex()
      const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3)
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
        const sax = pos.getX(i0), say = pos.getY(i0), saz = pos.getZ(i0)
        const sbx = pos.getX(i1), sby = pos.getY(i1), sbz = pos.getZ(i1)
        const scx = pos.getX(i2), scy = pos.getY(i2), scz = pos.getZ(i2)
        // plane of the sheet triangle; a vertical one (|n.y| ≈ 0) is a wall, not a sheet
        const ux = sbx - sax, uz = sbz - saz, uy = sby - say
        const vx = scx - sax, vz = scz - saz, vy = scy - say
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        if (Math.abs(ny) < 1e-7) continue
        const invNy = 1 / ny
        // grid cells the triangle's XZ bbox touches
        const minX = Math.min(sax, sbx, scx), maxX = Math.max(sax, sbx, scx)
        const minZ = Math.min(saz, sbz, scz), maxZ = Math.max(saz, sbz, scz)
        let ci0 = Math.floor((minX - this.x0) / this.dx), ci1 = Math.floor((maxX - this.x0) / this.dx)
        let cj0 = Math.floor((minZ - this.z0) / this.dz), cj1 = Math.floor((maxZ - this.z0) / this.dz)
        if (ci1 < 0 || cj1 < 0 || ci0 >= this.NX || cj0 >= this.NZ) continue
        if (ci0 < 0) ci0 = 0
        if (cj0 < 0) cj0 = 0
        if (ci1 > this.NX - 1) ci1 = this.NX - 1
        if (cj1 > this.NZ - 1) cj1 = this.NZ - 1
        // clipper edges, wound so that "inside" is a consistent sign
        const area2 = ux * vz - uz * vx
        const flip = area2 < 0 ? -1 : 1
        ax[0] = sax; az[0] = saz; ax[1] = sbx; az[1] = sbz; ax[2] = scx; az[2] = scz
        for (let cj = cj0; cj <= cj1; cj++) {
          for (let ci = ci0; ci <= ci1; ci++) {
            const x0 = this.x0 + ci * this.dx, z0 = this.z0 + cj * this.dz
            const a = cj * gx + ci, b = a + 1, c = a + gx, e = c + 1
            // the same b–c diagonal the index buffer and meshHeightAt use
            for (let half = 0; half < 2; half++) {
              const k0 = half === 0 ? a : b, k1 = half === 0 ? b : c, k2 = half === 0 ? c : e
              // grid triangle corners in world XZ
              if (half === 0) {
                inX[0] = x0; inZ[0] = z0
                inX[1] = x0 + this.dx; inZ[1] = z0
                inX[2] = x0; inZ[2] = z0 + this.dz
              } else {
                inX[0] = x0 + this.dx; inZ[0] = z0
                inX[1] = x0; inZ[1] = z0 + this.dz
                inX[2] = x0 + this.dx; inZ[2] = z0 + this.dz
              }
              let n = 3
              for (let edge = 0; edge < 3 && n; edge++) {
                const ex = ax[edge]!, ez = az[edge]!
                const fx = ax[(edge + 1) % 3]!, fz = az[(edge + 1) % 3]!
                const dx = (fx - ex) * flip, dz = (fz - ez) * flip
                let m = 0
                for (let p = 0; p < n; p++) {
                  const px = inX[p]!, pz = inZ[p]!
                  const qx = inX[(p + 1) % n]!, qz = inZ[(p + 1) % n]!
                  // > 0 is inside for a counter-clockwise clipper in (x, z)
                  const dp = dx * (pz - ez) - dz * (px - ex)
                  const dq = dx * (qz - ez) - dz * (qx - ex)
                  if (dp >= 0) { outX[m] = px; outZ[m] = pz; m++ }
                  if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
                    const s = dp / (dp - dq)
                    outX[m] = px + (qx - px) * s
                    outZ[m] = pz + (qz - pz) * s
                    m++
                  }
                  if (m >= 8) break
                }
                n = m
                for (let p = 0; p < n; p++) { inX[p] = outX[p]!; inZ[p] = outZ[p]! }
              }
              if (n < 3) continue
              // the difference of two planes is affine over the intersection: its max is at a vertex
              let viol = 0
              for (let p = 0; p < n; p++) {
                const px = inX[p]!, pz = inZ[p]!
                const u = (px - x0) / this.dx, v = (pz - z0) / this.dz
                const yT = half === 0
                  ? H[a]! + u * (H[b]! - H[a]!) + v * (H[c]! - H[a]!)
                  : H[e]! + (1 - u) * (H[c]! - H[e]!) + (1 - v) * (H[b]! - H[e]!)
                const yS = say - (nx * (px - sax) + nz * (pz - saz)) * invNy
                const d = yT - (yS - sheet.margin)
                if (d > viol) viol = d
              }
              if (viol <= 0) continue
              if (viol > sheet.maxDrop) {
                if (this.clampCapped.length < 200) this.clampCapped.push({ name: sheet.name, x: x0, z: z0, needed: viol })
                viol = sheet.maxDrop
              }
              if (viol > lower[k0]!) lower[k0] = viol
              if (viol > lower[k1]!) lower[k1] = viol
              if (viol > lower[k2]!) lower[k2] = viol
            }
          }
        }
      }
    }
    this.applyLower(lower)
  }

  /**
   * Push the terrain mesh below a set of surface points (xyz triples, world space): every
   * grid triangle that would rise above one of the points is lowered so it stays `margin`
   * underneath. Only for surfaces that have no triangles to hand (the stand decks); the ground
   * faces register with `addGroundFace` and get the exact triangle pass instead.
   */
  clampUnder(points: ArrayLike<number>, margin = 0.1, maxDrop = Infinity) {
    const gx = this.NX + 1, gz = this.NZ + 1
    const H = this.heights
    const lower = new Float32Array(gx * gz)
    for (let p = 0; p + 2 < points.length; p += 3) {
      const fu = (points[p]! - this.x0) / this.dx
      const fv = (points[p + 2]! - this.z0) / this.dz
      const i = Math.floor(fu), j = Math.floor(fv)
      if (i < 0 || j < 0 || i >= this.NX || j >= this.NZ) continue
      const u = fu - i, v = fv - j
      const a = j * gx + i, b = a + 1, c = a + gx, e = c + 1
      let yT: number
      let k0: number, k1: number, k2: number
      if (u + v <= 1) {
        yT = H[a]! + u * (H[b]! - H[a]!) + v * (H[c]! - H[a]!)
        k0 = a; k1 = b; k2 = c
      } else {
        yT = H[e]! + (1 - u) * (H[c]! - H[e]!) + (1 - v) * (H[b]! - H[e]!)
        k0 = b; k1 = c; k2 = e
      }
      let viol = yT - (points[p + 1]! - margin)
      if (viol > 0) {
        if (viol > maxDrop) viol = maxDrop
        if (viol > lower[k0]!) lower[k0] = viol
        if (viol > lower[k1]!) lower[k1] = viol
        if (viol > lower[k2]!) lower[k2] = viol
      }
    }
    this.applyLower(lower)
  }

  /** Subtract an accumulated per-node drop from the height grid and refresh the chunks it touched. */
  private applyLower(lower: Float32Array) {
    const gx = this.NX + 1
    const H = this.heights
    // a lowered grid vertex belongs to up to four chunks (shared edges): mark them all
    const dirty = new Set<number>()
    const cw = this.NX / this.CH, cd = this.NZ / this.CH
    for (let k = 0; k < lower.length; k++) {
      if (lower[k]! > 0) {
        H[k] = H[k]! - lower[k]!
        const i = k % gx, j = Math.floor(k / gx)
        for (const ci of [Math.floor((i - 1) / cw), Math.floor(i / cw)]) {
          for (const cj of [Math.floor((j - 1) / cd), Math.floor(j / cd)]) {
            if (ci >= 0 && cj >= 0 && ci < this.CH && cj < this.CH) dirty.add(ci + cj * this.CH)
          }
        }
      }
    }
    // before commit() the first full upload will pick the changes up anyway
    if (dirty.size && this.committed) this.refresh(dirty)
  }

  /** Distance to the nearest centreline sample within `maxR` (returns maxR if none). */
  distanceToTrack(x: number, z: number, maxR: number): { d: number; i: number; lateral: number; s: number } {
    let best = maxR * maxR
    let bi = -1
    this.track.forEachSampleNear(x, z, maxR, (i, d2) => {
      if (d2 < best) {
        best = d2
        bi = i
      }
    })
    if (bi < 0) return { d: maxR, i: -1, lateral: 0, s: 0 }
    const t = this.track
    const lateral = (x - t.px[bi]!) * t.nx[bi]! + (z - t.pz[bi]!) * t.nz[bi]!
    return { d: Math.sqrt(best), i: bi, lateral, s: bi * t.ds }
  }

  /** Gather callback: the road plane of every sample within ROAD_R, and the nearest of them. */
  private readonly gatherNear = (i: number, d2: number) => {
    const t = this.track
    const lat = (this.qx - t.px[i]!) * t.nx[i]! + (this.qz - t.pz[i]!) * t.nz[i]!
    const a = lat > ROLL_CAP ? ROLL_CAP : lat < -ROLL_CAP ? -ROLL_CAP : lat
    const k = this.sN
    if (k < this.sDist.length) {
      this.sDist[k] = Math.sqrt(d2)
      this.sPlane[k] = t.py[i]! + this.tanRoll[i]! * (a + 0.2 * (lat - a))
      this.sToe[k] = this.fillToe[i]!
      this.sN = k + 1
    }
    if (d2 < this.nearD2) { this.nearD2 = d2; this.nearI = i }
  }

  /** Continuous projection onto the two centreline segments that touch sample `i0`. */
  private readonly proj = { s: 0, lat: 0, py: 0, roll: 0, hw: 0 }
  private projectNear(i0: number, x: number, z: number) {
    const t = this.track, n = t.n, p = this.proj
    let best = Infinity
    for (let q = 0; q < 2; q++) {
      const j = (i0 - 1 + q + n) % n, k = (j + 1) % n
      const ax = t.px[j]!, az = t.pz[j]!
      let ux = t.px[k]! - ax, uz = t.pz[k]! - az
      const ul = Math.sqrt(ux * ux + uz * uz) || 1
      ux /= ul
      uz /= ul
      let u = (x - ax) * ux + (z - az) * uz
      u = u < 0 ? 0 : u > ul ? ul : u
      const dx = x - (ax + ux * u), dz = z - (az + uz * u)
      const d2 = dx * dx + dz * dz
      if (d2 < best) {
        best = d2
        const f = u / ul, g = 1 - f
        const nx = t.nx[j]! * g + t.nx[k]! * f, nz = t.nz[j]! * g + t.nz[k]! * f
        const nl = Math.sqrt(nx * nx + nz * nz) || 1
        p.s = (j * t.ds + u) % t.length
        p.lat = (dx * nx + dz * nz) / nl
        p.py = t.py[j]! * g + t.py[k]! * f
        p.roll = t.roll[j]! * g + t.roll[k]! * f
        p.hw = t.hw[j]! * g + t.hw[k]! * f
      }
    }
    return p
  }

  /**
   * Analytic terrain height — one continuous (C0) field.
   *
   * Near the track the ground is the road plane (camber included) cut ROAD_CUT below the asphalt,
   * taken from a CONTINUOUS projection onto the centreline (it used to be the nearest discrete
   * sample, a 2 m sawtooth of up to 157 mm along the lap and 800 mm at lateral 20). Beyond the
   * verge it blends over ~8 m into an inverse-distance blend of every road sample within ROAD_R,
   * weighted sharply towards the nearest road (ROAD_FALLOFF) so a higher road 30 m away does not
   * lift the verge beside a lower one, and faded to zero at ROAD_R so a sample entering the radius
   * contributes nothing (the old hard "stretch" membership made 0.3-0.5 m steps where a chain
   * split). Every sample also caps the ground at its own road level plus a FILL_SLOPE embankment
   * measured with the EUCLIDEAN distance — the old cap used a far stretch's lateral and cut
   * 8-10 m cliffs at the hairpin exit — so a lower road (the crossover, 200R under the back
   * straight) is never buried and the upper one stands on a bank. From DEM_BLEND[0] out the
   * blend gives way to the real DEM (dem.ts), which is the whole field beyond ROAD_R. Measured
   * on the built track: 5 cm steps over 30 mm along the verge went from 6,874 to 21, all but 6
   * of them facility relief edges (stands.ts), and the call costs 11 µs, not 27.
   */
  heightAt(x: number, z: number): number {
    const t = this.track
    this.qx = x
    this.qz = z
    this.sN = 0
    this.nearD2 = Infinity
    this.nearI = -1
    t.forEachSampleNear(x, z, ROAD_R, this.gatherNear)
    if (this.nearI < 0) {
      // out of road range: the real ground. The relief applies here too — RELIEF_REACH (170 m)
      // is beyond ROAD_R, so the E hill's outer fade would otherwise step at the 140 m seam
      return this.withRelief(x, z, this.farField(x, z))
    }
    const near = Math.sqrt(this.nearD2)
    // one pass: the road-plane blend, plus a lower bound of the embankment cap
    // (softRamp(v, 4) >= max(0, v)), which lets the cap itself be skipped most of the time
    const cut = near + 12 * ROAD_FALLOFF // e^-12: beyond this a sample cannot move the blend
    let num = 0, den = 0, capLow = Infinity
    for (let k = 0; k < this.sN; k++) {
      const d = this.sDist[k]!
      const over = d - this.sToe[k]!
      const low = this.sPlane[k]! - ROAD_CUT + (over > 0 ? FILL_SLOPE * over : 0)
      if (low < capLow) capLow = low
      if (d > cut) continue
      const d2 = d * d
      const fade = 1 - d2 / (ROAD_R * ROAD_R)
      const w = ((fade * fade) / (d2 + 400)) * Math.exp((near - d) / ROAD_FALLOFF)
      num += this.sPlane[k]! * w
      den += w
    }
    // the road-plane IDW cross-fades into the DEM between DEM_BLEND[0] and ROAD_R (where the
    // IDW's own fade has reached zero and the far branch takes over)
    const wD = smoothstep((near - DEM_BLEND[0]) / (DEM_BLEND[1] - DEM_BLEND[0]))
    const demH = wD > 0 || den <= 0 ? this.farField(x, z) : 0
    const far = den > 0 ? (num / den) * (1 - wD) + demH * wD : demH
    // flat cut under and beside the nearest road, blending into the smoothed plane
    const p = this.projectNear(this.nearI, x, z)
    const hNear = p.py + t.rollLift(p.roll, p.lat) - ROAD_CUT
    const wN = smoothstep((Math.abs(p.lat) - p.hw - 2) / 8)
    let h = hNear * (1 - wN) + far * wN
    // flat paddock / grandstand apron along the main straight, its s ends faded over 25 m so
    // they are a ramp and not a wall
    const fz = this.flatZone
    if ((p.s >= fz.from || p.s <= fz.to) && p.lat > fz.latMin && p.lat < fz.latMax) {
      const L = t.length
      const into = Math.min(
        p.s >= fz.from ? p.s - fz.from : p.s + (L - fz.from),
        p.s <= fz.to ? fz.to - p.s : L - fz.from + fz.to,
      )
      const edge = smoothstep((p.lat < 0 ? p.lat - fz.latMin : fz.latMax - p.lat) / 12) * smoothstep(into / 25)
      h = (p.py - ROAD_CUT) * edge + h * (1 - edge)
    }
    // every sample caps the ground at its road level plus an embankment slope
    if (capLow < h) {
      let cap = Infinity
      for (let k = 0; k < this.sN; k++) {
        const plane = this.sPlane[k]! - ROAD_CUT
        const over = this.sDist[k]! - this.sToe[k]!
        if (plane + (over > 0 ? FILL_SLOPE * over : 0) >= cap) continue
        const c = plane + FILL_SLOPE * softRamp(over, 4)
        if (c < cap) cap = c
      }
      if (cap < h) h = cap
    }
    return this.withRelief(x, z, h)
  }

  /**
   * Facility relief, applied after the caps so it wins: the hillside / embankment platforms the
   * stands stand on (C's cut terrace, the D5 grass bank, the D plateau, the E hill, the level
   * GP Square platform behind the main grandstand). Fill samples max() with the natural
   * ground, faded at the plateau edges; cut samples (the deck band of a stand cut into a
   * hill) replace it. Every ramp starts under a stand's retaining wall or beyond the run-off,
   * and the outer fades land on the DEM (stands.ts reads dem.ts for that).
   */
  private withRelief(x: number, z: number, h: number): number {
    const relief = facilityRelief(x, z, this.track)
    if (relief) {
      const hr = relief[0]
      const mode = relief[2]
      if (mode === true || (mode === 'cap' ? hr < h : hr > h)) h += (hr - h) * relief[1]
    }
    return h
  }
}

/**
 * Names that mark a mesh as ground — the `ground:<kind>` faces of ground-mesh.ts. Objects standing
 * on the ground and decals are deliberately not here.
 */
export const GROUND_NAME_RE = /^ground:/

/**
 * Dev sweep: every ground face in the scene must have gone through `Terrain.addGroundFace`.
 * The e2e suite fails the run on a console error, so a builder that forgets cannot ship.
 */
export function assertGroundRegistered(root: THREE.Object3D, terrain: Terrain) {
  const missing: string[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.name || !GROUND_NAME_RE.test(m.name)) return
    if (m.geometry.userData.groundReg === undefined) missing.push(m.name)
    else if (!terrain.clamped.has(m.geometry.uuid)) missing.push(`${m.name} (registered but not clamped)`)
  })
  if (missing.length) console.error(`[terrain] unregistered ground faces: ${missing.join(', ')} — the terrain grid will come through them`)
}

/** A stand's footprint band in track coordinates, used to keep trees (and later props) off it. */
export interface StandZone {
  from: number
  to: number
  side: 1 | -1
  /** outer edge of the stand, metres from the centreline */
  lateralBack: number
  /**
   * How far behind that edge the zone still keeps trees out (m). A stand needs the default 26 m
   * (its concourse, stairs and kiosks); a spectator bank is a lawn people sit on with the trees
   * that are already there right behind it, so its rows carry 4.
   */
  pad?: number
}

/**
 * Everything the environment builders share. One object instead of a growing parameter list, so
 * a builder can pick up a new dependency (the asset pack, the terrain) without touching the
 * call sites in buildEnvironment.
 */
export interface EnvBuildContext {
  track: Track
  terrain: Terrain
  ground: Ground
  /** the environment root every builder adds to */
  group: THREE.Group
  quality: Quality
  /** external asset pack; null / empty registry on the low tier — builders keep a procedural fallback */
  assets: AssetRegistry | null
  /** shared box placer (single-material boxes merge per material across builders; flushed once) */
  boxes: BoxPlacer
  /** the trees' generator (seed 7); the crowd seeds its own */
  rng: Rng
  standZones: StandZone[]
  /** world-space discs (x, z, radius) the trees stay out of — filled by the builders that place buildings and paving */
  keepOut: { x: number; z: number; r: number }[]
  /**
   * World-space polygons (ring + XZ bounding box [minX, minZ, maxX, maxZ]) the forest stays out
   * of — the building footprints, car parks and solar farms of the far field. Empty until those
   * builders exist (plan §2); their deferred jobs run before the forest stage.
   */
  keepOutPolys: { ring: [number, number][]; box: [number, number, number, number] }[]
  /**
   * The far-field registry and deferred build queue. Deferred jobs must not use `boxes` (it is
   * flushed before they run) and must not touch the terrain grid or the ground faces.
   */
  farField: FarField
  /** the land-cover masks (landcover.ts); `classAt` / `weightAt` for the builders that place by land use */
  landCover: LandCover
  /**
   * The tree library (trees.ts): the species prototypes with their LODs and the impostor card,
   * or the cone stand-ins without the pack. Built synchronously before the placers
   * (`buildSurroundings`, `buildForest`, `buildTrees`) so its materials get the viewport's setup.
   */
  trees: TreeLibrary
}

export interface Environment {
  group: THREE.Group
  terrain: Terrain
  /** Ground surface beside the road (shared with the track meshes and barriers). */
  ground: Ground
  /** the ground partition the faces were built from */
  plan: GroundPlan
  /** the drawn ground: one mesh per owner kind */
  groundMeshes: BuiltGround
  ferrisWheel: THREE.Group | null
  /** the far-field registry; the viewport starts its deferred drain after `store.ready` */
  farField: FarField
  /** the land-cover masks and their build statistics */
  landCover: LandCover
  /** the tree library the placers drew from (mode 'pack' / 'cone'); `update` advances its time and wind */
  trees: TreeLibrary
  /** the keep-outs the builders left in the context (discs and footprints) — read by the offline audits */
  keepOuts: { discs: EnvBuildContext['keepOut']; polys: EnvBuildContext['keepOutPolys'] }
  /** the ring / skyline / water meshes' statistics (terrain-far.ts) */
  terrainFar: TerrainFarStats
  /** wall-clock ms per synchronous builder (also `group.userData.buildMs`); the deferred jobs report through `farField.stats().buildMs` */
  buildMs: Record<string, number>
  /**
   * What the spectator builders measured — seats and their capacity clamp, the stands that built
   * a roof or a path frame, the deck-normal check, the banks, and the crowd's budget. Read by
   * `window.__suzuka.env.stats`, the e2e suite and scripts/perf-probe.mjs.
   */
  stats: { seats: StandsStats['seats']; roofs: string[]; pathStands: string[]; deckUp: Record<string, boolean>; banks: StandsStats['banks']; crowd: Crowd['stats'] }
  /**
   * per frame; `cameraPos` drives the crowd density LOD and yaw, and the far field's per-cell
   * LOD; `wind` is the gust factor 0–1 of the foliage sway (the viewport maps the store's m/s)
   */
  update: (dt: number, cameraPos?: THREE.Vector3, wind?: number) => void
}

export function buildEnvironment(track: Track, quality: Quality = QUALITY.high, seed = 7, assets: AssetRegistry | null = null): Environment {
  const group = new THREE.Group()
  // wall-clock per builder, surfaced as `Environment.buildMs` / `window.__suzuka.buildMs`
  const buildMs: Record<string, number> = {}
  let tLast = performance.now()
  const lap = (name: string) => {
    const now = performance.now()
    buildMs[name] = now - tLast
    tLast = now
  }
  // the land-cover masks first: the chunk material binds the inner layer at construction. The
  // rectangles are the grid's and the ring's (asserted against the built Terrain below).
  const innerRect = terrainRect(track)
  const outerRect = ringRect(innerRect, quality.terrain, quality.terrainRingCells)
  const landCover = buildLandCover(track, quality, innerRect, outerRect)
  lap('landCover')
  const terrain = new Terrain(track, quality.terrain, assets, quality.terrainRingCells, landCover.layer('inner'))
  group.add(terrain.group)
  lap('terrain')
  if (import.meta.dev) {
    const g = terrain.grid(), r = terrain.ring
    const off = Math.max(Math.abs(g.x0 - innerRect.x0), Math.abs(g.z0 - innerRect.z0), Math.abs(r.x0 - outerRect.x0), Math.abs(r.z0 - outerRect.z0), Math.abs((r.nx - 1) * r.dx - outerRect.w), Math.abs((r.nz - 1) * r.dz - outerRect.d))
    if (off > 1e-6) console.error(`[env] land-cover rectangles differ from the terrain's by ${off.toFixed(3)} m (terrainRect / ringRect vs Terrain)`)
  }
  // the coarse ring, the DEM_FAR skyline and the water planes, under terrain.group
  const terrainFar = buildTerrainFar(terrain, quality, assets, landCover.layer('outer'))
  lap('terrainFar')
  const field: GroundField = makeField(track, terrain)
  // the ground: plan (who owns each point) → meshes (one face per owner kind, shared vertices,
  // one height per vertex) → registered and the grid settled under them → wired into `ground`.
  // All of it before anything stands on the ground, so every object and decal below reads the
  // DRAWN faces over the SETTLED terrain (the three-phase build: draw, settle, place).
  const plan = buildGroundPlan(track)
  const ground = makeGround(field, plan)
  lap('plan')
  const groundMeshes = buildGroundMeshes(plan, field, groundMaterials(assets, landCover.layer('inner')))
  group.add(groundMeshes.group)
  for (const face of groundMeshes.faces) terrain.addGroundFace(face)
  lap('meshes')
  terrain.settle()
  settleGround(ground, groundMeshes, (x, z) => terrain.meshHeightAt(x, z))
  lap('settle')
  if (import.meta.dev) console.info(`[ground] plan ${buildMs.plan!.toFixed(0)} ms (${plan.stations.length} stations), meshes ${groundMeshes.stats.buildMs.toFixed(0)} ms (${groundMeshes.stats.triangles} triangles, ${groundMeshes.faces.length} faces)`)
  // only the trees draw from this generator (the crowd seeds its own)
  const rng = new Rng(seed)

  // one placer shared by the stands, the pit complex and the props, so their single-material
  // boxes merge per material across all of them
  const boxes = new BoxPlacer(track, ground, group)
  // the far field: its cells tile the terrain rectangle; its group is under `group` so the
  // viewport's freezeStatic / setupMaterials cover what is registered synchronously, and the
  // deferred jobs are attached one by one as they run
  const farField = new FarField(terrain.grid(), quality)
  group.add(farField.group)
  const ctx: EnvBuildContext = {
    track, terrain, ground, group, quality, assets, boxes, rng,
    standZones: [
      ...STANDS.map((d) => ({ from: d.sRange[0], to: d.sRange[1], side: d.side, lateralBack: lateralBackMax(d.lateralBack) })),
      // the spectator banks (banks.ts) keep trees off the lawn people sit on, but only just
      ...SPECTATOR_BANKS.map((b) => ({ from: b.sRange[0], to: b.sRange[1], side: b.side, lateralBack: lateralBackMax(b.lateral[1]), pad: 4 })),
    ],
    keepOut: [],
    keepOutPolys: [],
    farField,
    landCover,
    // the library reads the context (assets, quality) and every placer reads the library: it is
    // filled right below, before any builder runs
    trees: null as unknown as TreeLibrary,
  }
  // the species prototypes and their materials, synchronously (the viewport's material setup
  // runs over `group` once, before the deferred placers use them)
  ctx.trees = buildTreeLibrary(ctx)
  lap('treeLibrary')

  // --- grandstands from the real footprints; they hand every seat position to the crowd ----------
  const stands = buildStands(ctx)
  lap('stands')
  // --- spectators: instanced billboards per seat, in 60 m bays ---------------------------------
  const crowd = buildCrowd(track, stands.seats, quality, assets, 11)
  for (const o of crowd.objects) group.add(o)
  lap('crowd')
  // --- pit building (garages, podium, control pod, screens), Leader Tower, pit wall, paddock ----
  const { buildingRoofMat } = buildPitComplex(ctx)
  lap('pit')
  // --- the two-wheel chicanes / slip roads, in the lap's own frame ---------------------------
  group.add(buildLanes(track, ground))
  lap('lanes')
  // --- trackside furniture, rubbered braking zones, TV camera masts -------------------------
  const { flagTime } = buildTracksideProps(ctx, buildingRoofMat)
  lap('props')
  // --- crossover bridge, underpass parapets, screens, signs, lamps (plan §3) -------------------
  const structures = buildStructures(ctx, { buildingRoofMat })
  lap('structures')
  // every single-material box placed above, merged per material
  boxes.flush()

  // --- Ferris wheel (the Suzuka landmark behind the final-corner stands) ------------------------
  const ferrisWheel = buildFerrisWheel(ctx)
  lap('ferris')
  // --- far field: buildings / car parks / solar / poles / fence, then the woods (deferred jobs) --
  buildSurroundings(ctx)
  lap('surroundings')
  buildForest(ctx)
  lap('forest')

  // --- trackside scatter (a deferred 'forest' job inside buildTrees, after the keep-out producers) ---
  buildTrees(ctx, ferrisWheel)
  lap('trees')
  // every cut is in (the faces' settle, the stand decks' clampUnder): upload the grid once
  terrain.commit()
  lap('commit')
  group.userData.buildMs = buildMs
  if (import.meta.dev) console.info(`[env] build: ${Object.entries(buildMs).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}; ${farField.pending} far-field jobs deferred`)

  const wheel = ferrisWheel.getObjectByName('wheel')
  const update = (dt: number, cameraPos?: THREE.Vector3, wind = 0) => {
    if (wheel) {
      wheel.rotation.z += dt * 0.05
      for (const g of wheel.children) if (g.name === 'gondola') g.rotation.z = -wheel.rotation.z
    }
    flagTime.value += dt
    crowd.time.value += dt
    tickTrees(ctx.trees, dt, wind)
    if (cameraPos) {
      stands.update(cameraPos)
      crowd.update(cameraPos)
      structures.update(cameraPos)
      farField.update(cameraPos)
    }
  }

  const stats = { ...stands.stats, crowd: crowd.stats }
  return { group, terrain, ground, plan, groundMeshes, ferrisWheel, farField, landCover, trees: ctx.trees, keepOuts: { discs: ctx.keepOut, polys: ctx.keepOutPolys }, terrainFar, buildMs, stats, update }
}
