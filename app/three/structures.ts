/**
 * Circuit structures that are not ground, barriers or stands: the crossover bridge with its
 * abutments, the 2 m advertising fascia and the white / blue guard beam along its parapets
 * (I4-c), the service road under it, the parapet railings over the roads that pass under the
 * lap, the chicane service bridge, and the trackside signs (DRS boards, the pit-exit boards and
 * signal, the 'PIT ENTRY' board on the separator wall's top). The screens are pit-building.ts,
 * the Leader Tower and the pit wall pit-lane.ts, the start gantry track-mesh.ts.
 *
 * Built after the trackside props and BEFORE `boxes.flush()` so single-material boxes (girders,
 * kerbs, posts, boards) merge into the shared `props` meshes; everything stands on
 * `ground.standAt / standY` (never the terrain height functions, R3) and nothing here draws an
 * opaque horizontal ground face (R11) — the service road itself is a GROUND_AREAS band row.
 *
 * The crossover (verified 2026-09, plan §3a): the upper road (s 4691.4, the 130R approach) crosses
 * the lower one (s 2320.7, the Degner 2 exit) 6.5 m up at a 55.4° skew; OSM 175231434 gives the
 * 19 m half-span, and the abutments are the BARRIERS rows crossover-abutment-left / right at ±8.5
 * in the LOWER road's frame. Because of the skew the deck corners shift ±6.2 m along the upper
 * road between its two edges, so the abutments and wing walls are built in the UPPER road's frame
 * along the deck shoulder line (hw + DECK_SHOULDER) from the soffit down to the lower ground, and
 * the opening is wherever that line is inside the lower road's ±8.5 corridor — which is exactly
 * the skewed opening the OSM tunnel polygons draw.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { UNDERPASSES } from '~/data/suzuka-facilities-spec'
import { SIGNS, type SignDef } from '~/data/suzuka-barriers-spec'
import { forwardDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import type { Ground } from './ground'
import { DECK_REACH, DECK_SHOULDER } from './ground-plan'
import { profileRibbonGeometry, ribbonGeometry, wallGeometry } from './track-mesh'
import { texturedWall } from './pit-geometry'
import { barrierProfile, barrierRun } from './barriers'
import { osmWay } from './trackside'
import { cameraSide } from './props'
import { bridgeRailTexture, cached, canvas, concreteMaps, makeTexture, scaled } from './textures'
import { assetAspect, pbr, pbrFromAssets, tileMetres } from './materials'
import { EMISSIVE, emissiveScale } from './emissive'
import type { BoxPlacer } from './boxes'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const K = (v: number): Fn => () => v

export interface Structures {
  /**
   * Per-frame hook from Environment.update. The bridge's small furniture (kerbs, fence, lamp,
   * railings) is a far-field 'structure' entry with a near level, so its LOD is the registry's
   * (FarField.update) and nothing is done here; kept so a future instanced part has a home.
   */
  update(cameraPos: THREE.Vector3): void
}

// ---------------------------------------------------------------- constants (metres)

/** half-span of the crossover deck along the upper road (OSM 175231434) */
const SPAN = 19
/** the lower road's abutment line: BARRIERS crossover-abutment-left / right (±8.5) */
const ABUTMENT_LAT = 8.5
/** the deck slab's underside below the road plane; the fascia (the white advertising board, mlc.jpg ≈ 2 m) hangs from `FASCIA_TOP` over the road level to `FASCIA_BOTTOM` */
const SOFFIT = -1.3
const FASCIA_BOTTOM = -1.05
/** I4-c: the fascia's top over the road level (2.0 m of board with FASCIA_BOTTOM; the soffit and the girders stay where the chase lens passes under them) */
export const FASCIA_TOP = 0.95
/** the low guard beam along the deck's parapets (mlc.jpg: white with a blue band): height, thickness, bottom over the deck, and its gap to the parapet wall's face */
export const BRIDGE_RAIL = { h: 0.4, t: 0.12, bottom: 0.3, gap: 0.3, seg: 4 } as const
/** plate girders under the slab: height, and the yOffset BoxPlacer needs (its matrix adds height / 2) */
const GIRDER_H = 1.0
const GIRDER_Y = SOFFIT - GIRDER_H
/** the service road under the bridge (GROUND_AREAS '立体交差下の側道'): its s window and lateral band on the lower road */
const SERVICE_ROAD = { s: [2262, 2378] as const, lat: [5.9, 8.3] as const }
/** the parapet railing over the roads that pass under the lap */
const PARAPET_RAIL_H = 1.1

// ---------------------------------------------------------------- canvas textures

const FONT = "'Titillium Web', 'Segoe UI', Arial, sans-serif"

/** White fascia board with the circuit's name in a plain face (the bridge fascia). One repeat = the whole board. */
export function fasciaTextTexture(text: string): THREE.Texture {
  const [w, h] = scaled(2048, 128)
  return cached(`structures-fascia|${text}|${w}x${h}`, () => {
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#f4f4f1'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#1d1f22'
    ctx.font = `700 ${Math.round(h * 0.58)}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, h / 2 + h * 0.03)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(0, h - Math.max(2, h * 0.03), w, Math.max(2, h * 0.03))
    return makeTexture(c)
  })
}

/** Every word the sign atlas draws (textures-lint reads this list; no series, tyre or team names). */
export const SIGN_TEXTS = { fireStation: 'FIRE STATION', pitExit: 'PIT EXIT', drs: 'DRS', detection: 'DETECTION', zone: 'ZONE', speed60: '60', pitEntry: 'PIT ENTRY' } as const

/**
 * The sign atlas: 4 × 2 cells of 256 × 128 (logical) pixels. Cell 0 is blank white — every box
 * face that does not carry the graphic maps to it — then the boards of SIGNS by kind; cell 5 is
 * the round red-bordered 60 of the pit entry (drawn on the wall top by pit-lane.ts, I1-c), cell 6
 * the 'PIT ENTRY' board with its green arrow (on the separator wall's top, I4-c).
 */
export const SIGN_CELL: Record<'blank' | 'fireStation' | 'pitExit' | 'drsDetection' | 'drsZone' | 'speed60' | 'pitEntry', number> = { blank: 0, fireStation: 1, pitExit: 2, drsDetection: 3, drsZone: 4, speed60: 5, pitEntry: 6 }
const ATLAS_COLS = 4
const ATLAS_ROWS = 2

export function signAtlas(): THREE.Texture {
  const [w, h] = scaled(1024, 256)
  return cached(`structures-signs|${w}x${h}`, () => {
    const { c, ctx } = canvas(w, h)
    const cw = w / ATLAS_COLS, ch = h / ATLAS_ROWS
    ctx.fillStyle = '#f6f6f3'
    ctx.fillRect(0, 0, w, h)
    const cell = (i: number, draw: (x: number, y: number) => void) => {
      const x = (i % ATLAS_COLS) * cw, y = Math.floor(i / ATLAS_COLS) * ch
      draw(x, y)
      // a thin frame keeps the board's edge readable against a white wall
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = Math.max(1, ch * 0.03)
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, cw - ctx.lineWidth, ch - ctx.lineWidth)
    }
    const text = (t: string, x: number, y: number, px: number, colour: string, weight = 900) => {
      ctx.fillStyle = colour
      ctx.font = `${weight} ${px}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(t, x, y + px * 0.05)
    }
    cell(SIGN_CELL.fireStation, (x, y) => text(SIGN_TEXTS.fireStation, x + cw / 2, y + ch / 2, ch * 0.5, '#b8202c'))
    cell(SIGN_CELL.pitExit, (x, y) => text(SIGN_TEXTS.pitExit, x + cw / 2, y + ch / 2, ch * 0.55, '#1d1f22'))
    for (const [i, sub] of [[SIGN_CELL.drsDetection, SIGN_TEXTS.detection], [SIGN_CELL.drsZone, SIGN_TEXTS.zone]] as const) {
      cell(i, (x, y) => {
        text(SIGN_TEXTS.drs, x + cw / 2, y + ch * 0.42, ch * 0.62, '#1d1f22')
        text(sub, x + cw / 2, y + ch * 0.82, ch * 0.2, '#1d1f22', 700)
      })
    }
    // the 60: a red ring on white with black figures, centred in the (landscape) cell
    cell(SIGN_CELL.speed60, (x, y) => {
      const r = ch * 0.46
      ctx.strokeStyle = '#b8202c'
      ctx.lineWidth = r * 0.22
      ctx.beginPath()
      ctx.arc(x + cw / 2, y + ch / 2, r * 0.86, 0, Math.PI * 2)
      ctx.stroke()
      text(SIGN_TEXTS.speed60, x + cw / 2, y + ch / 2, r * 1.05, '#141414')
    })
    // PIT ENTRY: black letters on the left two thirds, a green arrow to the right (the lane is on the driver's right)
    cell(SIGN_CELL.pitEntry, (x, y) => {
      text(SIGN_TEXTS.pitEntry, x + cw * 0.36, y + ch / 2, ch * 0.34, '#1d1f22')
      ctx.fillStyle = '#1f9a4a'
      ctx.beginPath()
      ctx.moveTo(x + cw * 0.72, y + ch * 0.38)
      ctx.lineTo(x + cw * 0.84, y + ch * 0.38)
      ctx.lineTo(x + cw * 0.84, y + ch * 0.22)
      ctx.lineTo(x + cw * 0.96, y + ch * 0.5)
      ctx.lineTo(x + cw * 0.84, y + ch * 0.78)
      ctx.lineTo(x + cw * 0.84, y + ch * 0.62)
      ctx.lineTo(x + cw * 0.72, y + ch * 0.62)
      ctx.closePath()
      ctx.fill()
    })
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** BoxGeometry face index the sign's graphic goes on (groups +x, −x, +y, −y, +z, −z; local +X = +lateral, +Z = +s). */
export const FACING_FACE: Record<SignDef['facing'], number> = { '+lat': 0, '-lat': 1, '+s': 4, '-s': 5 }

/** the atlas cell of a board sign's kind (the pit-exit light has no board) */
export function signCellOf(sign: SignDef): number {
  return sign.kind === 'fireStation' ? SIGN_CELL.fireStation : sign.kind === 'pitExit' ? SIGN_CELL.pitExit : sign.kind === 'speed60' ? SIGN_CELL.speed60 : sign.kind === 'pitEntry' ? SIGN_CELL.pitEntry : sign.id === 'drs-detection' ? SIGN_CELL.drsDetection : SIGN_CELL.drsZone
}

/**
 * Remap a BoxGeometry's uv so face `face` shows atlas cell `cell` and every other face the blank
 * cell. `aspect` = the board's width / height: the cells are 2 : 1, so a square board (the 60
 * ring) reads the middle half of its cell and the ring stays round. Shared with pit-lane.ts,
 * which draws the SIGNS rows mounted on the pit wall's top (`pitWallTop`) from the same atlas.
 */
export function signUv(face: number, cell: number, aspect = 2): (uv: THREE.BufferAttribute) => void {
  // the fraction of the cell a board of this aspect shows, centred: a narrower board reads the
  // middle of the cell's width, a wider one the middle of its height (never under 60 %: the
  // letters are drawn at half the cell's height, so the crop keeps them whole)
  const span = Math.max(0.1, Math.min(1, aspect / 2))
  const vSpan = Math.max(0.6, Math.min(1, 2 / aspect))
  const uLo = (1 - span) / 2, vLo = (1 - vSpan) / 2
  const rect = (i: number) => {
    const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS)
    // canvas rows run top-down; the texture's v runs bottom-up
    return { u0: col / ATLAS_COLS, u1: (col + 1) / ATLAS_COLS, v0: 1 - (row + 1) / ATLAS_ROWS, v1: 1 - row / ATLAS_ROWS }
  }
  return (uv) => {
    for (let f = 0; f < 6; f++) {
      const r = rect(f === face ? cell : SIGN_CELL.blank)
      for (let i = f * 4; i < f * 4 + 4; i++) {
        // inset 6 % so the bilinear filter never reads the neighbouring cell
        const u = uLo + span * (0.06 + uv.getX(i) * 0.88), v = vLo + vSpan * (0.06 + uv.getY(i) * 0.88)
        uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0))
      }
    }
    uv.needsUpdate = true
  }
}

// ---------------------------------------------------------------- geometry helpers

/** Square-section tube along the track whose lateral and height are functions of s (a railing following a wall top). */
function railTube(track: Track, s0: number, s1: number, lat: Fn, y: Fn, r: number, step = 2): THREE.BufferGeometry {
  const edges: [Fn, Fn][] = [
    [(s) => lat(s) - r, (s) => y(s) - r],
    [(s) => lat(s) - r, (s) => y(s) + r],
    [(s) => lat(s) + r, (s) => y(s) + r],
    [(s) => lat(s) + r, (s) => y(s) - r],
    [(s) => lat(s) - r, (s) => y(s) - r],
  ]
  return profileRibbonGeometry(track, s0, s1, edges, step, 4)
}

/** A merged mesh of `geos` (disposed), named and added to `into`; null when there is nothing. */
function merged(into: THREE.Object3D, geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean): THREE.Mesh | null {
  if (!geos.length) return null
  const mixed = geos.some((g) => !g.getIndex())
  const list = mixed ? geos.map((g) => (g.getIndex() ? g.toNonIndexed() : g)) : geos
  const g = mergeGeometries(list, false)
  for (const x of geos) x.dispose()
  if (mixed) for (const x of list) x.dispose()
  if (!g) return null
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = name
  mesh.castShadow = cast
  mesh.receiveShadow = true
  into.add(mesh)
  return mesh
}

// ---------------------------------------------------------------- the builder

export function buildStructures(ctx: EnvBuildContext, _mats: { buildingRoofMat: THREE.MeshStandardMaterial }): Structures {
  const { track, ground, group, boxes, assets: reg, farField } = ctx

  // --- materials (all created here, before the viewport's setupMaterials) ---------------------
  const concreteTile = tileMetres(reg, 'tex/concrete046/diff', 2.4)
  const slabMat = reg
    ? pbrFromAssets(reg, 'concrete046', { fallback: () => pbr(concreteMaps(), { roughness: 0.95, side: THREE.DoubleSide }, 0.6), handBuiltUv: true, normalScale: 0.6, extra: { side: THREE.DoubleSide } })
    : pbr(concreteMaps(), { roughness: 0.95, side: THREE.DoubleSide }, 0.6)
  // the abutments and wing walls: weathered precast, 4 m × 1.33 m per tile (the manifest's
  // aspect), tinted darker so it reads as the shaded masonry of the crossing photo
  const wallTileU = tileMetres(reg, 'tex/preconcrete_wall_001_long/diff', 4)
  const wallTileV = wallTileU / assetAspect(reg, 'tex/preconcrete_wall_001_long/diff', 3)
  const wallFallback = () => {
    const maps = concreteMaps()
    const m = pbr({ map: maps.map.clone(), normalMap: maps.normalMap?.clone(), roughnessMap: maps.roughnessMap?.clone() }, { roughness: 0.95, side: THREE.DoubleSide, color: 0x9a9894 }, 0.6)
    // the wall's uv is metres over (tileU, tileV): square the procedural tile back up
    for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.repeat.set(1, wallTileV / wallTileU)
    return m
  }
  const wallMat = reg
    ? pbrFromAssets(reg, 'preconcrete_wall_001_long', { fallback: wallFallback, handBuiltUv: true, normalScale: 0.8, extra: { side: THREE.DoubleSide, color: 0x9a9894 } })
    : wallFallback()
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTextTexture('SUZUKA CIRCUIT'), roughness: 0.5 })
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide })
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.7 })
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.6, metalness: 0.6 })
  const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.5 })
  const bridgeRailMat = new THREE.MeshStandardMaterial({ map: bridgeRailTexture(), roughness: 0.5, metalness: 0.3 })
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x0b2d18, emissive: EMISSIVE.pitExitLight.color, emissiveIntensity: EMISSIVE.pitExitLight.intensity * emissiveScale(), roughness: 0.3 })

  const bridge = new THREE.Group()
  bridge.name = 'structures-bridge'
  group.add(bridge)
  /** the bridge's small furniture: a near level of the far-field entry 'structure-crossover' */
  const furniture = new THREE.Group()
  furniture.name = 'structures-bridge-furniture'

  buildCrossover(track, ground, boxes, bridge, furniture, { slabMat, wallMat, fasciaMat, steelMat, whiteMat, postMat, bridgeRailMat, concreteTile, wallTileU, wallTileV })
  const rails = new THREE.Group()
  rails.name = 'structures-underpass'
  group.add(rails)
  buildUnderpasses(track, ground, boxes, rails, { steelMat, slabMat, concreteTile })
  buildSigns(track, ground, boxes, { signMat, postMat, steelMat, lensMat })

  // the furniture is worth drawing only near the crossing: a near level, then nothing
  farField.register({
    kind: 'structure',
    name: 'structure-crossover',
    levels: [{ object: furniture, range: 900 }, { object: new THREE.Group(), range: Infinity }],
  })

  return { update() {} }
}

// ---------------------------------------------------------------- the crossover bridge

interface BridgeMats {
  slabMat: THREE.Material
  wallMat: THREE.Material
  fasciaMat: THREE.Material
  steelMat: THREE.Material
  whiteMat: THREE.Material
  postMat: THREE.Material
  bridgeRailMat: THREE.Material
  concreteTile: number
  wallTileU: number
  wallTileV: number
}

function buildCrossover(track: Track, ground: Ground, boxes: BoxPlacer, into: THREE.Group, furniture: THREE.Group, m: BridgeMats) {
  const cross = track.crossing
  const L = track.length
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const sOver = cross.sOver, sUnder = cross.sUnder
  const s0 = sOver - SPAN, s1 = sOver + SPAN
  const edge = (side: 1 | -1): Fn => (s) => side * (hwAt(s) + DECK_SHOULDER)

  // --- the deck: slab under the road, fascia boards, the dark edge strip, four plate girders ----
  const slabW = 2 * (hwAt(sOver) + DECK_SHOULDER)
  const slab = merged(into, [ribbonGeometry(track, s0, s1, edge(1), edge(-1), K(SOFFIT), K(SOFFIT), 3, m.concreteTile, slabW / m.concreteTile)], m.slabMat, 'structures-bridge-slab', true)
  if (slab) slab.receiveShadow = true
  merged(into, [texturedWall(track, s0, s1, edge(1)(sOver), FASCIA_BOTTOM, FASCIA_TOP, 2 * SPAN, 1, 2), texturedWall(track, s0, s1, edge(-1)(sOver), FASCIA_BOTTOM, FASCIA_TOP, 2 * SPAN, -1, 2)], m.fasciaMat, 'structures-bridge-fascia', false)
  // the low guard beam along both parapets (mlc.jpg): 4 m boxes of the white / blue beam on
  // short posts, BRIDGE_RAIL.gap in front of the parapet wall's face, over the run of the
  // BARRIERS parapet rows (on the road plane like the deck itself)
  for (const id of ['bridge-parapet-left', 'bridge-parapet-right'] as const) {
    const run = barrierRun(id)
    const { lat } = barrierProfile(track, ground, run)
    const [pa, pb] = run.sRange
    const plen = forwardDelta(pa, pb, L)
    const latRail: Fn = (s) => lat(s) - run.side * (BRIDGE_RAIL.gap + BRIDGE_RAIL.t / 2)
    for (let d = 0; d < plen; d += BRIDGE_RAIL.seg) {
      const seg = Math.min(BRIDGE_RAIL.seg, plen - d)
      const s = pa + d + seg / 2
      boxes.place(s, latRail(s), seg, BRIDGE_RAIL.t, BRIDGE_RAIL.h, m.bridgeRailMat, BRIDGE_RAIL.bottom, false, false)
      boxes.place(pa + d + 0.1, latRail(pa + d + 0.1), 0.08, 0.08, BRIDGE_RAIL.bottom, m.postMat, 0, false, false)
    }
  }
  const steel: THREE.BufferGeometry[] = []
  for (const side of [1, -1] as const) steel.push(wallGeometry(track, s0, s1, edge(side), K(SOFFIT), K(FASCIA_BOTTOM), 2, 4))
  // girders: 1.0 m plates from the soffit down; BoxPlacer adds height / 2, hence GIRDER_Y = −2.3
  const hwO = hwAt(sOver)
  for (let i = 0; i < 4; i++) boxes.place(sOver, ((i - 1.5) * 2 * hwO) / 4, 2 * SPAN, 0.35, GIRDER_H, m.steelMat, GIRDER_Y, true, true)

  // --- abutments and wing walls, in the upper road's frame ------------------------------------
  // Along the deck-shoulder line from −DECK_REACH to +DECK_REACH: a wall from the road level
  // (from the soffit inside the span, where the fascia covers the rest) down to the ground, except
  // where the line stands inside the lower road's ±ABUTMENT_LAT corridor — that is the opening.
  const walls: THREE.BufferGeometry[] = []
  // the ground is read 0.35 m OUTSIDE the shoulder line: on the line itself the drawn ground is
  // the deck shoulder (road level), beyond it the lower road's raster / the terrain the wall
  // must reach down to
  const bottom = (side: 1 | -1, lat: Fn): Fn => (s) => Math.min(-0.05, ground.standAt(s, lat(s) + side * 0.35) - 0.4)
  const top: Fn = (s) => (Math.abs(s - sOver) <= SPAN ? SOFFIT : 0)
  for (const side of [1, -1] as const) {
    const lat = edge(side)
    const open = (s: number): boolean => {
      if (Math.abs(s - sOver) > SPAN + 1) return false
      track.pointAt(s, lat(s), _p, 0)
      const q = track.nearestOnRange(_p.x, _p.z, sUnder - 60, sUnder + 60, 20)
      return Math.abs(q.lateral) < ABUTMENT_LAT
    }
    let runStart: number | null = null
    for (let s = sOver - DECK_REACH; s <= sOver + DECK_REACH + 0.5; s += 1) {
      const closed = s <= sOver + DECK_REACH && !open(s)
      if (closed && runStart === null) runStart = s
      if (!closed && runStart !== null) {
        // the span's top steps from 0 to the soffit at ±SPAN: split there so the step is vertical
        for (const [a, b] of splitAt(runStart, s - 1, [sOver - SPAN, sOver + SPAN])) {
          if (b - a < 0.5) continue
          walls.push(wallGeometry(track, a, b, lat, bottom(side, lat), top, 2, m.wallTileU, m.wallTileV))
        }
        runStart = null
      }
    }
  }
  merged(into, walls, m.wallMat, 'structures-bridge-abutments', true)

  // --- the service road under the bridge (its asphalt is the GROUND_AREAS band row) -----------
  // white kerbs on both edges, a low wire fence on the outer verge, one curved-arm lamp
  const [sa, sb] = SERVICE_ROAD.s
  const [latIn, latOut] = SERVICE_ROAD.lat
  const len = forwardDelta(sa, sb, L)
  for (const lat of [latIn - 0.075, latOut + 0.075]) {
    for (let d = 0; d < len; d += 4) boxes.place(sa + d + Math.min(2, (len - d) / 2), lat, Math.min(4, len - d), 0.15, 0.15, m.whiteMat, 0, false, false)
  }
  const fenceLat = latOut + 0.45
  const abutment = barrierRun('crossover-abutment-left')
  for (const [fa, fb] of [[sa, abutment.sRange[0] - 1], [abutment.sRange[1] + 1, sb]] as const) {
    const y: Fn = (s) => ground.standAt(s, fenceLat)
    for (let d = 0; d <= fb - fa; d += 2.5) boxes.place(fa + d, fenceLat, 0.05, 0.05, 1.0, m.steelMat, 0, false, false)
    steel.push(railTube(track, fa, fb, K(fenceLat), (s) => y(s) + 0.98, 0.012), railTube(track, fa, fb, K(fenceLat), (s) => y(s) + 0.55, 0.012))
  }
  // the lamp: an 8 m tapered pole on the outer verge, a curved arm reaching over the road
  {
    const s = abutment.sRange[0] - 6
    const lat = fenceLat + 0.6
    const base = ground.standAt(s, lat)
    const pole = new THREE.CylinderGeometry(0.07, 0.11, 8, 6)
    pole.translate(0, 4, 0)
    const arm = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 8, 0), new THREE.Vector3(-0.6, 9.2, 0), new THREE.Vector3(-2.6, 9.0, 0)), 4, 0.045, 4, false)
    const head = new THREE.BoxGeometry(0.28, 0.14, 0.7)
    head.translate(-2.75, 8.95, 0)
    const frame = new THREE.Matrix4()
    const h = track.headingAt(s)
    track.pointAt(s, lat, _p, base)
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    frame.copy(_m).setPosition(_p)
    for (const g of [pole, arm, head]) steel.push(g.applyMatrix4(frame))
  }
  merged(furniture, steel, m.steelMat, 'structures-bridge-steel', true)
  into.add(furniture)
}

/** Split [a, b] at the given cuts (those strictly inside it), in order. */
function splitAt(a: number, b: number, cuts: number[]): [number, number][] {
  const out: [number, number][] = []
  let from = a
  for (const c of [...cuts].sort((x, y) => x - y)) {
    if (c > from + 1e-6 && c < b - 1e-6) {
      out.push([from, c])
      from = c
    }
  }
  out.push([from, b])
  return out
}

// ---------------------------------------------------------------- underpass parapets and the chicane service bridge

interface UnderpassMats {
  steelMat: THREE.Material
  slabMat: THREE.Material
  concreteTile: number
}

/**
 * What is drawn of the UNDERPASSES today: a railing along the top of the parapet the county road
 * passes under at Dunlop and at the chicane, and the chicane service bridge's slab on the ground.
 * THE CUTTINGS ARE NOT DUG (plan §9 P8): the road bed under the lap stays at the field's height
 * until ground-field.ts can follow a declared cut (R6), so the railings stand on the existing
 * walls and the bridge lies on the grass it will one day span.
 */
function buildUnderpasses(track: Track, ground: Ground, boxes: BoxPlacer, into: THREE.Group, m: UnderpassMats) {
  const rails: THREE.BufferGeometry[] = []
  // railing on the top of the tabled BARRIERS run over the tunnel (UNDERPASSES.parapet): posts
  // every 2 m, a top rail and a mid rail
  for (const u of UNDERPASSES) {
    if (!u.parapet) continue
    const [s0, s1] = u.parapet.sRange
    const { lat, top } = barrierProfile(track, ground, barrierRun(u.parapet.run))
    for (let s = s0; s <= s1; s += 2) boxes.place(s, lat(s), 0.05, 0.05, PARAPET_RAIL_H, m.steelMat, top(s), true, false)
    rails.push(railTube(track, s0, s1, lat, (s) => top(s) + PARAPET_RAIL_H, 0.02), railTube(track, s0, s1, lat, (s) => top(s) + PARAPET_RAIL_H * 0.55, 0.015))
  }
  merged(into, rails, m.steelMat, 'structures-underpass-rails', false)

  // the chicane service bridge (OSM 467219905): a 6 m × 0.6 m slab, 4 m wide, two rail tubes
  const row = UNDERPASSES.find((u) => u.osmWay === 467219905)
  const way = row ? osmWay(row.osmWay) : undefined
  if (way && way.en.length >= 2) {
    const a = track.enToWorld(way.en[0]![0], way.en[0]![1], new THREE.Vector3())
    const b = track.enToWorld(way.en[way.en.length - 1]![0], way.en[way.en.length - 1]![1], new THREE.Vector3())
    const dir = b.clone().sub(a).setY(0).normalize()
    const c = a.clone().add(b).multiplyScalar(0.5)
    c.y = ground.standY(c.x, c.z)
    const frame = new THREE.Matrix4().makeBasis(dir, new THREE.Vector3(0, 1, 0), new THREE.Vector3(-dir.z, 0, dir.x)).setPosition(c)
    const slab = new THREE.BoxGeometry(6, 0.6, 4)
    slab.translate(0, 0.3, 0)
    const uv = slab.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 6) / m.concreteTile, (uv.getY(i) * 4) / m.concreteTile)
    merged(into, [slab.applyMatrix4(frame)], m.slabMat, 'structures-underpass-bridge', true)
    const parts: THREE.BufferGeometry[] = []
    for (const z of [-1.9, 1.9]) {
      for (const y of [0.6 + PARAPET_RAIL_H, 0.6 + PARAPET_RAIL_H * 0.55]) {
        const r = new THREE.BoxGeometry(6, 0.04, 0.04)
        r.translate(0, y, z)
        parts.push(r)
      }
      for (const x of [-2.8, 0, 2.8]) {
        const p = new THREE.BoxGeometry(0.05, PARAPET_RAIL_H, 0.05)
        p.translate(x, 0.6 + PARAPET_RAIL_H / 2, z)
        parts.push(p)
      }
    }
    merged(into, parts.map((g) => g.applyMatrix4(frame)), m.steelMat, 'structures-underpass-bridge-rails', false)
  }
}

// ---------------------------------------------------------------- signs

interface SignMats {
  signMat: THREE.Material
  postMat: THREE.Material
  steelMat: THREE.Material
  lensMat: THREE.Material
}

/** a `barrierTop` sign's two posts rise this far over the wall's top before the board (m) */
const BARRIER_SIGN_POST = 0.5

/**
 * The SIGNS table: boards on posts through the shared box placer, one atlas; the pit-exit
 * signal head. A `barrierTop` row (I4-c) stands on the resolved line of its BARRIERS `run`, its
 * posts BARRIER_SIGN_POST over the wall's top (the row's lateral is nominal there).
 */
function buildSigns(track: Track, ground: Ground, boxes: BoxPlacer, m: SignMats) {
  for (const sign of SIGNS) {
    // mounted rows are drawn by the wall's builder: pitWallBoard is a cell of the pit wall's
    // boards and pitWallTop a board on the wall's white block (both pit-lane.ts)
    if (sign.mount === 'pitWallBoard' || sign.mount === 'pitWallTop') continue
    if (sign.mount === 'barrierTop') {
      const run = barrierRun(sign.run ?? '')
      const prof = barrierProfile(track, ground, run)
      // 8 cm on the track side of the line: the board hangs in front of the run's fence mesh, not through it
      const lat = prof.lat(sign.s) - run.side * 0.08
      // the wall's top over the drawn ground the placer stands on (barrierProfile caps the base at MAX_RISE)
      const overGround = prof.top(sign.s) - ground.standAt(sign.s, lat)
      const cell = signCellOf(sign)
      const across = sign.facing === '+s' || sign.facing === '-s'
      const bottom = overGround + sign.height + BARRIER_SIGN_POST
      boxes.place(sign.s, lat, across ? 0.06 : sign.width, across ? sign.width : 0.06, sign.boardHeight, m.signMat, bottom, false, true, signUv(FACING_FACE[sign.facing], cell))
      for (const o of [-sign.width * 0.4, sign.width * 0.4]) boxes.place(sign.s + (across ? 0 : o), lat + (across ? o : 0), 0.06, 0.06, sign.height + BARRIER_SIGN_POST + sign.boardHeight * 0.3, m.postMat, overGround, false, false)
      continue
    }
    const lat = sign.lateral === 'cameraSide' ? cameraSide(track, sign.s) * (track.halfWidthAt(sign.s) + 3.2) : sign.lateral
    if (sign.kind === 'pitExitLight') {
      // a pole, a dark three-lens head, the green lens on the face towards the lane's traffic
      boxes.place(sign.s, lat, 0.1, 0.1, sign.height, m.steelMat, 0, false, false)
      boxes.place(sign.s, lat, 0.3, sign.width, sign.boardHeight, m.steelMat, sign.height, false, false)
      const dz = sign.facing === '-s' ? -0.17 : sign.facing === '+s' ? 0.17 : 0
      const dl = sign.facing === '+lat' ? 0.17 : sign.facing === '-lat' ? -0.17 : 0
      boxes.place(sign.s + dz, lat + dl, 0.05, 0.22, 0.22, m.lensMat, sign.height + sign.boardHeight * 0.62, false, false)
      continue
    }
    const cell = signCellOf(sign)
    const across = sign.facing === '+s' || sign.facing === '-s'
    // the board: its long side across the track for a ±s facing, along it otherwise
    boxes.place(sign.s, lat, across ? 0.06 : sign.width, across ? sign.width : 0.06, sign.boardHeight, m.signMat, sign.height, false, true, signUv(FACING_FACE[sign.facing], cell))
    // posts: one under a small board, two under a wide one, up into the board's lower third
    const offsets = sign.width > 1.5 ? [-sign.width * 0.4, sign.width * 0.4] : [0]
    for (const o of offsets) boxes.place(sign.s + (across ? 0 : o), lat + (across ? o : 0), 0.06, 0.06, sign.height + sign.boardHeight * 0.3, m.postMat, 0, false, false)
  }
}
