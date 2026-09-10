import * as THREE from 'three'
import { bucketedInstancedMeshes, type BucketOptions } from './instancing'
import type { Quality } from './quality'

/**
 * The far field: one registry for everything outside the fences that only STANDS on the ground
 * (forest, buildings, car parks, solar farms, roads, poles, fences, structures, water), one
 * deferred build queue that assembles it after the loading screen, and one per-cell LOD pass in
 * `Environment.update`.
 *
 * Why one registry: each of these builders used to be its own frustum-culled InstancedMesh set
 * with its own distance rule. Here every entry is placed in a 250 m cell of the terrain
 * rectangle, the cell keeps a bounding sphere grown from its entries, and `update` skips a whole
 * cell with one distance test before it looks at any entry. Inside a cell each entry picks the
 * first level whose range (scaled by `Quality.farField.lodScale`) still contains the camera, with
 * 5 % hysteresis so a level does not flicker at its boundary; at most one level is visible.
 *
 * Why a deferred queue: the far field is a large share of the build but nothing in it feeds the
 * height field, the ground partition, settle, or the names the e2e / census check. It is built
 * after `store.ready` in `setTimeout(0)` ticks with a wall-clock budget (`farField.tickMs`),
 * independent of the draw frame — SwiftShader renders a few frames a second and a rAF-driven
 * drain would take minutes there.
 *
 * Deferred jobs run AFTER `boxes.flush()` and after the main freezeStatic, so they must not use
 * `ctx.boxes` (a box placed there would never be flushed) and must not touch the terrain grid
 * or the ground faces; they read `ground.standY` and build their own meshes. The job's root is
 * added to `group` first, then handed to the attach callback (`ctx.setupMaterials` +
 * `freezeStatic` in the viewport), so the materials get their tier setup and the matrices are
 * computed once.
 */
export type FarKind = 'forest' | 'floor' | 'buildings' | 'carPark' | 'solar' | 'roads' | 'poles' | 'fence' | 'structure' | 'water'

/** Build stages, run in this order: the keep-out producers (paving, buildings) before the forest that avoids them. */
export type FarStage = 'paving' | 'buildings' | 'forest' | 'dressing'

/** One LOD level of an entry: near → far, ranges increasing; the last level may have range Infinity. */
export interface FarLevel {
  object: THREE.Object3D
  /** visible while the camera is closer than this to the entry's sphere (metres, before lodScale) */
  range: number
  /**
   * Ramp the InstancedMesh counts of this level down to 0 over the last `ramp` metres before
   * `range` (the crowd's density ramp), so a mass of instances thins out instead of popping.
   */
  ramp?: number
}

export interface FarEntry {
  kind: FarKind
  name: string
  /** cell index (`FarField.cellOf`); the 'outside' bucket is never skipped */
  cell: number
  /** world-space bounds of every level */
  sphere: THREE.Sphere
  levels: FarLevel[]
}

/** What `register` takes: the sphere and the cell are computed from the levels when omitted. */
export type FarEntryInput = Omit<FarEntry, 'sphere' | 'cell'> & { sphere?: THREE.Sphere; cell?: number }

/** A level of `registerBuckets`: the same instances drawn with another geometry / material. */
export interface FarBucketLevel {
  range: number
  ramp?: number
  /** defaults to the geometry / material the buckets were registered with */
  geometry?: THREE.BufferGeometry
  material?: THREE.Material
}

export interface FarStats {
  entries: number
  byKind: Partial<Record<FarKind, number>>
  /** entries with a visible level */
  visible: number
  /** triangles of the visible levels, InstancedMesh counts included (maintained incrementally) */
  visibleTriangles: number
  /** deferred jobs not yet run */
  pending: number
  /** cells holding at least one entry */
  cells: number
  /** deferred jobs that threw (each warned once) */
  failed: number
  /** wall-clock ms per deferred job (by job name, accumulated when a name repeats) */
  buildMs: Record<string, number>
}

/** Cell edge, metres — the terrain rectangle is ≈ 14 × 11 of them. */
export const FAR_CELL_M = 250
/** Level boundaries move by this fraction depending on the direction of travel. */
const HYSTERESIS = 0.05
const STAGE_ORDER: Record<FarStage, number> = { paving: 0, buildings: 1, forest: 2, dressing: 3 }

interface RampedMesh {
  inst: THREE.InstancedMesh
  full: number
  trisPerInstance: number
}

interface LevelState {
  level: FarLevel
  /** triangles drawn when the level is fully visible */
  tris: number
  ramped: RampedMesh[]
}

interface EntryState {
  entry: FarEntry
  levels: LevelState[]
  /** visible level, -1 = none */
  cur: number
  /** triangles the entry currently draws */
  tris: number
}

interface Cell {
  sphere: THREE.Sphere | null
  /** the largest finite range of any entry; Infinity when one entry is visible at any distance */
  range: number
  entries: EntryState[]
  /** the whole cell is hidden (skipped in update); hidden once, not per frame */
  hidden: boolean
}

interface Job {
  stage: FarStage
  seq: number
  name: string
  estMs: number
  job: () => THREE.Object3D | null
}

const _v = new THREE.Vector3()
const _sphere = new THREE.Sphere()

function triangleCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex()
  const n = index ? index.count : geo.attributes.position ? geo.attributes.position.count : 0
  const range = geo.drawRange
  return Math.floor(Math.min(n, range.count === Infinity ? n : range.count) / 3)
}

export class FarField {
  /** 'farField', under `env.group`; every level object and every deferred root lives here */
  readonly group = new THREE.Group()
  private readonly nx: number
  private readonly nz: number
  private readonly x0: number
  private readonly z0: number
  /** nx × nz grid cells, then the 'outside' bucket */
  private readonly cells: Cell[]
  private readonly outside: number
  private readonly names = new Set<string>()
  private readonly entries: EntryState[] = []
  private readonly byKind: Partial<Record<FarKind, number>> = {}
  private visibleCount = 0
  private visibleTris = 0
  private readonly lodScale: number
  private readonly tickMs: number

  // --- the deferred queue --------------------------------------------------------------------
  private readonly queue: Job[] = []
  private seq = 0
  private attach: ((o: THREE.Object3D) => void) | null = null
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failedCount = 0
  private readonly jobMs: Record<string, number> = {}
  /** level objects `register` added straight to `group` during the running job (attached with the root) */
  private loose: THREE.Object3D[] = []
  /** how long the last `update` took (ms), for the viewport's per-section frame timings */
  updateMs = 0

  /** `rect` is the terrain rectangle (`Terrain.grid()`); cells outside it fall into one 'outside' bucket. */
  constructor(rect: { x0: number; z0: number; w: number; d: number }, q: Quality) {
    this.x0 = rect.x0
    this.z0 = rect.z0
    this.nx = Math.max(1, Math.ceil(rect.w / FAR_CELL_M))
    this.nz = Math.max(1, Math.ceil(rect.d / FAR_CELL_M))
    this.outside = this.nx * this.nz
    this.cells = []
    for (let i = 0; i <= this.outside; i++) this.cells.push({ sphere: null, range: 0, entries: [], hidden: false })
    this.lodScale = q.farField.lodScale
    this.tickMs = q.farField.tickMs
    this.group.name = 'farField'
  }

  /** Cell index of world (x, z); the 'outside' bucket beyond the rectangle. */
  cellOf(x: number, z: number): number {
    const ci = Math.floor((x - this.x0) / FAR_CELL_M)
    const cj = Math.floor((z - this.z0) / FAR_CELL_M)
    if (ci < 0 || cj < 0 || ci >= this.nx || cj >= this.nz) return this.outside
    return ci + cj * this.nx
  }

  /** The 'outside' bucket's index (never skipped by `update`). */
  get outsideCell(): number {
    return this.outside
  }

  // --- registry ------------------------------------------------------------------------------

  /**
   * Register one entry. The sphere is the union of the levels' geometry bounding spheres in
   * world space (InstancedMesh: the instanced sphere) unless given; the cell is the sphere
   * centre's unless given. A level object without a parent is added to `group`. Level 0 starts
   * visible, the others hidden; `update` takes over from there. Throws on a duplicate name.
   */
  register(input: FarEntryInput): FarEntry {
    if (this.names.has(input.name)) throw new Error(`[farField] duplicate entry '${input.name}'`)
    if (!input.levels.length) throw new Error(`[farField] '${input.name}' has no levels`)
    const states: LevelState[] = []
    let sphere: THREE.Sphere | null = input.sphere ? input.sphere.clone() : null
    for (const level of input.levels) {
      const o = level.object
      if (!o.parent) {
        this.group.add(o)
        if (this.started) this.loose.push(o)
      }
      o.updateMatrixWorld(true)
      let tris = 0
      const ramped: RampedMesh[] = []
      o.traverse((c) => {
        const m = c as THREE.Mesh
        if (!m.isMesh) return
        const geo = m.geometry
        const per = triangleCount(geo)
        const inst = m as THREE.InstancedMesh
        if (inst.isInstancedMesh) {
          tris += per * inst.count
          if (level.ramp !== undefined) ramped.push({ inst, full: inst.count, trisPerInstance: per })
          if (!inst.boundingSphere) inst.computeBoundingSphere()
          _sphere.copy(inst.boundingSphere!)
        } else {
          tris += per
          if (!geo.boundingSphere) geo.computeBoundingSphere()
          _sphere.copy(geo.boundingSphere!)
        }
        if (!input.sphere) {
          _sphere.applyMatrix4(m.matrixWorld)
          if (sphere) sphere.union(_sphere)
          else sphere = _sphere.clone()
        }
      })
      states.push({ level, tris, ramped })
    }
    if (!sphere) sphere = new THREE.Sphere(new THREE.Vector3(), 0)
    const cell = input.cell ?? this.cellOf(sphere.center.x, sphere.center.z)
    const entry: FarEntry = { kind: input.kind, name: input.name, cell, sphere, levels: input.levels }
    const state: EntryState = { entry, levels: states, cur: 0, tris: states[0]!.tris }
    states.forEach((s, i) => { s.level.object.visible = i === 0 })
    this.names.add(entry.name)
    this.entries.push(state)
    this.byKind[entry.kind] = (this.byKind[entry.kind] ?? 0) + 1
    this.visibleCount++
    this.visibleTris += state.tris
    // grow the cell
    const c = this.cells[cell]!
    c.entries.push(state)
    if (c.sphere) c.sphere.union(sphere)
    else c.sphere = sphere.clone()
    let far = 0
    for (const l of input.levels) if (l.range > far) far = l.range
    if (far > c.range) c.range = far
    c.hidden = false
    return entry
  }

  /**
   * `bucketedInstancedMeshes` bucketed by cell: one entry per occupied cell, named
   * `<name>-<cell>` (pass the kind as `name` unless one kind registers several sets), each level
   * an InstancedMesh of the same instances with that level's geometry / material. `opts` are the
   * bucket options minus the name.
   */
  registerBuckets(
    kind: FarKind,
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: THREE.Matrix4[],
    colors: THREE.Color[] | null,
    levels: FarBucketLevel[],
    opts: Omit<BucketOptions, 'name'> = {},
  ): FarEntry[] {
    if (!levels.length) throw new Error(`[farField] registerBuckets('${name}'): no levels`)
    const bucketOf = (_i: number, m: THREE.Matrix4) => this.cellOf(m.elements[12]!, m.elements[14]!)
    // the same matrices in the same order give the same bucket order for every level
    const perLevel = levels.map((l, k) =>
      bucketedInstancedMeshes(l.geometry ?? geometry, l.material ?? material, matrices, colors, bucketOf, { ...opts, name: `${name}-L${k}` }),
    )
    const out: FarEntry[] = []
    const first = perLevel[0]!
    for (let b = 0; b < first.length; b++) {
      const cell = Number(first[b]!.name.slice(first[b]!.name.lastIndexOf('-') + 1))
      const entryLevels: FarLevel[] = levels.map((l, k) => {
        const inst = perLevel[k]![b]!
        const level: FarLevel = { object: inst, range: l.range }
        if (l.ramp !== undefined) level.ramp = l.ramp
        return level
      })
      out.push(this.register({ kind, name: `${name}-${cell}`, cell, levels: entryLevels }))
    }
    return out
  }

  // --- deferred build ------------------------------------------------------------------------

  /**
   * Queue a build job. Jobs run in stage order, then in the order they were queued; `estMs` is
   * the caller's estimate (for the loading indicator, not enforced). The job returns the root
   * it built (added to `group`, then attached) or null when it registered its levels itself.
   */
  defer(stage: FarStage, name: string, estMs: number, job: () => THREE.Object3D | null) {
    const j: Job = { stage, seq: this.seq++, name, estMs, job }
    const order = STAGE_ORDER[stage]
    let at = this.queue.length
    while (at > 0 && STAGE_ORDER[this.queue[at - 1]!.stage] > order) at--
    this.queue.splice(at, 0, j)
  }

  /** deferred jobs not yet run */
  get pending(): number {
    return this.queue.length
  }

  /** estimated ms of the jobs still queued (the callers' `estMs`) */
  get pendingMs(): number {
    let ms = 0
    for (const j of this.queue) ms += j.estMs
    return ms
  }

  /**
   * Start draining in `setTimeout(0)` ticks of `Quality.farField.tickMs` wall-clock each.
   * `attach` runs on every root a job returns (after it is added to `group`): the viewport passes
   * `ctx.setupMaterials` + `freezeStatic`. Calling it twice is a no-op.
   */
  start(attach: (o: THREE.Object3D) => void) {
    if (this.started) return
    this.started = true
    this.attach = attach
    this.schedule()
  }

  /** Stop the tick loop (the viewport's teardown); queued jobs stay queued. */
  stop() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.started = false
  }

  private schedule() {
    if (this.timer !== null || !this.queue.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.step(this.tickMs)
      if (this.started) this.schedule()
    }, 0)
  }

  /**
   * Run queued jobs until `budgetMs` of wall-clock has passed (at least one job per call).
   * Returns the number of jobs run. A job that throws is warned once and counted as failed; the
   * queue always advances.
   */
  step(budgetMs: number): number {
    const t0 = performance.now()
    let ran = 0
    while (this.queue.length) {
      const j = this.queue.shift()!
      const tj = performance.now()
      try {
        this.loose = []
        const root = j.job()
        if (root) {
          this.group.add(root)
          this.attach?.(root)
        }
        if (this.attach) for (const o of this.loose) if (o !== root) this.attach(o)
      } catch (e) {
        this.failedCount++
        console.warn(`[farField] job '${j.name}' (${j.stage}) failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      this.loose = []
      this.jobMs[j.name] = (this.jobMs[j.name] ?? 0) + (performance.now() - tj)
      ran++
      if (performance.now() - t0 >= budgetMs) break
    }
    return ran
  }

  /** Run every queued job now (the Node harness and the tests). */
  drain() {
    while (this.queue.length) this.step(Infinity)
  }

  // --- per frame -----------------------------------------------------------------------------

  private setLevel(s: EntryState, next: number) {
    if (next === s.cur) return
    if (s.cur >= 0) {
      s.levels[s.cur]!.level.object.visible = false
      this.visibleTris -= s.tris
      s.tris = 0
      if (next < 0) this.visibleCount--
    } else if (next >= 0) this.visibleCount++
    if (next >= 0) {
      const l = s.levels[next]!
      l.level.object.visible = true
      // a ramped level's count is set by the caller right after; start from its current count
      let tris = l.tris
      for (const r of l.ramped) tris -= (r.full - r.inst.count) * r.trisPerInstance
      s.tris = tris
      this.visibleTris += tris
    }
    s.cur = next
  }

  private ramp(s: EntryState, d: number) {
    const l = s.levels[s.cur]!
    if (!l.ramped.length || l.level.ramp === undefined) return
    const end = l.level.range * this.lodScale
    const f = THREE.MathUtils.clamp((end - d) / l.level.ramp, 0, 1)
    for (const r of l.ramped) {
      const n = Math.round(r.full * f)
      if (n !== r.inst.count) {
        const delta = (n - r.inst.count) * r.trisPerInstance
        r.inst.count = n
        s.tris += delta
        this.visibleTris += delta
      }
    }
  }

  /**
   * Pick every entry's level for this camera position. A cell whose sphere is beyond its largest
   * range is skipped as a whole: its entries are hidden once (the `hidden` flag) and not visited
   * again until the camera is back inside. The 'outside' bucket is never skipped.
   */
  update(cameraPos: THREE.Vector3) {
    const t0 = performance.now()
    const s = this.lodScale
    const up = 1 + HYSTERESIS, down = 1 - HYSTERESIS
    for (let ci = 0; ci < this.cells.length; ci++) {
      const c = this.cells[ci]!
      if (!c.entries.length || !c.sphere) continue
      if (ci !== this.outside && c.range !== Infinity) {
        const dc = cameraPos.distanceTo(c.sphere.center) - c.sphere.radius
        if (dc > c.range * s * up) {
          if (!c.hidden) {
            for (const e of c.entries) this.setLevel(e, -1)
            c.hidden = true
          }
          continue
        }
      }
      c.hidden = false
      for (const e of c.entries) {
        const sp = e.entry.sphere
        const d = _v.copy(cameraPos).sub(sp.center).length() - sp.radius
        const cur = e.cur
        let next = -1
        for (let k = 0; k < e.levels.length; k++) {
          const r = e.levels[k]!.level.range
          if (r === Infinity) { next = k; break }
          // nearer levels (and a re-show after hiding) need the camera 5 % inside their range,
          // the current level keeps it 5 % beyond, farther levels take over at the plain range
          const t = r * s * (k < cur || cur < 0 ? down : k === cur ? up : 1)
          if (d < t) { next = k; break }
        }
        this.setLevel(e, next)
        if (next >= 0) this.ramp(e, d)
      }
    }
    this.updateMs = performance.now() - t0
  }

  stats(): FarStats {
    let cells = 0
    for (const c of this.cells) if (c.entries.length) cells++
    return {
      entries: this.entries.length,
      byKind: { ...this.byKind },
      visible: this.visibleCount,
      visibleTriangles: this.visibleTris,
      pending: this.queue.length,
      cells,
      failed: this.failedCount,
      buildMs: { ...this.jobMs },
    }
  }
}
