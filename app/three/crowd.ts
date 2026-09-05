import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CROWD_ATLAS, CROWD_CHEER_PAIRS, CROWD_FIGURES } from '~/data/crowd-atlas'
import { STANDS } from '~/data/suzuka-facilities-spec'
import { Rng } from '~/sim/random'
import { forwardDelta, type Track } from '~/sim/track'
import type { AssetRegistry } from './assets'
import { cutoutParams } from './materials'
import type { Quality } from './quality'
import { spectatorAtlas } from './textures'
import { STAND_BAY, type SeatSlot } from './stands'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const Y_UP = new THREE.Vector3(0, 1, 0)

export interface Crowd {
  objects: THREE.Object3D[]
  time: { value: number }
  /** per frame: soft density LOD (back rows thin out between 280 and 380 m) and the camera uniform */
  update: (cameraPos: THREE.Vector3) => void
  stats: { impostors: number; near3d: number; atlas: 'baked' | 'procedural' }
}

/** race-day occupancy of the stands; the west-area lawns and small stands stay thinner */
const OCCUPANCY = 0.95
const OCCUPANCY_BY_STAND: Record<string, number> = { L: 0.55, M: 0.6, N: 0.55, O: 0.7, J: 0.6, IJ: 0.6, H: 0.75 }
/** inside this distance a bay draws its 3D figures (high tier), beyond it impostors only */
const NEAR_LOD = 55
/** the density ramp reaches zero at 380 m; beyond 420 m the bay is not visited at all */
const FAR_CUT = 420
const RAMP_END = 380
const RAMP_LEN = 100

// ---------------------------------------------------------------------------------------------
// who sits where: figure, cap, clothing colours

type Weighted<T> = [T, number][]

function pick<T>(rng: Rng, items: Weighted<T>): T {
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
const SHIRTS: Weighted<THREE.Color> = [
  [lin('#1a1a1e'), 15], [lin('#1c2745'), 15], [lin('#c8102e'), 13], [lin('#e8621a'), 7],
  [lin('#f2f2f0'), 15], [lin('#b9bcc0'), 7], [lin('#2f5fb8'), 6], [lin('#2a8f7a'), 3],
  [lin('#e6c231'), 3], [lin('#e07aa8'), 3], [lin('#7fc0e6'), 3], [lin('#2e5e3a'), 3], [lin('#6d4a3a'), 3],
]
/** C stand 2026: every seat a Honda support seat with a white poncho, red vertical stripes */
const SHIRTS_C: Weighted<THREE.Color> = [[lin('#f4f4f2'), 50], [lin('#c8102e'), 22], ...SHIRTS.map(([c, w]) => [c, w * 0.35] as [THREE.Color, number])]
const PANTS: Weighted<THREE.Color> = [[lin('#17181c'), 30], [lin('#1f2a44'), 25], [lin('#3b5a8a'), 20], [lin('#5f6266'), 15], [lin('#8a7a5a'), 10]]
/** skin multiplier on the atlas' baked #d9a884 */
const SKINS: Weighted<number> = [[1.12, 30], [1.0, 40], [0.86, 15], [0.66, 10], [0.5, 5]]

interface Look {
  /** atlas row of the rest pose (cap block included) and of the cheer pose (−1 = none) */
  row: number
  cheerRow: number
  /** figure index (bare row) for the 3D prototype */
  fig: number
  shirt: THREE.Color
  pants: THREE.Color
  skin: number
  scale: number
  phase: number
}

const cheerOf = new Map<number, number>(CROWD_CHEER_PAIRS)

function lookFor(rng: Rng, standId: string): Look {
  // most people sit; of the standing ones half are the rest pose that flips to a wave
  const seated = rng.next() < 0.72
  let fig: number
  if (seated) fig = rng.next() < 0.5 ? 0 : 2
  else if (rng.next() < 0.5) fig = rng.next() < 0.5 ? 4 : 6
  else fig = 8 + Math.floor(rng.next() * 6)
  const cap = rng.next() < 0.45
  const off = cap ? CROWD_ATLAS.figures : 0
  const cheer = cheerOf.get(fig)
  return {
    row: fig + off,
    cheerRow: cheer === undefined ? -1 : cheer + off,
    fig,
    shirt: pick(rng, standId === 'C' ? SHIRTS_C : SHIRTS),
    pants: pick(rng, PANTS),
    skin: pick(rng, SKINS),
    scale: 0.93 + rng.next() * 0.13,
    phase: rng.next(),
  }
}

// ---------------------------------------------------------------------------------------------
// impostors

interface Impostor {
  geo: THREE.BufferGeometry
  mat: THREE.MeshStandardMaterial
  /** instanced attributes (name, item size) filled per spectator */
  attrs: { name: string; size: number }[]
  fill: (arrays: Float32Array[], k: number, slot: SeatSlot, look: Look, rng: Rng) => void
  /** whether the instance matrix carries the seat facing (procedural) or the shader billboards (baked) */
  rotateInstances: boolean
}

/**
 * The baked atlas (scripts/assets/bake-crowd-atlas.mjs, layout in ~/data/crowd-atlas.ts): one
 * row per figure, 8 yaw columns × 2 camera pitches. The shader billboards the quad towards the
 * camera, picks the column from the camera's bearing relative to the seat's facing and the
 * pitch band from its elevation, flips paired figures into their cheer pose now and then, and
 * tints shirt / pants / skin per spectator through the mask texture.
 */
function bakedImpostor(diff: THREE.Texture, mask: THREE.Texture, time: { value: number }, camPos: { value: THREE.Vector3 }, cut: { alphaTest: number; alphaToCoverage: boolean }): Impostor {
  const A = CROWD_ATLAS
  // the widest figure (hands on hips, 0.92 m) fills less than half a 2 m cell: the quad covers the
  // middle 60 % of the cell's width, which cuts the transparent overdraw by 40 %
  const QUAD_W = 0.6
  const geo = new THREE.PlaneGeometry(A.cellM * QUAD_W, A.cellM)
  geo.translate(0, A.cellM / 2 - A.padM, 0)
  const mat = new THREE.MeshStandardMaterial({ map: diff, alphaTest: cut.alphaTest, alphaToCoverage: cut.alphaToCoverage, roughness: 0.9, side: THREE.FrontSide })
  mat.customProgramCacheKey = () => 'crowd|baked'
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.uniforms.uCamPos = camPos
    shader.uniforms.uMask = { value: mask }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        // (rest row, cheer row or -1, seat facing yaw, phase)
        attribute vec4 aInfo;
        // (shirt rgb, skin multiplier), pants rgb
        attribute vec4 aTint0;
        attribute vec3 aTint1;
        uniform float uTime;
        uniform vec3 uCamPos;
        varying vec3 vShirt;
        varying vec3 vPants;
        varying float vSkin;
        float bbYaw;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vShirt = aTint0.rgb;
        vSkin = aTint0.a;
        vPants = aTint1;
        vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = uCamPos - iPos;
        float dHor = max(length(toCam.xz), 1e-3);
        bbYaw = atan(toCam.x, toCam.z);
        // the bake put the camera at (sin yaw, cos yaw) in the figure's frame (yaw 0 = facing it)
        float rel = bbYaw - aInfo.z;
        float col = mod(floor(rel / (PI2 / ${A.yaws.toFixed(1)}) + 0.5), ${A.yaws.toFixed(1)});
        // pitch band: 8° cameras below 20° elevation, 32° cameras above
        if (atan(toCam.y, dHor) > 0.35) col += ${A.yaws.toFixed(1)};
        float row = aInfo.x;
        // a paired figure cheers for ≈ 1.7 s every ≈ 14 s, each on its own phase
        float cyc = fract(uTime * 0.07 + aInfo.w * 3.0);
        if (aInfo.y >= 0.0 && cyc < 0.12) row = aInfo.y;
        vMapUv = vec2((col + ${((1 - QUAD_W) / 2).toFixed(2)} + ${QUAD_W.toFixed(2)} * uv.x) / ${A.cols.toFixed(1)}, (row + (1.0 - uv.y)) / ${A.rows.toFixed(1)});`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // lit as a rounded shape facing the camera, a little upwards, not as a flat card
        objectNormal = normalize(vec3(0.0, 0.55, 1.0));
        { float cy = cos(bbYaw), sy = sin(bbYaw); objectNormal.xz = vec2(objectNormal.x * cy + objectNormal.z * sy, -objectNormal.x * sy + objectNormal.z * cy); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // gentle sway, then face the camera (yaw only: the pitch is in the atlas)
        transformed.x += sin(uTime * 1.6 + aInfo.w * 40.0) * 0.02 * uv.y;
        { float cy = cos(bbYaw), sy = sin(bbYaw); transformed.xz = vec2(transformed.x * cy + transformed.z * sy, -transformed.x * sy + transformed.z * cy); }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMask;
        varying vec3 vShirt;
        varying vec3 vPants;
        varying float vSkin;`)
      .replace('#include <map_fragment>', `
        vec4 texel = texture2D(map, vMapUv);
        vec3 mk = texture2D(uMask, vMapUv).rgb;
        vec3 tint = mix(vec3(1.0), vShirt, mk.r);
        tint = mix(tint, vPants, mk.g);
        tint = mix(tint, vec3(vSkin), mk.b);
        diffuseColor *= vec4(texel.rgb * tint, texel.a);`)
  }
  return {
    geo,
    mat,
    attrs: [{ name: 'aInfo', size: 4 }, { name: 'aTint0', size: 4 }, { name: 'aTint1', size: 3 }],
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
 * The procedural 16-figure atlas (low tier / no asset pack): the quad carries the seat facing
 * in its instance matrix and turns up to ±35° towards the camera in the shader.
 */
function proceduralImpostor(time: { value: number }, camPos: { value: THREE.Vector3 }, cut: { alphaTest: number; alphaToCoverage: boolean }): Impostor {
  const geo = new THREE.PlaneGeometry(0.5, 0.95)
  geo.translate(0, 0.42, 0)
  const mat = new THREE.MeshStandardMaterial({ map: spectatorAtlas(), alphaTest: cut.alphaTest, alphaToCoverage: cut.alphaToCoverage, side: THREE.DoubleSide, roughness: 0.9 })
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

const PART_ID: Record<string, number> = { Shoes: 0, Pants: 1, Shirt: 2, Skin: 3 }

/**
 * One merged geometry per figure (shoes / pants / shirt / skin as a per-vertex part id), at the
 * atlas' metric scale, facing +Z like the bake. null when any figure is missing from the pack.
 */
function figurePrototypes(reg: AssetRegistry): THREE.BufferGeometry[] | null {
  const out: THREE.BufferGeometry[] = []
  for (const f of CROWD_FIGURES) {
    const m = reg.model(`model/crowd/eclair/${f.id}`)
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
    merged.computeBoundingSphere()
    out.push(merged)
  }
  return out
}

function figureMaterial(): THREE.MeshStandardMaterial {
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
        vTint = aPart < 0.5 ? vec3(0.02, 0.018, 0.016) : aPart < 1.5 ? aTint1 : aPart < 2.5 ? aTint0.rgb : vec3(0.68, 0.39, 0.24) * aTint0.a;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTint;`)
  }
  return mat
}

// ---------------------------------------------------------------------------------------------

/**
 * Spectators on the stands: one instanced impostor per seat slot the stand generator handed
 * over, from the baked atlas when the asset pack is on (tinted per spectator, 8 yaws × 2
 * pitches, cheer flipbook) or from the procedural atlas otherwise. `quality.crowd` is the
 * instance budget: the slots are strided uniformly (every n-th seat of every row) so a small
 * budget still covers every stand. Each stand is split into ≤ 60 m bays with their own meshes
 * inside a THREE.LOD, so culling and the distance ramp are local: a bay's count ramps down with
 * distance (rows are filled front to back, so truncation empties the back rows first) and
 * beyond 420 m the bay is not visited. With `quality.crowdNear` > 0 the front rows of a bay
 * inside 55 m are the 3D figures the atlas was baked from (instanced per figure), the rest of
 * that bay stays impostors.
 */
export function buildCrowd(track: Track, seats: SeatSlot[], quality: Quality, assets: AssetRegistry | null, seed = 11): Crowd {
  const rng = new Rng(seed)
  const time = { value: 0 }
  const camPos = { value: new THREE.Vector3() }
  const cut = cutoutParams(quality)
  const diff = assets?.texture('tex/crowd_atlas/diff') ?? null
  const mask = assets?.texture('tex/crowd_atlas/mask') ?? null
  const baked = !!diff && !!mask
  const imp = baked ? bakedImpostor(diff!, mask!, time, camPos, cut) : proceduralImpostor(time, camPos, cut)
  const protos = baked && quality.crowdNear > 0 && assets ? figurePrototypes(assets) : null
  const figMat = protos ? figureMaterial() : null
  const nearCap = protos ? Math.max(0, Math.floor(quality.crowdNear / 3)) : 0

  // --- bays: stand × 60 m along the stand, rows front to back inside each ---------------------
  const standStart = new Map<string, number>()
  for (const d of STANDS) standStart.set(d.id, d.sRange[0])
  const bays = new Map<string, SeatSlot[]>()
  for (const slot of seats) {
    const s0 = standStart.get(slot.standId) ?? 0
    const bay = Math.floor(forwardDelta(s0, slot.s, track.length) / STAND_BAY)
    const key = `${slot.standId}|${bay}`
    let list = bays.get(key)
    if (!list) bays.set(key, (list = []))
    list.push(slot)
  }
  // the budget: every n-th seat of every row, so the density is even across the circuit
  const stride = Math.max(1, Math.round((seats.length * OCCUPANCY) / Math.max(1, quality.crowd)))

  /** an impostor mesh for `people`, matrices relative to `centre` */
  const impostorMesh = (people: { slot: SeatSlot; look: Look }[], centre: THREE.Vector3): THREE.InstancedMesh => {
    const n = people.length
    const inst = new THREE.InstancedMesh(imp.geo, imp.mat, n)
    const arrays = imp.attrs.map((a) => new Float32Array(n * a.size))
    for (let k = 0; k < n; k++) {
      const { slot, look } = people[k]!
      _p.set(slot.x - centre.x, slot.y + 0.02 - centre.y, slot.z - centre.z)
      // the procedural card's face (+Z) looks along the seat's facing, towards the track
      if (imp.rotateInstances) _q.setFromAxisAngle(Y_UP, slot.yaw)
      else _q.identity()
      _s.setScalar(look.scale)
      inst.setMatrixAt(k, _m.compose(_p, _q, _s))
      imp.fill(arrays, k, slot, look, rng)
    }
    inst.instanceMatrix.needsUpdate = true
    inst.geometry = imp.geo.clone()
    imp.attrs.forEach((a, i) => inst.geometry.setAttribute(a.name, new THREE.InstancedBufferAttribute(arrays[i]!, a.size)))
    inst.castShadow = false
    inst.receiveShadow = true
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    return inst
  }

  /** the 3D figures of a bay, one InstancedMesh per figure prototype */
  const figureMeshes = (people: { slot: SeatSlot; look: Look }[], centre: THREE.Vector3): THREE.InstancedMesh[] => {
    const byFig = new Map<number, { slot: SeatSlot; look: Look }[]>()
    for (const p of people) {
      let l = byFig.get(p.look.fig)
      if (!l) byFig.set(p.look.fig, (l = []))
      l.push(p)
    }
    const out: THREE.InstancedMesh[] = []
    for (const [fig, list] of byFig) {
      const n = list.length
      const inst = new THREE.InstancedMesh(protos![fig]!, figMat!, n)
      const t0 = new Float32Array(n * 4), t1 = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) {
        const { slot, look } = list[k]!
        _p.set(slot.x - centre.x, slot.y + 0.02 - centre.y, slot.z - centre.z)
        _q.setFromAxisAngle(Y_UP, slot.yaw)
        _s.setScalar(look.scale)
        inst.setMatrixAt(k, _m.compose(_p, _q, _s))
        t0[k * 4] = look.shirt.r; t0[k * 4 + 1] = look.shirt.g; t0[k * 4 + 2] = look.shirt.b; t0[k * 4 + 3] = look.skin
        t1[k * 3] = look.pants.r; t1[k * 3 + 1] = look.pants.g; t1[k * 3 + 2] = look.pants.b
      }
      inst.instanceMatrix.needsUpdate = true
      inst.geometry = protos![fig]!.clone()
      inst.geometry.setAttribute('aTint0', new THREE.InstancedBufferAttribute(t0, 4))
      inst.geometry.setAttribute('aTint1', new THREE.InstancedBufferAttribute(t1, 3))
      inst.castShadow = false
      inst.receiveShadow = true
      inst.computeBoundingSphere()
      inst.name = `crowd3d-${CROWD_FIGURES[fig]!.id}`
      out.push(inst)
    }
    return out
  }

  const out: THREE.Object3D[] = []
  const ramped: { lod: THREE.LOD; inst: THREE.InstancedMesh; full: number }[] = []
  let impostors = 0, near3d = 0
  for (const [key, list] of bays) {
    const standId = key.slice(0, key.indexOf('|'))
    const occupancy = OCCUPANCY_BY_STAND[standId] ?? OCCUPANCY
    list.sort((a, b) => a.row - b.row || a.s - b.s)
    const people: { slot: SeatSlot; look: Look }[] = []
    const centre = new THREE.Vector3()
    for (let i = 0; i < list.length; i += stride) {
      const slot = list[i]!
      if (rng.next() > occupancy) continue // empty seat
      const look = lookFor(rng, standId)
      people.push({ slot, look })
      centre.add(_p.set(slot.x, slot.y, slot.z))
    }
    if (!people.length) continue
    centre.multiplyScalar(1 / people.length)
    const lod = new THREE.LOD()
    lod.position.copy(centre)
    const far = impostorMesh(people, centre)
    far.name = `crowd-${key}`
    impostors += people.length
    if (protos && nearCap > 0) {
      // front rows in 3D (the TV cameras look up at the stands from the track), the rest impostors
      const near3 = people.slice(0, nearCap)
      const rest = people.slice(nearCap)
      const near = new THREE.Group()
      for (const m of figureMeshes(near3, centre)) near.add(m)
      if (rest.length) near.add(impostorMesh(rest, centre))
      near3d += near3.length
      lod.addLevel(near, 0)
      lod.addLevel(far, NEAR_LOD, 0.08)
    } else {
      lod.addLevel(far, 0)
    }
    lod.addLevel(new THREE.Object3D(), FAR_CUT)
    out.push(lod)
    ramped.push({ lod, inst: far, full: people.length })
  }
  const update = (cameraPos: THREE.Vector3) => {
    camPos.value.copy(cameraPos)
    for (const b of ramped) {
      const dist = cameraPos.distanceTo(b.lod.position)
      const f = THREE.MathUtils.clamp((RAMP_END - dist) / RAMP_LEN, 0, 1)
      const n = Math.round(b.full * f)
      if (n !== b.inst.count) b.inst.count = n
    }
  }
  if (import.meta.dev) console.info(`[crowd] ${impostors} impostors (${baked ? 'baked atlas' : 'procedural atlas'}), ${near3d} near-field figures, stride ${stride}, ${bays.size} bays`)
  return { objects: out, time, update, stats: { impostors, near3d, atlas: baked ? 'baked' : 'procedural' } }
}
