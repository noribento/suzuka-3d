import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COLOURS, LEADER_TOWER, PIT_BUILDING } from '~/data/suzuka-facilities-spec'
import { forwardDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { EMISSIVE, emissiveScale } from './emissive'
import { pbrFromAssets } from './materials'
import { profileRibbonGeometry } from './track-mesh'

/**
 * Pure geometry and canvas helpers of the pit complex (plan I1-a), shared by pit-building.ts,
 * pit-lane.ts, paddock.ts and structures.ts:
 *
 * - track-frame placement (`frameAt`) and the sweeps that follow the 2.8 % fall of the pit
 *   straight (`sweep` / `creased` / `texturedWall` / `sectionPlate` / `tube`), the prisms over
 *   OSM footprints in track coordinates (`trackCoords` / `clipD` / `trackPrism`), the EN → world
 *   extrusion matrix (`enMatrix`) and `slice` for ExtrudeGeometry groups, `podLoft` (the
 *   squircle bullet-nose loft of the control tower, parameterised so the T1 nose can reuse it);
 * - the tier-scaled canvas (`canvas` / `tex` / `label` / `chequer`) and the word list every pit
 *   texture draws from (`PIT_TEXTS`, read by textures-lint);
 * - `pitMaterials(ctx)`: the materials the three builders share, memoised per build context so
 *   splitting the builders changes no program combination and no merge bucket (`ctx.boxes`
 *   buckets by material);
 * - `addMerged`: one merged, named Mesh from a geometry list (the shells, rails, screens…).
 *
 * Nothing here reads the terrain or the ground: heights are relative to the road plane
 * (`track.pointAt(s, lateral, y)`), the callers decide where things stand.
 */

export type Fn = (s: number) => number
export type Pt = [number, number]

const _p = new THREE.Vector3()
const _c = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _one = new THREE.Vector3(1, 1, 1)

export const K = (v: number): Fn => () => v

export function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- small geometry helpers

/** Reverse every triangle so the surface faces the other way (normals recomputed). */
export function flip(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = geo.getIndex()
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1)
      idx.setX(i + 1, idx.getX(i + 2))
      idx.setX(i + 2, b)
    }
    idx.needsUpdate = true
  } else {
    const pos = geo.attributes.position as THREE.BufferAttribute
    const uv = geo.attributes.uv as THREE.BufferAttribute | undefined
    for (let i = 0; i < pos.count; i += 3) {
      for (const a of [pos, uv]) {
        if (!a) continue
        for (let k = 0; k < a.itemSize; k++) {
          const t = a.getComponent(i + 1, k)
          a.setComponent(i + 1, k, a.getComponent(i + 2, k))
          a.setComponent(i + 2, k, t)
        }
      }
    }
  }
  geo.computeVertexNormals()
  return geo
}

/** A track-frame placement (X = left / +lateral, Y = up, Z = forward) at (s, lateral, y above the road). */
export function frameAt(track: Track, s: number, lateral: number, y: number, out: THREE.Matrix4): THREE.Matrix4 {
  const h = track.headingAt(s)
  track.pointAt(s, lateral, _p, y)
  _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
  _q.setFromRotationMatrix(_m)
  return out.compose(_p, _q, _one)
}

/**
 * Cross-section polyline → ribbon edges with every corner duplicated. The duplicate makes a
 * zero-area strip between two coincident edges, so computeVertexNormals keeps the face normal
 * on both sides of the corner (a crease) with no extra triangles worth drawing. `uAt` is the
 * distance along the section in tiles so a plaster texture keeps its scale across and along.
 */
export function creased(pts: Pt[], tile: number): { edges: [Fn, Fn][]; uAt: number[] } {
  const edges: [Fn, Fn][] = []
  const uAt: number[] = []
  let d = 0
  for (let i = 0; i < pts.length; i++) {
    const [lat, y] = pts[i]!
    if (i > 0) d += Math.hypot(lat - pts[i - 1]![0], y - pts[i - 1]![1])
    const n = i === 0 || i === pts.length - 1 ? 1 : 2
    for (let k = 0; k < n; k++) {
      edges.push([K(lat), K(y)])
      uAt.push(d / tile)
    }
  }
  return { edges, uAt }
}

export function sweep(track: Track, pts: Pt[], s0: number, s1: number, tile = 2, step = 4): THREE.BufferGeometry {
  const { edges, uAt } = creased(pts, tile)
  return profileRibbonGeometry(track, s0, s1, edges, step, tile, uAt)
}

/**
 * Vertical textured wall along the track. Unlike track-mesh's wallGeometry this one chooses the
 * facing, and runs the texture's u AGAINST s on a track-facing (+lateral) wall: a viewer on the
 * left of the track has −s on their right, so text drawn left-to-right in the canvas has to be
 * laid out along −s to read correctly. `tileU` metres per texture repeat along the wall, the
 * height is one repeat (v 0..1).
 */
export function texturedWall(track: Track, s0: number, s1: number, lat: number, y0: number, y1: number, tileU: number, facing: 1 | -1, step = 4): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length)
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, lat, _p, y0)
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, lat, _p, y1)
    pos.push(_p.x, _p.y, _p.z)
    const u = (facing > 0 ? -d : d) / tileU
    uv.push(u, 0, u, 1)
    if (i < segs) {
      const a = i * 2
      // (bottom, top, next bottom) faces +lateral; swap for the other side
      if (facing > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** A flat plate in the (lateral, height) plane at a fixed s, facing +s (or −s when `forward` is false). */
export function sectionPlate(track: Track, s: number, pts: Pt[], forward: boolean): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))))
  geo.applyMatrix4(frameAt(track, s, 0, 0, new THREE.Matrix4()))
  return forward ? geo : flip(geo)
}

/** Square-section tube (railing) along the track at a constant lateral / height above the road. */
export function tube(track: Track, s0: number, s1: number, lat: number, y: number, r: number, step = 4): THREE.BufferGeometry {
  const pts: Pt[] = [[lat - r, y - r], [lat - r, y + r], [lat + r, y + r], [lat + r, y - r], [lat - r, y - r]]
  return profileRibbonGeometry(track, s0, s1, pts.map(([l, h]) => [K(l), K(h)] as [Fn, Fn]), step, 4)
}

/**
 * Track coordinates of a local-EN point: nearest centreline sample, then the offset resolved on
 * that sample's tangent / left normal (a footprint vertex lands within a few cm this way).
 */
export function trackCoords(track: Track, e: number, n: number): { s: number; lat: number } {
  track.enToWorld(e, n, _p)
  const { i } = track.nearestSample(_p.x, _p.z)
  const s0 = i * track.ds
  const h = track.headingAt(s0)
  track.pointAt(s0, 0, _c)
  const dx = _p.x - _c.x
  const dz = _p.z - _c.z
  return { s: track.wrap(s0 + dx * h.tx + dz * h.tz), lat: dx * h.tz - dz * h.tx }
}

/** Sutherland–Hodgman against one half-plane of the along-track coordinate `d`. */
export function clipD(poly: { d: number; lat: number }[], keep: (d: number) => boolean): { d: number; lat: number }[] {
  const out: { d: number; lat: number }[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const ia = keep(a.d)
    const ib = keep(b.d)
    if (ia) out.push(a)
    if (ia !== ib) {
      // the boundary is d = 0 for both half-planes used here
      const f = a.d / (a.d - b.d)
      out.push({ d: 0, lat: a.lat + (b.lat - a.lat) * f })
    }
  }
  return out
}

/**
 * Vertical prism over a polygon given in track coordinates, every vertex on the road surface at
 * its own s (so the slab follows the gradient). Sides and top are separate geometries (walls
 * and roof take different materials); the bottom is never visible.
 */
export function trackPrism(track: Track, poly: { d: number; lat: number }[], ref: number, y0: number, y1: number, tile = 2): { sides: THREE.BufferGeometry; top: THREE.BufferGeometry } {
  // counter-clockwise in (d, lat) = counter-clockwise seen from above (forward × left = up)
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    area += a.d * b.lat - b.d * a.lat
  }
  const pts = area < 0 ? [...poly].reverse() : poly
  const sPos: number[] = []
  const sUv: number[] = []
  let u = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    const w = Math.hypot(b.d - a.d, b.lat - a.lat)
    const a0 = track.pointAt(ref + a.d, a.lat, new THREE.Vector3(), y0)
    const a1 = track.pointAt(ref + a.d, a.lat, new THREE.Vector3(), y1)
    const b0 = track.pointAt(ref + b.d, b.lat, new THREE.Vector3(), y0)
    const b1 = track.pointAt(ref + b.d, b.lat, new THREE.Vector3(), y1)
    // (a0, b0, b1), (a0, b1, a1): normal = edge × up = outward for a counter-clockwise loop
    sPos.push(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z, b1.x, b1.y, b1.z, a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, a1.x, a1.y, a1.z)
    const u0 = u / tile, u1 = (u + w) / tile, v1 = (y1 - y0) / tile
    sUv.push(u0, 0, u1, 0, u1, v1, u0, 0, u1, v1, u0, v1)
    u += w
  }
  const sides = new THREE.BufferGeometry()
  sides.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3))
  sides.setAttribute('uv', new THREE.Float32BufferAttribute(sUv, 2))
  sides.computeVertexNormals()
  const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.d, p.lat)), [])
  const tPos: number[] = []
  const tUv: number[] = []
  for (const p of pts) {
    track.pointAt(ref + p.d, p.lat, _p, y1)
    tPos.push(_p.x, _p.y, _p.z)
    tUv.push(p.d / tile, p.lat / tile)
  }
  const top = new THREE.BufferGeometry()
  top.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3))
  top.setAttribute('uv', new THREE.Float32BufferAttribute(tUv, 2))
  top.setIndex(tris.flat())
  top.computeVertexNormals()
  // earcut keeps the contour's orientation, but make sure the roof faces up whatever it did
  const n = top.attributes.normal as THREE.BufferAttribute
  if (n.count > 0 && n.getY(0) < 0) flip(top)
  return { sides, top }
}

/** Take a vertex range of a non-indexed geometry (an ExtrudeGeometry group) as its own geometry. */
export function slice(geo: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!a) continue
    out.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize))
  }
  return out
}

/** Local EN (shape x = e, y = n, z = up) → world: x = e·k, y = z + base, z = −n·k. Determinant k² > 0, so the winding survives. */
export function enMatrix(track: Track, base: number): THREE.Matrix4 {
  const k = track.enScale
  return new THREE.Matrix4().set(k, 0, 0, 0, 0, 0, 1, base, 0, -k, 0, 0, 0, 0, 0, 1)
}

// ---------------------------------------------------------------- canvas textures

export interface CanvasCtx { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D }

/**
 * Canvas at logical size × `k` (the tier's textureScale) with the context pre-scaled, so the
 * drawing code works in logical pixels and the low tier gets a quarter of the memory.
 */
export function canvas(w: number, h: number, k: number): CanvasCtx {
  const c = document.createElement('canvas')
  c.width = Math.max(8, Math.round(w * k))
  c.height = Math.max(8, Math.round(h * k))
  const ctx = c.getContext('2d')!
  ctx.scale(c.width / w, c.height / h)
  return { c, ctx }
}

export function tex(c: HTMLCanvasElement, wrap: THREE.Wrapping = THREE.RepeatWrapping): THREE.Texture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = wrap
  t.wrapT = wrap
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

export const FONT = "'Titillium Web', 'Segoe UI', Arial, sans-serif"

/** Text at `px` pixels, shrunk to fit `maxWidth` when given (the fallback fonts run wider than Titillium). */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, weight = 900, align: CanvasTextAlign = 'center', maxWidth?: number) {
  ctx.fillStyle = color
  ctx.font = `${weight} ${px}px ${FONT}`
  if (maxWidth) {
    const w = ctx.measureText(text).width
    if (w > maxWidth) {
      px *= maxWidth / w
      ctx.font = `${weight} ${px}px ${FONT}`
    }
  }
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + px * 0.05)
}

export function chequer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: number, dark = '#1a1a1a', light = '#ffffff') {
  for (let j = 0; j * cell < h; j++) {
    for (let i = 0; i * cell < w; i++) {
      ctx.fillStyle = (i + j) % 2 ? dark : light
      ctx.fillRect(x + i * cell, y + j * cell, Math.min(cell, w - i * cell), Math.min(cell, h - j * cell))
    }
  }
}

/**
 * Every word the pit textures draw (textures-lint reads this list): descriptive panels only, no
 * trademarks, team colours without wordmarks. Indices 0–7 are the fascia / pit-wall panel cycle;
 * the words after them are the plates' cap band (PIT_BUILDING.v2.plates.capText) and the podium.
 */
export const PIT_TEXTS = ['SUZUKA CIRCUIT', 'JAPANESE GP', 'MOBILITY RESORT', 'ROUND 17', 'PIT LANE', 'SUZUKA', '2026 SEASON', 'RACE WEEKEND', 'SCRUTINEERING', 'PODIUM']
export const PANEL_COLOURS = [COLOURS.circuitRed.lit, '#1d5bb5', COLOURS.signageGreen.mid, '#111111']

// ---------------------------------------------------------------- the bullet-nose loft

export interface PodLoftParams {
  track: Track
  /** the loft runs s0 → s1; the nose is at s0 for `dir` +1 (the final-corner control pod), at s1 for −1 (the T1 nose, I1-b) */
  s0: number
  s1: number
  dir?: 1 | -1
  /** plan: the two flank laterals (front = pit-lane side) */
  front: number
  back: number
  /** elevation: where the loft meets the storey below, the mid line (band and nose tip) and the top */
  bottom: number
  mid: number
  top: number
  /** nose lengths (m): in plan (parabolic), of the top dome and of the bottom curve (elliptic) */
  nose?: { plan: number; top: number; bottom: number }
  /** the top eases down to `top` over the last `ease` m so the tail meets a roof without a step; null = none */
  tail?: { top: number; ease: number } | null
  /** texture tile (m): u along s, v = arc length around the section */
  tile: number
  /**
   * The glass band (v1): a vertex-colour attribute, `dark` within ±`deg` of the flanks' mid line
   * (the band's four edges are duplicated ring vertices for a hard edge). null = no colour
   * attribute (I1-b draws the band as its own ring geometry instead).
   */
  band?: { deg: number; dark: number } | null
  /** station spacing along s (m) */
  step?: number
}

/**
 * A streamlined pod lofted along the track: squircle section (|cos|^½ keeps the flanks nearly
 * vertical and the corners tight), parabolic in plan and domed in elevation towards the nose, a
 * flat tail face at the far end. The section is centred on `mid`: the flanks' mid-height
 * vertices carry the band, the tip of the nose is at `mid`. Winding is verified on a top vertex
 * mid-body and flipped if the normals point in.
 */
export function podLoft(p: PodLoftParams): THREE.BufferGeometry {
  const { track, s0, s1, front, back, bottom, mid, top, tile } = p
  const dir = p.dir ?? 1
  const nose = p.nose ?? { plan: 18, top: 18, bottom: 9 }
  const tail = p.tail === undefined ? null : p.tail
  const band = p.band === undefined ? { deg: 1.2, dark: 0x30383f } : p.band
  const step = p.step ?? 1
  const L = track.length
  const len = forwardDelta(s0, s1, L)
  const sAt = (d: number) => (dir > 0 ? s0 + d : s1 - d)
  const A = (front - back) / 2
  const cLat = (front + back) / 2
  const ell = (d: number, n: number) => (d >= n ? 1 : Math.sqrt(Math.max(0, 1 - ((n - d) / n) ** 2)))
  const bottomAt = (d: number) => mid - (mid - bottom) * ell(d, nose.bottom)
  const topAt = (d: number) => {
    const dome = mid + (top - mid) * ell(d, nose.top)
    return tail ? dome + (tail.top - dome) * smoothstep((d - (len - tail.ease)) / tail.ease) : dome
  }
  const stations: number[] = []
  for (let d = 0; d < len; d += step) stations.push(d)
  stations.push(len)
  // ring angles: uniform plus the four edges of the band (duplicated for a hard edge)
  const bandRad = ((band?.deg ?? 0) * Math.PI) / 180
  const edges = band ? [-bandRad, bandRad, Math.PI - bandRad, Math.PI + bandRad] : []
  const angles = new Set<number>()
  for (let i = 0; i < 36; i++) angles.add((i / 36) * Math.PI * 2 - Math.PI / 2)
  for (const e of edges) angles.add(e)
  const ring: { th: number; dark: boolean }[] = []
  const inBand = (th: number) => {
    if (!band) return false
    const t = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    return t < bandRad || t > Math.PI * 2 - bandRad || Math.abs(t - Math.PI) < bandRad
  }
  for (const th of [...angles].sort((x, y) => x - y)) {
    if (edges.some((e) => Math.abs(e - th) < 1e-9)) {
      const after = inBand(th + 1e-4)
      ring.push({ th, dark: !after }, { th, dark: after })
    } else ring.push({ th, dark: inBand(th) })
  }
  const N = ring.length
  // squircle section
  const sq = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
  // arc length around the full section, so the plaster tiles at the shell's scale (a per-vertex
  // fraction of the perimeter gave 30 tiny tiles that read as a woven brown skin on the high tier)
  const perim: number[] = []
  {
    const pt = (th: number): [number, number] => [A * sq(Math.cos(th)), (Math.sin(th) > 0 ? top - mid : mid - bottom) * sq(Math.sin(th))]
    let acc = 0
    let prev = pt(ring[0]!.th)
    for (let j = 0; j < N; j++) {
      const cur = pt(ring[j]!.th)
      acc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
      perim.push(acc)
      prev = cur
    }
  }
  const pos: number[] = []
  const col: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const darkC = new THREE.Color(band?.dark ?? 0xffffff)
  const white = new THREE.Color(0xffffff)
  stations.forEach((d, si) => {
    // parabolic in plan (a pointed train nose) but domed in elevation
    const kw = Math.max(0.002, d >= nose.plan ? 1 : 1 - ((nose.plan - d) / nose.plan) ** 2)
    const bt = Math.max(0.002, topAt(d) - mid), bb = Math.max(0.002, mid - bottomAt(d))
    const s = sAt(d)
    for (let j = 0; j < N; j++) {
      const { th, dark: isDark } = ring[j]!
      const sn = sq(Math.sin(th))
      track.pointAt(s, cLat + A * kw * sq(Math.cos(th)), _p, mid + (sn > 0 ? bt : bb) * sn)
      pos.push(_p.x, _p.y, _p.z)
      const c = isDark ? darkC : white
      col.push(c.r, c.g, c.b)
      uv.push(d / tile, perim[j]! / tile)
    }
    if (si > 0) {
      for (let j = 0; j < N; j++) {
        const j1 = (j + 1) % N
        const p0 = (si - 1) * N, p1 = si * N
        idx.push(p0 + j, p1 + j, p0 + j1, p0 + j1, p1 + j, p1 + j1)
      }
    }
  })
  // flat tail face
  const centre = pos.length / 3
  track.pointAt(sAt(len), cLat, _p, mid)
  pos.push(_p.x, _p.y, _p.z)
  col.push(1, 1, 1)
  uv.push(len / tile, 0)
  const last = (stations.length - 1) * N
  for (let j = 0; j < N; j++) idx.push(centre, last + ((j + 1) % N), last + j)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  if (band) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  // the winding above was chosen for outward normals; verify on a top vertex mid-body and flip if not
  const n = geo.attributes.normal as THREE.BufferAttribute
  const topJ = ring.findIndex((r) => Math.abs(r.th - Math.PI / 2) < 1e-6)
  const midStation = Math.floor(stations.length / 2)
  if (topJ >= 0 && n.getY(midStation * N + topJ) < 0) flip(geo)
  return geo
}

// ---------------------------------------------------------------- shared materials

export interface PitMaterials {
  /** metres per repeat of the plaster / concrete PBR sets (1 / 2 without the pack) */
  plasterTile: number
  concreteTile: number
  /** white panels (white_plaster_02 normal / ARM under a flat albedo): the building shells, caps, backdrop wall */
  shellMat: THREE.MeshStandardMaterial
  /** the same with vertex colours: the control pod's glass band (v1) */
  podMat: THREE.MeshStandardMaterial
  /** concrete046: the pit wall */
  concreteMat: THREE.MeshStandardMaterial
  /** plaster_grey_04: the garage piers */
  pierMat: THREE.MeshStandardMaterial
  /** the flat roof colour — returned by buildPitComplex, reused by the marshal huts and the paddock */
  buildingRoofMat: THREE.MeshStandardMaterial
  glassMat: THREE.MeshStandardMaterial
  /** the near-black of the Leader Tower, screens, perches, props */
  darkMat: THREE.MeshStandardMaterial
  interiorMat: THREE.MeshStandardMaterial
  /** white railings, posts, columns, flag poles, tent poles */
  railMat: THREE.MeshStandardMaterial
  seatMat: THREE.MeshStandardMaterial
  lampMat: THREE.MeshStandardMaterial
  /** plain white prefab / paddock block walls */
  whiteMat: THREE.MeshStandardMaterial
  /** a canvas-textured board; `emissive` > 0 makes it a lit panel (emissiveMap = the map) */
  boardMat: (map: THREE.Texture, emissive?: number) => THREE.MeshStandardMaterial
}

const materialsByCtx = new WeakMap<EnvBuildContext, PitMaterials>()

/** The pit complex's shared materials, created once per build context (the first caller pays). */
export function pitMaterials(ctx: EnvBuildContext): PitMaterials {
  const hit = materialsByCtx.get(ctx)
  if (hit) return hit
  const reg = ctx.assets
  const tileOf = (key: string, dflt: number) => (reg?.entry(key) as { tile?: number } | null)?.tile ?? dflt
  const plasterTile = tileOf('tex/white_plaster_02/diff', 1)
  const concreteTile = tileOf('tex/concrete046/diff', 2)
  // white panels: flat albedo over the plaster's normal / AO / roughness — the white_plaster_02
  // photo albedo itself is a warm mid grey (linear mean #8f887c) and rendered as a brown wall
  const plaster = (extra?: THREE.MeshStandardMaterialParameters) =>
    reg
      ? pbrFromAssets(reg, 'white_plaster_02', { fallback: () => new THREE.MeshStandardMaterial({ color: 0xe4e6e3, roughness: 0.75, ...extra }), handBuiltUv: true, normalScale: 0.5, noMap: true, extra: { color: 0xe4e6e3, ...extra } })
      : new THREE.MeshStandardMaterial({ color: 0xe4e6e3, roughness: 0.75, ...extra })
  const shellMat = plaster()
  const podMat = plaster({ vertexColors: true })
  const concreteMat = reg
    ? pbrFromAssets(reg, 'concrete046', { fallback: () => new THREE.MeshStandardMaterial({ color: COLOURS.concrete.mid, roughness: 0.9 }), handBuiltUv: true, normalScale: 0.6 })
    : new THREE.MeshStandardMaterial({ color: COLOURS.concrete.mid, roughness: 0.9 })
  const pierMat = reg
    ? pbrFromAssets(reg, 'plaster_grey_04', { fallback: () => new THREE.MeshStandardMaterial({ color: 0xa9acb0, roughness: 0.8 }), handBuiltUv: true, normalScale: 0.5, noMap: true, extra: { color: 0xb4b7b8 } })
    : new THREE.MeshStandardMaterial({ color: 0xa9acb0, roughness: 0.8 })
  const buildingRoofMat = new THREE.MeshStandardMaterial({ color: COLOURS.roofTop.mid, roughness: 0.85 })
  const glassMat = new THREE.MeshStandardMaterial({ color: PIT_BUILDING.glass, roughness: 0.12, metalness: 0.55, envMapIntensity: 1.3 })
  const darkMat = new THREE.MeshStandardMaterial({ color: LEADER_TOWER.colour, roughness: 0.6, metalness: 0.2 })
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.9, side: THREE.DoubleSide })
  const railMat = new THREE.MeshStandardMaterial({ color: COLOURS.mullionWhite.mid, roughness: 0.4, metalness: 0.3 })
  const seatMat = new THREE.MeshStandardMaterial({ color: PIT_BUILDING.terrace2F.seatColour, roughness: 0.8 })
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: EMISSIVE.garageStrip.color, emissiveIntensity: EMISSIVE.garageStrip.intensity * emissiveScale() })
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 })
  const boardMat = (map: THREE.Texture, emissive = 0) =>
    new THREE.MeshStandardMaterial({ map, roughness: 0.45, ...(emissive ? { emissive: 0xffffff, emissiveMap: map, emissiveIntensity: emissive * emissiveScale() } : {}) })
  const mats: PitMaterials = { plasterTile, concreteTile, shellMat, podMat, concreteMat, pierMat, buildingRoofMat, glassMat, darkMat, interiorMat, railMat, seatMat, lampMat, whiteMat, boardMat }
  materialsByCtx.set(ctx, mats)
  return mats
}

/**
 * One merged Mesh from a geometry list, named, added to `group`. mergeGeometries wants every
 * input indexed or none of them: the prisms and extrusion slices are non-indexed while the sweeps
 * and plates are indexed, so the latter are expanded when mixed. The inputs are disposed.
 */
export function addMerged(group: THREE.Group, geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean): THREE.Mesh | null {
  if (!geos.length) return null
  const mixed = geos.some((g) => !g.getIndex())
  const list = mixed ? geos.map((g) => (g.getIndex() ? g.toNonIndexed() : g)) : geos
  const merged = mergeGeometries(list, false)
  if (!merged) return null
  for (const g of geos) g.dispose()
  if (mixed) for (const g of list) g.dispose()
  const mesh = new THREE.Mesh(merged, mat)
  mesh.name = name
  mesh.castShadow = cast
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}
