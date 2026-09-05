import * as THREE from 'three'
import { GRANDSTANDS } from '~/data/suzuka'
import { Rng } from '~/sim/random'
import type { Track } from '~/sim/track'
import { addMacro } from './track-mesh'
import { makeGround, type Ground } from './ground'
import { buildCrowd } from './crowd'
import { grassMaps } from './textures'
import { QUALITY, type Quality } from './quality'
import { BoxPlacer } from './boxes'
import type { AssetRegistry } from './assets'
import { buildStands } from './stands'
import { buildPitComplex } from './pit-complex'
import { buildTracksideProps } from './props'
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

/** Terrain that hugs the track elevation and rolls into wooded hills further out. */
export class Terrain {
  /** Terrain chunks (a 4×4 grid so follow cameras can frustum-cull the far side). */
  readonly group: THREE.Group
  private coarse: { x: number; z: number; y: number }[] = []
  private readonly flatZone = { from: 5540, to: 90, latMin: -100, latMax: 62 }
  private readonly NX: number
  private readonly NZ: number
  private readonly CH = 4
  private readonly x0: number
  private readonly z0: number
  private readonly dx: number
  private readonly dz: number
  private readonly heights: Float32Array
  private readonly chunks: THREE.Mesh[] = []

  constructor(private track: Track, grid: [number, number] = [256, 192]) {
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
    for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) this.heights[j * gx + i] = this.heightAt(this.x0 + i * this.dx, this.z0 + j * this.dz)
    const grass = grassMaps(false)
    const mat = new THREE.MeshStandardMaterial({ map: grass.map, normalMap: grass.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0 })
    // terrain uv = xz / 9: one macro period every 250 m
    addMacro(mat, new THREE.Vector2(9 / 250, 9 / 250))
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
    let minH = Infinity
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i]! < minH) minH = this.heights[i]!
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
   * Push the terrain mesh below a set of surface points (xyz triples, world space): every
   * grid triangle that would rise above one of the points is lowered so it stays `margin`
   * underneath. The height grid is far coarser than the road ribbons, so without this the
   * terrain shows through wherever the ground is not flat (embankments, banked corners).
   */
  clampUnder(points: ArrayLike<number>, margin = 0.1) {
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
      const viol = yT - (points[p + 1]! - margin)
      if (viol > 0) {
        if (viol > lower[k0]!) lower[k0] = viol
        if (viol > lower[k1]!) lower[k1] = viol
        if (viol > lower[k2]!) lower[k2] = viol
      }
    }
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

  /**
   * Analytic terrain height. Near the track the ground is the road plane (camber included)
   * cut ROAD_CUT below the asphalt, blending over ~8 m beyond the verge into a smoothed
   * elevation of all road samples within 140 m; further out it rolls into the hills. Where a
   * second, lower stretch of track is nearby (the crossover, 200R under the back straight)
   * the ground is capped at that road's level plus a FILL_SLOPE embankment, so the lower road
   * is never buried and the upper one stands on a bank instead of a floating shelf.
   */
  heightAt(x: number, z: number): number {
    const t = this.track
    const n = t.n
    const near = this.distanceToTrack(x, z, 360)
    const base = this.base(x, z)
    const hillW = smoothstep((near.d - 90) / 260)
    const hills = this.hills(x, z) * hillW
    if (near.i < 0) return base + hills
    // smoothed road plane per separate stretch of track (stretches are > 300 m apart along
    // the lap): inverse-distance blend of its samples within 140 m, plus its nearest sample
    const stretches: { i: number; d2: number; lat: number; num: number; den: number }[] = []
    t.forEachSampleNear(x, z, 140, (i, d2) => {
      const lat = (x - t.px[i]!) * t.nx[i]! + (z - t.pz[i]!) * t.nz[i]!
      const w = 1 / (d2 + 400)
      const plane = (t.py[i]! + t.rollLift(t.roll[i]!, lat)) * w
      let hit: (typeof stretches)[number] | null = null
      for (const st of stretches) {
        const gap = Math.abs(st.i - i)
        if (gap < 150 || n - gap < 150) {
          hit = st
          break
        }
      }
      if (!hit) stretches.push({ i, d2, lat, num: plane, den: w })
      else {
        hit.num += plane
        hit.den += w
        if (d2 < hit.d2) {
          hit.i = i
          hit.d2 = d2
          hit.lat = lat
        }
      }
    })
    if (!stretches.length) return base + hills
    let nearest = stretches[0]!
    for (const st of stretches) if (st.d2 < nearest.d2) nearest = st
    // cross-fade between the stretches' planes with distance, weighted sharply towards the
    // nearest one so a higher road 30 m away does not lift the verge next to a lower one
    const dMin = Math.sqrt(nearest.d2)
    let num = 0, den = 0
    for (const st of stretches) {
      const w = Math.exp(-(Math.sqrt(st.d2) - dMin) / 6)
      num += (st.num / st.den) * w
      den += w
    }
    const hLocal = num / den
    const w2 = smoothstep((near.d - 140) / 220)
    const far = hLocal * (1 - w2) + base * w2 + hills
    // flat cut under and beside the nearest road, blending into the smoothed plane
    const dLat = Math.abs(nearest.lat)
    const hNear = t.py[nearest.i]! + t.rollLift(t.roll[nearest.i]!, nearest.lat) - ROAD_CUT
    const wN = smoothstep((dLat - t.hw[nearest.i]! - 2) / 8)
    let h = hNear * (1 - wN) + far * wN
    // flat paddock / grandstand apron along the main straight
    const fz = this.flatZone
    const inZoneS = near.s >= fz.from || near.s <= fz.to
    if (inZoneS && near.lateral > fz.latMin && near.lateral < fz.latMax && Math.abs(near.lateral) < 120) {
      const yFlat = t.py[near.i]! - ROAD_CUT
      const edge = smoothstep((near.lateral < 0 ? near.lateral - fz.latMin : fz.latMax - near.lateral) / 12)
      h = yFlat * edge + h * (1 - edge)
    }
    // every stretch of track caps the ground at its own level plus an embankment slope
    for (const st of stretches) {
      const cap = t.py[st.i]! + t.rollLift(t.roll[st.i]!, st.lat) - ROAD_CUT + FILL_SLOPE * softRamp(Math.abs(st.lat) - t.hw[st.i]! - 6, 4)
      if (cap < h) h = cap
    }
    return h
  }
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
}

export interface Environment {
  group: THREE.Group
  terrain: Terrain
  /** Ground surface beside the road (shared with the track meshes and barriers). */
  ground: Ground
  ferrisWheel: THREE.Group | null
  /** per frame; `cameraPos` drives the crowd density LOD and yaw */
  update: (dt: number, cameraPos?: THREE.Vector3) => void
}

export function buildEnvironment(track: Track, quality: Quality = QUALITY.high, seed = 7, assets: AssetRegistry | null = null): Environment {
  const group = new THREE.Group()
  const terrain = new Terrain(track, quality.terrain)
  group.add(terrain.group)
  const ground = makeGround(track, (x, z) => terrain.heightAt(x, z), (x, z) => terrain.meshHeightAt(x, z))
  // only the trees draw from this generator (the crowd seeds its own)
  const rng = new Rng(seed)

  // --- spectators: instanced billboards per seat (LOD back to the crowd texture far away) ---
  const crowd = buildCrowd(track, quality.crowd, 11, quality.msaa > 0)
  for (const o of crowd.objects) group.add(o)

  // one placer shared by the pit complex and the props, so their single-material boxes merge
  // per material across both
  const boxes = new BoxPlacer(track, ground, group)
  const hw = track.halfWidth
  const ctx: EnvBuildContext = {
    track, terrain, ground, group, quality, assets, boxes, rng,
    standZones: GRANDSTANDS.map(([from, to, side, depth]) => ({ from, to, side, lateralBack: hw + 11 + depth })),
  }

  // --- grandstands (merged: one mesh each for seats, structure and roofs) -------------------
  buildStands(ctx)
  // --- pit building, race control, paddock, Dunlop bridge ---------------------------------
  const { buildingRoofMat } = buildPitComplex(ctx)
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
    if (cameraPos) crowd.update(cameraPos)
  }

  return { group, terrain, ground, ferrisWheel, update }
}
