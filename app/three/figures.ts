import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CROWD_ATLAS, CROWD_FIGURES } from '~/data/crowd-atlas'
import { TEAMS, type TeamId } from '~/data/drivers'
import { CROWD_LAYOUT } from '~/data/impostor-atlas'
import { Rng } from '~/sim/random'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import type { FarLevel } from './farfield'
import { IMPOSTOR_ATTRIBUTES, impostorGeometry, impostorMaterial } from './impostor'
import { cutoutParams } from './materials'
import { MARSHAL_ATLAS, marshalAtlas, spectatorAtlas } from './textures'

/**
 * Human figures, shared by the crowd (crowd.ts) and the operations layer (ops.ts, plan I0-a):
 * the two impostor paths — the baked atlas (`tex/crowd_atlas`, tinted per figure through its
 * mask) and the procedural canvas atlas of the low tier / Node — the near-field 3D prototypes
 * merged from the CC0 posed GLBs with a per-vertex part id, and the one material that tints
 * those parts per instance. crowd.ts used to own all of it privately; it is promoted here
 * unchanged so a marshal in orange overalls and a spectator in a team jacket share the same
 * three programs ('crowd|baked' / 'crowd|procedural' / 'crowd|figure': a material built with
 * the same cache key and parameters compiles to the same program, plan §横断 7).
 *
 * The operations layer adds a HELMET: a fifth part (`HELMET_PART`, constant white in the
 * vertex shader — no crowd vertex carries it, so the crowd's program is unchanged) merged onto
 * a prototype's head, and on the impostor side the helmet rows the atlas bake appends after the
 * cap block (`helmetRow`; empty until scripts/assets/bake-crowd-atlas.mjs bakes them — an
 * empty row simply draws nothing, so the pack path degrades to the bare-head row with a
 * helmetless marshal until then). `buildOpsFigures` places figures by role through the
 * far-field registry (kind 'ops', 250 m cells, 3D inside `Quality.infield.figures3dM`,
 * impostors to `figuresFarM`) and never touches `quality.crowd` or the crowd's statistics.
 */

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const Y_UP = new THREE.Vector3(0, 1, 0)

// ---------------------------------------------------------------------------------------------
// clothing tables (the crowd's; the ops layer's guests draw from them too)

export type Weighted<T> = [T, number][]

export function pickWeighted<T>(rng: Rng, items: Weighted<T>): T {
  let total = 0
  for (const [, w] of items) total += w
  let r = rng.next() * total
  for (const [v, w] of items) {
    r -= w
    if (r <= 0) return v
  }
  return items[items.length - 1]![0]
}

const lin = (hex: string) => new THREE.Color(hex)

/**
 * Clothing from the 2024–2026 race photos: black / navy team jackets (Red Bull, Mercedes,
 * Haas), red (Ferrari, Honda), orange (McLaren), plenty of white, and scattered brights.
 */
export const SHIRTS: Weighted<THREE.Color> = [
  [lin('#1a1a1e'), 15], [lin('#1c2745'), 15], [lin('#c8102e'), 13], [lin('#e8621a'), 7],
  [lin('#f2f2f0'), 15], [lin('#b9bcc0'), 7], [lin('#2f5fb8'), 6], [lin('#2a8f7a'), 3],
  [lin('#e6c231'), 3], [lin('#e07aa8'), 3], [lin('#7fc0e6'), 3], [lin('#2e5e3a'), 3], [lin('#6d4a3a'), 3],
]
export const PANTS: Weighted<THREE.Color> = [[lin('#17181c'), 30], [lin('#1f2a44'), 25], [lin('#3b5a8a'), 20], [lin('#5f6266'), 15], [lin('#8a7a5a'), 10]]
/** skin multiplier on the atlas' baked #d9a884 */
export const SKINS: Weighted<number> = [[1.12, 30], [1.0, 40], [0.86, 15], [0.66, 10], [0.5, 5]]

/** What one figure looks like: its atlas rows / prototype, clothing, size, phase, and how far it sinks below its place. */
export interface FigureLook {
  /** atlas row of the rest pose (cap / helmet block included) and of the cheer pose (−1 = none) */
  row: number
  cheerRow: number
  /** figure index (bare row) for the 3D prototype */
  fig: number
  shirt: THREE.Color
  pants: THREE.Color
  skin: number
  scale: number
  phase: number
  /**
   * How far to drop this figure below the place it was given (m). The baked atlas was rendered
   * from people sitting ON A SEAT, hips ≈ 0.4 m up; on a grass bank there is no seat, so a seated
   * lawn figure sinks by that much. Only the baked atlas: the procedural one has standing poses
   * in every cell, and sinking those buries their feet.
   */
  sink: number
}

// ---------------------------------------------------------------------------------------------
// impostors

export interface Impostor {
  geo: THREE.BufferGeometry
  mat: THREE.MeshStandardMaterial
  /** instanced attributes (name, item size) filled per figure */
  attrs: { name: string; size: number }[]
  fill: (arrays: Float32Array[], k: number, slot: { yaw: number }, look: FigureLook, rng: Rng) => void
  /** whether the instance matrix carries the facing (procedural) or the shader billboards (baked) */
  rotateInstances: boolean
}

/**
 * The baked atlas (scripts/assets/bake-crowd-atlas.mjs, layout in ~/data/crowd-atlas.ts →
 * CROWD_LAYOUT): one row per figure, 8 yaw columns × 2 camera pitches, drawn by the shared
 * impostor shader (impostor.ts) with the crowd defaults — both pitch bands, the cheer flipbook,
 * a 2 cm sway, and shirt / pants / skin tinted per figure through the mask texture.
 */
export function bakedImpostor(diff: THREE.Texture, mask: THREE.Texture, time: { value: number }, camPos: { value: THREE.Vector3 }, cut: { alphaTest: number; alphaToCoverage: boolean }): Impostor {
  const mat = impostorMaterial({ map: diff, mask }, CROWD_LAYOUT, { pitchBands: 2, cheer: true, sway: 0.02, maskMode: 'crowd', cutout: cut, cacheKey: 'crowd|baked', time, camPos })
  return {
    geo: impostorGeometry(CROWD_LAYOUT),
    mat,
    attrs: [...IMPOSTOR_ATTRIBUTES],
    fill: (arrays, k, slot, look) => {
      const info = arrays[0]!, t0 = arrays[1]!, t1 = arrays[2]!
      info[k * 4] = look.row
      info[k * 4 + 1] = look.cheerRow
      info[k * 4 + 2] = slot.yaw
      info[k * 4 + 3] = look.phase
      t0[k * 4] = look.shirt.r
      t0[k * 4 + 1] = look.shirt.g
      t0[k * 4 + 2] = look.shirt.b
      t0[k * 4 + 3] = look.skin
      t1[k * 3] = look.pants.r
      t1[k * 3 + 1] = look.pants.g
      t1[k * 3 + 2] = look.pants.b
    },
    rotateInstances: false,
  }
}

/**
 * The procedural 16-figure atlas (low tier / no asset pack): the quad carries the facing in
 * its instance matrix and turns up to ±35° towards the camera in the shader. `map` is the
 * spectators' atlas by default; the ops layer passes `marshalAtlas()` (same layout, same
 * program — the map's presence is what the program key sees, not which map).
 */
export function proceduralImpostor(time: { value: number }, camPos: { value: THREE.Vector3 }, cut: { alphaTest: number; alphaToCoverage: boolean }, map: THREE.Texture = spectatorAtlas()): Impostor {
  const geo = new THREE.PlaneGeometry(0.5, 0.95)
  geo.translate(0, 0.42, 0)
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: cut.alphaTest, alphaToCoverage: cut.alphaToCoverage, side: THREE.DoubleSide, roughness: 0.9 })
  mat.customProgramCacheKey = () => 'crowd|procedural'
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.uniforms.uCamPos = camPos
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCell;
        uniform float uTime;
        uniform vec3 uCamPos;`)
      // the atlas cell is padded 8 px top and bottom (of 128): inset the v range to match
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = (vMapUv * vec2(1.0, 0.875) + vec2(0.0, 0.0625)) * 0.25 + aCell.xy;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // turn the figure towards the camera, at most 0.6 rad away from the seat's facing
        vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = uCamPos - iPos;
        float yaw = atan(toCam.x, toCam.z) - aCell.z;
        yaw = mod(yaw + PI, PI2) - PI;
        yaw = clamp(yaw, -0.6, 0.6);
        float cy = cos(yaw), sy = sin(yaw);
        transformed.xz = vec2(transformed.x * cy + transformed.z * sy, -transformed.x * sy + transformed.z * cy);
        float ph = aCell.x * 37.0 + aCell.y * 91.0 + float(gl_InstanceID) * 0.37;
        transformed.x += sin(uTime * 1.6 + ph) * 0.02 * uv.y;`)
  }
  return {
    geo,
    mat,
    attrs: [{ name: 'aCell', size: 3 }],
    fill: (arrays, k, slot, _look, rng) => {
      const cells = arrays[0]!
      cells[k * 3] = Math.floor(rng.next() * 4) * 0.25
      cells[k * 3 + 1] = Math.floor(rng.next() * 4) * 0.25
      cells[k * 3 + 2] = slot.yaw
    },
    rotateInstances: true,
  }
}

// ---------------------------------------------------------------------------------------------
// near-field 3D figures (high tier): the CC0 posed humans the atlas was baked from

export const PART_ID: Record<string, number> = { Shoes: 0, Pants: 1, Shirt: 2, Skin: 3 }
/** the fifth part: a white helmet merged onto the head by `figurePrototypes(…, helmet)` */
export const HELMET_PART = 4
/** the helmet's centre sits this far below the skin's highest vertex (the crown of the head), unverified per pose */
const HELMET_DROP = 0.12
/** the head is the skin within this much of its highest vertex (m, after scaling): its xz mean centres the helmet */
const HEAD_BAND = 0.2

/** the crowd's figure ids in atlas-row order */
const CROWD_IDS = CROWD_FIGURES.map((f) => f.id)

/**
 * One merged geometry per figure id (shoes / pants / shirt / skin as a per-vertex part id), at
 * the atlas' metric scale, facing +Z like the bake. null when any figure is missing from the
 * pack. With `helmet` a white helmet dome (car-model.ts's shape) is merged over the head of
 * each figure as part `HELMET_PART`.
 */
export function figurePrototypes(reg: AssetRegistry, ids: readonly string[] = CROWD_IDS, helmet = false): THREE.BufferGeometry[] | null {
  const out: THREE.BufferGeometry[] = []
  for (const id of ids) {
    const m = reg.model(`model/crowd/eclair/${id}`)
    if (!m) return null
    m.scene.updateMatrixWorld(true)
    const parts: THREE.BufferGeometry[] = []
    m.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      // gltfpack quantised the positions to int16 (KHR_mesh_quantization, the node scale
      // restores metres): applyMatrix4 on the integer attribute would truncate every vertex to
      // whole metres, so the attributes are widened to floats first
      const src = mesh.geometry
      const g = new THREE.BufferGeometry()
      for (const name of ['position', 'normal'] as const) {
        const a = src.getAttribute(name) as THREE.BufferAttribute | undefined
        if (!a) continue
        const f = new THREE.Float32BufferAttribute(a.count * 3, 3)
        for (let i = 0; i < a.count; i++) f.setXYZ(i, a.getX(i), a.getY(i), a.getZ(i))
        g.setAttribute(name, f)
      }
      if (src.index) g.setIndex(src.index.clone())
      g.applyMatrix4(mesh.matrixWorld)
      const n = (g.attributes.position as THREE.BufferAttribute).count
      const part = PART_ID[mesh.name] ?? PART_ID[mesh.parent?.name ?? ''] ?? 2
      g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1))
      parts.push(g.index ? g.toNonIndexed() : g)
    })
    if (!parts.length) return null
    const merged = mergeGeometries(parts, false)
    for (const g of parts) g.dispose()
    if (!merged) return null
    merged.scale(CROWD_ATLAS.modelScale, CROWD_ATLAS.modelScale, CROWD_ATLAS.modelScale)
    const withHelmet = helmet ? helmeted(merged) : merged
    withHelmet.computeBoundingSphere()
    out.push(withHelmet)
  }
  return out
}

/** `figure` (scaled, parts tagged) with the helmet dome merged over its head; the input is disposed */
function helmeted(figure: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = figure.getAttribute('position'), part = figure.getAttribute('aPart')
  let top = -Infinity
  for (let i = 0; i < pos.count; i++) if (part.getX(i) === PART_ID.Skin && pos.getY(i) > top) top = pos.getY(i)
  let cx = 0, cz = 0, n = 0
  for (let i = 0; i < pos.count; i++) {
    if (part.getX(i) !== PART_ID.Skin || pos.getY(i) < top - HEAD_BAND) continue
    cx += pos.getX(i)
    cz += pos.getZ(i)
    n++
  }
  if (!n || !Number.isFinite(top)) return figure
  const dome = new THREE.SphereGeometry(0.135, 20, 14)
  dome.scale(1, 1.06, 1.1)
  dome.translate(cx / n, top - HELMET_DROP, cz / n)
  dome.deleteAttribute('uv')
  const helmet = dome.toNonIndexed()
  dome.dispose()
  helmet.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(helmet.getAttribute('position').count).fill(HELMET_PART), 1))
  const merged = mergeGeometries([figure, helmet], false)
  figure.dispose()
  helmet.dispose()
  return merged ?? figure
}

/** The per-instance part tint of the 3D figures (one program, 'crowd|figure', shared by the crowd and the ops layer). */
export function figureMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 })
  mat.customProgramCacheKey = () => 'crowd|figure'
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart;
        attribute vec4 aTint0;
        attribute vec3 aTint1;
        varying vec3 vTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTint = aPart < 0.5 ? vec3(0.02, 0.018, 0.016) : aPart < 1.5 ? aTint1 : aPart < 2.5 ? aTint0.rgb : aPart < 3.5 ? vec3(0.68, 0.39, 0.24) * aTint0.a : vec3(0.92);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTint;`)
  }
  return mat
}

// ---------------------------------------------------------------------------------------------
// the operations layer's figures: poses, roles, the library, the placer

/** The standing poses the ops layer uses (male / female variants, a walk, a crouch at a wheel). */
export type FigurePose = 'stand' | 'standF' | 'hips' | 'hipsF' | 'lookUp' | 'lookUpF' | 'walk' | 'crouch'

/**
 * Per pose: the pack figure, its impostor row in the bare block (the walk and the crouch have
 * no baked row and stand in with the nearest one), its helmet row (the bake's helmet block,
 * rows 2·figures + i, in this order: male standing, female standing, male hips, male looking
 * up — mirrored from scripts/assets/bake-crowd-atlas.mjs) and the sink of the stand-in row
 * (the crouch borrows the seated row, baked on a seat 0.4 m up).
 */
export const OPS_FIGURES: Record<FigurePose, { id: string; row: number; helmetRow: number | null; sink: number }> = {
  stand: { id: 'male_standing', row: 4, helmetRow: 2 * CROWD_ATLAS.figures, sink: 0 },
  standF: { id: 'female_standing', row: 6, helmetRow: 2 * CROWD_ATLAS.figures + 1, sink: 0 },
  hips: { id: 'male_standing_hips', row: 8, helmetRow: 2 * CROWD_ATLAS.figures + 2, sink: 0 },
  hipsF: { id: 'female_standing_hips', row: 10, helmetRow: null, sink: 0 },
  lookUp: { id: 'male_lookingup', row: 9, helmetRow: 2 * CROWD_ATLAS.figures + 3, sink: 0 },
  lookUpF: { id: 'female_lookingup', row: 11, helmetRow: null, sink: 0 },
  walk: { id: 'male_walking', row: 4, helmetRow: 2 * CROWD_ATLAS.figures, sink: 0 },
  crouch: { id: 'male_pickingup', row: 0, helmetRow: null, sink: 0.4 },
}
export const FIGURE_POSES = Object.keys(OPS_FIGURES) as FigurePose[]

export type FigureRole = 'marshal' | 'official' | 'crew' | 'photographer' | 'staff' | 'guest'

/** One figure of the ops layer, in world space (`y` = what it stands on, `ground.standY`). */
export interface FigurePlacement {
  x: number
  y: number
  z: number
  /** facing: `atan2(dx, dz)` of the direction the figure looks along (the crowd's convention) */
  yaw: number
  pose: FigurePose
  role: FigureRole
  /** the crew's team (its shirt colour) */
  team?: TeamId
  scale?: number
}

export interface FigureLibrary {
  mode: 'baked' | 'procedural'
  /** the impostor of this tier: 'crowd|baked' with the crowd's atlas, or 'crowd|procedural' with `marshalAtlas` */
  impostor: Impostor
  /** high tier with the pack only: per pose the bare and the helmeted 3D prototype */
  protos: Map<FigurePose, { bare: THREE.BufferGeometry; helmet: THREE.BufferGeometry }> | null
  figureMat: THREE.MeshStandardMaterial | null
  time: { value: number }
  camPos: { value: THREE.Vector3 }
}

/** the marshals' overall orange */
const MARSHAL_ORANGE = lin('#f07020')
const WHITE = lin('#f2f2f0')
const OFFICIAL_PANTS = lin('#14161a')
const CREW_PANTS = lin('#1e2126')
const BLACK = lin('#1a1a1e')
const STAFF_SHIRT = lin('#d8d8d4')
const TEAM_ORDER = Object.keys(TEAMS) as TeamId[]
/** the procedural card is 0.95 m tall for the crowd (seated, far); a standing figure's card wants ≈ 2 m */
const PROC_CARD_SCALE = 2.0 / 0.95

/**
 * The figure library for the tier: the impostor (the crowd's baked atlas when the pack has it,
 * else the marshal canvas atlas) and, with 3D figures budgeted (`Quality.infield.figures3dM`)
 * and every pose in the pack, the bare and helmeted prototypes and their material. Built once
 * in buildEnvironment right after the tree library, so the viewport's material setup covers
 * it; `time` / `camPos` are ticked by `Environment.update`. null when the tier draws no figures.
 */
export function buildFigureLibrary(ctx: Pick<EnvBuildContext, 'assets' | 'quality'>): FigureLibrary | null {
  const { assets, quality } = ctx
  if (quality.infield.figuresFarM <= 0) return null
  const time = { value: 0 }
  const camPos = { value: new THREE.Vector3() }
  const cut = cutoutParams(quality)
  const diff = assets?.texture('tex/crowd_atlas/diff') ?? null
  const mask = assets?.texture('tex/crowd_atlas/mask') ?? null
  const baked = !!diff && !!mask
  const impostor = baked ? bakedImpostor(diff!, mask!, time, camPos, cut) : proceduralImpostor(time, camPos, cut, marshalAtlas())
  let protos: FigureLibrary['protos'] = null
  if (baked && assets && quality.infield.figures3dM > 0) {
    const ids = FIGURE_POSES.map((p) => OPS_FIGURES[p].id)
    const bare = figurePrototypes(assets, ids, false)
    const helmet = bare ? figurePrototypes(assets, ids, true) : null
    if (bare && helmet) {
      protos = new Map()
      FIGURE_POSES.forEach((p, i) => protos!.set(p, { bare: bare[i]!, helmet: helmet[i]! }))
    }
  }
  return { mode: baked ? 'baked' : 'procedural', impostor, protos, figureMat: protos ? figureMaterial() : null, time, camPos }
}

interface RoleLook {
  shirt: THREE.Color
  pants: THREE.Color
  skin: number
  helmet: boolean
  /** the procedural atlas cell */
  cell: number
}

function roleLook(rng: Rng, role: FigureRole, pose: FigurePose, team: TeamId | undefined): RoleLook {
  const skin = pickWeighted(rng, SKINS)
  switch (role) {
    case 'marshal':
      return { shirt: MARSHAL_ORANGE, pants: MARSHAL_ORANGE, skin, helmet: true, cell: MARSHAL_ATLAS.marshals[FIGURE_POSES.indexOf(pose) % MARSHAL_ATLAS.marshals.length]! }
    case 'official':
      return { shirt: WHITE, pants: OFFICIAL_PANTS, skin, helmet: false, cell: MARSHAL_ATLAS.official }
    case 'crew': {
      const t = team ?? TEAM_ORDER[0]!
      return { shirt: lin(TEAMS[t].body), pants: CREW_PANTS, skin, helmet: true, cell: MARSHAL_ATLAS.crewBase + TEAM_ORDER.indexOf(t) }
    }
    case 'photographer':
      return { shirt: BLACK, pants: BLACK, skin, helmet: false, cell: MARSHAL_ATLAS.official }
    case 'staff':
      return { shirt: STAFF_SHIRT, pants: BLACK, skin, helmet: false, cell: MARSHAL_ATLAS.official }
    case 'guest':
      return { shirt: pickWeighted(rng, SHIRTS), pants: pickWeighted(rng, PANTS), skin, helmet: false, cell: MARSHAL_ATLAS.official }
  }
}

export interface OpsFigureStats {
  /** figures placed */
  figures: number
  byRole: Partial<Record<FigureRole, number>>
  /** impostor instances (every figure has one) */
  impostors: number
  /** 3D instances (the near level, high tier with the pack) */
  near3d: number
  mode: FigureLibrary['mode'] | 'none'
}

/**
 * Place the ops layer's figures: per 250 m cell one far-field entry (kind 'ops', `<name>-<cell>`)
 * whose near level is the 3D figures (one InstancedMesh per pose, `Quality.infield.figures3dM`,
 * with the pack only), the next the impostors (`figuresFarM`, ramped over `figuresRamp`), the
 * last empty. Tints per role — marshals in orange overalls with a helmet, officials white over
 * dark, crews in their team's body colour with a helmet, photographers in black, staff in grey,
 * guests in the crowd's clothing. Counts go to `ctx.infieldStats[name]` and the returned stats;
 * the crowd's budget and statistics are untouched.
 */
export function buildOpsFigures(ctx: EnvBuildContext, placements: readonly FigurePlacement[], name = 'ops-figures'): OpsFigureStats {
  const lib = ctx.figures
  const stats: OpsFigureStats = { figures: 0, byRole: {}, impostors: 0, near3d: 0, mode: lib ? lib.mode : 'none' }
  if (!lib || !placements.length) return stats
  const { farField, quality } = ctx
  const rng = new Rng(29)
  const looks = placements.map((p) => roleLook(rng, p.role, p.pose, p.team))
  const phases = placements.map(() => rng.next())
  // --- buckets --------------------------------------------------------------------------------
  let single: number | null = null
  if (!quality.infield.cells) {
    _p.set(0, 0, 0)
    for (const p of placements) { _p.x += p.x; _p.z += p.z }
    single = farField.cellOf(_p.x / placements.length, _p.z / placements.length)
  }
  const cells = new Map<number, number[]>()
  placements.forEach((p, i) => {
    const cell = single ?? farField.cellOf(p.x, p.z)
    let list = cells.get(cell)
    if (!list) cells.set(cell, (list = []))
    list.push(i)
  })
  const imp = lib.impostor
  const baked = lib.mode === 'baked'
  /** the impostor mesh of `list` */
  const impostorMesh = (list: number[], meshName: string): THREE.InstancedMesh => {
    const n = list.length
    const inst = new THREE.InstancedMesh(imp.geo, imp.mat, n)
    const arrays = imp.attrs.map((a) => new Float32Array(n * a.size))
    list.forEach((i, k) => {
      const p = placements[i]!, look = looks[i]!, f = OPS_FIGURES[p.pose]
      const sink = baked ? f.sink : 0
      _p.set(p.x, p.y + 0.02 - sink, p.z)
      if (imp.rotateInstances) _q.setFromAxisAngle(Y_UP, p.yaw)
      else _q.identity()
      _s.setScalar((p.scale ?? 1) * (baked ? 1 : PROC_CARD_SCALE))
      inst.setMatrixAt(k, _m.compose(_p, _q, _s))
      if (baked) {
        const info = arrays[0]!, t0 = arrays[1]!, t1 = arrays[2]!
        info[k * 4] = look.helmet && f.helmetRow !== null ? f.helmetRow : f.row
        info[k * 4 + 1] = -1
        info[k * 4 + 2] = p.yaw
        info[k * 4 + 3] = phases[i]!
        t0[k * 4] = look.shirt.r; t0[k * 4 + 1] = look.shirt.g; t0[k * 4 + 2] = look.shirt.b; t0[k * 4 + 3] = look.skin
        t1[k * 3] = look.pants.r; t1[k * 3 + 1] = look.pants.g; t1[k * 3 + 2] = look.pants.b
      } else {
        const cellsArr = arrays[0]!
        cellsArr[k * 3] = (look.cell % MARSHAL_ATLAS.cols) / MARSHAL_ATLAS.cols
        cellsArr[k * 3 + 1] = Math.floor(look.cell / MARSHAL_ATLAS.cols) / MARSHAL_ATLAS.rows
        cellsArr[k * 3 + 2] = p.yaw
      }
    })
    inst.instanceMatrix.needsUpdate = true
    inst.geometry = imp.geo.clone()
    imp.attrs.forEach((a, k) => inst.geometry.setAttribute(a.name, new THREE.InstancedBufferAttribute(arrays[k]!, a.size)))
    inst.castShadow = false
    inst.receiveShadow = true
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    inst.name = meshName
    return inst
  }
  /** the 3D figures of `list`, one InstancedMesh per pose × helmet */
  const figureMeshes = (list: number[], into: THREE.Group, cell: number) => {
    const byKey = new Map<string, number[]>()
    for (const i of list) {
      const key = `${placements[i]!.pose}|${looks[i]!.helmet ? 'h' : 'b'}`
      let l = byKey.get(key)
      if (!l) byKey.set(key, (l = []))
      l.push(i)
    }
    for (const [key, l] of byKey) {
      const [pose, h] = key.split('|') as [FigurePose, string]
      const proto = lib.protos!.get(pose)!
      const geo = (h === 'h' ? proto.helmet : proto.bare).clone()
      const n = l.length
      const inst = new THREE.InstancedMesh(geo, lib.figureMat!, n)
      const t0 = new Float32Array(n * 4), t1 = new Float32Array(n * 3)
      l.forEach((i, k) => {
        const p = placements[i]!, look = looks[i]!
        _p.set(p.x, p.y + 0.02, p.z)
        _q.setFromAxisAngle(Y_UP, p.yaw)
        _s.setScalar(p.scale ?? 1)
        inst.setMatrixAt(k, _m.compose(_p, _q, _s))
        t0[k * 4] = look.shirt.r; t0[k * 4 + 1] = look.shirt.g; t0[k * 4 + 2] = look.shirt.b; t0[k * 4 + 3] = look.skin
        t1[k * 3] = look.pants.r; t1[k * 3 + 1] = look.pants.g; t1[k * 3 + 2] = look.pants.b
      })
      inst.instanceMatrix.needsUpdate = true
      geo.setAttribute('aTint0', new THREE.InstancedBufferAttribute(t0, 4))
      geo.setAttribute('aTint1', new THREE.InstancedBufferAttribute(t1, 3))
      inst.castShadow = false
      inst.receiveShadow = true
      inst.frustumCulled = true
      inst.computeBoundingSphere()
      inst.name = `${name}-3d-${OPS_FIGURES[pose].id}${h === 'h' ? '-helmet' : ''}-${cell}`
      into.add(inst)
      stats.near3d += n
    }
  }
  for (const [cell, list] of cells) {
    const levels: FarLevel[] = []
    if (lib.protos && quality.infield.figures3dM > 0) {
      const near = new THREE.Group()
      near.name = `${name}-L0-${cell}`
      figureMeshes(list, near, cell)
      levels.push({ object: near, range: quality.infield.figures3dM })
    }
    const far = impostorMesh(list, `${name}-L${levels.length}-${cell}`)
    levels.push({ object: far, range: quality.infield.figuresFarM, ramp: quality.infield.figuresRamp })
    const empty = new THREE.Object3D()
    empty.name = `${name}-L${levels.length}-${cell}`
    levels.push({ object: empty, range: Infinity })
    farField.register({ kind: 'ops', name: `${name}-${cell}`, cell, levels })
    stats.impostors += list.length
  }
  stats.figures = placements.length
  for (const p of placements) stats.byRole[p.role] = (stats.byRole[p.role] ?? 0) + 1
  ctx.infieldStats[name] = (ctx.infieldStats[name] ?? 0) + placements.length
  return stats
}
