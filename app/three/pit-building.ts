import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { COLOURS, GARAGE_ORDER, PIT_BLOCK, PIT_BOX, PIT_BOX_STRIP, PIT_BUILDING, PIT_CORES, PIT_GARAGE_COUNT, SCREENS, garageS } from '~/data/suzuka-facilities-spec'
import { OSM_PIT_BUILDING } from '~/data/suzuka-facilities'
import { forwardDelta, signedDelta } from '~/sim/track'
import { EMISSIVE, emissiveScale } from './emissive'
import type { EnvBuildContext } from './environment'
import { bucketedInstancedMeshes } from './instancing'
import { pbrFromAssets, tileMetres } from './materials'
import {
  addMerged, canvas, clipD, frameAt, label, PIT_TEXTS, pitMaterials, podBand, podFlank, podLoft, remapV, sectionPlate, smoothProfile, sweep, tex, texturedWall, trackCoords, trackPrism, tube, type PodLoftParams, type Pt,
} from './pit-geometry'

/**
 * The pit building v2 (plan I1-b), built from the Mobilityland 2009 pit / paddock dossier
 * (`PIT_BUILDING.v2`: pp4s2-4 section, pphi-3 / pphi-4 elevations, pp4t-4 plan, p5spec pit
 * spec, pitph-12 terraces, ct-13 control tower) on the OSM footprint (way 184422099):
 *
 * - the body is SWEPT IN TRACK COORDINATES (s along the lap, lateral across) so its floors,
 *   terraces and canopy follow the 2.8 % fall of the pit straight the way the real apron does
 *   (the DEM shows the building is laterally level but drops 9.7 m end to end). Section, front
 *   to back: the 2 m fascia beam on the drip line (−25.1, y 2.85 → 5.05) with the downlit
 *   soffit behind it (4.6), the 0.35 m shutter wall (−28.3) with 4.2 × 3.0 openings between the
 *   piers, the 23.3 m garage (floor 0.025, ceiling 4.6), the 2F terrace (5.05, three stepped
 *   rows behind the drip-line glass rail, the lounge glass on −28.6), the 3F terrace (five rows
 *   from 8.15 behind the −28.0 parapet up to the 9.85 deck) under the curved canopy (13.4 at the
 *   back wall −52 → 15.3 at the front lip −22.0, round columns every pit on −28.0);
 * - along s: the control pod 5554.5 → 5590 (silver aluminium `podLoft`, its glass band as a
 *   `podBand` ring, a dark-blue sign band under it, the dark-glass race-control corner and the
 *   portholes) on the OSM cap prism of the 1F (the medical centre), the media section 5590 →
 *   5625 (a straight 2F / 3F glass body, no terraces), block 12 with the flat podium terrace,
 *   the eleven team blocks with their stepped terraces, the 88 → 92 paddock-information box and
 *   the T1 nose 92 → 103.3 (the same loft mirrored, top 11); seven stair towers on the paddock
 *   side; the garage row's piers, folded glass door leaves (team blocks), ribbed shutters
 *   (block 12 and the 49–55 caps), odd number plates, the podium bay's concrete backdrop;
 * - the seven screens (three on the canopy, one facing the paddock, four trackside on posts —
 *   SCREENS.mount).
 *
 * Everything static and single-material is merged; repeated pieces (terrace seats, rail posts,
 * 3F columns, door leaves) are instanced per 60 m bay so the follow cameras can cull them.
 * Shadow policy: shell / canopy / caps / pods / towers cast + receive; seats, railings, columns,
 * leaves, plates, screens and glass receive only. The pit wall, the Leader Tower and the
 * perches are pit-lane.ts, the paddock behind is paddock.ts; the materials the three share come
 * from `pitMaterials(ctx)`. The garage interiors (mesh side walls, the wash, the equipment), the
 * rear elevation (rear canopy, window bands, spur, roof plant) and the terrace guests are
 * commit 3 of I1-b; until then the 1F paddock face keeps the v1 textured wall and the garages
 * their v1 placeholder props.
 *
 * Chase-lens contract (PIT_ENVELOPE.chaseLens, asserted by scripts/audit/pit-smoke.mjs from the
 * built meshes): in front of every block nothing of the building stands inside
 * s ∈ [boxS − 13, boxS − 3] × lateral stop ± 1.5 below the 2F soffit — the fascia (−25.1), the
 * rail (−25.1), the columns (−28.0) and the piers (−28.3) all lie outside that column.
 *
 * Returns the roof material because the marshal huts (props.ts) and the paddock reuse it for
 * their roofs, which keeps them in the same merged mesh.
 */

// ---------------------------------------------------------------- section constants (metres, v2)

const V2 = PIT_BUILDING.v2
const DRIP = PIT_BUILDING.front // −25.1: the 2F terrace drip line = fascia face = OSM outline
const BACK = PIT_BUILDING.back // −56.7: the 1F paddock face
const SHUTTER = V2.shutter // −28.3: the door plane
const GARAGE_BACK = V2.garageBack // −51.6
const F2 = V2.floors[1] // 5.05
const F3 = V2.floors[2] // 9.85
const CEIL = V2.garage.ceiling // 4.6
const DOOR_H = V2.garage.door.h // 3.0
const DOOR_W = V2.garage.door.w // 4.2
const PIER = V2.garage.pier // 0.55
const BLOCK_PIER = V2.garage.blockPier // 1.0
const [FASCIA_LO, FASCIA_HI] = V2.garage.fascia // 2.85 → 5.05
/** the fascia is the vertical face of a 0.4 m deep edge beam; the soffit behind it is the door-head level 4.6 */
const BEAM_DEPTH = 0.4
/** the shutter-line wall: piers and header between the door plane and its lane face */
const WALL_T = 0.35
const PIER_FACE = SHUTTER + WALL_T // −27.95
const T2 = V2.terrace2F
const T3 = V2.terrace3F
const LOUNGE = T2.lounge // −28.6
const STEP_TOP = F2 + T2.rows * T2.riser // 5.95: the landing in front of the lounge glass
/** the 3F slab is 0.4 thick: the lounge ceiling / 3F soffit */
const SOFFIT3 = T3.frontRow.y - 0.4 // 7.75
const PARAPET_TOP = T3.frontRow.y + T3.parapet.h // 9.25
const PARAPET_T = T3.frontRow.lateral - T3.parapet.lateral // 0.3
const ROW3_RISER = (T3.deck.y - T3.frontRow.y) / T3.rows // 0.34
const ROW3_TREAD = (T3.frontRow.lateral - T3.deck.lateral) / T3.rows // 0.85
const REAR_WALL = V2.canopy.profile[0]![0] // −52: the 2F / 3F paddock wall
const REAR_WALL_T = 0.3
const CANOPY_T = V2.canopy.thickness // 0.4
const CANOPY_LIP = V2.canopy.lip // 0.3
/** the smoothed canopy profile, back → front, top surface */
const CANOPY: Pt[] = smoothProfile(V2.canopy.profile, 6)
const CANOPY_FRONT = CANOPY[CANOPY.length - 1]![0] // −22.0
const RAIL_H = T2.rail.h // 1.2
const COLUMN_R = T3.columns.d / 2
/** the round columns stand inside the parapet line so their outer face is flush with −28.0 */
const COLUMN_LAT = T3.parapet.lateral - COLUMN_R
const STAIR = V2.stairTowers
const POD = V2.controlPod
const MEDIA = V2.mediaSection
const T1 = V2.t1Nose

/** Top of the canopy at a lateral (m above the road plane) — the screens' frames and the paddock's flag poles stand on it. */
export function canopyTopAt(lat: number): number {
  const pts = CANOPY
  if (lat <= pts[0]![0]) return pts[0]![1]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!
    if (lat <= x1) return y0 + ((lat - x0) / (x1 - x0)) * (y1 - y0)
  }
  return pts[pts.length - 1]![1]
}

// ---------------------------------------------------------------- canvas textures

/**
 * Fascia band, one 19 m block per repeat, three atlas rows (v): 0 = block variant A, 1 = block
 * variant B (two framed panels each, descriptive words only), 2 = the plain white cladding of
 * the 7 m cores and the media section. Panel seams every pit (4.75 m).
 */
function fasciaTexture(k: number): THREE.Texture {
  const w = 2048, h = 384
  const rowH = h / 3
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#f4f4f1'
  ctx.fillRect(0, 0, w, h)
  const seams = (y: number) => {
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    for (let i = 0; i < 4; i++) ctx.fillRect(i * (w / 4), y, 2, rowH)
    ctx.fillStyle = 'rgba(0,0,0,0.20)'
    ctx.fillRect(0, y + rowH - 4, w, 4)
    ctx.fillStyle = 'rgba(0,0,0,0.08)'
    ctx.fillRect(0, y, w, 3)
  }
  const frame = (x: number, y: number, fw: number, fh: number, fill: string | null, text: string, color: string) => {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(x, y, fw, fh)
    ctx.fillStyle = fill ?? '#fbfbf9'
    ctx.fillRect(x + 4, y + 4, fw - 8, fh - 8)
    label(ctx, text, x + fw / 2, y + fh / 2, 58, color, 900, 'center', fw - 60)
  }
  for (let row = 0; row < 2; row++) {
    const y = row * rowH
    seams(y)
    const fw = w * 0.34, fh = rowH - 40
    const [ta, tb] = row === 0 ? [PIT_TEXTS[0]!, PIT_TEXTS[1]!] : [PIT_TEXTS[4]!, PIT_TEXTS[3]!]
    frame(w * 0.08, y + 20, fw, fh, null, ta, '#1d1f22')
    frame(w * 0.58, y + 20, fw, fh, row === 0 ? COLOURS.circuitRed.lit : '#1d5bb5', tb, '#ffffff')
  }
  seams(2 * rowH)
  return tex(c)
}

/**
 * Atlas: number plates 1–55 in 8 × 7 cells (black, white digits — pitbox.jpg), cell 56 the
 * 'PODIUM' plate, the last row a white personnel door (cell 57) for the podium entrance.
 * Plate n at column (n−1) % 8, row (n−1) / 8 from the top.
 */
const ATLAS_COLS = 8, ATLAS_ROWS = 8
function doorAtlas(k: number): THREE.Texture {
  const w = 1024, h = 1024
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#e9ebe9'
  ctx.fillRect(0, 0, w, h)
  const cw = w / ATLAS_COLS, ch = h / ATLAS_ROWS
  const cell = (n: number) => ({ x: ((n - 1) % ATLAS_COLS) * cw, y: Math.floor((n - 1) / ATLAS_COLS) * ch })
  for (let n = 1; n <= 55; n++) {
    const { x, y } = cell(n)
    ctx.fillStyle = '#141414'
    ctx.fillRect(x + 6, y + 6, cw - 12, ch - 12)
    label(ctx, String(n), x + cw / 2, y + ch / 2, 74, '#ffffff', 700)
  }
  {
    const { x, y } = cell(56)
    ctx.fillStyle = '#141414'
    ctx.fillRect(x + 6, y + 6, cw - 12, ch - 12)
    label(ctx, PIT_TEXTS[9]!, x + cw / 2, y + ch / 2, 30, '#ffffff', 700, 'center', cw - 20)
  }
  {
    // the personnel door: a pale door leaf in a dark frame with a handle
    const { x, y } = cell(57)
    ctx.fillStyle = '#4a5058'
    ctx.fillRect(x, y, cw, ch)
    ctx.fillStyle = '#eceeec'
    ctx.fillRect(x + 8, y + 8, cw - 16, ch - 8)
    ctx.fillStyle = '#7a7d80'
    ctx.fillRect(x + cw - 30, y + ch / 2 - 3, 14, 6)
  }
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** uv of a plate quad into atlas cell `n` (quad uv 0..1 → the cell) */
function atlasUv(geo: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const col = (n - 1) % ATLAS_COLS, row = Math.floor((n - 1) / ATLAS_COLS)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / ATLAS_COLS, 1 - (row + 1 - uv.getY(i)) / ATLAS_ROWS)
  return geo
}

/** Procedural ribbed roller shutter (the fallback for painted_metal_shutter): a 2 m tile, 0.1 m horizontal ribs. */
function shutterTexture(k: number): THREE.Texture {
  const w = 512, h = 512
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#d5d7d6'
  ctx.fillRect(0, 0, w, h)
  const rib = h / 20
  for (let i = 0; i < 20; i++) {
    const y = i * rib
    ctx.fillStyle = 'rgba(255,255,255,0.28)'
    ctx.fillRect(0, y, w, rib * 0.3)
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(0, y + rib * 0.72, w, rib * 0.28)
  }
  return tex(c)
}

/** Procedural garage floor (the fallback for concrete_floor_03): a cool grey with faint aggregate noise, 2.5 m tile. */
function garageFloorTexture(k: number): THREE.Texture {
  const w = 256, h = 256
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#8f9296'
  ctx.fillRect(0, 0, w, h)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 1400; i++) {
    const v = rnd()
    ctx.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)'
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3)
  }
  return tex(c)
}

/** The terrace soffit: white panels with one recessed downlight per 2.8 m tile (map) and the lit disc alone (emissiveMap). */
function soffitTextures(k: number): { map: THREE.Texture; emissive: THREE.Texture } {
  const w = 256, h = 256
  const a = canvas(w, h, k)
  a.ctx.fillStyle = '#f2f3f1'
  a.ctx.fillRect(0, 0, w, h)
  a.ctx.fillStyle = 'rgba(0,0,0,0.10)'
  a.ctx.fillRect(0, 0, w, 2)
  a.ctx.fillRect(0, 0, 2, h)
  a.ctx.fillStyle = '#5a5e63'
  a.ctx.beginPath()
  a.ctx.arc(w / 2, h / 2, 16, 0, Math.PI * 2)
  a.ctx.fill()
  a.ctx.fillStyle = '#fff6e6'
  a.ctx.beginPath()
  a.ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2)
  a.ctx.fill()
  const e = canvas(w, h, k)
  e.ctx.fillStyle = '#000000'
  e.ctx.fillRect(0, 0, w, h)
  e.ctx.fillStyle = '#fff2dd'
  e.ctx.beginPath()
  e.ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2)
  e.ctx.fill()
  return { map: tex(a.c), emissive: tex(e.c) }
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

/** The 1F paddock face (v1, until commit 3 draws the rear shutters and canopy): white cladding, a service door, one 19 m bay per repeat. */
function rearTexture(k: number): THREE.Texture {
  const w = 512, h = 128
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#e8eae8'
  ctx.fillRect(0, 0, w, h)
  const yOf = (m: number) => h - (m / F2) * h
  ctx.fillStyle = 'rgba(0,0,0,0.14)'
  ctx.fillRect(0, yOf(4.6), w, 3)
  ctx.fillStyle = '#9ea3a7'
  ctx.fillRect(w * 0.55, yOf(3.6), w * 0.16, yOf(0) - yOf(3.6))
  ctx.fillStyle = '#4a5058'
  ctx.fillRect(w * 0.2, yOf(2.6), w * 0.06, yOf(1.0) - yOf(2.6))
  return tex(c)
}

// ---------------------------------------------------------------- the builder

export function buildPitBuilding(ctx: EnvBuildContext): { buildingRoofMat: THREE.MeshStandardMaterial } {
  const { track, ground, group, boxes, quality, assets: reg } = ctx
  const L = track.length
  const k = quality.textureScale
  const { plasterTile, shellMat, podMat, pierMat, buildingRoofMat, glassMat, darkMat, interiorMat, railMat, seatMat, lampMat, boardMat, concreteMat } = pitMaterials(ctx)
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTexture(k), roughness: 0.55 })
  const rearMat = new THREE.MeshStandardMaterial({ map: rearTexture(k), roughness: 0.7 })
  const doorMat = new THREE.MeshStandardMaterial({ map: doorAtlas(k), roughness: 0.6 })
  const soffit = soffitTextures(k)
  const soffitMat = new THREE.MeshStandardMaterial({ map: soffit.map, roughness: 0.7, emissive: 0xffffff, emissiveMap: soffit.emissive, emissiveIntensity: EMISSIVE.terraceDownlight.intensity * emissiveScale() })
  const soffitTile = 2.8
  // the garage floor (concrete_floor_03), the ceiling deck (corrugated steel, dark grey), the
  // shutters (painted_metal_shutter) and the pods' glass bands (facade001), each with its
  // procedural fallback so the Node / low-tier build has the same geometry
  const floorTile = tileMetres(reg, 'tex/concrete_floor_03/diff', 2.5)
  const floorMat = reg
    ? pbrFromAssets(reg, 'concrete_floor_03', { fallback: () => new THREE.MeshStandardMaterial({ map: garageFloorTexture(k), roughness: 0.35 }), handBuiltUv: true, normalScale: 0.6 })
    : new THREE.MeshStandardMaterial({ map: garageFloorTexture(k), roughness: 0.35 })
  const ceilTile = tileMetres(reg, 'tex/corrugatedsteel003/diff', 2)
  const ceilingMat = reg
    ? pbrFromAssets(reg, 'corrugatedsteel003', { fallback: () => new THREE.MeshStandardMaterial({ color: 0x4d5055, roughness: 0.7, metalness: 0.3 }), handBuiltUv: true, normalScale: 0.7, extra: { color: 0x4d5055 } })
    : new THREE.MeshStandardMaterial({ color: 0x4d5055, roughness: 0.7, metalness: 0.3 })
  const shutterTile = tileMetres(reg, 'tex/painted_metal_shutter/diff', 2)
  const shutterMat = reg
    ? pbrFromAssets(reg, 'painted_metal_shutter', { fallback: () => new THREE.MeshStandardMaterial({ map: shutterTexture(k), roughness: 0.55, metalness: 0.3 }), handBuiltUv: true, normalScale: 0.8 })
    : new THREE.MeshStandardMaterial({ map: shutterTexture(k), roughness: 0.55, metalness: 0.3 })
  const bandTile = tileMetres(reg, 'tex/facade001/diff', 2)
  const bandGlassMat = reg
    ? pbrFromAssets(reg, 'facade001', { fallback: () => glassMat, handBuiltUv: true, normalScale: 0.5, extra: { envMapIntensity: 1.3 } })
    : glassMat
  const darkGlassMat = new THREE.MeshStandardMaterial({ color: 0x2a3238, roughness: 0.15, metalness: 0.6, envMapIntensity: 1.2 })
  const signBandMat = new THREE.MeshStandardMaterial({ color: V2.podMat.signBand.color, roughness: 0.6 })
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)
  const m4 = () => new THREE.Matrix4()

  // --- extents along s ------------------------------------------------------------------------------
  const S0 = track.wrap(PIT_BOX_STRIP[0]) // 5625: block 12's final-corner edge
  const S1 = track.wrap(PIT_BOX_STRIP[1]) // 88: block 1's T1 edge
  const POD0 = track.wrap(POD.sRange[0]) // 5554.5
  const ROW0 = track.wrap(MEDIA.sRange[0]) // 5590: the 1F garage row and the 2F / 3F body start here
  const BLOCK12_END = track.wrap(S0 + PIT_BLOCK) // 5644: the podium terrace ends, the stepped terraces begin
  const LINK1 = track.wrap(T1.info.sRange[1]) // 92: the paddock-information box ends, the T1 nose begins
  const NOSE1 = track.wrap(T1.sRange[1]) // 103.3
  const cores = PIT_CORES.map(([a, b]) => [track.wrap(a), track.wrap(b)] as const)
  const blocks = GARAGE_ORDER.map((id) => TEAMS[id])
  /** the canopy underside at a lateral */
  const canopyUnder = (lat: number) => canopyTopAt(lat) - CANOPY_T

  const shell: THREE.BufferGeometry[] = []
  const roof: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []
  const bandGlass: THREE.BufferGeometry[] = []
  const darkGlass: THREE.BufferGeometry[] = []
  const floor: THREE.BufferGeometry[] = []
  const ceiling: THREE.BufferGeometry[] = []
  const interior: THREE.BufferGeometry[] = []
  const rails: THREE.BufferGeometry[] = []
  const soffits: THREE.BufferGeometry[] = []
  const shutters: THREE.BufferGeometry[] = []
  const plates: THREE.BufferGeometry[] = []

  // --- the 1F garage row 5590 → 88: floor, ceiling, header, fascia beam, soffit ---------------------
  {
    floor.push(sweep(track, [[GARAGE_BACK, 0.025], [SHUTTER, 0.025]], ROW0, S1, floorTile))
    ceiling.push(sweep(track, [[SHUTTER, CEIL], [GARAGE_BACK, CEIL]], ROW0, S1, ceilTile))
    // the garage back wall (into the garage) and the header's inner face over the openings
    interior.push(sweep(track, [[GARAGE_BACK, CEIL], [GARAGE_BACK, 0.025]], ROW0, S1, 4))
    interior.push(sweep(track, [[SHUTTER, DOOR_H], [SHUTTER, CEIL]], ROW0, S1, 4))
    // the header's lane face over the openings, then the beam underside, its inner face and the soffit
    shell.push(sweep(track, [[PIER_FACE, CEIL], [PIER_FACE, DOOR_H]], ROW0, S1, plasterTile))
    shell.push(sweep(track, [[DRIP, FASCIA_LO], [DRIP - BEAM_DEPTH, FASCIA_LO], [DRIP - BEAM_DEPTH, CEIL]], ROW0, S1, plasterTile))
    soffits.push(sweep(track, [[DRIP - BEAM_DEPTH, CEIL], [PIER_FACE, CEIL]], ROW0, S1, soffitTile))
    // the fascia: one atlas row per segment — blocks alternate the two panel variants, cores and the media 1F are plain
    const fascia: THREE.BufferGeometry[] = []
    const band = (a: number, b: number, row: number) => fascia.push(remapV(texturedWall(track, a, b, DRIP, FASCIA_LO, FASCIA_HI, forwardDelta(a, b, L), 1), row / 3 + 0.004, (row + 1) / 3 - 0.004))
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) band(track.wrap(garageS(g) - PIT_BLOCK / 2), track.wrap(garageS(g) + PIT_BLOCK / 2), g % 2)
    for (const [a, b] of cores) band(a, b, 2)
    band(ROW0, S0, 2)
    const fm = new THREE.Mesh(mergeGeometries(fascia, false)!, fasciaMat)
    for (const g of fascia) g.dispose()
    fm.name = 'pitFascia'
    fm.receiveShadow = true
    group.add(fm)
    // the 1F paddock face and the roof of the 1F strip behind the 2F wall (v1 stand-ins until commit 3)
    const rear = new THREE.Mesh(texturedWall(track, ROW0, S1, BACK, 0, F2, PIT_BLOCK, -1), rearMat)
    rear.name = 'pitRear'
    rear.castShadow = true
    rear.receiveShadow = true
    group.add(rear)
    roof.push(sweep(track, [[BACK, F2], [REAR_WALL, F2]], ROW0, S1, 4))
  }

  // --- the 2F / 3F body 5590 → 92: back wall, canopy, terraces, media section, link block ----------
  {
    // the paddock wall of the upper floors (its inner face shows from the 3F terrace)
    shell.push(sweep(track, [[REAR_WALL, F2], [REAR_WALL, canopyTopAt(REAR_WALL)]], ROW0, LINK1, plasterTile))
    // the canopy: top (roof colour) with the front lip, underside (white) back to the rear edge
    const lipBack = CANOPY_FRONT - CANOPY_LIP
    const top: Pt[] = [...CANOPY.filter(([x]) => x < lipBack - 0.05), [lipBack, canopyTopAt(lipBack)], [lipBack, canopyTopAt(CANOPY_FRONT) + CANOPY_LIP], [CANOPY_FRONT, canopyTopAt(CANOPY_FRONT) + CANOPY_LIP], [CANOPY_FRONT, canopyUnder(CANOPY_FRONT)]]
    const underCurve: Pt[] = [...CANOPY].reverse().map(([x, y]) => [x, y - CANOPY_T] as Pt)
    const under: Pt[] = [...underCurve, [REAR_WALL, canopyTopAt(REAR_WALL)]]
    roof.push(sweep(track, top, ROW0, LINK1, 4))
    shell.push(sweep(track, under, ROW0, LINK1, plasterTile))
    const canopyOutline: Pt[] = [...top, ...underCurve.slice(1)]
    shell.push(sectionPlate(track, ROW0, canopyOutline, false), sectionPlate(track, LINK1, canopyOutline, true))

    // 3F terrace 5625 → 88: the wall's inner face, the deck, five rows, the parapet, the 3F soffit
    const t3: Pt[] = [[REAR_WALL + REAR_WALL_T, canopyUnder(REAR_WALL + REAR_WALL_T)], [REAR_WALL + REAR_WALL_T, F3], [T3.deck.lateral, F3]]
    for (let r = T3.rows - 1; r >= 0; r--) {
      const lat = T3.frontRow.lateral - r * ROW3_TREAD
      const y = T3.frontRow.y + r * ROW3_RISER
      t3.push([lat - ROW3_TREAD, y], [lat, y])
    }
    t3.push([T3.frontRow.lateral, PARAPET_TOP], [T3.parapet.lateral, PARAPET_TOP], [T3.parapet.lateral, SOFFIT3], [LOUNGE, SOFFIT3])
    shell.push(sweep(track, t3, S0, S1, plasterTile))
    // 2F: the flat podium terrace on block 12, the stepped terraces from 5644 (3 rows), the front walk to the drip line
    const t2flat: Pt[] = [[LOUNGE, F2], [DRIP, F2]]
    const t2: Pt[] = [[LOUNGE, STEP_TOP], [T2.steps[1], STEP_TOP]]
    for (let r = T2.rows - 1; r >= 0; r--) {
      // tread r spans the riser at its back down to its front edge, one riser above the deck per row
      const back = T2.steps[0] - (r + 1) * T2.tread
      const y = F2 + (r + 1) * T2.riser
      if (r < T2.rows - 1) t2.push([back, y])
      t2.push([T2.steps[0] - r * T2.tread, y])
    }
    t2.push([T2.steps[0], F2], [DRIP, F2])
    shell.push(sweep(track, t2flat, S0, BLOCK12_END, plasterTile), sweep(track, t2, BLOCK12_END, S1, plasterTile))
    // the steps' open end into the podium terrace
    const stepEnd: Pt[] = [[LOUNGE, STEP_TOP], [T2.steps[1], STEP_TOP]]
    for (let r = T2.rows - 1; r >= 0; r--) {
      const lat = T2.steps[0] - r * T2.tread
      stepEnd.push([lat, F2 + (r + 1) * T2.riser], [lat, F2 + r * T2.riser])
    }
    stepEnd.push([LOUNGE, F2])
    shell.push(sectionPlate(track, BLOCK12_END, stepEnd, false))
    // the lounge glass: from the landing (the terraces) or the deck (block 12) up to the 3F soffit
    glass.push(sweep(track, [[LOUNGE, SOFFIT3], [LOUNGE, STEP_TOP]], BLOCK12_END, S1, 3), sweep(track, [[LOUNGE, SOFFIT3], [LOUNGE, F2]], S0, BLOCK12_END, 3))
    // the 2F drip-line glass rail: two-faced plates, a top tube, posts every 1.5 m
    glass.push(sweep(track, [[DRIP, F2 + RAIL_H], [DRIP, F2 + 0.1]], ROW0, S1, 3), sweep(track, [[DRIP, F2 + 0.1], [DRIP, F2 + RAIL_H]], ROW0, S1, 3))
    rails.push(tube(track, ROW0, S1, DRIP, F2 + RAIL_H + 0.02, 0.02))

    // the media section 5590 → 5625: a straight glass body behind the 2F ledge, its slab edge and end walls
    const MEDIA_FACE = -26.0
    shell.push(sweep(track, [[MEDIA_FACE, F2], [DRIP, F2]], ROW0, S0, plasterTile))
    glass.push(sweep(track, [[MEDIA_FACE, canopyUnder(MEDIA_FACE)], [MEDIA_FACE, F2]], ROW0, S0, 3))
    shell.push(sweep(track, [[MEDIA_FACE + 0.02, F3 + 0.2], [MEDIA_FACE + 0.02, F3 - 0.2]], ROW0, S0, plasterTile))
    const mediaOutline: Pt[] = [[REAR_WALL, F2], [MEDIA_FACE, F2], [MEDIA_FACE, canopyUnder(MEDIA_FACE)], [REAR_WALL, canopyUnder(REAR_WALL)]]
    shell.push(sectionPlate(track, ROW0 + 0.02, mediaOutline, false), sectionPlate(track, S0, mediaOutline, true))
    // the 88 → 92 link: the paddock-information box (1F, a glass counter on the lane) and the white 2F / 3F block under the canopy
    boxes.place((S1 + LINK1) / 2, (DRIP + BACK) / 2, forwardDelta(S1, LINK1, L), BACK * -1 + DRIP, F2, shellMat, 0, true)
    glass.push(sweep(track, [[DRIP + 0.03, 2.6], [DRIP + 0.03, 1.0]], S1 + 0.5, LINK1 - 0.5, 3))
    shell.push(sweep(track, [[DRIP, canopyUnder(DRIP)], [DRIP, F2]], S1, LINK1, plasterTile))
    const linkOutline: Pt[] = [[REAR_WALL, F2], [DRIP, F2], [DRIP, canopyUnder(DRIP)], [REAR_WALL, canopyUnder(REAR_WALL)]]
    shell.push(sectionPlate(track, S1, linkOutline, false), sectionPlate(track, LINK1, linkOutline, true))
  }

  // --- the two end caps from the OSM footprint: the 1F under the control pod, the T1 base ----------
  {
    const ring = OSM_PIT_BUILDING.en.map(([e, n]) => trackCoords(track, e, n))
    /** the footprint beyond a cut: the whole ring in along-track coordinates, clipped to one side of it */
    const cap = (cut: number, sign: 1 | -1) => clipD(ring.map((v) => ({ d: signedDelta(cut, v.s, L), lat: v.lat })), (d) => sign * d >= -1e-6)
    // the final-corner end: the medical centre's ground floor, the pod sits on its roof
    const fc = trackPrism(track, cap(ROW0, -1), ROW0, -0.3, F2, plasterTile)
    // the T1 end: the ground floor under the nose pod
    const t1 = trackPrism(track, cap(LINK1, 1), LINK1, -0.3, F2, plasterTile)
    shell.push(fc.sides, t1.sides)
    roof.push(fc.top, t1.top)
    // the rear spur's tunnel hall on the paddock face (v2 hall; the 2F bridge is commit 3)
    const sp = V2.spur.hall
    const hall = trackPrism(track, [{ d: 0, lat: BACK + 0.2 }, { d: 0, lat: sp.lateral[1] }, { d: sp.sRange[1] - sp.sRange[0], lat: sp.lateral[1] }, { d: sp.sRange[1] - sp.sRange[0], lat: BACK + 0.2 }], sp.sRange[0], -0.3, sp.h, plasterTile)
    shell.push(hall.sides)
    roof.push(hall.top)
  }

  // --- the pods: the control tower (final corner) and the T1 nose --------------------------------------
  {
    // The control pod is the whole final-corner end of the 2F / 3F volume: a bullet nose rounded
    // in plan and elevation, its tip on the glass band's mid line, sitting on the 1F cap, its top
    // easing down to the canopy lip over the last 6 m so the tail meets the media section.
    const bandY = POD.band
    const pod: PodLoftParams = {
      track, s0: POD0, s1: ROW0 - 0.02, front: DRIP + 0.9, back: BACK + 1.2,
      bottom: F2, mid: (bandY[0] + bandY[1]) / 2, top: POD.top,
      nose: { plan: 18, top: 18, bottom: 9 }, tail: { top: canopyTopAt(CANOPY_FRONT), ease: 6 }, tile: plasterTile, band: null,
    }
    const podMesh = new THREE.Mesh(podLoft(pod), podMat)
    podMesh.name = 'controlPod'
    podMesh.castShadow = true
    podMesh.receiveShadow = true
    group.add(podMesh)
    bandGlass.push(podBand(pod, { y0: bandY[0], y1: bandY[1], proud: 0.04 }))
    // the dark-blue sign band under it, the race-control corner (2F, the last 8 m on the pit side) and the portholes
    const sign = new THREE.Mesh(podBand(pod, { y0: bandY[0] - V2.podMat.signBand.h, y1: bandY[0] - 0.02, proud: 0.03, segments: 1 }), signBandMat)
    sign.name = 'controlPodSign'
    sign.receiveShadow = true
    group.add(sign)
    const len = forwardDelta(pod.s0, pod.s1, L)
    darkGlass.push(podBand(pod, { y0: F2 + 0.3, y1: bandY[0] - V2.podMat.signBand.h - 0.1, proud: 0.05, dRange: [len - 8, len], sides: 'front' }))
    const portholes = (p: PodLoftParams, y: number, d0: number, pitch: number) => {
      for (const side of [1, -1] as const) {
        for (let i = 0; i < T1.portholes; i++) {
          const f = podFlank(p, d0 + i * pitch, y, side, 0.05)
          const disc = new THREE.CircleGeometry(0.3, 16).rotateY(Math.PI / 2).rotateY(f.yaw)
          disc.applyMatrix4(frameAt(track, f.s, f.lat, f.y, m4()))
          darkGlass.push(disc)
        }
      }
    }
    portholes(pod, F2 + 2.4, 3, 2)

    // the T1 nose: the same loft mirrored, 1F + 2F, its band on the 2F, eight portholes
    const t1Band = T1.band
    const nose: PodLoftParams = {
      track, s0: LINK1 + 0.02, s1: NOSE1, dir: -1, front: DRIP + 0.5, back: BACK + 0.7,
      bottom: 0.6, mid: (t1Band[0] + t1Band[1]) / 2, top: T1.top,
      nose: { plan: forwardDelta(LINK1, NOSE1, L) - 0.5, top: 9, bottom: 6 }, tail: null, tile: plasterTile, band: null,
    }
    const noseMesh = new THREE.Mesh(podLoft(nose), podMat)
    noseMesh.name = 't1Nose'
    noseMesh.castShadow = true
    noseMesh.receiveShadow = true
    group.add(noseMesh)
    const t1Glass = new THREE.Mesh(podBand(nose, { y0: t1Band[0], y1: t1Band[1], proud: 0.04 }), bandGlassMat)
    t1Glass.name = 't1NoseGlass'
    t1Glass.receiveShadow = true
    group.add(t1Glass)
    portholes(nose, t1Band[0] - 1.4, 2, 1.1)
  }

  // --- the garage row: piers, cores, door leaves, shutters, number plates, placeholder interiors ----
  {
    /** every pier of the row: s → width (block ends and the cap pier 1.0, the rest 0.55) */
    const piers = new Map<number, number>()
    const pier = (s: number, w: number) => {
      const key = Math.round(track.wrap(s) * 100) / 100
      piers.set(key, Math.max(piers.get(key) ?? 0, w))
    }
    /** openings: centre s and whether they take folded glass (team) or a closed shutter */
    const openings: { s: number; team: boolean }[] = []
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const a = garageS(g) - PIT_BLOCK / 2
      for (let j = 0; j <= 4; j++) pier(a + j * PIT_BOX, j === 0 || j === 4 ? BLOCK_PIER : PIER)
      for (let j = 0; j < 4; j++) openings.push({ s: track.wrap(a + (j + 0.5) * PIT_BOX), team: g < blocks.length })
    }
    // the 49–55 caps under the media section: seven pits from block 12's edge toward the pod, a stub wall at the end
    const nCaps = Math.floor(forwardDelta(ROW0, S0, L) / PIT_BOX)
    for (let j = 1; j <= nCaps; j++) pier(S0 - j * PIT_BOX, PIER)
    for (let j = 0; j < nCaps; j++) openings.push({ s: track.wrap(S0 - (j + 0.5) * PIT_BOX), team: false })
    const stub = forwardDelta(ROW0, S0 - nCaps * PIT_BOX, L)
    if (stub > 0.05) boxes.place(ROW0 + stub / 2, PIER_FACE - WALL_T / 2, stub, WALL_T, DOOR_H, shellMat, 0, true)
    for (const [s, w] of piers) boxes.place(s, PIER_FACE - WALL_T / 2, w, WALL_T, DOOR_H, pierMat, 0, true)
    // the cores: a white wall between the block-end piers
    for (const [a, b] of cores) boxes.place(track.wrap(a + forwardDelta(a, b, L) / 2), PIER_FACE - WALL_T / 2, forwardDelta(a, b, L) - BLOCK_PIER, WALL_T, DOOR_H, shellMat, 0, true)
    // folded glass door leaves (team blocks): one stacked leaf at each side of the opening, just behind the door plane
    const leafGeo = (() => {
      const frame = new THREE.BoxGeometry(0.15, DOOR_H, 0.6)
      frame.translate(0, DOOR_H / 2, 0)
      const pane = new THREE.BoxGeometry(0.17, DOOR_H - 0.3, 0.5)
      pane.translate(0, DOOR_H / 2, 0)
      return mergeGeometries([frame, pane], true)!
    })()
    const leafM: THREE.Matrix4[] = []
    const leafS: number[] = []
    const shutterGeo = new THREE.PlaneGeometry(DOOR_W, DOOR_H).rotateY(Math.PI / 2)
    for (const o of openings) {
      if (o.team) {
        for (const ds of [-(DOOR_W / 2 - 0.35), DOOR_W / 2 - 0.35]) {
          leafM.push(frameAt(track, o.s + ds, SHUTTER - 0.2, 0, m4()))
          leafS.push(track.wrap(o.s + ds))
        }
      } else {
        const g = shutterGeo.clone()
        const uv = g.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * DOOR_W) / shutterTile, (uv.getY(i) * DOOR_H) / shutterTile)
        g.applyMatrix4(frameAt(track, o.s, SHUTTER + 0.1, DOOR_H / 2, m4()))
        shutters.push(g)
      }
    }
    for (const inst of bucketedInstancedMeshes(leafGeo, [darkMat, glassMat], leafM, null, (i) => Math.floor(leafS[i]! / 60), { name: 'pitDoorLeaves', receiveShadow: true })) group.add(inst)
    // number plates (odd scheme, PIT_BUILDING.v2.plates): plate n on the +s pier of pit n, on the header just right of the pier
    const plateGeo = new THREE.PlaneGeometry(0.35, 0.35).rotateY(Math.PI / 2)
    const plate = (n: number, pierS: number) => {
      const p = atlasUv(plateGeo.clone(), n)
      p.applyMatrix4(frameAt(track, pierS - 0.4, PIER_FACE + 0.02, DOOR_H + 0.55, m4()))
      plates.push(p)
    }
    const P = V2.plates
    for (let b = 0; b < PIT_GARAGE_COUNT; b++) {
      plate(b * P.stride + P.perBlock[0], garageS(b) + PIT_BLOCK / 2)
      plate(b * P.stride + P.perBlock[1], garageS(b))
    }
    P.caps.forEach((n, i) => plate(n, S0 - i * 2 * PIT_BOX))
    // the podium bay: pits 45–47's concrete backdrop wall on the flat 2F terrace, the podium entrance (a personnel door with its plate) on the core beside it
    const podium = V2.podium
    boxes.place(podium.s, LOUNGE + 0.15, podium.backdrop[0], 0.3, SOFFIT3 - F2, concreteMat, F2, true, false)
    const door = atlasUv(new THREE.PlaneGeometry(0.9, 2.1).rotateY(Math.PI / 2), 57)
    door.applyMatrix4(frameAt(track, cores[5]![0] + 1.5, PIER_FACE + 0.02, 1.05, m4()))
    const doorPlate = atlasUv(new THREE.PlaneGeometry(0.35, 0.35).rotateY(Math.PI / 2), 56)
    doorPlate.applyMatrix4(frameAt(track, cores[5]![0] + 1.5, PIER_FACE + 0.02, 2.45, m4()))
    add([door, doorPlate], doorMat, 'pitPodiumDoor', false)

    // interiors (placeholders until commit 3): side plates at the block ends, the team-coloured back wall, three lamp strips, a few dark props
    const sideWall: Pt[] = [[SHUTTER, 0], [GARAGE_BACK, 0], [GARAGE_BACK, CEIL], [SHUTTER, CEIL]]
    const walls: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const plateS = new Set<number>()
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const s = garageS(g)
      const team = blocks[g]
      for (const e of [s - PIT_BLOCK / 2, s + PIT_BLOCK / 2]) plateS.add(Math.round(track.wrap(e) * 100) / 100)
      walls.push({ m: boxes.matrix(s, GARAGE_BACK + 0.2, CEIL, 0, true, m4()), color: new THREE.Color(team ? team.body : COLOURS.garageInterior.mid) })
      for (const lat of [-31, -38, -45]) boxes.place(s, lat, PIT_BLOCK - 6, 0.5, 0.12, lampMat, CEIL - 0.1, true, false)
      if (!team) continue
      boxes.place(s - 8, -33, 1.2, 0.7, 1.1, darkMat, 0, true, false)
      boxes.place(s + 7, -37.5, 0.7, 0.7, 1.3, darkMat, 0, true, false)
      boxes.place(s + 7.9, -37.5, 0.7, 0.7, 1.3, darkMat, 0, true, false)
      boxes.place(s + 8.5, -40, 0.8, 8, 0.9, darkMat, 0, true, false)
      boxes.place(s - 8, -47, 0.6, 3, 1.8, darkMat, 0, true, false)
    }
    for (const s of plateS) interior.push(sectionPlate(track, s, sideWall, true))
    boxes.instanced(PIT_BLOCK - 0.6, 0.3, CEIL, walls, 0.6, false, 'garageWalls')
  }

  // --- 3F round columns, stair towers ------------------------------------------------------------------
  {
    const colH = canopyUnder(COLUMN_LAT) - T3.frontRow.y
    const colGeo = new THREE.CylinderGeometry(COLUMN_R, COLUMN_R, colH, 12)
    colGeo.translate(0, colH / 2, 0)
    const colM: THREE.Matrix4[] = []
    const colS: number[] = []
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const a = garageS(g) - PIT_BLOCK / 2
      for (let j = 0; j <= 4; j++) {
        const s = track.wrap(a + j * PIT_BOX)
        if (colS.some((x) => Math.abs(signedDelta(x, s, L)) < 0.1)) continue
        colM.push(frameAt(track, s, COLUMN_LAT, T3.frontRow.y, m4()))
        colS.push(s)
      }
    }
    for (const inst of bucketedInstancedMeshes(colGeo, railMat, colM, null, (i) => Math.floor(colS[i]! / 60), { name: 'pitColumns', receiveShadow: true })) group.add(inst)
    // seven stair towers on the paddock side: white boxes from the ground through the deck and the canopy
    const towers: THREE.BufferGeometry[] = []
    const [tw, td] = STAIR.size
    const tLat = (STAIR.lateral[0] + STAIR.lateral[1]) / 2
    for (const s of STAIR.s) {
      const g = new THREE.BoxGeometry(td, STAIR.top + 0.3, tw)
      g.translate(0, (STAIR.top + 0.3) / 2 - 0.3, 0)
      g.applyMatrix4(frameAt(track, s, tLat, 0, m4()))
      towers.push(g)
    }
    add(towers, shellMat, 'pitStairTowers', true)
  }

  // --- 2F / 3F terraces: seats and rail posts ----------------------------------------------------------
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
        seatMatrices.push(frameAt(track, s, lat, y, m4()))
        seatS.push(track.wrap(s))
      }
    }
    const bayHalf = PIT_BLOCK / 2 - 0.6
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const c = garageS(g)
      // 2F: three rows per hospitality room (≈ 90 seats), none on the podium terrace
      if (g < PIT_GARAGE_COUNT - 1) for (let r = 0; r < T2.rows; r++) seatRow(c - bayHalf, c + bayHalf, T2.steps[0] - r * T2.tread - 0.42, F2 + (r + 1) * T2.riser)
      // 3F: five rows per bay
      for (let r = 0; r < T3.rows; r++) seatRow(c - bayHalf, c + bayHalf, T3.frontRow.lateral - r * ROW3_TREAD - 0.42, T3.frontRow.y + r * ROW3_RISER)
    }
    for (const inst of bucketedInstancedMeshes(seatGeo, seatMat, seatMatrices, null, (i) => Math.floor(seatS[i]! / 60), { name: 'pitSeats', receiveShadow: true })) group.add(inst)
    // the glass rail's posts every 1.5 m along the drip line
    const postGeo = new THREE.CylinderGeometry(0.015, 0.015, RAIL_H, 8)
    postGeo.translate(0, RAIL_H / 2, 0)
    const postM: THREE.Matrix4[] = []
    const postS: number[] = []
    const railLen = forwardDelta(ROW0, S1, L)
    for (let d = 0; d <= railLen; d += 1.5) {
      postM.push(frameAt(track, ROW0 + d, DRIP, F2, m4()))
      postS.push(track.wrap(ROW0 + d))
    }
    for (const inst of bucketedInstancedMeshes(postGeo, railMat, postM, null, (i) => Math.floor(postS[i]! / 60), { name: 'pitRailPosts', receiveShadow: true })) group.add(inst)
  }

  // --- the screens: three on the canopy, one facing the paddock, four trackside on posts (SCREENS.mount)
  // One material and one merged face mesh for all of them, whichever way they are mounted.
  {
    const screenMat = boardMat(screenTexture(k), 0.9)
    const faces: THREE.BufferGeometry[] = []
    for (const sc of SCREENS) {
      /** height of the panel's bottom above the road plane at (s, lateral) */
      let bottom: number
      if (sc.mount === 'roof') {
        // four posts from the canopy's top to the panel (the lattice pylons are commit 3)
        bottom = sc.base
        const roofY = canopyTopAt(sc.lateral)
        const frame = Math.max(0.3, sc.base - roofY)
        for (const ds of [-sc.width / 2 + 0.3, sc.width / 2 - 0.3]) for (const dl of [-0.4, 0.4]) boxes.place(sc.s + ds, sc.lateral + dl, 0.3, 0.3, frame, darkMat, roofY, true, false)
        boxes.place(sc.s, sc.lateral, sc.width, 1.2, sc.height, darkMat, sc.base, true)
      } else {
        // two square legs standing on the DRAWN ground (the H / P visions are on relief hills),
        // a beam under the panel: the West-straight photo's type
        bottom = ground.standAt(sc.s, sc.lateral) + sc.base
        for (const ds of [-sc.width / 2 + 0.6, sc.width / 2 - 0.6]) boxes.place(sc.s + ds, sc.lateral, 0.4, 0.4, sc.base, darkMat, 0, false, true)
        boxes.place(sc.s, sc.lateral, sc.width - 1.0, 0.5, 0.4, darkMat, sc.base - 0.4, false, false)
        boxes.place(sc.s, sc.lateral, sc.width, 1.2, sc.height, darkMat, sc.base, false, true)
      }
      // the single face looks at the track (+lateral) unless the row faces the paddock
      const toward = sc.faces === 1 && sc.facing === 'paddock' ? -1 : 1
      const front = new THREE.PlaneGeometry(sc.width - 0.4, sc.height - 0.4).rotateY((toward * Math.PI) / 2)
      front.applyMatrix4(frameAt(track, sc.s, sc.lateral + toward * 0.62, bottom + sc.height / 2, m4()))
      faces.push(front)
      if (sc.faces === 2) {
        const rear = new THREE.PlaneGeometry(sc.width - 0.4, sc.height - 0.4).rotateY(-Math.PI / 2)
        rear.applyMatrix4(frameAt(track, sc.s, sc.lateral - 0.62, bottom + sc.height / 2, m4()))
        faces.push(rear)
      }
    }
    add(faces, screenMat, 'pitScreens', false)
  }

  // --- merge the building's meshes --------------------------------------------------------------------
  add(shell, shellMat, 'pitShell', true)
  add(roof, buildingRoofMat, 'pitCanopy', true)
  add(glass, glassMat, 'pitGlass', false)
  add(bandGlass, bandGlassMat, 'controlPodGlass', false)
  add(darkGlass, darkGlassMat, 'pitDarkGlass', false)
  add(floor, floorMat, 'pitInterior', false)
  add(ceiling, ceilingMat, 'pitInteriorCeiling', false)
  add(interior, interiorMat, 'pitInteriorWalls', false)
  add(soffits, soffitMat, 'pitSoffit', false)
  add(shutters, shutterMat, 'pitShutters', false)
  add(plates, doorMat, 'pitPlates', false)
  add(rails, railMat, 'pitRails', false)

  return { buildingRoofMat }
}
