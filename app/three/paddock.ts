import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { TEAMS } from '~/data/drivers'
import { enPairs } from '~/data/en-codec'
import {
  BUILDINGS, COLOURS, GARAGE_ORDER, PADDOCK_BUILDINGS, PADDOCK_FENCE, PADDOCK_ISLAND, PADDOCK_LAMPS, PADDOCK_MASTS, PADDOCK_OFFICE, PADDOCK_PLANE,
  PIT_BOX_STRIP, PIT_BUILDING, UNDERPASSES, garageS, type PaddockBuildingDef,
} from '~/data/suzuka-facilities-spec'
import { osmFeature, type OsmFeature } from '~/data/suzuka-facilities'
import { SUR_ROADS } from '~/data/suzuka-surroundings'
import { forwardDelta } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { GROUND_OBJECTS, LAYER, markDecal, markObject } from './ground'
import type { DecalQuad } from './ground-mesh'
import { registerPropSet, type PropSet } from './infield-lod'
import { bucketedInstancedMeshes } from './instancing'
import { sweepKerb } from './lanes'
import { latticeGeometry } from './lattice'
import { assetAspect, cutoutFromAssets, cutoutParams, pbrFromAssets, tileMetres } from './materials'
import { canopyTopAt } from './pit-building'
import { addMerged, canvas, enMatrix, frameAt, pitMaterials, slice, tex } from './pit-geometry'
import { glbOr, packProp, procProp, propMaterial, type PropProto } from './props-pack'
import { chainLinkTexture } from './textures'
import type { LanePoint } from './trackside'

/**
 * The paddock behind the pit building (plan I2-b), from the 2009 Mobilityland dossier
 * (pphi-3 layout, pitpad-6 team-office module, pad-14 photos) and the OSM outlines
 * (PADDOCK_BUILDINGS / BUILDINGS `builder: 'paddock'` in suzuka-facilities-spec.ts):
 *
 * - the team-office row — one merged module prototype (siding, openings atlas, roof, plinth:
 *   4 material groups) instanced per module (`teamOffices-<bay>`), every module a flat slab
 *   PADDOCK_PLANE.floor over the paddock plane at its own −s (uphill) end, so the row steps
 *   down the 2.8 % fall block by block as the elevations show; the roller doors and the
 *   condenser units are prop sets (`infield-office-shutters` / `infield-office-aircon`); the
 *   two-storey A block is its own merged mesh with an external corridor;
 * - the centre house: the OSM ring extruded (white plaster) with the 1F glass band on its round
 *   side (facade001), the 2F window band, the 2 m balcony and the external stair, the
 *   elliptical 52 × 36 m canopy on 16 round columns, and a paving-stone decal ring round it
 *   (`paddockPaving`, LAYER.paddock.hatch); the I1 spur bridge enters its flat side;
 * - the SMSC office (glass front under a deep slab on round columns), the fuel station
 *   (canopy on four columns, two island kerbs = GROUND_OBJECTS.islandKerb, four dispensers,
 *   a kiosk) oriented on the two OSM pump ways, the service house and the tyre garage on the
 *   natural ground, the former medical room (course-vehicle base) with its roll doors;
 * - the tunnel heads (the 逆バンク ramp head, the works-road portal's retaining-wall stubs —
 *   the cuts themselves are I6), the green chain-link enclosure from the OSM fence ways with
 *   its three gates (`paddockFence`: vertical cards only, posts `paddockFencePosts`), the street
 *   lamps (`infield-lamps`) and the two 22 m floodlight masts (`paddockMasts`).
 *
 * Kept from v1 until I3: the team-coloured transporters and cabs on the truck strip, the tents
 * and the flags (the gate flags moved to s 5538, off the tunnel head). Everything on the
 * paddock plane is placed in the road frame (frameAt / onPlane); everything else stands on
 * `ground.standY`. Nothing here reads the terrain (R3). No new program: plain Standard maps,
 * pbrFromAssets, cutoutFromAssets('fence003'), the pit materials.
 */

const _p = new THREE.Vector3()
const _q = new THREE.Vector3()
const _v = new THREE.Vector3()
const m4 = () => new THREE.Matrix4()
const Q = Math.PI / 2

// ---------------------------------------------------------------- geometry helpers

/** Non-indexed triangle sink with position / normal / uv, for the hand-built walls and slabs. */
class Sheet {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  /** a quad a → b → c → d (any winding); when `out` is given the winding is fixed so the normal agrees with it */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvs: [number, number][], out?: THREE.Vector3) {
    const n = _q.copy(b).sub(a).cross(_v.copy(c).sub(a))
    if (n.lengthSq() < 1e-12) n.copy(_q.copy(c).sub(a).cross(_v.copy(d).sub(a)))
    n.normalize()
    let pts = [a, b, c, d], tc = uvs
    if (out && n.dot(out) < 0) {
      n.negate()
      pts = [a, d, c, b]
      tc = [uvs[0]!, uvs[3]!, uvs[2]!, uvs[1]!]
    }
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i]!
      this.pos.push(p.x, p.y, p.z)
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(tc[i]![0], tc[i]![1])
    }
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out?: THREE.Vector3) {
    const n = _q.copy(b).sub(a).cross(_v.copy(c).sub(a)).normalize()
    let pts = [a, b, c]
    if (out && n.dot(out) < 0) { n.negate(); pts = [a, c, b] }
    for (const p of pts) {
      this.pos.push(p.x, p.y, p.z)
      this.nrm.push(n.x, n.y, n.z)
      this.uv.push(p.x, p.z)
    }
  }
  get empty() { return this.pos.length === 0 }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    return g
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** A box (w × h × d, non-indexed) with its base centre at (x, y, z) — for the prototypes and the merged pieces. */
function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  g.translate(x, y + h / 2, z)
  return g
}

/**
 * A wall quad in the local frame from (x0, z0) to (x1, z1), y0 → y1, with metre uv (u along
 * the wall from `u0`, v up) divided by `tile`; `outX / outZ` says which way it faces.
 */
function wall(sh: Sheet, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, tile: number, outX: number, outZ: number, u0 = 0) {
  const len = Math.hypot(x1 - x0, z1 - z0)
  sh.quad(V(x0, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z0), [[u0 / tile, y0 / tile], [(u0 + len) / tile, y0 / tile], [(u0 + len) / tile, y1 / tile], [u0 / tile, y1 / tile]], V(outX, 0, outZ))
}

/** the four walls of a local-frame box x ∈ [x0, x1], z ∈ [z0, z1], y0 → y1, metre uv / tile */
function walls(sh: Sheet, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, tile: number) {
  wall(sh, x1, z0, x1, z1, y0, y1, tile, 1, 0)
  wall(sh, x0, z1, x0, z0, y0, y1, tile, -1, 0)
  wall(sh, x1, z1, x0, z1, y0, y1, tile, 0, 1)
  wall(sh, x0, z0, x1, z0, y0, y1, tile, 0, -1)
}

// ---------------------------------------------------------------- canvas textures (procedural fallbacks and the openings)

/** vertical corrugated siding, one repeat = `PADDOCK_OFFICE.sidingTile` metres (the pack-less siding) */
function corrugatedTexture(k: number, base: string, dark: string): THREE.Texture {
  const w = 128, h = 128
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)
  // 8 ribs per repeat: a shaded flank on each
  for (let i = 0; i < 8; i++) {
    const x = i * 16
    ctx.fillStyle = dark
    ctx.globalAlpha = 0.28
    ctx.fillRect(x + 9, 0, 5, h)
    ctx.globalAlpha = 0.1
    ctx.fillRect(x + 3, 0, 3, h)
    ctx.globalAlpha = 1
  }
  const t = tex(c)
  t.minFilter = THREE.LinearMipmapLinearFilter
  return t
}

/**
 * The openings atlas of the team offices (256²): the left half a white steel door with a glass
 * panel (u 0–0.5, v 0–1 = 0.9 × 2.1 m), the right half's top a dark window with a white frame
 * (u 0.5–1, v 0.55–1 = 1.2 × 1.0 m).
 */
function officeOpeningsTexture(k: number): THREE.Texture {
  const w = 256, h = 256
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#e6e8e6'
  ctx.fillRect(0, 0, w, h)
  // door: frame, leaf, glass panel, handle
  ctx.fillStyle = '#9ea3a6'
  ctx.fillRect(0, 0, 128, 256)
  ctx.fillStyle = '#f2f3f1'
  ctx.fillRect(6, 6, 116, 250)
  ctx.fillStyle = '#3a4650'
  ctx.fillRect(22, 26, 84, 96)
  ctx.fillStyle = '#7d8a94'
  ctx.fillRect(28, 32, 30, 84)
  ctx.fillStyle = '#5a5e62'
  ctx.fillRect(100, 150, 10, 4)
  // window: frame + two dark panes with a reflection gradient
  ctx.fillStyle = '#f4f5f3'
  ctx.fillRect(128, 0, 128, 116)
  ctx.fillStyle = '#2f3b45'
  ctx.fillRect(134, 6, 116, 104)
  ctx.fillStyle = '#f4f5f3'
  ctx.fillRect(190, 6, 4, 104)
  const grad = ctx.createLinearGradient(134, 6, 250, 110)
  grad.addColorStop(0, 'rgba(255,255,255,0.28)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.05)')
  grad.addColorStop(1, 'rgba(255,255,255,0.18)')
  ctx.fillStyle = grad
  ctx.fillRect(134, 6, 116, 104)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** a light-grey ribbed roller shutter (the pack-less shutter prototype), one leaf per texture */
function shutterTexture(k: number): THREE.Texture {
  const w = 128, h = 128
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#c9ccce'
  ctx.fillRect(0, 0, w, h)
  for (let y = 0; y < h; y += 8) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(0, y + 5, w, 3)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillRect(0, y + 1, w, 2)
  }
  return tex(c)
}

/** a window band: dark glass with mullions every 1.5 m (one repeat = 1.5 m) */
function windowBandTexture(k: number): THREE.Texture {
  const w = 96, h = 64
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#2c3842'
  ctx.fillRect(0, 0, w, h)
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, 'rgba(255,255,255,0.22)')
  grad.addColorStop(1, 'rgba(255,255,255,0.04)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#dfe2e0'
  ctx.fillRect(0, 0, 4, h)
  ctx.fillRect(0, 0, w, 3)
  ctx.fillRect(0, h - 3, w, 3)
  return tex(c)
}

/** the pack-less paving stones (2 m repeat = a 5 × 5 grid of grey flags) */
function pavingTexture(k: number): THREE.Texture {
  const w = 128, h = 128
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#8d8c88'
  ctx.fillRect(0, 0, w, h)
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    const g = 150 + ((i * 7 + j * 13) % 5) * 9
    ctx.fillStyle = `rgb(${g},${g - 2},${g - 6})`
    ctx.fillRect(i * 25.6 + 1.5, j * 25.6 + 1.5, 22.6, 22.6)
  }
  return tex(c)
}

// ---------------------------------------------------------------- materials

interface PaddockMaterials {
  siding: THREE.MeshStandardMaterial
  sidingTile: number
  siding009: THREE.MeshStandardMaterial
  siding009Tile: [number, number]
  openings: THREE.MeshStandardMaterial
  officeRoof: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  shell: THREE.MeshStandardMaterial
  white: THREE.MeshStandardMaterial
  glass: THREE.MeshStandardMaterial
  glassBand: THREE.MeshStandardMaterial
  glassBandTile: number
  windowBand: THREE.MeshStandardMaterial
  paving: THREE.MeshStandardMaterial
  pavingTile: number
  retaining: THREE.MeshStandardMaterial
  retainingTile: [number, number]
  fence: THREE.MeshStandardMaterial
  fenceTile: number
  green: THREE.MeshStandardMaterial
  steel: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  rail: THREE.MeshStandardMaterial
  roof: THREE.Material
}

function paddockMaterials(ctx: EnvBuildContext, buildingRoofMat: THREE.Material): PaddockMaterials {
  const reg = ctx.assets
  const k = ctx.quality.textureScale
  const pm = pitMaterials(ctx)
  const sidingTile = tileMetres(reg, 'tex/corrugatedsteel007a/diff', PADDOCK_OFFICE.sidingTile)
  const sidingFallback = () => new THREE.MeshStandardMaterial({ map: corrugatedTexture(k, '#e9ebe8', '#6d7276'), roughness: 0.55, metalness: 0.35 })
  const siding = reg ? pbrFromAssets(reg, 'corrugatedsteel007a', { fallback: sidingFallback, handBuiltUv: true, normalScale: 0.7, extra: { color: 0xf2f3f0 } }) : sidingFallback()
  const t9u = tileMetres(reg, 'tex/corrugatedsteel009/diff', 1.5)
  const siding009Tile: [number, number] = [t9u, t9u / assetAspect(reg, 'tex/corrugatedsteel009/diff', 2)]
  const siding009Fallback = () => new THREE.MeshStandardMaterial({ map: corrugatedTexture(k, '#cfd3d1', '#4e5457'), roughness: 0.6, metalness: 0.4 })
  const siding009 = reg ? pbrFromAssets(reg, 'corrugatedsteel009', { fallback: siding009Fallback, handBuiltUv: true, normalScale: 0.7, extra: { color: 0xd8dbd8 } }) : siding009Fallback()
  const openings = new THREE.MeshStandardMaterial({ map: officeOpeningsTexture(k), roughness: 0.45, metalness: 0.2 })
  const officeRoof = new THREE.MeshStandardMaterial({ color: PADDOCK_OFFICE.roofColour, roughness: 0.5, metalness: 0.35 })
  const glassBandTile = tileMetres(reg, 'tex/facade001/diff', 4)
  const glassBand = reg ? pbrFromAssets(reg, 'facade001', { fallback: () => pm.glassMat, handBuiltUv: true, normalScale: 0.5 }) : pm.glassMat
  const windowBand = new THREE.MeshStandardMaterial({ map: windowBandTexture(k), roughness: 0.25, metalness: 0.5 })
  const pavingTile = tileMetres(reg, 'tex/pavingstones099/diff', 2)
  const pavingFallback = () => new THREE.MeshStandardMaterial({ map: pavingTexture(k), roughness: 0.85 })
  const paving = reg ? pbrFromAssets(reg, 'pavingstones099', { fallback: pavingFallback, handBuiltUv: true, normalScale: 0.7 }) : pavingFallback()
  const rtU = tileMetres(reg, 'tex/preconcrete_wall_001_long/diff', 4)
  const retainingTile: [number, number] = [rtU, rtU / assetAspect(reg, 'tex/preconcrete_wall_001_long/diff', 3)]
  const retainingFallback = () => new THREE.MeshStandardMaterial({ color: 0x9a9894, roughness: 0.9 })
  const retaining = reg ? pbrFromAssets(reg, 'preconcrete_wall_001_long', { fallback: retainingFallback, handBuiltUv: true, normalScale: 0.8, extra: { color: 0x9a9894 } }) : retainingFallback()
  const fenceTile = 2.0
  const fence = cutoutFromAssets(reg, 'fence003', {
    quality: ctx.quality, tile: fenceTile, handBuiltUv: true, normalScale: 0.5, extra: { color: PADDOCK_FENCE.colour, metalness: 0.3 },
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(1 / 0.2, 1 / 0.2)
      return new THREE.MeshStandardMaterial({ map, color: PADDOCK_FENCE.colour, ...cutoutParams(ctx.quality), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 })
    },
  })
  const green = new THREE.MeshStandardMaterial({ color: PADDOCK_FENCE.colour, roughness: 0.6, metalness: 0.3 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.6 })
  return {
    siding, sidingTile, siding009, siding009Tile, openings, officeRoof, concrete: pm.pierMat, shell: pm.shellMat, white: pm.whiteMat, glass: pm.glassMat,
    glassBand, glassBandTile, windowBand, paving, pavingTile, retaining, retainingTile, fence, fenceTile, green, steel, dark: pm.darkMat, rail: pm.railMat, roof: buildingRoofMat,
  }
}

// ---------------------------------------------------------------- the builder

export function buildPaddock(ctx: EnvBuildContext, opts: { buildingRoofMat: THREE.Material }): void {
  const { track, ground, group, boxes, quality } = ctx
  const L = track.length
  const M = paddockMaterials(ctx, opts.buildingRoofMat)
  const { railMat, whiteMat } = pitMaterials(ctx)
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)
  const stat = (key: string, n: number) => { ctx.infieldStats[key] = (ctx.infieldStats[key] ?? 0) + n }
  const shadows = quality.farField.shadows
  const rowOf = (id: string): PaddockBuildingDef => {
    const r = PADDOCK_BUILDINGS.find((b) => b.id === id)
    if (!r) throw new Error(`[paddock] PADDOCK_BUILDINGS has no '${id}'`)
    return r
  }
  /** world y of the road plane at track (s, lateral) */
  const roadY = (s: number, lat: number) => track.pointAt(track.wrap(s), lat, _p, 0).y
  /** track coordinates of an EN point, windowed to the row's stretch (R14: the paddock's far corners are nearer the S-curve leg) */
  const trackAt = (e: number, n: number, window: [number, number]): { s: number; lat: number } => {
    track.enToWorld(e, n, _p)
    const r = track.nearestOnRange(_p.x, _p.z, window[0], window[1], 40)
    return { s: r.s, lat: r.lateral }
  }
  /** world y of the drawn ground at track (s, lateral) */
  const standWorld = (s: number, lat: number): number => {
    track.pointAt(track.wrap(s), lat, _p, 0)
    return ground.standY(_p.x, _p.z)
  }
  /** a track-frame box: s0 → s1 along the lap, l0 → l1 across, WORLD y0 → y1, as walls (metre uv / tile) + a top */
  const trackWalls = (s0: number, s1: number, l0: number, l1: number, y0: number, y1: number, tile: [number, number]): { sides: THREE.BufferGeometry; top: THREE.BufferGeometry; bottom: THREE.BufferGeometry } => {
    const sides = new Sheet(), top = new Sheet(), bottom = new Sheet()
    const at = (s: number, l: number, y: number) => { track.pointAt(track.wrap(s), l, _p, 0); return V(_p.x, y, _p.z) }
    const A0 = at(s0, l0, y0), B0 = at(s1, l0, y0), C0 = at(s1, l1, y0), D0 = at(s0, l1, y0)
    const A1 = at(s0, l0, y1), B1 = at(s1, l0, y1), C1 = at(s1, l1, y1), D1 = at(s0, l1, y1)
    const cx = (A0.x + C0.x) / 2, cz = (A0.z + C0.z) / 2
    const face = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3) => {
      const mx = (p0.x + p1.x) / 2 - cx, mz = (p0.z + p1.z) / 2 - cz
      const len = p0.distanceTo(p1), h = y1 - y0
      sides.quad(p0, p1, p2, p3, [[0, 0], [len / tile[0], 0], [len / tile[0], h / tile[1]], [0, h / tile[1]]], V(mx, 0, mz))
    }
    face(A0, B0, B1, A1)
    face(B0, C0, C1, B1)
    face(C0, D0, D1, C1)
    face(D0, A0, A1, D1)
    top.quad(A1, B1, C1, D1, [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 1, 0))
    bottom.quad(A0, B0, C0, D0, [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, -1, 0))
    return { sides: sides.build(), top: top.build(), bottom: bottom.build() }
  }
  /** a proud quad on a track-frame face: s0 → s1 at lateral `lat`, y0 → y1 (world), facing ±lateral; uv u in metres / tileU, v 0 → 1 */
  const faceQuad = (sh: Sheet, s0: number, s1: number, lat: number, y0: number, y1: number, facing: 1 | -1, tileU = 1) => {
    const at = (s: number, y: number) => { track.pointAt(track.wrap(s), lat, _p, 0); return V(_p.x, y, _p.z) }
    const len = forwardDelta(s0, s1, L)
    const h = track.headingAt(track.wrap((s0 + s1) / 2))
    sh.quad(at(s0, y0), at(s1, y0), at(s1, y1), at(s0, y1), [[0, 0], [len / tileU, 0], [len / tileU, 1], [0, 1]], V(facing * h.tz, 0, -facing * h.tx))
  }
  const plane = PADDOCK_PLANE
  const rails: THREE.BufferGeometry[] = []
  const glassGeos: THREE.BufferGeometry[] = []
  const concreteGeos: THREE.BufferGeometry[] = []
  const darkGeos: THREE.BufferGeometry[] = []

  // --- the prop prototypes shared by several buildings ------------------------------------------------
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const k = quality.textureScale
  const shutterMat = new THREE.MeshStandardMaterial({ map: shutterTexture(k), roughness: 0.5, metalness: 0.45 })
  /** a roller shutter leaf w × h (the pack door is 1.08 × 2.4: its prototype is stretched to the size, so both levels share the placements) */
  const shutterProto = (id: string, w: number, h: number): { near: PropProto; far: PropProto } => {
    const far = procProp(id, [{ geometry: box(w, h, 0.06), material: shutterMat }])
    let near = far
    if (quality.infield.glb && ctx.assets) {
      const glb = packProp(ctx.assets, ctx.props, 'model/props/rollershutter_door', { id, nodes: /^rollershutter_door(\/|$)/, front: 'moreArea' })
      if (glb) {
        glb.geometry.scale(w / glb.footprint.long, h / glb.footprint.height, 1)
        glb.geometry.computeBoundingBox()
        glb.geometry.computeBoundingSphere()
        glb.footprint = { long: w, short: glb.footprint.short, height: h }
        near = glb
      }
    }
    return { near, far }
  }
  const officeShutter = shutterProto('office-shutter', PADDOCK_OFFICE.rollDoor[0], PADDOCK_OFFICE.rollDoor[1])
  const airconProc = procProp('aircon', [{ geometry: box(0.8, 0.85, 0.35), material: plain(0xd9dbd8, 0.6, 0.3) }, { geometry: box(0.7, 0.05, 0.3, 0, 0.85), material: plain(0x5a5e62, 0.6, 0.3) }])
  const aircon = glbOr(ctx, 'model/props/exterior_aircon_unit', { front: 'moreArea', scaleTo: { height: 0.9 } }, airconProc)
  const shutters: PropSet = { proto: officeShutter.near, far: officeShutter.far, placements: [] }
  const aircons: PropSet = { proto: aircon, far: airconProc, placements: [] }
  /** put a base-centred prototype in a local frame: parent matrix × translation × yaw */
  const putIn = (set: PropSet, parent: THREE.Matrix4, x: number, y: number, z: number, yaw: number) => {
    const m = parent.clone().multiply(m4().makeTranslation(x, y, z))
    if (yaw) m.multiply(m4().makeRotationY(yaw))
    set.placements.push({ m })
  }

  // ================================================================ team offices
  {
    const O = PADDOCK_OFFICE
    const D = O.lateral[1] - O.lateral[0] // 10.5
    const latMid = (O.lateral[0] + O.lateral[1]) / 2
    const E = O.eaves
    /** one module (or the WC block) as a 4-group geometry in the module frame: X = +lateral (the pit side at +X), Z = +s, y = the floor */
    const moduleGeometry = (len: number, rooms: number): THREE.BufferGeometry => {
      const hx = D / 2, hz = len / 2
      const siding = new Sheet(), open = new Sheet(), roof = new Sheet(), conc = new Sheet()
      walls(siding, -hx, hx, -hz, hz, 0, E, M.sidingTile)
      // the openings: per room a window on the pit face beside the roller door, a door + window on the paddock face
      const P = 0.012
      const cell = (u0: number, v0: number, u1: number, v1: number): [number, number][] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
      const DOOR = cell(0, 0, 0.5, 1), WIN = cell(0.5, 0.55, 1, 1)
      for (let r = 0; r < rooms; r++) {
        const zc = -hz + (len / rooms) * (r + 0.5)
        const [ww, wh] = O.window
        // pit face window, 0.9 wide beside the 2.5 m roller door (the prop stands at zc − 0.45, to zc + 0.8)
        let z0 = zc + 1.4 - 0.45
        open.quad(V(hx + P, 1.5, z0), V(hx + P, 1.5, z0 + 0.9), V(hx + P, 1.5 + wh, z0 + 0.9), V(hx + P, 1.5 + wh, z0), WIN, V(1, 0, 0))
        // paddock face: the door and its window
        const [dw, dh] = O.door
        z0 = zc - 1.0 - dw / 2
        open.quad(V(-hx - P, 0, z0 + dw), V(-hx - P, 0, z0), V(-hx - P, dh, z0), V(-hx - P, dh, z0 + dw), DOOR, V(-1, 0, 0))
        z0 = zc + 0.9 - ww / 2
        open.quad(V(-hx - P, 1.5, z0 + ww), V(-hx - P, 1.5, z0), V(-hx - P, 1.5 + wh, z0), V(-hx - P, 1.5 + wh, z0 + ww), WIN, V(-1, 0, 0))
        // the 2 m ramp down from the paddock porch at the door (its toe below the plane: the ground cuts it)
        const rx0 = -hx - O.porch.paddock, rx1 = rx0 - O.ramp, rz0 = zc - 1.0 - 0.6, rz1 = zc - 1.0 + 0.6
        conc.quad(V(rx0, 0, rz0), V(rx0, 0, rz1), V(rx1, -0.5, rz1), V(rx1, -0.5, rz0), [[0, 0], [1, 0], [1, 1], [0, 1]], V(-0.24, 1, 0))
        conc.tri(V(rx0, 0, rz0), V(rx1, -0.5, rz0), V(rx0, -0.5, rz0), V(0, 0, -1))
        conc.tri(V(rx0, 0, rz1), V(rx0, -0.5, rz1), V(rx1, -0.5, rz1), V(0, 0, 1))
      }
      // the roof: a 0.33 fascia slab with 0.3 m eaves overhang and a shallow ridge along the module
      const ox = hx + 0.3, oz = hz + 0.2, ridge = O.roofTop + 0.3
      roof.quad(V(-ox, E, -oz), V(ox, E, -oz), V(ox, O.roofTop, -oz), V(-ox, O.roofTop, -oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 0, -1))
      roof.quad(V(-ox, E, oz), V(ox, E, oz), V(ox, O.roofTop, oz), V(-ox, O.roofTop, oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 0, 1))
      roof.quad(V(ox, E, -oz), V(ox, E, oz), V(ox, O.roofTop, oz), V(ox, O.roofTop, -oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(1, 0, 0))
      roof.quad(V(-ox, E, -oz), V(-ox, E, oz), V(-ox, O.roofTop, oz), V(-ox, O.roofTop, -oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(-1, 0, 0))
      roof.quad(V(-ox, E, -oz), V(ox, E, -oz), V(ox, E, oz), V(-ox, E, oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, -1, 0))
      roof.quad(V(-ox, O.roofTop, -oz), V(-ox, O.roofTop, oz), V(0, ridge, oz), V(0, ridge, -oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(-0.3, 1, 0))
      roof.quad(V(ox, O.roofTop, -oz), V(ox, O.roofTop, oz), V(0, ridge, oz), V(0, ridge, -oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0.3, 1, 0))
      roof.tri(V(-ox, O.roofTop, -oz), V(0, ridge, -oz), V(ox, O.roofTop, -oz), V(0, 0, -1))
      roof.tri(V(-ox, O.roofTop, oz), V(ox, O.roofTop, oz), V(0, ridge, oz), V(0, 0, 1))
      // the plinth and the porches: down to the plane at the module's downhill end (0.035 × len of fall) and the plinth depth
      const depth = plane.floor + plane.plinth + 0.035 * len
      const plinth = mergeGeometries([box(D + O.porch.pit + O.porch.paddock, depth, len, (O.porch.pit - O.porch.paddock) / 2, -depth, 0)], false)!
      const concGeo = conc.empty ? plinth : mergeGeometries([plinth, conc.build()], false)!
      const geo = mergeGeometries([siding.build(), open.build(), roof.build(), concGeo], true)!
      geo.computeBoundingBox()
      geo.computeBoundingSphere()
      return geo
    }
    const moduleMats = [M.siding, M.openings, M.officeRoof, M.concrete]
    const moduleGeo = moduleGeometry(O.module, O.rooms)
    const matrices: THREE.Matrix4[] = []
    const bays: number[] = []
    let modules = 0
    for (const row of PADDOCK_BUILDINGS) {
      if (row.kind !== 'teamOffices') continue
      const n = row.modules || 1
      const len = row.modules ? O.module : forwardDelta(row.sRange[0], row.sRange[1], L)
      const geo = row.modules ? moduleGeo : moduleGeometry(len, Math.max(1, Math.round(len / (O.module / O.rooms))))
      const rowMatrices: THREE.Matrix4[] = []
      for (let i = 0; i < n; i++) {
        // the floor: PADDOCK_PLANE.floor over the plane at the module's −s (uphill) end, one flat slab
        const s0 = track.wrap(row.sRange[0] + i * len)
        const sc = track.wrap(s0 + len / 2)
        const floor = roadY(s0, latMid) - plane.drop + plane.floor - roadY(sc, latMid)
        const m = frameAt(track, sc, latMid, floor, m4())
        rowMatrices.push(m)
        modules++
        if (!row.modules) continue
        const rooms = O.rooms
        for (let r = 0; r < rooms; r++) {
          const zc = -len / 2 + (len / rooms) * (r + 0.5)
          putIn(shutters, m, D / 2 + 0.05, 0, zc - 0.45, Q)
          putIn(aircons, m, -D / 2 - 0.35, 0, zc + 1.75, -Q)
        }
      }
      if (row.modules) {
        for (const m of rowMatrices) { matrices.push(m); bays.push(Math.floor(track.wrap(row.sRange[0]) / 60)) }
      } else {
        for (const inst of bucketedInstancedMeshes(geo, moduleMats, rowMatrices, null, () => 0, { name: `teamOffices-${row.id}`, castShadow: shadows, receiveShadow: true })) group.add(inst)
      }
    }
    for (const inst of bucketedInstancedMeshes(moduleGeo, moduleMats, matrices, null, (i) => bays[i]!, { name: 'teamOffices', castShadow: shadows, receiveShadow: true })) group.add(inst)
    stat('paddock-offices', modules)

    // --- the two-storey A block: a white plaster box with two window rows, an external corridor on the paddock face and a stair
    {
      const row = rowOf('offices_a')
      const [s0, s1] = row.sRange
      const sc = (s0 + s1) / 2
      const floorW = roadY(s0, latMid) - plane.drop + plane.floor
      const base = floorW - plane.floor - plane.plinth - 0.035 * (s1 - s0)
      const eaves = floorW + row.eaves
      const b = trackWalls(s0, s1, O.lateral[0], O.lateral[1], base, eaves, [2, 2])
      const shell: THREE.BufferGeometry[] = [b.sides]
      const roofGeos: THREE.BufferGeometry[] = [b.top]
      // the parapet and the corridor slab (1.5 m on the paddock face at the 2F floor)
      const corridor = trackWalls(s0 - 0.2, s1 + 0.2, O.lateral[0] - 1.5, O.lateral[0], floorW + 3.2, floorW + 3.4, [2, 2])
      shell.push(corridor.sides, corridor.bottom)
      roofGeos.push(corridor.top)
      // window rows on both long faces
      const win = new Sheet()
      for (const [lat, facing] of [[O.lateral[1] + 0.02, 1], [O.lateral[0] - 0.02, -1]] as const) {
        for (const y of [floorW + 1.2, floorW + 4.5]) {
          for (let s = s0 + 1.2; s + 3.2 < s1; s += 4.6) faceQuad(win, s, s + 3.2, lat, y, y + 1.3, facing, 1.5)
        }
      }
      // corridor rail: a top tube and posts
      const railY = floorW + 3.4
      const railLat = O.lateral[0] - 1.45
      const tubeS = new Sheet()
      const r = 0.025
      const at = (s: number, l: number, y: number) => { track.pointAt(track.wrap(s), l, _p, 0); return V(_p.x, y, _p.z) }
      tubeS.quad(at(s0, railLat - r, railY + 1.1), at(s1, railLat - r, railY + 1.1), at(s1, railLat - r, railY + 1.1 + 2 * r), at(s0, railLat - r, railY + 1.1 + 2 * r), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 0, 0))
      rails.push(tubeS.build())
      for (let s = s0 + 0.3; s <= s1; s += 2.0) {
        const post = new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6)
        post.translate(0, 0.55, 0)
        post.applyMatrix4(frameAt(track, track.wrap(s), railLat, railY - roadY(s, railLat), m4()))
        rails.push(post)
      }
      // the external stair at the −s end: 16 treads down along −s from the corridor
      for (let i = 0; i < 16; i++) {
        const y = railY - 0.2 * (i + 1)
        const s = s0 - 0.2 - 0.28 * (i + 0.5)
        const step = box(1.4, 0.2, 0.3)
        step.applyMatrix4(frameAt(track, track.wrap(s), O.lateral[0] - 0.75, y - roadY(s, O.lateral[0] - 0.75), m4()))
        concreteGeos.push(step)
      }
      add(shell, M.shell, 'paddockOfficeA', true)
      add(roofGeos, M.roof, 'paddockOfficeARoof', true)
      glassGeos.push(win.build())
      stat('paddock-officeA', 1)
    }
  }

  // ================================================================ the centre house and its canopy
  {
    const bRow = BUILDINGS.find((b) => b.id === 'centre_house')!
    const row = rowOf('centre_house')
    const f = osmFeature(row.osmWay!)!
    const anchor = bRow.anchor as { s: number; lateral: number }
    const floorW = roadY(anchor.s, anchor.lateral) - plane.drop + plane.floor
    const baseW = floorW - plane.floor - plane.plinth
    const eavesW = floorW + bRow.height
    // the ring in world xz and track coordinates, its outward normals
    const ring = f.en.map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z, ...trackAt(e, n, row.sRange) } })
    const n = ring.length
    let cx = 0, cz = 0
    for (const v of ring) { cx += v.x / n; cz += v.z / n }
    const segNormal = (i: number) => {
      const a = ring[i]!, b = ring[(i + 1) % n]!
      const dx = b.x - a.x, dz = b.z - a.z
      const len = Math.hypot(dx, dz) || 1
      let nx = dz / len, nz = -dx / len
      if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.z + b.z) / 2 - cz) < 0) { nx = -nx; nz = -nz }
      return { nx, nz, len }
    }
    // the flat (pit) side = the segment whose midpoint has the greatest lateral
    let flat = 0, best = -Infinity
    for (let i = 0; i < n; i++) {
      const mid = (ring[i]!.lat + ring[(i + 1) % n]!.lat) / 2
      if (mid > best) { best = mid; flat = i }
    }
    // the shell: the OSM ring extruded from the plinth to the eaves (the flat roof at the eaves)
    const shape = new THREE.Shape(f.en.map(([e, nn]) => new THREE.Vector2(e, nn)))
    const ext = new THREE.ExtrudeGeometry(shape, { depth: eavesW - baseW, bevelEnabled: false })
    ext.applyMatrix4(enMatrix(track, baseW))
    const capGeos: THREE.BufferGeometry[] = [], wallGeos: THREE.BufferGeometry[] = []
    for (const g of ext.groups) (g.materialIndex === 0 ? capGeos : wallGeos).push(slice(ext, g.start, g.count))
    ext.dispose()
    add(wallGeos, M.shell, 'centreHouse', true)
    add(capGeos, M.roof, 'centreHouseRoof', true)
    // the 1F glass band on the round side (facade001, 0.2 → 3.8), the 2F window band all round, the balcony slab + rail
    const glass1 = new Sheet(), band2 = new Sheet(), balcony = new Sheet()
    const balconyY = floorW + PIT_BUILDING.v2.floors[1]
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!
      const { nx, nz, len } = segNormal(i)
      const out = V(nx, 0, nz)
      const P = 0.03
      const ax = a.x + nx * P, az = a.z + nz * P, bx = b.x + nx * P, bz = b.z + nz * P
      band2.quad(V(ax, floorW + 5.6, az), V(bx, floorW + 5.6, bz), V(bx, floorW + 7.2, bz), V(ax, floorW + 7.2, az), [[0, 0], [len / 1.5, 0], [len / 1.5, 1], [0, 1]], out)
      if (i === flat) continue
      glass1.quad(V(ax, floorW + 0.2, az), V(bx, floorW + 0.2, bz), V(bx, floorW + 3.8, bz), V(ax, floorW + 3.8, az), [[0, 0], [len / M.glassBandTile, 0], [len / M.glassBandTile, 3.6 / M.glassBandTile], [0, 3.6 / M.glassBandTile]], out)
      // balcony: a 2 m slab from the wall out, 0.2 thick, and its rail on the outer edge
      const ox = nx * 2, oz = nz * 2
      const y0 = balconyY, y1 = balconyY + 0.2
      balcony.quad(V(a.x, y1, a.z), V(b.x, y1, b.z), V(b.x + ox, y1, b.z + oz), V(a.x + ox, y1, a.z + oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, 1, 0))
      balcony.quad(V(a.x, y0, a.z), V(b.x, y0, b.z), V(b.x + ox, y0, b.z + oz), V(a.x + ox, y0, a.z + oz), [[0, 0], [1, 0], [1, 1], [0, 1]], V(0, -1, 0))
      balcony.quad(V(a.x + ox, y0, a.z + oz), V(b.x + ox, y0, b.z + oz), V(b.x + ox, y1, b.z + oz), V(a.x + ox, y1, a.z + oz), [[0, 0], [1, 0], [1, 1], [0, 1]], out)
      const rs = new Sheet()
      const ry = y1 + 1.1, r = 0.025
      rs.quad(V(a.x + ox, ry, a.z + oz), V(b.x + ox, ry, b.z + oz), V(b.x + ox, ry + 2 * r, b.z + oz), V(a.x + ox, ry + 2 * r, a.z + oz), [[0, 0], [1, 0], [1, 1], [0, 1]], out)
      rails.push(rs.build())
      for (let d = 0.2; d < len; d += 1.5) {
        const t = d / len
        const post = new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6)
        post.translate(a.x + ox + (b.x - a.x) * t - nx * 0.05, y1 + 0.55, a.z + oz + (b.z - a.z) * t - nz * 0.05)
        rails.push(post)
      }
    }
    add([glass1.build()], M.glassBand, 'centreHouseGlass', false)
    add([band2.build()], M.windowBand, 'centreHouseWindows', false)
    add([balcony.build()], M.shell, 'centreHouseBalcony', true)
    // the external stair on the −s side: 25 treads from the ground up to the balcony along lateral
    {
      const sStair = row.sRange[0] + 2.0
      const rise = (balconyY - standWorld(sStair, -100)) / 25
      for (let i = 0; i < 25; i++) {
        const lat = -100 + 0.28 * (i + 0.5)
        const y = standWorld(sStair, -100) + rise * (i + 1)
        const step = box(0.3, 0.2, 1.2)
        step.applyMatrix4(frameAt(track, track.wrap(sStair), lat, y - 0.2 - roadY(sStair, lat), m4()))
        concreteGeos.push(step)
      }
    }
    // the elliptical canopy: 52 (lateral) × 36 (s), a 0.35 slab at 9.6, on 16 round columns just outside the walls
    {
      const a = 26, b = 18, y = 9.6
      const centreS = (row.sRange[0] + row.sRange[1]) / 2, centreLat = anchor.lateral - 19
      const shape2 = new THREE.Shape().absellipse(0, 0, a, b, 0, Math.PI * 2, false, 0)
      const slab = new THREE.ExtrudeGeometry(shape2, { depth: 0.35, bevelEnabled: false, curveSegments: 48 })
      slab.rotateX(Q)
      slab.translate(0, 0.35, 0)
      const frame = frameAt(track, track.wrap(centreS), centreLat, floorW - roadY(centreS, centreLat) + y, m4())
      slab.applyMatrix4(frame)
      add([slab], M.white, 'centreHouseCanopy', true)
      const cols: THREE.BufferGeometry[] = []
      const inRing = (x: number, z: number) => {
        let inside = false
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const pi = ring[i]!, pj = ring[j]!
          if (pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z) + pi.x) inside = !inside
        }
        return inside
      }
      let count = 0
      for (let i = 0; i < 16; i++) {
        // angle 0 = +lateral (the flat side): the columns leave the flat side's ±40° to the bridge and the entrance
        const t = (40 + (280 * i) / 15) * (Math.PI / 180)
        let rx = 0.94 * a * Math.cos(t), rz = 0.94 * b * Math.sin(t)
        for (let step = 0; step < 8; step++) {
          _p.set(rx, 0, rz).applyMatrix4(frame)
          if (!inRing(_p.x, _p.z)) break
          rx *= 1.03
          rz *= 1.03
        }
        _p.set(rx, 0, rz).applyMatrix4(frame)
        const top = floorW + y
        const bottom = ground.standY(_p.x, _p.z) - 0.05
        const col = new THREE.CylinderGeometry(0.175, 0.175, top - bottom, 12)
        col.translate(_p.x, (top + bottom) / 2, _p.z)
        cols.push(col)
        count++
      }
      add(cols, M.white, 'centreHouseColumns', true)
      stat('paddock-centreHouseColumns', count)
    }
    // the paving-stone apron round the building: a 3 m decal ring on the paddock face (mitred offsets, no overlaps)
    {
      const quads: DecalQuad[] = []
      const off = ring.map((v, i) => {
        const p = segNormal((i - 1 + n) % n), q = segNormal(i)
        let bx = p.nx + q.nx, bz = p.nz + q.nz
        const bl = Math.hypot(bx, bz) || 1
        bx /= bl
        bz /= bl
        const scale = 3 / Math.max(0.35, bx * q.nx + bz * q.nz)
        return { x: v.x + bx * scale, z: v.z + bz * scale }
      })
      const yHint = floorW - plane.floor
      const tile = M.pavingTile
      for (let i = 0; i < n; i++) {
        const a = ring[i]!, b = ring[(i + 1) % n]!, oa = off[i]!, ob = off[(i + 1) % n]!
        quads.push({ xz: [a.x, a.z, b.x, b.z, ob.x, ob.z, oa.x, oa.z], yHint, attrs: (x, z) => [x / tile, z / tile] })
      }
      const built = ground.decal(quads, LAYER.paddock.hatch, [{ name: 'uv', size: 2 }])
      if (built.geo) {
        const mesh = new THREE.Mesh(built.geo, M.paving)
        mesh.name = 'paddockPaving'
        mesh.receiveShadow = true
        mesh.renderOrder = 1
        markDecal(mesh, LAYER.paddock.hatch, built.stats)
        group.add(mesh)
      }
    }
  }

  // ================================================================ SMSC office
  {
    const row = rowOf('smsc')
    const [s0, s1] = row.sRange
    const [l0, l1] = row.lateral!
    const floorW = roadY(s0, (l0 + l1) / 2) - plane.drop + plane.floor
    const base = floorW - plane.floor - plane.plinth - 0.035 * (s1 - s0)
    const b = trackWalls(s0, s1, l0, l1, base, floorW + row.eaves, [2, 2])
    // the deep roof slab overhangs the glazed front (+lateral face) by 3 m, on round columns every 5 m
    const slab = trackWalls(s0 - 0.3, s1 + 0.3, l0 - 0.3, l1 + 3.0, floorW + row.eaves - 0.5, floorW + row.eaves, [2, 2])
    add([b.sides, slab.sides, slab.bottom], M.shell, 'paddockSmsc', true)
    add([b.top, slab.top], M.roof, 'paddockSmscRoof', true)
    const g = new Sheet()
    faceQuad(g, s0 + 0.2, s1 - 0.2, l1 + 0.03, floorW + 0.15, floorW + row.eaves - 0.55, 1, 4)
    glassGeos.push(g.build())
    for (let s = s0 + 0.5; s <= s1; s += 5) {
      const col = new THREE.CylinderGeometry(0.15, 0.15, row.eaves - 0.5, 10)
      col.translate(0, (row.eaves - 0.5) / 2, 0)
      col.applyMatrix4(frameAt(track, track.wrap(s), l1 + 2.6, floorW - roadY(s, l1 + 2.6), m4()))
      concreteGeos.push(col)
    }
  }

  // ================================================================ the fuel station
  {
    const row = rowOf('fuel')
    const [wa, wb] = row.axisWays!
    const fa = osmFeature(wa)!, fb = osmFeature(wb)!
    const centroid = (f: OsmFeature) => {
      let e = 0, nn = 0
      for (const [pe, pn] of f.en) { e += pe / f.en.length; nn += pn / f.en.length }
      return trackAt(e, nn, row.sRange)
    }
    const ca = centroid(fa), cb = centroid(fb)
    const sc = (ca.s + cb.s) / 2, lc = (ca.lat + cb.lat) / 2
    // the long axis through the two islands, in the road frame (X = +lateral, Z = +s)
    const yaw = Math.atan2(cb.lat - ca.lat, cb.s - ca.s)
    const groundY = standWorld(sc, lc)
    const frame = frameAt(track, track.wrap(sc), lc, groundY - roadY(sc, lc), m4()).multiply(m4().makeRotationY(yaw))
    const canopyH = row.eaves
    // canopy 24 × 9 × 0.6 on four φ0.4 columns
    const canopy = box(9, 0.6, 24, 0, canopyH)
    canopy.applyMatrix4(frame)
    add([canopy], M.white, 'paddockFuelCanopy', true)
    const cols: THREE.BufferGeometry[] = []
    for (const [x, z] of [[-3.0, -8.5], [3.0, -8.5], [-3.0, 8.5], [3.0, 8.5]]) {
      _p.set(x!, 0, z!).applyMatrix4(frame)
      const bottom = ground.standY(_p.x, _p.z) - 0.05, top = groundY + canopyH + 0.05
      const col = new THREE.CylinderGeometry(0.2, 0.2, top - bottom, 12)
      col.translate(_p.x, (top + bottom) / 2, _p.z)
      cols.push(col)
    }
    add(cols, M.white, 'paddockFuelColumns', true)
    // the two island kerbs (GROUND_OBJECTS.islandKerb, stadium outlines walked in the frame's positive sense) and the dispensers
    const rule = GROUND_OBJECTS.islandKerb
    const kerbs: THREE.BufferGeometry[] = []
    let kerbLen = 0
    const dispensers: PropSet = { proto: procProp('dispenser', [{ geometry: box(0.55, 1.6, 1.0), material: plain(0x3a3d41, 0.5, 0.4) }, { geometry: box(0.5, 0.5, 0.95, 0, 1.1), material: plain(0xf2f2f0, 0.5, 0.2) }]), placements: [] }
    const dz = Math.hypot(cb.lat - ca.lat, cb.s - ca.s) / 2
    for (const zc of [-dz, dz]) {
      const hl = 2.5, hw = 0.6, r = hw
      const pts: LanePoint[] = []
      const push = (x: number, z: number) => {
        _p.set(x, 0, z).applyMatrix4(frame)
        pts.push({ x: _p.x, z: _p.z, s: sc, lat: lc, d: pts.length ? pts[pts.length - 1]!.d + Math.hypot(_p.x - pts[pts.length - 1]!.x, _p.z - pts[pts.length - 1]!.z) : 0 })
      }
      const capN = 8
      for (let i = 0; i <= capN; i++) { const t = -Q + (Math.PI * i) / capN; push(r * Math.sin(t), zc + hl - r + r * Math.cos(t)) }
      for (let i = 0; i <= capN; i++) { const t = Q + (Math.PI * i) / capN; push(r * Math.sin(t), zc - (hl - r) + r * Math.cos(t)) }
      // the same parametrisation as the grass island (X = r sin t, Z = r cos t, t rising), so the ribbon faces up
      const loop = pts
      kerbs.push(sweepKerb(ground, loop, rule.maxWidth, 0, rule, true))
      // the ring's length includes the closing segment (the audit divides the drawn footprint by it)
      const last = loop[loop.length - 1]!, first = loop[0]!
      kerbLen += last.d + Math.hypot(last.x - first.x, last.z - first.z)
      for (const z of [zc - 1.0, zc + 1.0]) {
        const m = frame.clone().multiply(m4().makeTranslation(0, 0, z))
        _p.setFromMatrixPosition(m)
        m.elements[13] = ground.standY(_p.x, _p.z) + rule.crown
        dispensers.placements.push({ m })
      }
    }
    const kerbMesh = new THREE.Mesh(mergeGeometries(kerbs, false)!, M.concrete)
    kerbMesh.name = 'paddockFuelIslands'
    kerbMesh.receiveShadow = true
    markObject(kerbMesh, 'islandKerb', kerbLen)
    group.add(kerbMesh)
    registerPropSet(ctx, 'infield', 'infield-fuel', [dispensers], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
    // the kiosk 6 × 4 × 3.2 at the −s end of the apron, its glass front toward the pumps
    const ks = row.sRange[0] + 2, kl = row.lateral![0] + 1
    const kg0 = standWorld(ks + 3, kl + 2)
    const kiosk = trackWalls(ks, ks + 6, kl, kl + 4, kg0 - 0.4, kg0 + 3.2, [2, 2])
    add([kiosk.sides], M.shell, 'paddockFuelKiosk', true)
    add([kiosk.top], M.roof, 'paddockFuelKioskRoof', true)
    const kg = new Sheet()
    faceQuad(kg, ks + 0.4, ks + 5.6, kl + 4.03, kg0 + 0.6, kg0 + 2.4, 1, 1.5)
    add([kg.build()], M.windowBand, 'paddockFuelKioskGlass', false)
  }

  // ================================================================ the service house and the tyre garage (natural ground)
  {
    const garageShutter = shutterProto('garage-shutter', 3.5, 4.0)
    const garageDoors: PropSet = { proto: garageShutter.near, far: garageShutter.far, placements: [] }
    for (const id of ['service_house', 'tyre_garage'] as const) {
      const row = rowOf(id)
      const [s0, s1] = row.sRange
      const [l0, l1] = row.lateral!
      const corners = [[s0, l0], [s1, l0], [s1, l1], [s0, l1]].map(([s, l]) => standWorld(s!, l!))
      const base = Math.min(...corners) - 0.5
      const top = Math.max(...corners) + row.eaves
      const b = trackWalls(s0, s1, l0, l1, base, top, M.siding009Tile)
      add([b.sides], M.siding009, `paddock-${id}`, true)
      add([b.top], M.roof, `paddock-${id}-roof`, true)
      const g = new Sheet()
      if (id === 'service_house') {
        for (const y of [Math.max(...corners) + 1.2, Math.max(...corners) + 4.6]) {
          faceQuad(g, s0 + 0.5, s1 - 0.5, l1 + 0.03, y, y + 1.2, 1, 1.5)
          faceQuad(g, s0 + 0.5, s1 - 0.5, l0 - 0.03, y, y + 1.2, -1, 1.5)
        }
      } else if (row.doors) {
        // six roll doors on the +lateral face, the service-house side
        const d = row.doors
        for (let i = 0; i < d.n; i++) {
          const s = s0 + ((s1 - s0) / d.n) * (i + 0.5)
          const m = frameAt(track, track.wrap(s), l1 + 0.04, standWorld(s, l1 + 0.04) + 0.02 - roadY(s, l1 + 0.04), m4()).multiply(m4().makeRotationY(Q))
          garageDoors.placements.push({ m })
        }
        faceQuad(g, s0 + 0.5, s1 - 0.5, l1 + 0.03, Math.max(...corners) + 4.6, Math.max(...corners) + 5.4, 1, 1.5)
      }
      add([g.build()], M.windowBand, `paddock-${id}-windows`, false)
    }
    registerPropSet(ctx, 'infield', 'infield-garage-shutters', [garageDoors], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
  }

  // ================================================================ the former medical room (course-vehicle base)
  {
    const bRow = BUILDINGS.find((b) => b.id === 'course_vehicle_base')!
    const row = rowOf('course_vehicle_base')
    const f = osmFeature(row.osmWay!)!
    const anchor = bRow.anchor as { s: number; lateral: number }
    const baseW = standWorld(anchor.s, anchor.lateral) - 0.5
    const shape = new THREE.Shape(f.en.map(([e, nn]) => new THREE.Vector2(e, nn)))
    const ext = new THREE.ExtrudeGeometry(shape, { depth: bRow.height + 0.5, bevelEnabled: false })
    ext.applyMatrix4(enMatrix(track, baseW))
    const capGeos: THREE.BufferGeometry[] = [], wallGeos: THREE.BufferGeometry[] = []
    for (const g of ext.groups) (g.materialIndex === 0 ? capGeos : wallGeos).push(slice(ext, g.start, g.count))
    ext.dispose()
    add(wallGeos, M.shell, 'paddockVehicleBase', true)
    add(capGeos, M.roof, 'paddockVehicleBaseRoof', true)
    // the window band all round and three roll doors on the −s face (the segment whose midpoint has the smallest s)
    const ring = f.en.map(([e, nn]) => { track.enToWorld(e, nn, _p); return { x: _p.x, z: _p.z, ...trackAt(e, nn, row.sRange) } })
    const n = ring.length
    let cx = 0, cz = 0
    for (const v of ring) { cx += v.x / n; cz += v.z / n }
    const band = new Sheet()
    let minS = Infinity, doorSeg = 0
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1
      let nx = dz / len, nz = -dx / len
      if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.z + b.z) / 2 - cz) < 0) { nx = -nx; nz = -nz }
      const y0 = baseW + 0.5 + 2.2, y1 = y0 + 1.2
      band.quad(V(a.x + nx * 0.03, y0, a.z + nz * 0.03), V(b.x + nx * 0.03, y0, b.z + nz * 0.03), V(b.x + nx * 0.03, y1, b.z + nz * 0.03), V(a.x + nx * 0.03, y1, a.z + nz * 0.03), [[0, 0], [len / 1.5, 0], [len / 1.5, 1], [0, 1]], V(nx, 0, nz))
      const mid = forwardDelta(row.sRange[0], (a.s + b.s) / 2, L)
      if (len > 5 && mid < minS) { minS = mid; doorSeg = i }
    }
    add([band.build()], M.windowBand, 'paddockVehicleBaseWindows', false)
    if (row.doors) {
      const d = row.doors
      const proto = shutterProto('base-shutter', d.w, d.h)
      const set: PropSet = { proto: proto.near, far: proto.far, placements: [] }
      const a = ring[doorSeg]!, b = ring[(doorSeg + 1) % n]!
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz)
      let nx = dz / len, nz = -dx / len
      if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.z + b.z) / 2 - cz) < 0) { nx = -nx; nz = -nz }
      const yaw = Math.atan2(nx, nz)
      for (let i = 0; i < d.n; i++) {
        const t = (i + 0.5) / d.n
        const x = a.x + dx * t + nx * 0.05, z = a.z + dz * t + nz * 0.05
        const m = m4().makeRotationY(yaw)
        m.setPosition(x, ground.standY(x, z) + 0.02, z)
        set.placements.push({ m })
      }
      registerPropSet(ctx, 'infield', 'infield-base-shutters', [set], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
    }
  }

  // ================================================================ tunnel heads (the cuts are I6)
  {
    // the 逆バンクトンネル's paddock-side ramp head: a concrete box with a dark opening on its paddock (−lateral) face
    const row = rowOf('gyaku_bank_head')
    const [s0, s1] = row.sRange
    const [l0, l1] = row.lateral!
    const floorW = roadY((s0 + s1) / 2, (l0 + l1) / 2) - plane.drop
    const b = trackWalls(s0, s1, l0, l1, floorW - 0.5, floorW + row.eaves, [2, 2])
    const heads: THREE.BufferGeometry[] = [b.sides, b.top]
    const dark = new Sheet()
    if (row.doors) {
      const d = row.doors
      const sc = (s0 + s1) / 2
      faceQuad(dark, sc - d.w / 2, sc + d.w / 2, l0 - 0.03, floorW + 0.1, floorW + 0.1 + d.h, -1)
    }
    // the works-road portal (UNDERPASSES 175231859 `portal`): two retaining-wall stubs along the road and the head frame
    const up = UNDERPASSES.find((u) => u.osmWay === 175231859)
    const portal = up?.portal
    const wallGeos: THREE.BufferGeometry[] = []
    if (portal) {
      const prow = rowOf('works_road_head')
      const [ps0, ps1] = prow.sRange
      const [pl0, pl1] = prow.lateral!
      const gy = standWorld(portal.s, portal.lateral)
      // the stubs: 0.25 thick, 1.2 high above the ground at their ends, either side of the 5 m road
      for (const s of [ps0, ps1]) {
        const w = trackWalls(s - 0.125, s + 0.125, pl0, pl1, Math.min(standWorld(s, pl0), standWorld(s, pl1)) - 0.3, Math.max(standWorld(s, pl0), standWorld(s, pl1)) + 1.2, M.retainingTile)
        wallGeos.push(w.sides)
        heads.push(w.top)
      }
      // the head frame at the +lateral end of the stubs (the tunnel is under the apron beyond): two piers and a lintel, the dark mouth looking −lateral
      const frameLat = pl1 - 0.4
      const lintel = trackWalls(ps0 - 0.3, ps1 + 0.3, frameLat - 0.4, frameLat, gy + 3.0, gy + prow.eaves, [2, 2])
      heads.push(lintel.sides, lintel.top, lintel.bottom)
      for (const s of [ps0, ps1]) {
        const pier = trackWalls(s - 0.25, s + 0.25, frameLat - 0.4, frameLat, gy - 0.3, gy + 3.0, [2, 2])
        heads.push(pier.sides, pier.top)
      }
      faceQuad(dark, ps0 + 0.25, ps1 - 0.25, frameLat - 0.42, gy - 0.05, gy + 3.0, -1)
    }
    add(heads, M.concrete, 'paddockTunnelHeads', true)
    add(wallGeos, M.retaining, 'paddockRetainingWalls', true)
    darkGeos.push(dark.build())
    stat('paddock-tunnelHeads', portal ? 2 : 1)
  }

  // ================================================================ the enclosure: chain-link fence, posts, gates
  {
    const F = PADDOCK_FENCE
    type P2 = { x: number; z: number }
    const polylines: { pts: P2[]; name: string }[] = []
    for (const id of F.ways) {
      const f = osmFeature(id)
      if (!f) continue
      const drop = new Set(F.clip.filter(([w]) => w === id).map(([, i]) => i))
      const pts: P2[] = []
      f.en.forEach(([e, n], i) => { if (drop.has(i)) return; track.enToWorld(e, n, _p); pts.push({ x: _p.x, z: _p.z }) })
      if (f.closed && pts.length > 2) pts.push(pts[0]!)
      polylines.push({ pts, name: `osm ${id}` })
    }
    for (const h of F.hand) polylines.push({ pts: h.pts.map(([s, l]) => { track.pointAt(track.wrap(s), l, _p, 0); return { x: _p.x, z: _p.z } }), name: h.name })
    // the gates: an opening of `w` centred on the nearest point of the nearest polyline
    const gatePts = F.gates.map((g) => { track.pointAt(track.wrap(g.s), g.lateral, _p, 0); return { x: _p.x, z: _p.z, w: g.w } })
    const runs: P2[][] = []
    const gateFrames: { x: number; z: number; tx: number; tz: number }[] = []
    for (const line of polylines) {
      const pts = line.pts
      // arc length of every vertex
      const arc = [0]
      for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z))
      const total = arc[arc.length - 1]!
      const cuts: { d: number; w: number }[] = []
      for (const g of gatePts) {
        // nearest point on this polyline
        let best = Infinity, bestD = 0
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!, b = pts[i]!
          const dx = b.x - a.x, dz = b.z - a.z
          const l2 = dx * dx + dz * dz || 1
          const t = Math.max(0, Math.min(1, ((g.x - a.x) * dx + (g.z - a.z) * dz) / l2))
          const px = a.x + dx * t, pz = a.z + dz * t
          const dist = Math.hypot(g.x - px, g.z - pz)
          if (dist < best) { best = dist; bestD = arc[i - 1]! + Math.sqrt(l2) * t }
        }
        if (best < 6) cuts.push({ d: bestD, w: g.w })
      }
      cuts.sort((a, b) => a.d - b.d)
      const pointAt = (d: number): P2 => {
        for (let i = 1; i < pts.length; i++) {
          if (d <= arc[i]! + 1e-9) {
            const t = (d - arc[i - 1]!) / Math.max(1e-9, arc[i]! - arc[i - 1]!)
            return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, z: pts[i - 1]!.z + (pts[i]!.z - pts[i - 1]!.z) * t }
          }
        }
        return pts[pts.length - 1]!
      }
      const slice_ = (d0: number, d1: number): P2[] => {
        if (d1 - d0 < 0.5) return []
        const out: P2[] = [pointAt(d0)]
        for (let i = 0; i < pts.length; i++) if (arc[i]! > d0 + 1e-6 && arc[i]! < d1 - 1e-6) out.push(pts[i]!)
        out.push(pointAt(d1))
        return out
      }
      let from = 0
      for (const c of cuts) {
        const d0 = Math.max(0, c.d - c.w / 2), d1 = Math.min(total, c.d + c.w / 2)
        const run = slice_(from, d0)
        if (run.length > 1) runs.push(run)
        const a = pointAt(d0), b = pointAt(d1)
        const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1
        gateFrames.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, tx: (b.x - a.x) / tl, tz: (b.z - a.z) / tl })
        from = d1
      }
      const tail = slice_(from, total)
      if (tail.length > 1) runs.push(tail)
    }
    // the mesh: one card per segment standing on the drawn ground at both ends (vertical faces only), metre uv
    const mesh = new Sheet()
    const postM: THREE.Matrix4[] = []
    let length = 0
    const H = F.height
    for (const run of runs) {
      let u = 0
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1]!, b = run[i]!
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 0.05) continue
        const ya = ground.standY(a.x, a.z), yb = ground.standY(b.x, b.z)
        mesh.quad(V(a.x, ya - 0.05, a.z), V(b.x, yb - 0.05, b.z), V(b.x, yb + H, b.z), V(a.x, ya + H, a.z), [[u, 0], [u + len, 0], [u + len, H], [u, H]])
        // posts every postPitch along the segment, plus the run's ends
        const nPost = Math.max(1, Math.round(len / F.postPitch))
        for (let p = i === 1 ? 0 : 1; p <= nPost; p++) {
          const t = p / nPost
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t
          postM.push(m4().makeTranslation(x, ground.standY(x, z) - 0.05, z))
        }
        u += len
        length += len
      }
    }
    const fenceMesh = new THREE.Mesh(mesh.build(), M.fence)
    fenceMesh.name = 'paddockFence'
    fenceMesh.receiveShadow = true
    group.add(fenceMesh)
    const postGeo = new THREE.CylinderGeometry(0.03, 0.03, H + 0.1, 6)
    postGeo.translate(0, (H + 0.1) / 2, 0)
    for (const inst of bucketedInstancedMeshes(postGeo, M.green, postM, null, (_i, m) => ctx.farField.cellOf(m.elements[12]!, m.elements[14]!), { name: 'paddockFencePosts', receiveShadow: true })) group.add(inst)
    // the gate frames: two φ0.1 posts and a top bar over the opening
    const gateGeos: THREE.BufferGeometry[] = []
    for (const g of gateFrames) {
      for (const side of [-1, 1]) {
        const x = g.x + g.tx * side * 4, z = g.z + g.tz * side * 4
        const post = new THREE.CylinderGeometry(0.05, 0.05, H + 0.4, 8)
        post.translate(x, ground.standY(x, z) + (H + 0.4) / 2 - 0.05, z)
        gateGeos.push(post)
      }
      const bar = new THREE.BoxGeometry(8.1, 0.08, 0.08)
      bar.rotateY(-Math.atan2(g.tz, g.tx))
      bar.translate(g.x, ground.standY(g.x, g.z) + H + 0.3, g.z)
      gateGeos.push(bar)
    }
    add(gateGeos, M.green, 'paddockGates', false)
    stat('paddock-fenceM', Math.round(length))
    stat('paddock-gates', gateFrames.length)
  }

  // ================================================================ street lamps and the floodlight masts
  {
    const Lp = PADDOCK_LAMPS
    const hgt = Lp.height
    const mast = new THREE.CylinderGeometry(0.06, 0.1, hgt, 6, 1, true)
    mast.translate(0, hgt / 2, 0)
    const arm = new THREE.BoxGeometry(1.6, 0.07, 0.07)
    arm.translate(0.8, hgt - 0.04, 0)
    const head = new THREE.BoxGeometry(0.6, 0.16, 0.3)
    head.translate(1.5, hgt - 0.1, 0)
    const poleProc = procProp('lamp-pole', [{ geometry: mergeGeometries([mast, arm, head].map((g) => g.toNonIndexed()), false)!, material: plain(0xb4b8b6, 0.6, 0.4) }])
    const pole = glbOr(ctx, 'model/props/street_lamp_02', { front: 'none', scaleTo: { height: hgt } }, poleProc)
    const lamps: PropSet = { proto: pole, far: poleProc, placements: [] }
    const put = (x: number, z: number, yaw: number) => {
      const m = m4().makeRotationY(yaw)
      m.setPosition(x, ground.standY(x, z) - 0.02, z)
      lamps.placements.push({ m })
    }
    for (const id of Lp.roads) {
      const road = SUR_ROADS.find((r) => r.id === id)
      if (!road) continue
      const pts = enPairs(road).map(([e, n]) => { track.enToWorld(e, n, _p); return { x: _p.x, z: _p.z } })
      let next = Lp.pitch / 2
      let walked = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 1e-6) continue
        const tx = (b.x - a.x) / len, tz = (b.z - a.z) / len
        while (next <= walked + len) {
          const t = (next - walked) / len
          // the lamp stands `offset` to the right of the walking direction, its arm pointing back at the road
          const rx = -tz, rz = tx
          put(a.x + (b.x - a.x) * t + rx * Lp.offset, a.z + (b.z - a.z) * t + rz * Lp.offset, Math.atan2(rz, -rx))
          next += Lp.pitch
        }
        walked += len
      }
    }
    for (const [s, lat] of Lp.extra) {
      track.pointAt(track.wrap(s), lat, _p, 0)
      const h = track.headingAt(track.wrap(s))
      // the arm toward the track (+lateral = the left normal (tz, −tx))
      put(_p.x, _p.z, Math.atan2(-(-h.tx), h.tz))
    }
    registerPropSet(ctx, 'infield', 'infield-lamps', [lamps], { nearM: 700, farM: Infinity }, { receiveShadow: true })

    // the 22 m masts: a 0.6 m square lattice, a crossbar with three flood heads facing the paddock (−lateral)
    const Mt = PADDOCK_MASTS
    const lattice = latticeGeometry({ height: Mt.height, baseHalf: 0.3, topHalf: 0.25, panel: 1.5, leg: 0.06, ring: 0.04, brace: 0.035, braces: quality.infield.detail })
    const mastGeos: THREE.BufferGeometry[] = []
    const headProc = procProp('flood-head', [{ geometry: box(0.6, 0.5, 0.45, 0, 0), material: plain(0x2a2d31, 0.5, 0.5) }, { geometry: box(0.5, 0.4, 0.03, 0, 0.05, 0.24), material: plain(0xe8ecef, 0.3, 0.2) }])
    const headProto = glbOr(ctx, 'model/trackside/flood_light', { front: 'moreArea', scaleTo: { height: 1.2 } }, headProc)
    const heads: PropSet = { proto: headProto, far: headProc, placements: [] }
    for (const at of Mt.at) {
      const frame = frameAt(track, track.wrap(at.s), at.lateral, ground.standAt(track.wrap(at.s), at.lateral) - 0.05, m4())
      const body = lattice.clone()
      body.applyMatrix4(frame)
      mastGeos.push(body)
      const bar = new THREE.BoxGeometry(0.15, 0.15, 3.2)
      bar.translate(0, Mt.height - 1.0, 0)
      bar.applyMatrix4(frame)
      mastGeos.push(bar)
      for (let i = 0; i < Mt.heads; i++) putIn(heads, frame, -0.3, Mt.height - 0.92, -1.2 + (2.4 * i) / (Mt.heads - 1), -Q)
    }
    lattice.dispose()
    add(mastGeos, M.steel, 'paddockMasts', true)
    registerPropSet(ctx, 'infield', 'infield-flood-heads', [heads], { nearM: quality.infield.propsNearM, farM: Infinity }, { receiveShadow: true })
    stat('paddock-masts', Mt.at.length)
  }

  // ================================================================ the offices' prop sets, the shared merges
  registerPropSet(ctx, 'infield', 'infield-office-shutters', [shutters], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
  registerPropSet(ctx, 'infield', 'infield-office-aircon', [aircons], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
  add(rails, railMat, 'paddockRails', false)
  add(glassGeos, M.glass, 'paddockGlass', false)
  add(concreteGeos, M.concrete, 'concretePaddockSteps', true)
  add(darkGeos, M.dark, 'paddockOpenings', false)

  // ================================================================ v1 pieces kept until I3: the other BUILDINGS extrusions, transporters, tents, flags
  {
    // the BUILDINGS rows no other builder owns (the Dunlop office, the west tower, CIRCUIT PLAZA) — the v1 extrusion
    const capGeos: THREE.BufferGeometry[] = []
    const wallGeos: THREE.BufferGeometry[] = []
    for (const b of BUILDINGS) {
      if (b.osmWay === null || b.builder === 'paddock') continue
      const f = osmFeature(b.osmWay)
      if (!f) continue
      let base: number
      if (b.anchor === 'terrain') {
        const [ce, cn] = f.en.reduce(([ae, an], [e, n]) => [ae + e / f.en.length, an + n / f.en.length], [0, 0])
        track.enToWorld(ce, cn, _p)
        base = ground.standY(_p.x, _p.z) - 0.5
      } else base = standWorld(b.anchor.s, b.anchor.lateral) - 0.5
      const shape = new THREE.Shape(f.en.map(([e, n]) => new THREE.Vector2(e, n)))
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height + 0.5, bevelEnabled: false })
      geo.applyMatrix4(enMatrix(track, base))
      for (const g of geo.groups) (g.materialIndex === 0 ? capGeos : wallGeos).push(slice(geo, g.start, g.count))
      geo.dispose()
    }
    add(wallGeos, whiteMat, 'paddockBuildings', true)
    add(capGeos, opts.buildingRoofMat, 'paddockRoofs', true)

    // transporters backed up to the rear wall behind each team's garage, two per team (I3 replaces them)
    const teams = GARAGE_ORDER.map((id) => TEAMS[id])
    const trailers: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      for (const ds of [-5, 5]) {
        trailers.push({ m: boxes.matrix(s + ds, -64.5, 4.0, 0, false, new THREE.Matrix4()), color: new THREE.Color(team.body) })
        boxes.place(s + ds, -72.6, 2.5, 2.4, 3.2, whiteMat, 0, false, false) // cab
      }
    })
    boxes.instanced(2.55, 13.6, 4.0, trailers, 0.5, true, 'transporters')
    // tents (white and red) on the final-corner side of the truck strip
    const tentMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.9, side: THREE.DoubleSide })
    const tentRedMat = new THREE.MeshStandardMaterial({ color: COLOURS.circuitRed.lit, roughness: 0.9, side: THREE.DoubleSide })
    const tentGeos: THREE.BufferGeometry[] = []
    const tentRedGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 6; i++) {
      const s = 5600 + i * 9
      const lat = -70
      const cone = new THREE.ConeGeometry(4.6, 2.2, 4, 1, true)
      cone.rotateY(Math.PI / 4)
      cone.applyMatrix4(frameAt(track, s, lat, ground.standAt(s, lat) + 2.7 + 1.1, new THREE.Matrix4()))
      ;(i % 3 === 1 ? tentRedGeos : tentGeos).push(cone)
      for (const [ds, dl] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) boxes.place(s + ds, lat + dl, 0.1, 0.1, 2.7, railMat, 0, false, false)
    }
    add(tentGeos, tentMat, 'tents', false)
    add(tentRedGeos, tentRedMat, 'tentsRed', false)
    // flag poles on the canopy at the T1 end (pitbld.jpg) and at the paddock gate (moved from s 5548 to
    // 5538: the 逆バンク ramp head and the helipad compound fence stand where they were)
    const S1 = track.wrap(PIT_BOX_STRIP[1])
    const flagGeos: THREE.BufferGeometry[] = []
    const flagColours = [0xffffff, COLOURS.circuitRed.lit, 0x1d5bb5, 0xffffff, COLOURS.signageGreen.mid]
    const flagMats = flagColours.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }))
    const flagsByMat: THREE.BufferGeometry[][] = flagColours.map(() => [])
    const pole = (s: number, lat: number, yBase: number, i: number) => {
      const p = new THREE.CylinderGeometry(0.04, 0.05, 9, 6)
      p.applyMatrix4(frameAt(track, s, lat, yBase + 4.5, new THREE.Matrix4()))
      flagGeos.push(p)
      const f = new THREE.PlaneGeometry(1.6, 1.0)
      f.translate(0, 0, -0.8)
      f.applyMatrix4(frameAt(track, s, lat + 0.02, yBase + 8.3, new THREE.Matrix4()))
      flagsByMat[i % flagColours.length]!.push(f)
    }
    // the canopy poles stand on the canopy's top (their base sunk 5 cm into the 0.4 m slab, no gap)
    for (let i = 0; i < 5; i++) pole(track.wrap(S1 - 1.5 - i * 1.5), -36 - i * 4, canopyTopAt(-36 - i * 4) - 0.05, i)
    for (let i = 0; i < 6; i++) pole(5538, -60 - i * 3, ground.standAt(5538, -60 - i * 3), i)
    add(flagGeos, railMat, 'flagPoles', false)
    flagsByMat.forEach((geos, i) => add(geos, flagMats[i]!, `flags${i}`, false))
  }

  // --- the centre house's grass island (I2-a): its kerb ring ---------------------------------------
  // The island itself is the GROUND_AREAS disc 'センターハウス芝島' (a grass face cut out of the
  // drive); the cast concrete kerb around it is an OBJECT on the drawn ground: a 0.3 m ribbon
  // centred on the disc's rim, half on the grass and half on the asphalt, edges sunk 20 mm and the
  // upstand 120 mm proud (GROUND_OBJECTS.islandKerb). The circle is walked in the frame's positive
  // sense (s, then lateral), which winds counter-clockwise seen from above like a lane's left kerb.
  {
    const rule = GROUND_OBJECTS.islandKerb
    const { s, lateral, radius } = PADDOCK_ISLAND
    const segs = Math.max(24, Math.ceil((2 * Math.PI * radius) / 0.8))
    const pts: LanePoint[] = []
    for (let i = 0; i < segs; i++) {
      const t = (i / segs) * Math.PI * 2
      const si = track.wrap(s + radius * Math.cos(t)), li = lateral + radius * Math.sin(t)
      track.pointAt(si, li, _p, 0)
      pts.push({ x: _p.x, z: _p.z, s: si, lat: li, d: (i / segs) * 2 * Math.PI * radius })
    }
    const geo = sweepKerb(ground, pts, rule.maxWidth, 0, rule, true)
    const mesh = new THREE.Mesh(geo, M.concrete)
    mesh.name = 'paddockIslandKerb'
    mesh.receiveShadow = true
    markObject(mesh, 'islandKerb', 2 * Math.PI * radius)
    group.add(mesh)
    stat('paddock-islandKerb', 1)
  }
  stat('paddock-buildings', PADDOCK_BUILDINGS.length)
}
