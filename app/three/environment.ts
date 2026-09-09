import * as THREE from 'three'
import { STANDS } from '~/data/suzuka-facilities-spec'
import { Rng } from '~/sim/random'
import { ROLL_CAP, type Track } from '~/sim/track'
import { makeGround, type Ground } from './ground'
import { makeField, type GroundField } from './ground-field'
import { buildGroundPlan, type GroundPlan } from './ground-plan'
import { buildGroundMeshes, isGroundFace, type BuiltGround, type GroundFace } from './ground-mesh'
import { groundMaterials } from './ground-materials'
import { buildCrowd } from './crowd'
import { grassSurfaceMaterial } from './materials'
import { QUALITY, type Quality } from './quality'
import { BoxPlacer } from './boxes'
import type { AssetRegistry } from './assets'
import { buildStands, facilityRelief, lateralBackMax } from './stands'
import { buildPitComplex } from './pit-complex'
import { buildTracksideProps } from './props'
import { buildLanes } from './lanes'
import { buildFerrisWheel, buildTrees } from './vegetation'

/** Which side of the track a trackside camera should stand on — lives with the props, re-exported for the camera rig. */
export { cameraSide } from './props'

const _p = new THREE.Vector3()

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
/** Decay of the cross-fade towards the nearest road, metres: e^-5 for a road 30 m further away. */
const ROAD_FALLOFF = 6

/**
 * A ground sheet registered with the terrain (`Terrain.addGroundSurface`).
 *
 * Every horizontal surface drawn over the terrain MUST be registered: the height grid is 13.3 m
 * (17.7 m on the low tier) and the faces sit centimetres above it, so without the clamp the
 * terrain rises straight through them. Measured before this existed: the paddock apron behind the
 * pit building was pierced over 16.7 % of its area (worst 0.70 m), the secondary paving over
 * 26.6 % (worst 2.75 m) and the offset lanes over 13.6 % (worst 0.24 m).
 *
 * The ground itself registers through `addGroundFace` (a branded GroundFace from ground-mesh.ts);
 * this raw form remains for the objects that still stand on the ground as swept ribbons (the
 * offset-lane kerbs, until they become placed objects).
 */
export interface GroundReg {
  /** declared clearance the terrain must keep below the sheet (m) */
  margin?: number
  /** cap on how far one grid node may be cut below its analytic height (m) */
  maxDrop?: number
  /** for the dev diagnostics and the offline audit */
  name?: string
  /** rides on another sheet: recorded for the audit, never clamps the terrain */
  decal?: boolean
  /**
   * Deliberately planar (a poured concrete pad), so the max-edge rule does not apply: it cannot
   * follow the ground and does not need to, because the apron it sits on is flat.
   */
  flat?: boolean
}

interface GroundSheet {
  geo: THREE.BufferGeometry
  margin: number
  maxDrop: number
  name: string
  flat: boolean
}

/** Terrain that hugs the track elevation and rolls into wooded hills further out. */
export class Terrain {
  /** Terrain chunks (a 4×4 grid so follow cameras can frustum-cull the far side). */
  readonly group: THREE.Group
  private coarse: { x: number; z: number; y: number }[] = []
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

  /** the asset pack (null / empty on the low tier); the track meshes read it from here */
  constructor(private track: Track, grid: [number, number] = [256, 192], readonly assets: AssetRegistry | null = null) {
    this.NX = grid[0]
    this.NZ = grid[1]
    for (let s = 0; s < track.length; s += 90) {
      track.pointAt(s, 0, _p)
      this.coarse.push({ x: _p.x, z: _p.z, y: _p.y })
    }
    const w = 3400, d = 2600
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
    // terrain uv = xz / 9; withered_grass at its 2 m tile on the high tier, the procedural SEASON
    // tile otherwise, one macro period every 250 m either way (materials.ts grassSurfaceMaterial)
    const mat = grassSurfaceMaterial(assets, [9, 9], [250, 250], 0.7)
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
    // a flat skirt far beyond the height grid: the overview camera looks past the terrain
    // rectangle, and without ground there the Sky shader's below-horizon colours show through
    const minH = this.minHeight()
    const skirtSize = 40000
    const skirtGeo = new THREE.PlaneGeometry(skirtSize, skirtSize, 1, 1)
    const skirtUv = skirtGeo.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < skirtUv.count; i++) skirtUv.setXY(i, (skirtUv.getX(i) * skirtSize) / 9, (skirtUv.getY(i) * skirtSize) / 9)
    const skirt = new THREE.Mesh(skirtGeo, mat)
    skirt.rotation.x = -Math.PI / 2
    skirt.position.set(cx, minH - 0.5, cz)
    skirt.receiveShadow = false
    skirt.name = 'terrainSkirt'
    skirt.updateMatrix()
    skirt.matrixAutoUpdate = false
    this.group.add(skirt)
    this.skirt = skirt
  }

  private readonly skirt: THREE.Mesh
  private minHeight(): number {
    let minH = Infinity
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i]! < minH) minH = this.heights[i]!
    return minH
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
   * Declare that `geo` is a horizontal sheet drawn over the terrain. `settle()` then pushes every
   * grid triangle it covers at least `margin` underneath it.
   *
   * Registering is the ONLY thing that protects a sheet; a builder that forgets is caught by the
   * dev sweep in RaceViewport and by `scripts/audit/surface-check.mjs`.
   */
  addGroundSurface(geo: THREE.BufferGeometry, reg: GroundReg = {}) {
    const name = reg.name ?? 'unnamed'
    const margin = reg.margin ?? 0.1
    const maxDrop = reg.maxDrop ?? 2
    const flat = reg.flat ?? false
    geo.userData.groundReg = { margin, maxDrop, name, flat, decal: reg.decal ?? false }
    if (reg.decal) return
    if (this.settled) {
      console.error(`[terrain] addGroundSurface('${name}') called after settle() — the sheet is unprotected`)
      return
    }
    this.sheets.push({ geo, margin, maxDrop, name, flat })
  }

  /**
   * Register one drawn ground face (ground-mesh.ts). Only a face minted by `buildGroundMeshes` is
   * accepted: the partition is the one source of opaque ground, so nothing else can claim to be it.
   */
  addGroundFace(face: GroundFace) {
    if (!isGroundFace(face)) {
      console.error('[terrain] addGroundFace: not a GroundFace minted by buildGroundMeshes — refused')
      return
    }
    // maxDrop 12: the deepest cut the ground needs is ~9.4 m, where the verge meets the relief
    // platform E-1 stands on; the cap bounds a runaway and surface-check reports what it refuses
    this.addGroundSurface(face.geo, { name: face.mesh.name, margin: 0.1, maxDrop: 12 })
  }

  /** The registrations, for scripts/audit/surface-check.mjs (a sheet may be merged into a mesh). */
  get groundSheets(): readonly { geo: THREE.BufferGeometry; margin: number; maxDrop: number; name: string; flat: boolean }[] {
    return this.sheets
  }

  /**
   * Apply every registration, put the skirt back under the (now lower) grid, and upload.
   * Called once, from RaceViewport, after every ground builder has run.
   */
  settle() {
    if (this.settled) return
    const t0 = performance.now()
    this.settled = true
    this.clampUnderSheets()
    for (const s of this.sheets) this.clamped.add(s.geo.uuid)
    // the clamp only ever lowers, so the skirt's pre-clamp minimum can now be above the grid
    this.skirt.position.y = this.minHeight() - 0.5
    this.skirt.updateMatrix()
    this.commit()
    this.settleMs = performance.now() - t0
    if (import.meta.dev) {
      const capped = this.clampCapped.length
      console.info(`[terrain] settle: ${this.sheets.length} ground sheets, ${this.settleMs.toFixed(1)} ms` + (capped ? `, ${capped} nodes hit maxDrop` : ''))
      if (capped) for (const c of this.clampCapped.slice(0, 8)) console.warn(`[terrain] ${c.name}: node at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) needed ${c.needed.toFixed(2)} m of cut`)
    }
  }

  private committed = false
  /**
   * First upload of the vertex data. Called once the track meshes have pushed the terrain
   * under the road (clampUnder), so the grid is built and uploaded a single time.
   */
  commit() {
    if (this.committed) return
    this.committed = true
    this.refresh()
  }

  /** Index (0..15) of the 4×4 terrain chunk containing world (x, z) — the tree bucket key. */
  chunkIndex(x: number, z: number): number {
    const ci = THREE.MathUtils.clamp(Math.floor(((x - this.x0) / (this.dx * this.NX)) * this.CH), 0, this.CH - 1)
    const cj = THREE.MathUtils.clamp(Math.floor(((z - this.z0) / (this.dz * this.NZ)) * this.CH), 0, this.CH - 1)
    return ci + cj * this.CH
  }

  /** Re-upload vertex positions and normals from the height grid (only the chunks in `dirty` when given). */
  private refresh(dirty?: Set<number>) {
    const gx = this.NX + 1, gz = this.NZ + 1
    const H = this.heights
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
          const hl = H[gj * gx + Math.max(0, gi - 1)]!, hr = H[gj * gx + Math.min(gx - 1, gi + 1)]!
          const hu = H[Math.max(0, gj - 1) * gx + gi]!, hd = H[Math.min(gz - 1, gj + 1) * gx + gi]!
          const nx = (hl - hr) / (2 * this.dx), nz = (hu - hd) / (2 * this.dz)
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

  /** Height of the rendered terrain mesh at (x, z) — the analytic surface sampled on the grid. */
  meshHeightAt(x: number, z: number): number {
    const gx = this.NX + 1
    const H = this.heights
    const fu = (x - this.x0) / this.dx
    const fv = (z - this.z0) / this.dz
    const i = Math.min(this.NX - 1, Math.max(0, Math.floor(fu)))
    const j = Math.min(this.NZ - 1, Math.max(0, Math.floor(fv)))
    const u = Math.min(1, Math.max(0, fu - i)), v = Math.min(1, Math.max(0, fv - j))
    const a = j * gx + i, b = a + 1, c = a + gx, e = c + 1
    if (u + v <= 1) return H[a]! + u * (H[b]! - H[a]!) + v * (H[c]! - H[a]!)
    return H[e]! + (1 - u) * (H[c]! - H[e]!) + (1 - v) * (H[b]! - H[e]!)
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
   * underneath. Only for surfaces that have no triangles to hand (the stand decks); everything
   * that is a mesh registers with `addGroundSurface` and gets the exact triangle pass instead.
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

  private base(x: number, z: number): number {
    let num = 0, den = 0
    for (const c of this.coarse) {
      const dx = c.x - x, dz = c.z - z
      const w = 1 / (dx * dx + dz * dz + 900)
      num += c.y * w
      den += w
    }
    return num / den
  }

  private hills(x: number, z: number): number {
    return 9 * Math.sin(x * 0.0113 + 1.3) * Math.cos(z * 0.0091 - 0.4) + 5 * Math.sin(x * 0.027 - z * 0.019) + 3 * Math.cos(z * 0.041 + x * 0.008)
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

  /** Gather callback for the far field: the nearest sample only. */
  private readonly gatherFar = (i: number, d2: number) => {
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
   * straight) is never buried and the upper one stands on a bank. Further out it rolls into the
   * hills. Measured on the built track: 5 cm steps over 30 mm along the verge went from 6,874 to
   * 21, all but 6 of them facility relief edges (stands.ts), and the call costs 11 µs, not 27.
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
      // out of road range: the smoothed coarse elevation rolling into the hills
      this.nearD2 = Infinity
      t.forEachSampleNear(x, z, 360, this.gatherFar)
      const d = this.nearI < 0 ? 360 : Math.sqrt(this.nearD2)
      return this.base(x, z) + smoothstep((d - 90) / 260) * this.hills(x, z)
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
    const hillW = smoothstep((near - 90) / 260)
    const w2 = smoothstep((near - ROAD_R) / 220)
    const far = (num / den) * (1 - w2) + (w2 > 0 ? this.base(x, z) * w2 : 0) + (hillW > 0 ? this.hills(x, z) * hillW : 0)
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
    // facility relief, after the caps so it wins: the hillside / embankment platforms the
    // stands stand on (C's cut terrace, the D5 grass bank, the D plateau, the E hill, the level
    // GP Square platform behind the main grandstand). Fill samples max() with the natural
    // ground, faded at the plateau edges; cut samples (the deck band of a stand cut into a
    // hill) replace it. Every ramp starts under a stand's retaining wall or beyond the run-off
    const relief = facilityRelief(x, z, t)
    if (relief) {
      const hr = relief[0]
      const mode = relief[2]
      if (mode === true || (mode === 'cap' ? hr < h : hr > h)) h += (hr - h) * relief[1]
    }
    return h
  }
}

/**
 * Names that mark a mesh as ground — the `ground:<kind>` faces of ground-mesh.ts and the
 * offset-lane kerbs that still stand on it as a ribbon. Decals (paint, rubber, white lines) ride
 * on a face and are deliberately not here.
 */
export const GROUND_NAME_RE = /^(ground:|laneKerbs$)/

/**
 * Dev sweep: every ground sheet in the scene must have gone through `Terrain.addGroundSurface`.
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
  if (missing.length) console.error(`[terrain] unregistered ground sheets: ${missing.join(', ')} — the terrain grid will come through them`)
}

/** A stand's footprint band in track coordinates, used to keep trees (and later props) off it. */
export interface StandZone {
  from: number
  to: number
  side: 1 | -1
  /** outer edge of the stand, metres from the centreline */
  lateralBack: number
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
  /** per frame; `cameraPos` drives the crowd density LOD and yaw */
  update: (dt: number, cameraPos?: THREE.Vector3) => void
}

export function buildEnvironment(track: Track, quality: Quality = QUALITY.high, seed = 7, assets: AssetRegistry | null = null): Environment {
  const group = new THREE.Group()
  const terrain = new Terrain(track, quality.terrain, assets)
  group.add(terrain.group)
  const field: GroundField = makeField(track, terrain)
  // the ground: plan (who owns each point) → meshes (one face per owner kind, shared vertices,
  // one height per vertex) → registered so settle() pushes the grid under them. Built before
  // anything that stands on the ground, so the decals and objects can read the DRAWN faces.
  const tPlan = performance.now()
  const plan = buildGroundPlan(track)
  const ground = makeGround(track, field, plan)
  const tMesh = performance.now()
  const groundMeshes = buildGroundMeshes(plan, field, groundMaterials(assets))
  group.add(groundMeshes.group)
  for (const face of groundMeshes.faces) terrain.addGroundFace(face)
  ground.builtY = groundMeshes.yAt
  if (import.meta.dev) console.info(`[ground] plan ${(tMesh - tPlan).toFixed(0)} ms (${plan.stations.length} stations), meshes ${groundMeshes.stats.buildMs.toFixed(0)} ms (${groundMeshes.stats.triangles} triangles, ${groundMeshes.faces.length} faces)`)
  // only the trees draw from this generator (the crowd seeds its own)
  const rng = new Rng(seed)

  // one placer shared by the stands, the pit complex and the props, so their single-material
  // boxes merge per material across all of them
  const boxes = new BoxPlacer(track, ground, group)
  const ctx: EnvBuildContext = {
    track, terrain, ground, group, quality, assets, boxes, rng,
    standZones: STANDS.map((d) => ({ from: d.sRange[0], to: d.sRange[1], side: d.side, lateralBack: lateralBackMax(d.lateralBack) })),
    keepOut: [],
  }

  // --- grandstands from the real footprints; they hand every seat position to the crowd ----------
  const stands = buildStands(ctx)
  // --- spectators: instanced billboards per seat, in 60 m bays ---------------------------------
  const crowd = buildCrowd(track, stands.seats, quality, assets, 11)
  for (const o of crowd.objects) group.add(o)
  // --- pit building (garages, podium, control pod, screens), Leader Tower, pit wall, paddock ----
  const { buildingRoofMat } = buildPitComplex(ctx)
  // --- the two-wheel chicanes / slip roads, in the lap's own frame ---------------------------
  group.add(buildLanes(track, ground, terrain))
  // --- trackside furniture, rubbered braking zones, TV camera masts -------------------------
  const { flagTime } = buildTracksideProps(ctx, buildingRoofMat)
  // every single-material box placed above, merged per material
  boxes.flush()

  // --- Ferris wheel (the Suzuka landmark behind the final-corner stands) ------------------------
  const ferrisWheel = buildFerrisWheel(ctx)

  // --- trees -------------------------------------------------------------------------------
  buildTrees(ctx, ferrisWheel)

  const wheel = ferrisWheel.getObjectByName('wheel')
  const update = (dt: number, cameraPos?: THREE.Vector3) => {
    if (wheel) {
      wheel.rotation.z += dt * 0.05
      for (const g of wheel.children) if (g.name === 'gondola') g.rotation.z = -wheel.rotation.z
    }
    flagTime.value += dt
    crowd.time.value += dt
    if (cameraPos) {
      stands.update(cameraPos)
      crowd.update(cameraPos)
    }
  }

  return { group, terrain, ground, plan, groundMeshes, ferrisWheel, update }
}
