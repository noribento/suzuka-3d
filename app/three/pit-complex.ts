import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DRIVERS, TEAMS } from '~/data/drivers'
import {
  SEASON,
  BUILDINGS, COLOURS, GARAGE_ORDER, LEADER_TOWER, PIT_BUILDING, PIT_GARAGE_COUNT, PIT_GARAGE_PITCH, PIT_WALL, PRAT_PERCH, SCREENS, garageS,
} from '~/data/suzuka-facilities-spec'
import { OSM_BUILDINGS, OSM_PIT_BUILDING, OSM_WATER, osmFeature, type OsmFeature } from '~/data/suzuka-facilities'
import { BASINS } from '~/data/suzuka-barriers-spec'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { addMacro, profileRibbonGeometry, ribbonGeometry } from './track-mesh'
import { bucketedInstancedMeshes } from './instancing'
import { cutoutParams, pbrFromAssets } from './materials'
import { EMISSIVE, emissiveScale } from './emissive'

/**
 * The pit complex, built from the OSM footprint (way 184422099) and the hand-authored spec:
 *
 * - the pit building itself is SWEPT IN TRACK COORDINATES (s along the lap, lateral across) so
 *   its floors, terraces and roof follow the 2.8 % fall of the pit straight the way the real
 *   apron does (the DEM shows the building is laterally level but drops 9.7 m end to end);
 * - the two rounded / chamfered end caps and the rear service spur are prisms over the OSM
 *   vertices, also placed per vertex on the track surface so they meet the swept body;
 * - the white streamlined control-tower pod on the final-corner roof, the podium recess on the
 *   2F terrace, the three roof screens, the Leader Tower at the pit exit, the pit wall with its
 *   panels and the team prat perches, the helipad and the paddock behind (OSM buildings, prefab
 *   rows, transporters, tents, flags, car park) and the two water bodies.
 *
 * Everything static and single-material is merged; repeated pieces (terrace seats, railing
 * posts, parking lines) are instanced per 60 m bay so the follow cameras can cull them. Shadow
 * policy (plan §4): shell / roof / caps / pod / towers / buildings cast + receive; seats,
 * railings, perches, interior props and lamps receive only.
 *
 * Returns the roof material because the marshal huts (props.ts) reuse it for their roofs, which
 * keeps them in the same merged mesh.
 */

type Fn = (s: number) => number
type Pt = [number, number]

const _p = new THREE.Vector3()
const _c = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _one = new THREE.Vector3(1, 1, 1)

// ---------------------------------------------------------------- section constants (metres)

const FRONT = PIT_BUILDING.front // −25.1: garage doors and piers
const BACK = PIT_BUILDING.back // −56.7: paddock face
const F2 = PIT_BUILDING.floors[1] // 7.8: 2F terrace deck
const F3 = PIT_BUILDING.floors[2] // 12.3: 3F terrace deck
const ROOF = PIT_BUILDING.roofTop // 15.5
const DOOR_H = PIT_BUILDING.garage.doorHeight // 4.1
const PIER = PIT_BUILDING.garage.pier // 0.95
const BOX = PIT_BUILDING.garage.boxPitch // 7.083
const PITCH = PIT_GARAGE_PITCH // 28.33
const GARAGE_BACK = FRONT - PIT_BUILDING.garage.depth // −40.5
const GARAGE_CEIL = 4.5
/** the fascia band is 0.7 m proud of the door line, its soffit doubles as the door head */
const FASCIA_FACE = FRONT + 0.7
const FASCIA_TOP = F2 - 0.5
/** 2F / 3F terrace edge cantilevered over the pit apron, the roof overhangs 2 m further */
const DECK_EDGE = -21.5
const ROOF_EDGE = -19.5
/** lounge glazing line behind the 2F terrace steps; the 3F wall stands on the same line */
const LOUNGE = -27.3
const SOFFIT3 = F3 - 0.4
const ROOF_SOFFIT = ROOF - 0.35
const ROOF_BACK = BACK - 0.5
const ROWS = PIT_BUILDING.terrace2F.rows
const TREAD = 0.85
const RISER = 0.35
const STEPS_BACK = LOUNGE + 1.2
const STEP_TOP = F2 + ROWS * RISER
const RAIL_H = 1.1
const PODIUM_HALF = PIT_BUILDING.podium.width / 2

const K = (v: number): Fn => () => v

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- small geometry helpers

/** Reverse every triangle so the surface faces the other way (normals recomputed). */
function flip(geo: THREE.BufferGeometry): THREE.BufferGeometry {
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
function frameAt(track: Track, s: number, lateral: number, y: number, out: THREE.Matrix4): THREE.Matrix4 {
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
function creased(pts: Pt[], tile: number): { edges: [Fn, Fn][]; uAt: number[] } {
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

function sweep(track: Track, pts: Pt[], s0: number, s1: number, tile = 2, step = 4): THREE.BufferGeometry {
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
function texturedWall(track: Track, s0: number, s1: number, lat: number, y0: number, y1: number, tileU: number, facing: 1 | -1, step = 4): THREE.BufferGeometry {
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
function sectionPlate(track: Track, s: number, pts: Pt[], forward: boolean): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))))
  geo.applyMatrix4(frameAt(track, s, 0, 0, new THREE.Matrix4()))
  return forward ? geo : flip(geo)
}

/** Square-section tube (railing) along the track at a constant lateral / height above the road. */
function tube(track: Track, s0: number, s1: number, lat: number, y: number, r: number, step = 4): THREE.BufferGeometry {
  const pts: Pt[] = [[lat - r, y - r], [lat - r, y + r], [lat + r, y + r], [lat + r, y - r], [lat - r, y - r]]
  return profileRibbonGeometry(track, s0, s1, pts.map(([l, h]) => [K(l), K(h)] as [Fn, Fn]), step, 4)
}

/**
 * Track coordinates of a local-EN point: nearest centreline sample, then the offset resolved on
 * that sample's tangent / left normal (a footprint vertex lands within a few cm this way).
 */
function trackCoords(track: Track, e: number, n: number): { s: number; lat: number } {
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
function clipD(poly: { d: number; lat: number }[], keep: (d: number) => boolean): { d: number; lat: number }[] {
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
function trackPrism(track: Track, poly: { d: number; lat: number }[], ref: number, y0: number, y1: number, tile = 2): { sides: THREE.BufferGeometry; top: THREE.BufferGeometry } {
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
function slice(geo: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!a) continue
    out.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize))
  }
  return out
}

/** Local EN (shape x = e, y = n, z = up) → world: x = e·k, y = z + base, z = −n·k. Determinant k² > 0, so the winding survives. */
function enMatrix(track: Track, base: number): THREE.Matrix4 {
  const k = track.enScale
  return new THREE.Matrix4().set(k, 0, 0, 0, 0, 0, 1, base, 0, -k, 0, 0, 0, 0, 0, 1)
}

// ---------------------------------------------------------------- canvas textures

interface CanvasCtx { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D }

/**
 * Canvas at logical size × `k` (the tier's textureScale) with the context pre-scaled, so the
 * drawing code works in logical pixels and the low tier gets a quarter of the memory.
 */
function canvas(w: number, h: number, k: number): CanvasCtx {
  const c = document.createElement('canvas')
  c.width = Math.max(8, Math.round(w * k))
  c.height = Math.max(8, Math.round(h * k))
  const ctx = c.getContext('2d')!
  ctx.scale(c.width / w, c.height / h)
  return { c, ctx }
}

function tex(c: HTMLCanvasElement, wrap: THREE.Wrapping = THREE.RepeatWrapping): THREE.Texture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = wrap
  t.wrapT = wrap
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

const FONT = "'Titillium Web', 'Segoe UI', Arial, sans-serif"

/** Text at `px` pixels, shrunk to fit `maxWidth` when given (the fallback fonts run wider than Titillium). */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, weight = 900, align: CanvasTextAlign = 'center', maxWidth?: number) {
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

function chequer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: number, dark = '#1a1a1a', light = '#ffffff') {
  for (let j = 0; j * cell < h; j++) {
    for (let i = 0; i * cell < w; i++) {
      ctx.fillStyle = (i + j) % 2 ? dark : light
      ctx.fillRect(x + i * cell, y + j * cell, Math.min(cell, w - i * cell), Math.min(cell, h - j * cell))
    }
  }
}

/** Descriptive panels only (plan §4.11): no trademarks, team colours without wordmarks. */
const PANEL_TEXTS = ['SUZUKA CIRCUIT', 'JAPANESE GP', 'MOBILITY RESORT', 'ROUND 17', 'PIT LANE', 'SUZUKA', '2026 SEASON', 'RACE WEEKEND']
const PANEL_COLOURS = [COLOURS.circuitRed.lit, '#1d5bb5', COLOURS.signageGreen.mid, '#111111']

/** Fascia band above the garage doors: 8 boxes (56.66 m) × 3.2 m per repeat, mostly white like the real one. */
function fasciaTexture(k: number): THREE.Texture {
  const w = 2048, h = 192
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#f4f4f1'
  ctx.fillRect(0, 0, w, h)
  const slot = w / 8
  for (let i = 0; i < 8; i++) {
    const x = i * slot
    const kind = i % 4
    if (kind === 1) {
      ctx.fillStyle = PANEL_COLOURS[(i >> 2) % PANEL_COLOURS.length]!
      ctx.fillRect(x + 8, 22, slot - 16, h - 44)
      label(ctx, PANEL_TEXTS[i]!, x + slot / 2, h / 2, 62, '#ffffff', 900, 'center', slot - 40)
    } else if (kind === 3) {
      // a blank white box with the thin seam lines of the real cladding
      ctx.fillStyle = 'rgba(0,0,0,0.06)'
      ctx.fillRect(x + 8, h / 2 - 1, slot - 16, 2)
    } else {
      label(ctx, PANEL_TEXTS[i]!, x + slot / 2, h / 2, 64, kind === 0 ? '#1d1f22' : COLOURS.circuitRed.lit, 900, 'center', slot - 28)
    }
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(x, 0, 2, h)
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(0, h - 4, w, 4)
  return tex(c)
}

/** Event banner over the podium bay: descriptive text in a generic face, no series logo. */
function bannerTexture(k: number): THREE.Texture {
  const w = 1024, h = 112
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#fbfbf9'
  ctx.fillRect(0, 0, w, h)
  chequer(ctx, 16, 14, 84, h - 28, 14, '#1a1a1a', '#fbfbf9')
  label(ctx, 'JAPANESE GRAND PRIX', 470, h / 2 - 6, 56, '#1a1a1a', 900, 'center', 640)
  label(ctx, '2026', 900, h / 2 - 6, 56, COLOURS.circuitRed.lit, 900, 'center', 150)
  ctx.fillStyle = COLOURS.circuitRed.lit
  ctx.fillRect(140, h - 14, 840, 5)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/**
 * Atlas: the white sectional door (v 0.5–1) and the 48 number plates (v 0–0.5, 8 × 6 cells,
 * plate n at column (n−1) % 8, row (n−1) / 8 from the top of the lower half).
 */
function doorAtlas(k: number): THREE.Texture {
  const w = 1024, h = 512
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#e9ebe9'
  ctx.fillRect(0, 0, w, h / 2)
  // four hinged panels with a darker rebate, a small window row on the third
  for (let j = 0; j < 4; j++) {
    const y = j * 64
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fillRect(0, y, w, 4)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillRect(0, y + 4, w, 3)
    if (j === 1) {
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = '#3a4046'
        ctx.fillRect(40 + i * 160, y + 18, 110, 28)
      }
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.08)'
  for (let i = 1; i < 6; i++) ctx.fillRect(i * (w / 6) - 1, 0, 2, h / 2)
  // number plates
  const cw = w / 8, ch = (h / 2) / 6
  for (let n = 1; n <= 48; n++) {
    const col = (n - 1) % 8, row = Math.floor((n - 1) / 8)
    const x = col * cw, y = h / 2 + row * ch
    ctx.fillStyle = '#f7f7f5'
    ctx.fillRect(x + 6, y + 4, cw - 12, ch - 8)
    ctx.fillStyle = '#7a7d80'
    ctx.fillRect(x + 6, y + 4, cw - 12, 2)
    label(ctx, String(n), x + cw / 2, y + ch / 2, 30, '#141414', 700)
  }
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Podium backdrop: chequered border bands with the circuit name in a plain face. */
function podiumTexture(k: number): THREE.Texture {
  const w = 512, h = 256
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#f6f6f4'
  ctx.fillRect(0, 0, w, h)
  chequer(ctx, 0, 0, w, 64, 32, '#202020', '#f6f6f4')
  chequer(ctx, 0, h - 64, w, 64, 32, '#202020', '#f6f6f4')
  label(ctx, 'SUZUKA CIRCUIT', w / 2, h / 2, 46, '#2a2f34', 700, 'center', w - 60)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** The big white board on the 3F front (the real one carries the circuit name between chequered flags). */
function bigBoardTexture(k: number): THREE.Texture {
  const w = 1024, h = 128
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#fbfbf9'
  ctx.fillRect(0, 0, w, h)
  chequer(ctx, 24, 24, 80, h - 48, 16, '#1c1c1c', '#fbfbf9')
  chequer(ctx, w - 104, 24, 80, h - 48, 16, '#1c1c1c', '#fbfbf9')
  label(ctx, 'SUZUKA CIRCUIT', w / 2, h / 2, 74, COLOURS.signageGreen.mid, 900, 'center', w - 260)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Plain red panel with the circuit name in white (stands in for the manufacturer boards on the real walls). */
function redPanelTexture(k: number): THREE.Texture {
  const w = 512, h = 96
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = COLOURS.circuitRed.lit
  ctx.fillRect(0, 0, w, h)
  label(ctx, 'SUZUKA', w / 2, h / 2, 64, '#ffffff', 900, 'center', w - 80)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** A generic live-timing frame for the big screens (team tv colours, three-letter codes, no logos). */
function screenTexture(k: number): THREE.Texture {
  const w = 512, h = 288
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#0a0d12'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#152238'
  ctx.fillRect(0, 0, w, 40)
  label(ctx, 'JAPANESE GP · LAP 1 / 53', w / 2, 20, 22, '#ffffff', 700, 'center', w - 40)
  for (let i = 0; i < 10; i++) {
    const d = DRIVERS[i]!
    const y = 48 + i * 24
    ctx.fillStyle = i % 2 ? '#10151d' : '#131a24'
    ctx.fillRect(16, y, w - 32, 22)
    ctx.fillStyle = TEAMS[d.team].tv
    ctx.fillRect(48, y + 3, 5, 16)
    label(ctx, String(i + 1), 34, y + 11, 16, '#ffffff', 700)
    label(ctx, d.code, 66, y + 11, 16, '#ffffff', 700, 'left')
    label(ctx, i === 0 ? 'LEADER' : `+${(i * 0.734).toFixed(3)}`, w - 30, y + 11, 15, i === 0 ? '#ffd400' : '#cfd6df', 600, 'right')
  }
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Leader Tower LED board: white top panel, clock and lap, then ten rows of position + car number. */
function towerTexture(k: number, first: number): THREE.Texture {
  const w = 256, h = 1024
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#0b0b0d'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#f5f5f2'
  ctx.fillRect(10, 10, w - 20, 150)
  label(ctx, 'SUZUKA', w / 2, 70, 44, COLOURS.circuitRed.lit, 900, 'center', w - 40)
  label(ctx, 'CIRCUIT', w / 2, 118, 30, '#2a2f34', 700, 'center', w - 40)
  label(ctx, '14:00', w / 2, 200, 44, '#ffffff', 700)
  label(ctx, 'LAP  1', w / 2, 248, 30, '#ffffff', 700)
  for (let i = 0; i < 10; i++) {
    const pos = first + i
    const d = DRIVERS[pos - 1]
    const y = 320 + i * 66
    label(ctx, String(pos), 78, y, 46, '#ffffff', 700, 'right')
    label(ctx, d ? String(d.number) : '', 190, y, 46, '#ffd400', 700, 'right')
  }
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Pit-wall boards: 8 panels of 8 m in Suzuka's white / black / red rhythm, chequered circuit-name panel included. */
function wallPanelTexture(k: number): THREE.Texture {
  const w = 2048, h = 128
  const { c, ctx } = canvas(w, h, k)
  const slot = w / 8
  const styles: [string, string][] = [['#fbfbf9', '#141414'], ['#141414', '#ffffff'], ['#fbfbf9', COLOURS.circuitRed.lit], [COLOURS.circuitRed.lit, '#ffffff']]
  for (let i = 0; i < 8; i++) {
    const [bg, fg] = styles[i % 4]!
    const x = i * slot
    ctx.fillStyle = bg
    ctx.fillRect(x, 0, slot, h)
    if (i === 0) {
      chequer(ctx, x + 10, 12, 60, h - 24, 15)
      chequer(ctx, x + slot - 70, 12, 60, h - 24, 15)
    }
    label(ctx, PANEL_TEXTS[i]!, x + slot / 2, h / 2, 60, fg, 900, 'center', i === 0 ? slot - 170 : slot - 40)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(x, 0, 3, h)
  }
  return tex(c)
}

/** Paddock face of the building, one 28.33 m × 15.15 m bay per repeat: white cladding, window bands, a service door. */
function rearTexture(k: number): THREE.Texture {
  const w = 512, h = 256
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#e8eae8'
  ctx.fillRect(0, 0, w, h)
  const yOf = (m: number) => h - (m / 15.15) * h
  // 2F and 3F window strips with mullions
  for (const [lo, hi] of [[8.9, 10.9], [13.2, 14.6]] as const) {
    ctx.fillStyle = '#39454f'
    ctx.fillRect(0, yOf(hi), w, yOf(lo) - yOf(hi))
    ctx.fillStyle = '#dfe2e0'
    for (let i = 0; i <= 8; i++) ctx.fillRect(i * (w / 8) - 2, yOf(hi), 4, yOf(lo) - yOf(hi))
  }
  // floor lines and a grey service door on the ground floor
  ctx.fillStyle = 'rgba(0,0,0,0.14)'
  for (const m of [F2, F3]) ctx.fillRect(0, yOf(m), w, 3)
  ctx.fillStyle = '#9ea3a7'
  ctx.fillRect(w * 0.55, yOf(3.6), w * 0.16, yOf(0) - yOf(3.6))
  ctx.fillStyle = '#4a5058'
  ctx.fillRect(w * 0.2, yOf(2.6), w * 0.08, yOf(1.0) - yOf(2.6))
  return tex(c)
}

/** Debris-fence mesh: dark wire grid on a transparent ground, one tile = 0.5 m (the alpha test thins it with distance like real mesh). */
function meshTexture(k: number): THREE.Texture {
  const w = 64
  const { c, ctx } = canvas(w, w, k)
  ctx.clearRect(0, 0, w, w)
  ctx.fillStyle = '#2a2d31'
  for (let i = 0; i < w; i += 8) {
    ctx.fillRect(i, 0, 2, w)
    ctx.fillRect(0, i, w, 2)
  }
  const t = tex(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}

function helipadTexture(k: number): THREE.Texture {
  const w = 256
  const { c, ctx } = canvas(w, w, k)
  ctx.fillStyle = '#6f7275'
  ctx.fillRect(0, 0, w, w)
  ctx.strokeStyle = '#f4f4f2'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.arc(w / 2, w / 2, w * 0.44, 0, Math.PI * 2)
  ctx.stroke()
  label(ctx, 'H', w / 2, w / 2, 150, '#f4f4f2', 900)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Plain paddock asphalt: grey noise so the macro-variation patch has a map to modulate. */
function asphaltTexture(k: number): THREE.Texture {
  const w = 256
  const { c, ctx } = canvas(w, w, k)
  const img = ctx.createImageData(c.width, c.height)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 96 + rnd() * 26
    img.data[i] = v
    img.data[i + 1] = v + 1
    img.data[i + 2] = v + 3
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return tex(c)
}

// ---------------------------------------------------------------- the builder

export function buildPitComplex(ctx: EnvBuildContext): { buildingRoofMat: THREE.MeshStandardMaterial } {
  const { track, ground, group, boxes, assets: reg, quality } = ctx
  const L = track.length
  const k = quality.textureScale

  // --- materials -----------------------------------------------------------------------------
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
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTexture(k), roughness: 0.55 })
  const rearMat = new THREE.MeshStandardMaterial({ map: rearTexture(k), roughness: 0.7 })
  const doorMat = new THREE.MeshStandardMaterial({ map: doorAtlas(k), roughness: 0.6 })
  const boardMat = (map: THREE.Texture, emissive = 0) =>
    new THREE.MeshStandardMaterial({ map, roughness: 0.45, ...(emissive ? { emissive: 0xffffff, emissiveMap: map, emissiveIntensity: emissive * emissiveScale() } : {}) })
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 })
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f4d58, roughness: 0.08, metalness: 0.55 })

  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean): THREE.Mesh | null => {
    if (!geos.length) return null
    // mergeGeometries wants every input indexed or none of them: the prisms and extrusion slices
    // are non-indexed while the sweeps and plates are indexed, so expand the latter when mixed
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

  // --- extents: the box strip (48 × 7.083 m) sets the swept body, the caps take the rest -------
  const S0 = track.wrap(garageS(PIT_GARAGE_COUNT - 1) - PITCH / 2) // 5561.8, final-corner end
  const S1 = track.wrap(garageS(0) + PITCH / 2) // 94.8, T1 end
  const podS0 = track.wrap(PIT_BUILDING.podium.s - PODIUM_HALF)
  const podS1 = track.wrap(PIT_BUILDING.podium.s + PODIUM_HALF)
  const stripLen = forwardDelta(S0, S1, L)

  const shell: THREE.BufferGeometry[] = []
  const roof: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []
  const interior: THREE.BufferGeometry[] = []
  const rails: THREE.BufferGeometry[] = []
  const concrete: THREE.BufferGeometry[] = []

  // --- body cross-section, swept the length of the strip ------------------------------------------
  {
    // 2F terrace: stepped seating between the lounge glazing and the deck edge, with the deck
    // soffit and the fascia's top edge; flat in the podium recess
    const stepped: Pt[] = [[LOUNGE, STEP_TOP]]
    for (let r = 0; r < ROWS; r++) {
      const lat = STEPS_BACK + r * TREAD
      const y = STEP_TOP - r * RISER
      stepped.push([lat, y], [lat, y - RISER])
    }
    stepped.push([DECK_EDGE, F2], [DECK_EDGE, FASCIA_TOP], [FASCIA_FACE, FASCIA_TOP])
    const flat: Pt[] = [[LOUNGE, F2], [DECK_EDGE, F2], [DECK_EDGE, FASCIA_TOP], [FASCIA_FACE, FASCIA_TOP]]
    // The upper floors start at the podium recess: bay 12 (final-corner end) is the control
    // tower pod, not a hospitality room (11 rooms for 12 garages, Honda 2009), and the podium
    // photo shows the glazed podium-entrance core right beside the recess.
    shell.push(sweep(track, flat, podS0, podS1, plasterTile), sweep(track, stepped, podS1, S1, plasterTile))
    // the steps' open end into the recess (the pod's tail closes the other side)
    const stepEnd: Pt[] = stepped.slice(0, 1 + ROWS * 2)
    stepEnd.push([stepEnd[stepEnd.length - 1]![0], F2], [LOUNGE, F2])
    shell.push(sectionPlate(track, podS1 + 0.01, stepEnd, false))
    // 2F lounge glazing (full height in the recess), 3F wall / deck / slab edge / soffit, roof
    glass.push(sweep(track, [[LOUNGE, SOFFIT3], [LOUNGE, F2]], podS0, podS1, 3), sweep(track, [[LOUNGE, SOFFIT3], [LOUNGE, STEP_TOP]], podS1, S1, 3))
    shell.push(sweep(track, [[LOUNGE, ROOF_SOFFIT], [LOUNGE, F3], [DECK_EDGE, F3], [DECK_EDGE, SOFFIT3], [LOUNGE, SOFFIT3]], podS0, S1, plasterTile))
    shell.push(sweep(track, [[ROOF_EDGE, ROOF + 0.4], [ROOF_EDGE, ROOF - 0.1], [LOUNGE, ROOF_SOFFIT]], podS0, S1, plasterTile))
    shell.push(sweep(track, [[BACK, ROOF_SOFFIT], [ROOF_BACK, ROOF_SOFFIT], [ROOF_BACK, ROOF]], podS0, S1, plasterTile))
    // roof slab with the slight upturn at the front edge
    roof.push(sweep(track, [[ROOF_BACK, ROOF], [ROOF_EDGE - 3, ROOF], [ROOF_EDGE, ROOF + 0.4]], podS0, S1, 4))
    // 3F glazing where bays 2–7 were enclosed (2024–25 works)
    glass.push(sweep(track, [[DECK_EDGE - 0.5, ROOF_SOFFIT], [DECK_EDGE - 0.5, F3]], track.wrap(garageS(6) - PITCH / 2), track.wrap(garageS(1) + PITCH / 2), 3))
    // door head soffit, the fascia band, the paddock face
    shell.push(sweep(track, [[FASCIA_FACE, DOOR_H], [FRONT, DOOR_H]], S0, S1, plasterTile))
    const fascia = new THREE.Mesh(texturedWall(track, S0, S1, FASCIA_FACE, DOOR_H, FASCIA_TOP, 8 * BOX, 1), fasciaMat)
    fascia.name = 'pitFascia'
    fascia.receiveShadow = true
    group.add(fascia)
    // ground floor the full length, the upper floors from the pod's tail (the pod is narrower than the footprint at its nose)
    const rear = new THREE.Mesh(mergeGeometries([texturedWall(track, S0, S1, BACK, 0, F2, PITCH, -1), texturedWall(track, podS0, S1, BACK, F2, ROOF_SOFFIT, PITCH, -1)], false)!, rearMat)
    rear.name = 'pitRear'
    rear.castShadow = true
    rear.receiveShadow = true
    group.add(rear)
    // garage interior: floor, ceiling, header over the openings
    interior.push(sweep(track, [[GARAGE_BACK, 0.025], [FRONT + 0.45, 0.025]], S0, S1, 4))
    interior.push(sweep(track, [[FRONT, GARAGE_CEIL], [GARAGE_BACK, GARAGE_CEIL]], S0, S1, 4))
    interior.push(sweep(track, [[FRONT, DOOR_H], [FRONT, GARAGE_CEIL]], S0, S1, 4))
    // end plates: the whole outline above ground at both ends (what the caps do not enclose shows)
    const outline: Pt[] = [[FRONT, DOOR_H], [FASCIA_FACE, DOOR_H], [FASCIA_FACE, FASCIA_TOP], [DECK_EDGE, FASCIA_TOP], [DECK_EDGE, F2]]
    for (let r = ROWS - 1; r >= 0; r--) {
      const lat = STEPS_BACK + r * TREAD
      const y = STEP_TOP - r * RISER
      outline.push([lat, y - RISER], [lat, y])
    }
    outline.push([LOUNGE, STEP_TOP], [LOUNGE, SOFFIT3], [DECK_EDGE, SOFFIT3], [DECK_EDGE, F3], [LOUNGE, F3], [LOUNGE, ROOF_SOFFIT], [ROOF_EDGE, ROOF - 0.1], [ROOF_EDGE, ROOF + 0.4], [ROOF_EDGE - 3, ROOF], [ROOF_BACK, ROOF], [ROOF_BACK, ROOF_SOFFIT], [BACK, ROOF_SOFFIT], [BACK, 0], [FRONT, 0])
    shell.push(sectionPlate(track, S1 - 0.01, outline, true), sectionPlate(track, podS0 + 0.01, outline, false))
  }

  // --- end caps and the rear spur from the OSM footprint ---------------------------------------------
  {
    const ring = OSM_PIT_BUILDING.en.map(([e, n]) => trackCoords(track, e, n))
    const cap = (cut: number, sign: 1 | -1) => {
      // ring vertices beyond the cut (within the cap's 15 m), front to rear
      const verts = ring
        .map((v) => ({ d: signedDelta(cut, v.s, L), lat: v.lat }))
        .filter((v) => sign * v.d > -8 && Math.abs(v.d) < 15 && v.lat < FRONT + 3 && v.lat > BACK - 3)
        .sort((a, b) => b.lat - a.lat)
      const poly = [{ d: 0, lat: FRONT }, ...verts, { d: 0, lat: BACK }]
      return clipD(poly, (d) => sign * d >= -1e-6)
    }
    // T1 end: chamfered, full height; final-corner end: rounded, ground floor only (the pod sits on it)
    const t1 = trackPrism(track, cap(S1, 1), S1, -0.3, ROOF, plasterTile)
    const fc = trackPrism(track, cap(S0, -1), S0, -0.3, F2, plasterTile)
    shell.push(t1.sides, fc.sides)
    roof.push(t1.top, fc.top)
    const sp = PIT_BUILDING.spur
    const spur = trackPrism(track, [{ d: 0, lat: BACK + 0.2 }, { d: 0, lat: sp.lateral[1] }, { d: sp.sRange[1] - sp.sRange[0], lat: sp.lateral[1] }, { d: sp.sRange[1] - sp.sRange[0], lat: BACK + 0.2 }], sp.sRange[0], -0.3, ROOF - 0.3, plasterTile)
    shell.push(spur.sides)
    roof.push(spur.top)
  }

  // --- control-tower pod: the bullet-nosed final-corner end ------------------------------------
  {
    // The photos show the pod as the whole end of the 2F/3F volume: a bullet nose rounded in
    // plan and elevation, its tip at the 2F glass band, sitting on the ground floor's fascia and
    // ending flush with the podium recess (the spec's 5605 end is UNVERIFIED and would bury the
    // podium; bay 12 is the control tower, see above).
    const pS0 = PIT_BUILDING.controlPod.sRange[0]
    const pS1 = podS0 - 0.02
    const len = forwardDelta(pS0, pS1, L)
    const TOP = PIT_BUILDING.controlPod.top
    const BAND_Y = 10 // the glass band, and the nose tip
    // flanks just proud of the fascia and inside the paddock wall: the real pod does not
    // overhang the terraces, and a narrower body keeps the nose from reading as a bulb
    const podFront = FASCIA_FACE + 0.9, podBack = BACK + 1.2
    const A = (podFront - podBack) / 2
    const cLat = (podFront + podBack) / 2
    const NOSE = 18, NOSE_TOP = 18, NOSE_BOT = 9
    const ell = (d: number, n: number) => (d >= n ? 1 : Math.sqrt(Math.max(0, 1 - ((n - d) / n) ** 2)))
    const bottomAt = (d: number) => BAND_Y - (BAND_Y - FASCIA_TOP) * ell(d, NOSE_BOT)
    const topAt = (d: number) => {
      const nose = BAND_Y + (TOP - BAND_Y) * ell(d, NOSE_TOP)
      // the top eases down to the roof upturn so the tail meets the roof without a step
      return nose + (ROOF + 0.4 - nose) * smoothstep((d - (len - 6)) / 6)
    }
    const stations: number[] = []
    for (let d = 0; d < len; d += 1) stations.push(d)
    stations.push(len)
    // ring angles: uniform plus the four edges of the glass band (duplicated for a hard edge)
    const band = (1.2 * Math.PI) / 180
    const edges = [-band, band, Math.PI - band, Math.PI + band]
    const angles = new Set<number>()
    for (let i = 0; i < 36; i++) angles.add((i / 36) * Math.PI * 2 - Math.PI / 2)
    for (const e of edges) angles.add(e)
    const ring: { th: number; dark: boolean }[] = []
    const inBand = (th: number) => {
      const t = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      return t < band || t > Math.PI * 2 - band || Math.abs(t - Math.PI) < band
    }
    for (const th of [...angles].sort((x, y) => x - y)) {
      if (edges.some((e) => Math.abs(e - th) < 1e-9)) {
        const after = inBand(th + 1e-4)
        ring.push({ th, dark: !after }, { th, dark: after })
      } else ring.push({ th, dark: inBand(th) })
    }
    const N = ring.length
    // arc length around the full section, so the plaster tiles at the shell's scale (a per-vertex
    // fraction of the perimeter gave 30 tiny tiles that read as a woven brown skin on the high tier)
    const perim: number[] = []
    {
      const sq0 = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
      const pt = (th: number): [number, number] => [A * sq0(Math.cos(th)), (Math.sin(th) > 0 ? TOP - BAND_Y : BAND_Y - FASCIA_TOP) * sq0(Math.sin(th))]
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
    const dark = new THREE.Color(0x30383f)
    const white = new THREE.Color(0xffffff)
    // squircle section: |cos|^½ keeps the flanks nearly vertical and the corners tight
    const sq = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
    stations.forEach((d, si) => {
      // parabolic in plan (a pointed train nose) but domed in elevation
      const kw = Math.max(0.002, d >= NOSE ? 1 : 1 - ((NOSE - d) / NOSE) ** 2)
      // the section is centred on the glass band: the flanks' mid-height vertices carry it
      const cy = BAND_Y
      const bt = Math.max(0.002, topAt(d) - cy), bb = Math.max(0.002, cy - bottomAt(d))
      const s = pS0 + d
      for (let j = 0; j < N; j++) {
        const { th, dark: isDark } = ring[j]!
        const sn = sq(Math.sin(th))
        track.pointAt(s, cLat + A * kw * sq(Math.cos(th)), _p, cy + (sn > 0 ? bt : bb) * sn)
        pos.push(_p.x, _p.y, _p.z)
        const c = isDark ? dark : white
        col.push(c.r, c.g, c.b)
        uv.push(d / plasterTile, perim[j]! / plasterTile)
      }
      if (si > 0) {
        for (let j = 0; j < N; j++) {
          const j1 = (j + 1) % N
          const p0 = (si - 1) * N, p1 = si * N
          idx.push(p0 + j, p1 + j, p0 + j1, p0 + j1, p1 + j, p1 + j1)
        }
      }
    })
    // flat tail face (mostly buried in the roof)
    const centre = pos.length / 3
    track.pointAt(pS1, cLat, _p, BAND_Y)
    pos.push(_p.x, _p.y, _p.z)
    col.push(1, 1, 1)
    uv.push(len / plasterTile, 0)
    const last = (stations.length - 1) * N
    for (let j = 0; j < N; j++) idx.push(centre, last + ((j + 1) % N), last + j)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    // the winding above was chosen for outward normals; verify on a top vertex mid-body and flip if not
    const n = geo.attributes.normal as THREE.BufferAttribute
    const topJ = ring.findIndex((r) => Math.abs(r.th - Math.PI / 2) < 1e-6)
    const midStation = Math.floor(stations.length / 2)
    if (topJ >= 0 && n.getY(midStation * N + topJ) < 0) flip(geo)
    const pod = new THREE.Mesh(geo, podMat)
    pod.name = 'controlPod'
    pod.castShadow = true
    pod.receiveShadow = true
    group.add(pod)
  }

  // --- garages: piers, doors, number plates, interiors ------------------------------------------------
  const teams = GARAGE_ORDER.map((id) => TEAMS[id])
  {
    const doors: THREE.BufferGeometry[] = []
    const plates: THREE.BufferGeometry[] = []
    const doorGeo = new THREE.PlaneGeometry(BOX - PIER, DOOR_H)
    doorGeo.rotateY(Math.PI / 2)
    const doorUv = doorGeo.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < doorUv.count; i++) doorUv.setY(i, 0.5 + doorUv.getY(i) * 0.5)
    const plateGeo = new THREE.PlaneGeometry(0.4, 0.4)
    plateGeo.rotateY(Math.PI / 2)
    const m = new THREE.Matrix4()
    // 48 boxes, number 1 at the T1 end; box k (from the final-corner end) starts at S0 + k·7.083
    for (let kk = 0; kk <= 48; kk++) {
      const sb = S0 + kk * BOX
      boxes.place(sb, FRONT - 0.3, PIER, 0.6, DOOR_H, pierMat, 0, true)
      if (kk === 48) break
      const num = 48 - kk
      const garage = Math.floor((num - 1) / 4) // 0 = McLaren
      // team garages stand open on a race weekend; the spare bay under the podium keeps its doors
      if (garage >= teams.length) {
        const d = doorGeo.clone()
        d.applyMatrix4(frameAt(track, sb + BOX / 2, FRONT + 0.05, DOOR_H / 2, m))
        doors.push(d)
      }
      // plate on the T1-side pier of every box, top left of the opening seen from the lane
      const p = plateGeo.clone()
      const uv = p.attributes.uv as THREE.BufferAttribute
      const colI = (num - 1) % 8, rowI = Math.floor((num - 1) / 8)
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (colI + uv.getX(i)) / 8, 0.5 - (rowI + 1 - uv.getY(i)) / 12)
      p.applyMatrix4(frameAt(track, sb + BOX, FRONT + 0.02, DOOR_H - 0.55, m))
      plates.push(p)
    }
    add([...doors, ...plates], doorMat, 'garageDoors', false)
    // interiors per F1 garage (12: 11 teams + the neutral bay under the podium)
    const walls: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const boards: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const sideWall: Pt[] = [[FRONT, 0], [GARAGE_BACK, 0], [GARAGE_BACK, GARAGE_CEIL], [FRONT, GARAGE_CEIL]]
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const s = garageS(g)
      const team = teams[g]
      if (g > 0) interior.push(sectionPlate(track, track.wrap(s + PITCH / 2), sideWall, true))
      walls.push({ m: boxes.matrix(s, GARAGE_BACK + 0.2, GARAGE_CEIL, 0, true, new THREE.Matrix4()), color: new THREE.Color(team ? team.body : COLOURS.garageInterior.mid) })
      for (const lat of [-29.5, -36.5]) boxes.place(s, lat, PITCH - 6, 0.5, 0.12, lampMat, GARAGE_CEIL - 0.1, true, false)
      if (!team) continue
      // props: tool carts, tyre stacks, a bench along the side wall (interior: never cast)
      boxes.place(s - 8, -33, 1.2, 0.7, 1.1, darkMat, 0, true, false)
      boxes.place(s + 9, -37.5, 0.7, 0.7, 1.3, darkMat, 0, true, false)
      boxes.place(s + 9.9, -37.5, 0.7, 0.7, 1.3, darkMat, 0, true, false)
      boxes.place(s + 12.5, -33, 0.8, 8, 0.9, darkMat, 0, true, false)
      boxes.place(s - 11, -30, 0.6, 3, 1.8, darkMat, 0, true, false)
      // pit gantry over the working lane with the team's light board
      boxes.place(s, FRONT + 0.5, 0.25, 0.25, 4.2, darkMat, 0, true, false)
      boxes.place(s, FRONT + 3.6, 0.25, 6.0, 0.25, darkMat, 4.2, true, false)
      boards.push({ m: boxes.matrix(s, FRONT + 6.5, 1.0, 3.3, true, new THREE.Matrix4()), color: new THREE.Color(team.body) })
    }
    boxes.instanced(PITCH - 0.6, 0.3, GARAGE_CEIL, walls, 0.6, false, 'garageWalls')
    boxes.instanced(1.6, 0.15, 1.0, boards, 0.5, false, 'pitBoards')
  }

  // --- podium recess ---------------------------------------------------------------------------------
  {
    const ps = PIT_BUILDING.podium.s
    const back = new THREE.Mesh(new THREE.PlaneGeometry(PIT_BUILDING.podium.width - 0.4, PIT_BUILDING.podium.backdropHeight).rotateY(Math.PI / 2), boardMat(podiumTexture(k)))
    back.applyMatrix4(frameAt(track, ps, LOUNGE + 0.45, F2 + PIT_BUILDING.podium.backdropHeight / 2, new THREE.Matrix4()))
    back.name = 'podiumBackdrop'
    back.receiveShadow = true
    group.add(back)
    boxes.place(ps, LOUNGE + 0.2, PIT_BUILDING.podium.width - 0.4, 0.4, PIT_BUILDING.podium.backdropHeight, shellMat, F2, true, false)
    // the three steps: winner in the middle, second on the T1 side
    boxes.place(ps, LOUNGE + 1.6, 2.6, 1.6, 0.75, darkMat, F2, true, false)
    boxes.place(ps + 2.8, LOUNGE + 1.6, 2.6, 1.6, 0.5, darkMat, F2, true, false)
    boxes.place(ps - 2.8, LOUNGE + 1.6, 2.6, 1.6, 0.32, darkMat, F2, true, false)
    // event banner on the fascia under the podium
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(PITCH - 1, 2.6).rotateY(Math.PI / 2), boardMat(bannerTexture(k)))
    banner.applyMatrix4(frameAt(track, garageS(PIT_GARAGE_COUNT - 1), FASCIA_FACE + 0.03, (DOOR_H + FASCIA_TOP) / 2, new THREE.Matrix4()))
    banner.receiveShadow = true
    group.add(banner)
    // the big white circuit-name board on the 3F front, final-corner side of the centre screen
    const big = new THREE.Mesh(new THREE.PlaneGeometry(24, 2.6).rotateY(Math.PI / 2), boardMat(bigBoardTexture(k)))
    big.applyMatrix4(frameAt(track, 5626, DECK_EDGE + 0.05, F3 + 1.4, new THREE.Matrix4()))
    big.receiveShadow = true
    group.add(big)
    // generic wall panels (the building's walls carry advertising by design): a red circuit-name
    // panel on the 3F front near the T1 end and a rooftop board on the T1 cap facing Turn 1
    const redMat = boardMat(redPanelTexture(k))
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(14, 2.6).rotateY(Math.PI / 2), redMat)
    wall.applyMatrix4(frameAt(track, 5790, DECK_EDGE + 0.05, F3 + 1.4, new THREE.Matrix4()))
    wall.receiveShadow = true
    group.add(wall)
    const roofBoard = new THREE.Mesh(new THREE.PlaneGeometry(14, 2.6), redMat)
    roofBoard.applyMatrix4(frameAt(track, S1 + 4, -41, ROOF + 1.9, new THREE.Matrix4()))
    roofBoard.receiveShadow = true
    group.add(roofBoard)
    for (const dl of [-6.5, 0, 6.5]) boxes.place(S1 + 4, -41 + dl, 0.15, 0.15, 3.4, darkMat, ROOF, true, false)
  }

  // --- 2F / 3F terraces: seats, railings, roof columns ------------------------------------------------
  {
    const seatGeo = (() => {
      const parts: THREE.BufferGeometry[] = []
      const pan = new THREE.BoxGeometry(0.42, 0.05, 0.46)
      pan.translate(0.02, 0.45, 0)
      const back = new THREE.BoxGeometry(0.05, 0.5, 0.46)
      back.translate(-0.2, 0.7, 0)
      parts.push(pan, back)
      for (const dz of [-0.2, 0.2]) {
        const leg = new THREE.BoxGeometry(0.05, 0.45, 0.05)
        leg.translate(-0.1, 0.225, dz)
        parts.push(leg)
      }
      return mergeGeometries(parts, false)!
    })()
    const seatMatrices: THREE.Matrix4[] = []
    const seatS: number[] = []
    const seatRow = (s0: number, s1: number, lat: number, y: number) => {
      const len = forwardDelta(s0, s1, L)
      const n = Math.floor(len / 0.55)
      const start = s0 + (len - (n - 1) * 0.55) / 2
      for (let i = 0; i < n; i++) {
        const s = start + i * 0.55
        seatMatrices.push(frameAt(track, s, lat, y, new THREE.Matrix4()))
        seatS.push(track.wrap(s))
      }
    }
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const c = garageS(g)
      // ≈100 seats per hospitality room: 4 rows of 26 centred on the bay, none in the podium recess
      // bay 12 is the pod up to the podium recess: only the T1-side sliver of terrace remains
      const spans: [number, number][] = g === PIT_GARAGE_COUNT - 1 ? [[podS1 + 0.6, c + 13.5]] : [[c - 7.2, c + 7.2]]
      for (const [a, b] of spans) {
        for (let r = 0; r < ROWS; r++) {
          const lat = STEPS_BACK + r * TREAD + 0.42
          seatRow(a, b, lat, STEP_TOP - (r + 1) * RISER)
        }
      }
      // 3F: two rows along the open terrace (none in the pod)
      const a3 = signedDelta(podS0, c - 13.5, L) < 0 ? podS0 + 0.5 : c - 13.5
      if (signedDelta(a3, c + 13.5, L) > 2) for (const lat of [-23.1, -24.1]) seatRow(a3, c + 13.5, lat, F3)
    }
    for (const inst of bucketedInstancedMeshes(seatGeo, seatMat, seatMatrices, null, (i) => Math.floor(seatS[i]! / 60), { name: 'pitSeats', receiveShadow: true })) group.add(inst)

    // white railings at both deck edges, on the podium and along the roof edge
    const postMatrices: THREE.Matrix4[] = []
    const postS: number[] = []
    const railing = (s0: number, s1: number, lat: number, y: number) => {
      rails.push(tube(track, s0, s1, lat, y + RAIL_H, 0.03), tube(track, s0, s1, lat, y + RAIL_H * 0.55, 0.015))
      const len = forwardDelta(s0, s1, L)
      for (let d = 0; d <= len; d += 1.6) {
        postMatrices.push(frameAt(track, s0 + d, lat, y, new THREE.Matrix4()))
        postS.push(track.wrap(s0 + d))
      }
    }
    railing(podS0, S1, DECK_EDGE - 0.08, F2)
    railing(podS0, S1, DECK_EDGE - 0.08, F3)
    railing(podS0, S1, ROOF_EDGE - 0.1, ROOF + 0.4)
    const postGeo = new THREE.BoxGeometry(0.05, RAIL_H, 0.05)
    postGeo.translate(0, RAIL_H / 2, 0)
    for (const inst of bucketedInstancedMeshes(postGeo, railMat, postMatrices, null, (i) => Math.floor(postS[i]! / 60), { name: 'pitRailPosts', receiveShadow: true })) group.add(inst)
    // slim columns carrying the roof overhang, one per box along the 3F terrace edge
    for (let d = BOX / 2; d < stripLen; d += BOX) if (signedDelta(podS0, S0 + d, L) > 0.5) boxes.place(S0 + d, DECK_EDGE + 0.5, 0.25, 0.25, ROOF_SOFFIT - F3, railMat, F3, true, false)
  }

  // --- roof screens (the three permanent big screens; the centre one shows both ways) ---------------------
  {
    const screenMat = boardMat(screenTexture(k), 0.9)
    const faces: THREE.BufferGeometry[] = []
    for (const sc of SCREENS) {
      if (!sc.id.startsWith('pit_')) continue
      const base = sc.base - ROOF // frame height above the roof slab
      for (const ds of [-sc.width / 2 + 0.3, sc.width / 2 - 0.3]) for (const dl of [-0.4, 0.4]) boxes.place(sc.s + ds, sc.lateral + dl, 0.3, 0.3, base, darkMat, ROOF, true, false)
      boxes.place(sc.s, sc.lateral, sc.width, 1.2, sc.height, darkMat, sc.base, true)
      const front = new THREE.PlaneGeometry(sc.width - 0.4, sc.height - 0.4).rotateY(Math.PI / 2)
      front.applyMatrix4(frameAt(track, sc.s, sc.lateral + 0.62, sc.base + sc.height / 2, new THREE.Matrix4()))
      faces.push(front)
      if (sc.doubleSided) {
        const rear = new THREE.PlaneGeometry(sc.width - 0.4, sc.height - 0.4).rotateY(-Math.PI / 2)
        rear.applyMatrix4(frameAt(track, sc.s, sc.lateral - 0.62, sc.base + sc.height / 2, new THREE.Matrix4()))
        faces.push(rear)
      }
    }
    add(faces, screenMat, 'pitScreens', false)
  }

  // --- Leader Tower at the pit exit ---------------------------------------------------------------
  {
    const t = LEADER_TOWER
    const [along, across] = t.footprint
    const gy = ground.yAt(t.s, t.lateral)
    const boardBottom = t.height - t.boardHeight
    // open steel column: four corner posts and rungs every 1.5 m, then the board box on top
    for (const ds of [-along / 2 + 0.15, along / 2 - 0.15]) for (const dl of [-across / 2 + 0.15, across / 2 - 0.15]) boxes.place(t.s + ds, t.lateral + dl, 0.3, 0.3, boardBottom - gy, darkMat, gy, true)
    for (let y = gy + 1.5; y < boardBottom - 0.5; y += 1.5) {
      boxes.place(t.s, t.lateral - across / 2 + 0.15, along - 0.6, 0.12, 0.12, darkMat, y, true, false)
      boxes.place(t.s, t.lateral + across / 2 - 0.15, along - 0.6, 0.12, 0.12, darkMat, y, true, false)
      for (const ds of [-along / 2 + 0.15, along / 2 - 0.15]) boxes.place(t.s + ds, t.lateral, 0.12, across - 0.6, 0.12, darkMat, y, true, false)
    }
    boxes.place(t.s, t.lateral, t.boardWidth + 0.4, 1.3, t.boardHeight, darkMat, boardBottom, true)
    boxes.place(t.s, t.lateral, t.boardWidth + 0.6, 1.5, 0.3, darkMat, t.height, true, false)
    // positions 1–10 towards the grandstand, 11–20 towards the pit lane
    const front = new THREE.Mesh(new THREE.PlaneGeometry(t.boardWidth, t.boardHeight - 0.4).rotateY(Math.PI / 2), boardMat(towerTexture(k, 1), 1.1))
    front.applyMatrix4(frameAt(track, t.s, t.lateral + 0.66, boardBottom + t.boardHeight / 2, new THREE.Matrix4()))
    const rear = new THREE.Mesh(new THREE.PlaneGeometry(t.boardWidth, t.boardHeight - 0.4).rotateY(-Math.PI / 2), boardMat(towerTexture(k, 11), 1.1))
    rear.applyMatrix4(frameAt(track, t.s, t.lateral - 0.66, boardBottom + t.boardHeight / 2, new THREE.Matrix4()))
    front.name = 'leaderTowerBoard'
    group.add(front, rear)
  }

  // --- pit wall, its boards and the prat perches --------------------------------------------------------
  {
    const [w0, w1] = PIT_WALL.sRange
    const lat = PIT_WALL.lateral
    const half = 0.35
    const h = PIT_WALL.height
    // 1.05 m concrete (pit-lane face, top, grid face); the boards sit on top of it as a 0.5 m box
    concrete.push(profileRibbonGeometry(track, w0, w1, [[K(lat - half), K(0)], [K(lat - half), K(h)], [K(lat - half), K(h)], [K(lat + half), K(h)], [K(lat + half), K(h)], [K(lat + half), K(0)]], 4, concreteTile, [0, h / concreteTile, h / concreteTile, (h + 2 * half) / concreteTile, (h + 2 * half) / concreteTile, (2 * h + 2 * half) / concreteTile]))
    const panelMat = new THREE.MeshStandardMaterial({ map: wallPanelTexture(k), roughness: 0.5 })
    const bh = 0.5
    const boardsGeo = [texturedWall(track, w0, w1, lat + half, h, h + bh, 64, 1), texturedWall(track, w0, w1, lat - half, h, h + bh, 64, -1)]
    add(boardsGeo, panelMat, 'pitWallBoards', false)
    rails.push(ribbonGeometry(track, w0, w1, K(lat + half), K(lat - half), K(h + bh), K(h + bh), 4, 8))
    // debris fence on the grid side over the pit-stop zone: posts every 4 m and a wire mesh
    // (alpha-tested so it thins out with distance the way real mesh does)
    const fenceTop = h + bh + PIT_WALL.fenceHeight
    for (let d = 0; d <= stripLen; d += 4) boxes.place(S0 + d, lat + half - 0.04, 0.08, 0.08, fenceTop - h, darkMat, h, true, false)
    rails.push(tube(track, S0, S1, lat + half - 0.04, fenceTop, 0.02))
    const meshMat = new THREE.MeshStandardMaterial({ map: meshTexture(k), color: 0x9a9da1, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide, ...cutoutParams(quality) })
    const fence = new THREE.Mesh(texturedWall(track, S0, S1, lat + half - 0.04, h + bh, fenceTop, 0.5, 1), meshMat)
    const fuv = fence.geometry.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < fuv.count; i++) fuv.setY(i, fuv.getY(i) * (PIT_WALL.fenceHeight / 0.5))
    fence.name = 'pitDebrisFence'
    fence.receiveShadow = true
    group.add(fence)
    // team prat perches on the pit-lane side of the wall, opposite each garage
    const perch = PRAT_PERCH
    const pl = lat - half - 0.1 - perch.width / 2
    const canopies: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const backs: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      const colour = new THREE.Color(team.body)
      boxes.place(s, pl, perch.length, perch.width, 0.9, darkMat, 0, true, false)
      for (const ds of [-perch.length / 2 + 0.05, perch.length / 2 - 0.05]) boxes.place(s + ds, pl, 0.1, perch.width, perch.height - 0.9, darkMat, 0.9, true, false)
      for (let i = 0; i < 4; i++) boxes.place(s - 1.8 + i * 1.2, pl - 0.3, 0.5, 0.5, 0.5, darkMat, 0.9, true, false)
      canopies.push({ m: boxes.matrix(s, pl, 0.2, perch.height - 0.2, true, new THREE.Matrix4()), color: colour })
      backs.push({ m: boxes.matrix(s, pl - perch.width / 2 + 0.05, perch.height - 0.9, 0.9, true, new THREE.Matrix4()), color: colour })
    })
    boxes.instanced(perch.length, perch.width, 0.2, canopies, 0.5, false, 'perchCanopies')
    boxes.instanced(perch.length, 0.1, perch.height - 0.9, backs, 0.5, false, 'perchBacks')
  }

  // --- helipad beside the final-corner end (aerial: the H sits west of the pod nose) ------------------
  {
    // The spec's HELIPAD record (s 200, lateral −48) is the 2009 dossier's guess; the GSI aerial
    // shows the H next to the rounded final-corner end, so it is placed there.
    const hs = 5566, hl = -78, r = 8
    const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 40), boardMat(helipadTexture(k)))
    pad.geometry.rotateX(-Math.PI / 2)
    pad.applyMatrix4(frameAt(track, hs, hl, ground.yAt(hs, hl) + 0.04, new THREE.Matrix4()))
    pad.name = 'helipad'
    pad.receiveShadow = true
    group.add(pad)
  }

  // --- paddock: asphalt aprons, footprint buildings, prefabs, transporters, tents, flags, car park ------
  {
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTexture(k), color: 0xb8b8b8, roughness: 0.95 })
    addMacro(asphaltMat, new THREE.Vector2(40 / 250, 40 / 250))
    const drape = (s0: number, s1: number, lats: number[], lift: number) => {
      const edges: [Fn, Fn][] = lats.map((lat) => [K(lat), (s) => ground.yAt(s, lat) + lift])
      return profileRibbonGeometry(track, s0, s1, edges, 6, 40, lats.map((lat) => lat / 40))
    }
    // behind the building (the flat zone of the terrain), and the pit-exit yard around the medical centre
    add([drape(5536, 100, [-125, -118, -112, -106, -100, -88, -76, -66, -57.3], 0.03), drape(103, 205, [-52, -44, -36, -28, -24.9], 0.03)], asphaltMat, 'paddockAsphalt', false)

    // real footprints: the spec'd buildings plus every other OSM building inside the paddock box
    const capGeos: THREE.BufferGeometry[] = []
    const wallGeos: THREE.BufferGeometry[] = []
    const extrude = (f: OsmFeature, height: number, base: number) => {
      const shape = new THREE.Shape(f.en.map(([e, n]) => new THREE.Vector2(e, n)))
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
      geo.applyMatrix4(enMatrix(track, base))
      for (const g of geo.groups) (g.materialIndex === 0 ? capGeos : wallGeos).push(slice(geo, g.start, g.count))
      geo.dispose()
    }
    const done = new Set<number>()
    for (const b of BUILDINGS) {
      if (b.osmWay === null) continue
      const f = osmFeature(b.osmWay)
      if (!f) continue
      done.add(f.id)
      let base: number
      if (b.anchor === 'terrain') {
        const [ce, cn] = f.en.reduce(([ae, an], [e, n]) => [ae + e / f.en.length, an + n / f.en.length], [0, 0])
        track.enToWorld(ce, cn, _p)
        base = ctx.terrain.heightAt(_p.x, _p.z) - 0.5
      } else base = ground.worldY(b.anchor.s, b.anchor.lateral) - 0.5
      extrude(f, b.height + 0.5, base)
    }
    const inPaddock = (f: OsmFeature) => {
      const [s, lat] = f.centroid
      return lat < -57 && lat > -135 && (s > 5530 || s < 260) && !f.fold
    }
    for (const f of OSM_BUILDINGS) {
      if (done.has(f.id) || !inPaddock(f)) continue
      done.add(f.id)
      extrude(f, 4.5, ground.worldY(f.centroid[0], f.centroid[1]) - 0.4)
    }
    add(wallGeos, whiteMat, 'paddockBuildings', true)
    add(capGeos, buildingRoofMat, 'paddockRoofs', true)

    // transporters backed up to the rear wall behind each team's garage, two per team
    const trailers: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      for (const ds of [-5, 5]) {
        trailers.push({ m: boxes.matrix(s + ds, -64.5, 4.0, 0, false, new THREE.Matrix4()), color: new THREE.Color(team.body) })
        boxes.place(s + ds, -72.6, 2.5, 2.4, 3.2, whiteMat, 0, false, false) // cab
      }
    })
    boxes.instanced(2.55, 13.6, 4.0, trailers, 0.5, true, 'transporters')
    // white prefab hospitality units along the T1 end of the paddock road
    for (let i = 0; i < 6; i++) boxes.place(track.wrap(5790 + i * 13), -78, 12, 6, 3.4, whiteMat, 0, false, true)
    for (let i = 0; i < 6; i++) boxes.place(track.wrap(5790 + i * 13), -78, 12.4, 6.4, 0.2, buildingRoofMat, 3.4, false, false)
    // tents (white and red) on the final-corner side
    const tentMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.9, side: THREE.DoubleSide })
    const tentRedMat = new THREE.MeshStandardMaterial({ color: COLOURS.circuitRed.lit, roughness: 0.9, side: THREE.DoubleSide })
    const tentGeos: THREE.BufferGeometry[] = []
    const tentRedGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 6; i++) {
      const s = 5600 + i * 9
      const lat = -70
      const cone = new THREE.ConeGeometry(4.6, 2.2, 4, 1, true)
      cone.rotateY(Math.PI / 4)
      cone.applyMatrix4(frameAt(track, s, lat, ground.yAt(s, lat) + 2.7 + 1.1, new THREE.Matrix4()))
      ;(i % 3 === 1 ? tentRedGeos : tentGeos).push(cone)
      for (const [ds, dl] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) boxes.place(s + ds, lat + dl, 0.1, 0.1, 2.7, railMat, 0, false, false)
    }
    add(tentGeos, tentMat, 'tents', false)
    add(tentRedGeos, tentRedMat, 'tentsRed', false)
    // flag poles on the T1 cap roof (as in the photos) and at the paddock gate
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
    for (let i = 0; i < 5; i++) pole(track.wrap(S1 + 1 + i * 1.5), -36 - i * 4, ROOF + 0.3, i)
    for (let i = 0; i < 6; i++) pole(5548, -62 - i * 5, ground.yAt(5548, -62 - i * 5), i)
    add(flagGeos, railMat, 'flagPoles', false)
    flagsByMat.forEach((geos, i) => add(geos, flagMats[i]!, `flags${i}`, false))
    // car park west of the team offices: bay lines and a few parked cars
    const lines: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const cars: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const carColours = [0xf2f2f2, 0x1a1a1a, 0x8a8f95, 0xb01e28, 0x2b4a8c, 0xd8d8d8]
    let ci = 0
    for (const lat0 of [-104, -116]) {
      for (let s = 5600; s <= 5735; s += 2.6) {
        lines.push({ m: boxes.matrix(s, lat0 - 2.5, 0.01, 0.02, false, new THREE.Matrix4()), color: new THREE.Color(0xf4f4f0) })
        if (ci++ % 3 !== 1) cars.push({ m: boxes.matrix(s + 1.3, lat0 - 2.5, 1.45, 0, false, new THREE.Matrix4()), color: new THREE.Color(carColours[ci % carColours.length]!) })
      }
    }
    boxes.instanced(0.12, 5, 0.01, lines, 0.8, false, 'parkingLines')
    boxes.instanced(1.8, 4.4, 1.45, cars, 0.45, true, 'parkedCars')
  }

  // --- basins: dry earth in late March, water only where the season keeps it ---------------------
  {
    // Both retention basins are dry mud in the 2026 race-weekend photos (the audit's S01-04 /
    // S02-05): a blue sheet at grade read as a lake from every camera. They are drawn as a sunken
    // floor with a rim instead, and BASINS.dry flips back to water for the October palette.
    const waterGeos: THREE.BufferGeometry[] = []
    const dryGeos: THREE.BufferGeometry[] = []
    const rimGeos: THREE.BufferGeometry[] = []
    for (const f of OSM_WATER) {
      const def = BASINS.find((b) => b.osmWay === f.id)
      const dry = (def?.dry ?? false) && SEASON === 'spring'
      const heights = f.en.map(([e, n]) => {
        track.enToWorld(e, n, _p)
        return ctx.terrain.heightAt(_p.x, _p.z)
      }).sort((a, b) => a - b)
      const shore = heights[Math.floor(heights.length * 0.3)]!
      const shape = new THREE.Shape(f.en.map(([e, n]) => new THREE.Vector2(e, n)))
      if (!dry) {
        const geo = new THREE.ShapeGeometry(shape)
        geo.applyMatrix4(enMatrix(track, shore - 0.05))
        waterGeos.push(geo)
        continue
      }
      // floor: the footprint shrunk towards its centroid, sunk by `depth`; rim: the ring between
      // the shrunk floor and the shoreline, so the bank is a slope rather than a cliff
      const depth = def?.depth ?? 2.5
      let ce = 0, cn = 0
      for (const [e, n] of f.en) {
        ce += e / f.en.length
        cn += n / f.en.length
      }
      const inset = f.en.map(([e, n]): [number, number] => [ce + (e - ce) * 0.82, cn + (cn === n ? 0 : (n - cn) * 0.82)])
      const floor = new THREE.ShapeGeometry(new THREE.Shape(inset.map(([e, n]) => new THREE.Vector2(e, n))))
      floor.applyMatrix4(enMatrix(track, shore - depth))
      dryGeos.push(floor)
      // bank: one quad per footprint edge, from the shoreline down to the sunk floor
      const pos: number[] = []
      const uv: number[] = []
      for (let i = 0; i < f.en.length; i++) {
        const j = (i + 1) % f.en.length
        const a = f.en[i]!, b = f.en[j]!
        const ai = inset[i]!, bi = inset[j]!
        const P = (e: number, n: number, y: number) => {
          track.enToWorld(e, n, _p)
          pos.push(_p.x, y, _p.z)
        }
        P(a[0], a[1], shore)
        P(ai[0], ai[1], shore - depth)
        P(b[0], b[1], shore)
        P(ai[0], ai[1], shore - depth)
        P(bi[0], bi[1], shore - depth)
        P(b[0], b[1], shore)
        uv.push(0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0)
      }
      const bank = new THREE.BufferGeometry()
      bank.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      bank.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      bank.computeVertexNormals()
      rimGeos.push(bank)
    }
    const water = add(waterGeos, waterMat, 'water', false)
    if (water) water.castShadow = false
    const dryMat = new THREE.MeshStandardMaterial({ color: 0x8a7d66, roughness: 0.95, side: THREE.DoubleSide })
    add(dryGeos, dryMat, 'basinFloor', false)
    add(rimGeos, dryMat, 'basinBank', false)
  }

  // --- merge the building shells --------------------------------------------------------------------
  add(shell, shellMat, 'pitShell', true)
  add(roof, buildingRoofMat, 'pitRoof', true)
  add(glass, glassMat, 'pitGlass', false)
  add(interior, interiorMat, 'pitInterior', false)
  add(rails, railMat, 'pitRails', false)
  add(concrete, concreteMat, 'pitWall', true)

  return { buildingRoofMat }
}
