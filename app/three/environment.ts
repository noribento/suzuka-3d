import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { APEX_SPEED_TARGETS, CIRCUIT, GRANDSTANDS, OVERTAKE_ZONES, TV_CAMERA_SPOTS } from '~/data/suzuka'
import { TEAMS, TEAM_ORDER } from '~/data/drivers'
import { Rng } from '~/sim/random'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import { addMacro, ribbonGeometry, wallGeometry } from './track-mesh'
import { makeGround, type Ground } from './ground'
import { buildCrowd } from './crowd'
import { boardTexture, brakingRubberTexture, crowdTexture, garageTexture, grassMaps, labelTexture } from './textures'
import { EMISSIVE, emissiveScale } from './emissive'
import { QUALITY, type Quality } from './quality'
import { bucketedInstancedMeshes } from './instancing'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _one = new THREE.Vector3(1, 1, 1)
const _s = new THREE.Vector3()

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

export interface Environment {
  group: THREE.Group
  terrain: Terrain
  /** Ground surface beside the road (shared with the track meshes and barriers). */
  ground: Ground
  ferrisWheel: THREE.Group | null
  /** per frame; `cameraPos` drives the crowd density LOD and yaw */
  update: (dt: number, cameraPos?: THREE.Vector3) => void
}

export function buildEnvironment(track: Track, quality: Quality = QUALITY.high, seed = 7): Environment {
  const group = new THREE.Group()
  const terrain = new Terrain(track, quality.terrain)
  group.add(terrain.group)
  const ground = makeGround(track, (x, z) => terrain.heightAt(x, z), (x, z) => terrain.meshHeightAt(x, z))
  const rng = new Rng(seed)
  const hw = track.halfWidth

  // --- spectators: instanced billboards per seat (LOD back to the crowd texture far away) ---
  const crowd = buildCrowd(track, quality.crowd, 11, quality.msaa > 0)
  for (const o of crowd.objects) group.add(o)

  // --- grandstands (merged: one mesh each for seats, structure and roofs) -------------------
  const seatMat = new THREE.MeshStandardMaterial({ map: crowdTexture(), roughness: 0.9 })
  const structMat = new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.8, side: THREE.DoubleSide })
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide })
  const seatGeos: THREE.BufferGeometry[] = []
  const structGeos: THREE.BufferGeometry[] = []
  const roofGeos: THREE.BufferGeometry[] = []
  for (const [from, to, side, depth, roof] of GRANDSTANDS) {
    const gap = 11
    const l0 = side * (hw + gap)
    const l1 = side * (hw + gap + depth)
    const height = depth * 0.62
    const len = forwardDelta(from, to, track.length)
    seatGeos.push(ribbonGeometry(track, from, to, () => (side > 0 ? l1 : l0), () => (side > 0 ? l0 : l1), () => (side > 0 ? height : 1.6), () => (side > 0 ? 1.6 : height), 4, 32, depth / 12))
    // the structure walls reach down into the ground, whatever the verge does underneath
    structGeos.push(wallGeometry(track, from, to, () => l1, (s) => ground.yAt(s, l1) - 1, () => height, 4))
    structGeos.push(wallGeometry(track, from, to, () => l0, (s) => ground.yAt(s, l0) - 1, () => 1.6, 4))
    // end caps
    for (const s of [from, to]) {
      structGeos.push(ribbonGeometry(track, s, s + 0.3, () => (side > 0 ? l1 : l0), () => (side > 0 ? l0 : l1), () => (side > 0 ? height : 1.6), () => (side > 0 ? 1.6 : height), 1, 1))
      structGeos.push(wallGeometry(track, s, s + 0.3, () => l0 + side * depth * 0.5, (ss) => ground.yAt(ss, l0 + side * depth * 0.5) - 1, () => height * 0.6, 1))
    }
    if (roof) {
      roofGeos.push(ribbonGeometry(track, from, to, () => (side > 0 ? l1 + 2 : l0 - 1), () => (side > 0 ? l0 - 1 : l1 + 2), () => height + 7, () => height + 7, 4, 8))
      const cols = Math.max(2, Math.floor(len / 28))
      for (let k = 0; k <= cols; k++) {
        const s = from + (len * k) / cols
        track.pointAt(s, l1 + side * 1, _p)
        const gy = ground.yAt(s, l1 + side * 1) - 0.5
        const col = new THREE.CylinderGeometry(0.5, 0.5, height + 7 - gy, 8)
        col.translate(_p.x, _p.y + (height + 7 + gy) / 2, _p.z)
        structGeos.push(col)
      }
    }
  }
  const seats = new THREE.Mesh(mergeGeometries(seatGeos, false)!, seatMat)
  seats.name = 'grandstandSeats'
  seats.castShadow = true
  seats.receiveShadow = true
  const struct = new THREE.Mesh(mergeGeometries(structGeos, false)!, structMat)
  struct.name = 'grandstandStructure'
  struct.castShadow = true
  group.add(seats, struct)
  if (roofGeos.length) {
    const roofs = new THREE.Mesh(mergeGeometries(roofGeos, false)!, roofMat)
    roofs.name = 'grandstandRoofs'
    roofs.castShadow = true
    group.add(roofs)
  }

  // --- pit building, race control, paddock ------------------------------------------------
  const pit = CIRCUIT.pit
  const garageMat = new THREE.MeshStandardMaterial({ map: garageTexture(), roughness: 0.7 })
  const buildingMat = new THREE.MeshStandardMaterial({ color: 0xd2d4d6, roughness: 0.7 })
  const buildingRoofMat = new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.8 })
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x3f6f9c, roughness: 0.12, metalness: 0.85 })
  /**
   * Box standing on the ground at (s, lateral) — its base follows the verge / terrain there,
   * not the road plane. `onPlane` keeps it on the road plane instead (pit apron, garages).
   */
  /**
   * Single-material boxes are collected per (material, caster flag) and merged into one mesh
   * each at the end (≈10 draws instead of ≈180); multi-material boxes stay individual meshes.
   * Returns the placement matrix (world).
   */
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>()
  const boxMatrix = (s: number, lateral: number, height: number, yOffset: number, onPlane: boolean, out: THREE.Matrix4) => {
    const h = track.headingAt(s)
    track.pointAt(s, lateral, _p)
    const base = onPlane ? 0 : ground.yAt(s, lateral)
    _p.y += base + height / 2 + yOffset
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    _q.setFromRotationMatrix(_m)
    return out.compose(_p, _q, _one)
  }
  const placeBox = (s: number, lateral: number, length: number, depth: number, height: number, mats: THREE.Material | THREE.Material[], yOffset = 0, onPlane = false, cast = true, uvFn?: (uv: THREE.BufferAttribute) => void) => {
    const geo = new THREE.BoxGeometry(depth, height, length)
    if (uvFn) uvFn(geo.attributes.uv as THREE.BufferAttribute)
    const m = boxMatrix(s, lateral, height, yOffset, onPlane, new THREE.Matrix4())
    if (Array.isArray(mats)) {
      const mesh = new THREE.Mesh(geo, mats)
      mesh.applyMatrix4(m)
      mesh.castShadow = cast
      mesh.receiveShadow = true
      group.add(mesh)
      return m
    }
    geo.applyMatrix4(m)
    const key = `${mats.uuid}|${cast ? 1 : 0}`
    let b = buckets.get(key)
    if (!b) buckets.set(key, (b = { mat: mats, cast, geos: [] }))
    b.geos.push(geo)
    return m
  }
  const flushBoxes = () => {
    for (const b of buckets.values()) {
      const merged = mergeGeometries(b.geos, false)
      if (!merged) continue
      for (const g of b.geos) g.dispose()
      const mesh = new THREE.Mesh(merged, b.mat)
      mesh.castShadow = b.cast
      mesh.receiveShadow = true
      mesh.name = 'props'
      group.add(mesh)
    }
    buckets.clear()
  }
  /** one InstancedMesh for a run of same-sized, per-instance-coloured boxes */
  const instancedBoxes = (length: number, depth: number, height: number, items: { m: THREE.Matrix4; color: THREE.Color }[], roughness: number, cast: boolean, name: string) => {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(depth, height, length), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness }), items.length)
    items.forEach((it, i) => {
      inst.setMatrixAt(i, it.m)
      inst.setColorAt(i, it.color)
    })
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    inst.castShadow = cast
    inst.receiveShadow = true
    inst.name = name
    group.add(inst)
    return inst
  }
  const pitCentre = track.wrap(pit.boxStartS + 5 * pit.boxSpacing)
  // main pit building behind the pit lane: open garages facing the lane (and the track), the
  // glass hospitality floor above them, the paddock at the back.
  // Local frame of placeBox: +X = left of the track (towards the circuit), so the pit-lane
  // face of the building is its +X face at lateral `pit.garageFront`.
  {
    const depth = 13, height = 10, length = 320
    const front = pit.garageFront // -21
    const centre = front - depth / 2 // -27.5
    const back = front - depth // -34
    // upper floor (hospitality) over the garages: solid block from 4.6 m up, glass towards the track
    placeBox(pitCentre, centre, length, depth, height - 4.6, [glassMat, buildingMat, buildingRoofMat, buildingMat, buildingMat, buildingMat], 4.6, true)
    // garage floor slab (level with the pit apron) and the paddock-side back wall up to the ceiling
    placeBox(pitCentre, centre, length, depth, 0.3, buildingMat, -0.3, true)
    placeBox(pitCentre, back + 0.6, length, 1.2, 4.6, buildingMat, 0, true)
    // team-coloured interior back walls + the fascia above each bay opening
    const teams = TEAM_ORDER.map((id) => TEAMS[id])
    const walls: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const boards: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: EMISSIVE.garageStrip.color, emissiveIntensity: EMISSIVE.garageStrip.intensity * emissiveScale() })
    const cartMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7 })
    const tyreStackMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.9 })
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t]!
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing)
      walls.push({ m: boxMatrix(s, back + 1.5, 4.4, 0, true, new THREE.Matrix4()), color: new THREE.Color(team.body) })
      // the fascia shows this team's slice of the one façade texture: baked into the box uv
      // (every face — only the lane face is visible) instead of a cloned, offset texture per team
      placeBox(s, front - 0.2, pit.boxSpacing - 1.5, 0.25, 1.1, garageMat, 3.4, true, false, (uv) => {
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (t + uv.getX(i)) / teams.length, 0.55 + uv.getY(i) * 0.15)
      })
      // lit ceiling strips in the bay (bloom on the high tier)
      placeBox(s, centre, pit.boxSpacing - 6, 6, 0.1, lampMat, 4.3, true, false)
      // a couple of props: tool carts / tyre stacks (interior: never cast)
      placeBox(s - 6, centre - 2, 1.2, 1.0, 1.1, cartMat, 0, true, false)
      placeBox(s + 7, centre - 3, 0.7, 0.7, 1.3, tyreStackMat, 0, true, false)
    }
    instancedBoxes(pit.boxSpacing - 1.5, 0.3, 4.4, walls, 0.6, false, 'garageWalls')
    // columns between the bays along the pit-lane face
    for (let t = 0; t <= teams.length; t++) {
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing - pit.boxSpacing / 2)
      placeBox(s, front - 0.4, 0.8, 0.8, 4.6, buildingMat, 0, true)
    }
    placeBox(pitCentre, centre, length + 4, depth + 2, 1.2, buildingMat, height, true) // roof slab
    placeBox(pitCentre, front + 0.8, length - 4, 2.2, 5, glassMat, height + 0.6, true) // hospitality deck rail over the lane
    // pit gantries: a post at the garage line carrying an arm over the working lane with the number board
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.5, metalness: 0.6 })
    for (let t = 0; t < teams.length; t++) {
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing)
      placeBox(s, front + 0.6, 0.3, 0.3, 4.2, gantryMat, 0, true)
      placeBox(s, front + 4.3, 0.3, 7.6, 0.3, gantryMat, 4.2, true, false)
      boards.push({ m: boxMatrix(s, pit.laneOffset - 2.5, 1.2, 3.0, true, new THREE.Matrix4()), color: new THREE.Color(teams[t]!.body) })
    }
    instancedBoxes(2.4, 0.15, 1.2, boards, 0.5, false, 'pitBoards')
    // race control tower rising out of the building at the line
    placeBox(2, centre - 0.5, 16, depth + 1, 22, [glassMat, buildingMat, buildingRoofMat, buildingMat, buildingMat, buildingMat], 0, true)
  }
  // paddock: motorhomes / trucks (on the terrain behind the building)
  const truckMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 })
  for (let i = 0; i < 16; i++) {
    const s = track.wrap(5580 + i * 21)
    placeBox(s, -48 - (i % 2) * 18, 14, 4.5, 4, truckMat, 0, false, false)
  }
  for (let i = 0; i < 7; i++) {
    const s = track.wrap(5600 + i * 44)
    placeBox(s, -80, 24, 12, 8, [buildingMat, buildingMat, buildingRoofMat, buildingMat, glassMat, glassMat])
  }

  // --- Dunlop bridge: a sponsor bridge spanning the track at the top of Dunlop Curve -----------
  {
    const s = 1880
    const hw2 = track.halfWidthAt(s)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.5 })
    const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.5 })
    for (const side of [1, -1]) placeBox(s, side * (hw2 + 4), 2.2, 2.2, 7.6, towerMat, -0.1, true)
    placeBox(s, 0, 2 * hw2 + 10.4, 2.6, 2.4, [towerMat, towerMat, towerMat, towerMat, boardMat, boardMat], 7.5, true)
    placeBox(s, 0, 2 * hw2 + 10.4, 3.0, 0.4, towerMat, 9.9, true)
  }

  // --- trackside furniture: distance boards, marshal posts, sector boards -------------------------
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.6 })
    const boardGeos: Record<string, THREE.Matrix4[]> = { '150': [], '100': [], '50': [] }
    const postGeos: THREE.BufferGeometry[] = []
    const orient = (s: number, lateral: number, y: number, out: THREE.Matrix4) => {
      const h = track.headingAt(s)
      track.pointAt(s, lateral, _p, y + ground.yAt(s, lateral))
      _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
      _q.setFromRotationMatrix(_m)
      out.compose(_p, _q, new THREE.Vector3(1, 1, 1))
    }
    // braking boards before every corner that has a braking zone
    for (const c of track.corners) {
      const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(signedDelta(t.s, c.apex, track.length)) < 60)
      if (!tgt || tgt.kmh > 240) continue
      const side: 1 | -1 = c.sign > 0 ? -1 : 1 // outside of the corner
      for (const [label, dist] of [['150', 150], ['100', 100], ['50', 50]] as const) {
        const s = c.from - dist
        const lat = side * (track.halfWidthAt(s) + 3.2)
        const m = new THREE.Matrix4()
        orient(s, lat, 1.55, m)
        boardGeos[label]!.push(m)
        track.pointAt(s, lat, _p, ground.yAt(s, lat))
        const post = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6)
        post.translate(_p.x, _p.y + 0.55, _p.z)
        postGeos.push(post)
      }
    }
    // boards face the approaching cars (back along the track)
    const boardGeo = new THREE.PlaneGeometry(0.9, 0.9)
    boardGeo.rotateY(Math.PI)
    for (const [label, mats] of Object.entries(boardGeos)) {
      if (!mats.length) continue
      const mat = new THREE.MeshStandardMaterial({ map: labelTexture(label, '#1848a0', '#ffffff'), roughness: 0.6, side: THREE.DoubleSide })
      const inst = new THREE.InstancedMesh(boardGeo, mat, mats.length)
      mats.forEach((m, i) => inst.setMatrixAt(i, m))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = true
      group.add(inst)
    }
    // sector boards at the timing lines
    const sectorGeo = new THREE.PlaneGeometry(2.4, 1.0)
    sectorGeo.rotateY(Math.PI)
    CIRCUIT.sectors.forEach((s, i) => {
      const side = cameraSide(track, s)
      const lat = side * (track.halfWidthAt(s) + 4)
      const mesh = new THREE.Mesh(sectorGeo, new THREE.MeshStandardMaterial({ map: labelTexture(`SECTOR ${i + 2}`, '#111111', '#ffffff', 512, 224, 96), roughness: 0.6, side: THREE.DoubleSide }))
      const m = new THREE.Matrix4()
      orient(s, lat, 2.4, m)
      mesh.applyMatrix4(m)
      group.add(mesh)
      track.pointAt(s, lat, _p, ground.yAt(s, lat))
      for (const dx of [-1, 1]) {
        const post = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6)
        const hh = track.headingAt(s)
        post.translate(_p.x + hh.tx * dx * 1.0, _p.y + 1.0, _p.z + hh.tz * dx * 1.0)
        postGeos.push(post)
      }
    })
    group.add(new THREE.Mesh(mergeGeometries(postGeos, false)!, postMat))
    // marshal posts every ~330 m, alternating sides, with a flag pole and a green flag
    const hutMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 })
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1f8a3f, roughness: 0.7 })
    const flagGeos: THREE.BufferGeometry[] = []
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x1fa34a, roughness: 0.9, side: THREE.DoubleSide })
    let marshal = 0
    for (let s = 160; s < track.length - 100; s += 330) {
      const side: 1 | -1 = marshal++ % 2 ? -1 : 1
      const lat = side * (track.halfWidthAt(s) + 7.5)
      placeBox(s, lat, 2.4, 1.8, 1.3, hutMat, 0, false, false)
      placeBox(s, lat, 2.4, 1.85, 0.25, stripeMat, 0.6, false, false)
      placeBox(s, lat, 2.5, 1.9, 0.12, buildingRoofMat, 1.3, false, false)
      const poleS = s + 1.8
      track.pointAt(poleS, lat, _p, ground.yAt(poleS, lat))
      const pole = new THREE.CylinderGeometry(0.03, 0.03, 3.6, 6)
      pole.translate(_p.x, _p.y + 1.8, _p.z)
      postGeos.push(pole)
      const flag = new THREE.PlaneGeometry(1.0, 0.7, 8, 2)
      const h = track.headingAt(poleS)
      // hang from the pole top, trailing along the track direction; per-vertex phase in uv.x
      flag.translate(0.5, 0, 0)
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tx, 0, h.tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-h.tz, 0, h.tx))
      m.setPosition(_p.x, _p.y + 3.2, _p.z)
      flag.applyMatrix4(m)
      flagGeos.push(flag)
    }
    const flags = new THREE.Mesh(mergeGeometries(flagGeos, false)!, flagMat)
    flags.name = 'flags'
    flags.frustumCulled = false
    const flagTime = { value: 0 }
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = flagTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = uv.x;
          transformed.y += sin(uTime * 5.0 + position.x * 2.0 + position.z * 2.0 + w * 6.0) * 0.06 * w;
          transformed.x += cos(uTime * 3.7 + w * 5.0 + position.z) * 0.05 * w;`)
    }
    group.add(flags)
    group.userData.flagTime = flagTime
  }

  // --- rubbered-in braking zones (dark streaks laid down before the slow corners) ---------------
  {
    const rubberTex = brakingRubberTexture()
    // lit rubber so the streaks take the asphalt's shading (polygon offset keeps it off the road
    // surface on the reversed-Z path; three flips the offset sign there)
    const rubberMat = new THREE.MeshStandardMaterial({ map: rubberTex, alphaMap: rubberTex, color: 0x101012, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const geos: THREE.BufferGeometry[] = []
    for (const z of OVERTAKE_ZONES) {
      const from = z.s - 40
      const to = z.s + 110
      geos.push(ribbonGeometry(track, from, to, (s) => track.halfWidthAt(s) * 0.9, (s) => -track.halfWidthAt(s) * 0.9, () => 0.006, () => 0.006, 2, 10))
    }
    const rubber = new THREE.Mesh(mergeGeometries(geos, false)!, rubberMat)
    rubber.renderOrder = 1
    rubber.name = 'brakingRubber'
    group.add(rubber)
  }

  // --- TV camera masts -------------------------------------------------------------------------
  {
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.6, metalness: 0.5 })
    const mastGeo = new THREE.CylinderGeometry(0.18, 0.25, 9, 8)
    const camGeo = new THREE.BoxGeometry(0.7, 0.5, 1.1)
    const masts = new THREE.InstancedMesh(mastGeo, mastMat, TV_CAMERA_SPOTS.length)
    const cams = new THREE.InstancedMesh(camGeo, mastMat, TV_CAMERA_SPOTS.length)
    TV_CAMERA_SPOTS.forEach((s, i) => {
      const side = cameraSide(track, s)
      track.pointAt(s, side * (hw + 9), _p, ground.yAt(s, side * (hw + 9)))
      masts.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 3.5, _p.z))
      cams.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 8.3, _p.z))
    })
    masts.instanceMatrix.needsUpdate = true
    cams.instanceMatrix.needsUpdate = true
    masts.castShadow = true
    masts.name = 'tvMasts'
    group.add(masts, cams)
  }
  // every single-material box placed above, merged per material
  flushBoxes()

  // --- Ferris wheel (the Suzuka landmark beside the main straight) -----------------------------
  const ferrisWheel = new THREE.Group()
  {
    const s = 330
    track.pointAt(s, 215, _p)
    const groundY = terrain.meshHeightAt(_p.x, _p.z)
    ferrisWheel.position.set(_p.x, groundY, _p.z)
    const h = track.headingAt(s)
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    ferrisWheel.quaternion.setFromRotationMatrix(_m)
    const R = 36
    const hub = R + 6
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5, metalness: 0.3 })
    const wheel = new THREE.Group()
    wheel.name = 'wheel'
    wheel.position.set(0, hub, 0)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.7, 8, 48), whiteMat)
    const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 3, 0.4, 8, 48), whiteMat)
    rim.castShadow = true
    wheel.add(rim, rim2)
    const spokeGeo = new THREE.BoxGeometry(0.4, R * 2, 0.4)
    const gondolaGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6)
    const colors = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffb703, 0x8ecae6]
    for (let i = 0; i < 12; i++) {
      const spoke = new THREE.Mesh(spokeGeo, whiteMat)
      spoke.rotation.z = (i / 12) * Math.PI
      wheel.add(spoke)
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const g = new THREE.Mesh(gondolaGeo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.4 }))
      g.position.set(Math.cos(a) * R, Math.sin(a) * R, 0)
      g.name = 'gondola'
      wheel.add(g)
    }
    ferrisWheel.add(wheel)
    const legGeo = new THREE.BoxGeometry(1.2, hub * 1.08, 1.2)
    for (const [dx, dz] of [[-14, 3], [14, 3], [-14, -3], [14, -3]]) {
      const leg = new THREE.Mesh(legGeo, whiteMat)
      leg.position.set(dx! / 2, hub / 2, dz!)
      leg.rotation.z = dx! > 0 ? -0.3 : 0.3
      leg.castShadow = true
      ferrisWheel.add(leg)
    }
    group.add(ferrisWheel)
  }

  // --- trees -------------------------------------------------------------------------------
  {
    const canopy = mergeGeometries([
      (() => { const g = new THREE.ConeGeometry(3.2, 7, 7); g.translate(0, 6.5, 0); return g })(),
      (() => { const g = new THREE.ConeGeometry(2.4, 5, 7); g.translate(0, 9.5, 0); return g })(),
    ], false)!
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 6)
    trunk.translate(0, 2, 0)
    const count = quality.trees
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d25, roughness: 0.9 })
    const matrices: THREE.Matrix4[] = []
    const colors: THREE.Color[] = []
    const b = track.bounds
    let placed = 0
    let tries = 0
    const wheelPos = ferrisWheel.position
    while (placed < count && tries < count * 40) {
      tries++
      const x = rng.range(b.minX - 420, b.maxX + 420)
      const z = rng.range(b.minZ - 380, b.maxZ + 380)
      const near = terrain.distanceToTrack(x, z, 200)
      if (near.d < 44) continue
      if (near.i >= 0) {
        const s = near.s
        const inPitZone = s >= 5540 || s <= 90
        if (inPitZone && near.lateral > -125 && near.lateral < 80) continue
        let inStand = false
        for (const [from, to, side, depth] of GRANDSTANDS) {
          const inS = from < to ? s >= from - 15 && s <= to + 15 : s >= from - 15 || s <= to + 15
          if (inS && Math.sign(near.lateral) === side && Math.abs(near.lateral) < hw + depth + 26) inStand = true
        }
        if (inStand) continue
      }
      if (Math.hypot(x - wheelPos.x, z - wheelPos.z) < 60) continue
      // denser woods further from the track
      if (near.d < 120 && rng.next() < 0.55) continue
      const y = terrain.meshHeightAt(x, z)
      const sc = rng.range(0.7, 1.45)
      _s.set(sc, sc * rng.range(0.85, 1.2), sc)
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * Math.PI * 2)
      matrices.push(new THREE.Matrix4().compose(_p.set(x, y - 0.3, z), _q, _s))
      colors.push(new THREE.Color().setHSL(0.26 + rng.next() * 0.09, 0.45 + rng.next() * 0.3, 0.2 + rng.next() * 0.14))
      placed++
    }
    // one InstancedMesh per terrain chunk (16) so the follow cameras and the cascades cull the
    // far side of the circuit; canopies cast only on the high tier, trunks never
    const bucketOf = (_i: number, m: THREE.Matrix4) => terrain.chunkIndex(m.elements[12]!, m.elements[14]!)
    for (const inst of bucketedInstancedMeshes(canopy, canopyMat, matrices, colors, bucketOf, { castShadow: quality.treeShadows, name: 'canopies' })) group.add(inst)
    for (const inst of bucketedInstancedMeshes(trunk, trunkMat, matrices, null, bucketOf, { castShadow: false, name: 'trunks' })) group.add(inst)
  }

  const wheel = ferrisWheel.getObjectByName('wheel')
  const flagTime = group.userData.flagTime as { value: number }
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

/** Which side of the track a trackside camera should stand on (outside of the nearest corner). */
export function cameraSide(track: Track, s: number): 1 | -1 {
  let k = 0
  for (let d = -40; d <= 40; d += 10) k += track.kappaAt(s + d)
  if (Math.abs(k) < 1e-4) return 1
  return k > 0 ? -1 : 1
}
