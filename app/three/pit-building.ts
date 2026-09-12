import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COMPOUND_COLORS, DRIVERS, TEAMS } from '~/data/drivers'
import { COLOURS, GARAGE_ORDER, PIT_BLOCK, PIT_BOX, PIT_BOX_STRIP, PIT_BUILDING, PIT_CORES, PIT_GARAGE_COUNT, SCREENS, garageS } from '~/data/suzuka-facilities-spec'
import { OSM_PIT_BUILDING } from '~/data/suzuka-facilities'
import { forwardDelta, signedDelta } from '~/sim/track'
import { EMISSIVE, emissiveScale } from './emissive'
import type { EnvBuildContext } from './environment'
import { buildOpsFigures, terraceSlots } from './figures'
import { registerPropSet, type PropPlacement, type PropSet } from './infield-lod'
import { bucketedInstancedMeshes } from './instancing'
import { latticeGeometry } from './lattice'
import { cutoutFromAssets, cutoutParams, pbrFromAssets, tileMetres } from './materials'
import { glbOr, procProp, propMaterial, type PropProto } from './props-pack'
import { chainLinkTexture, tyreMaps } from './textures'
import {
  addMerged, canvas, chequer, clipD, frameAt, label, PIT_TEXTS, pitMaterials, podBand, podFlank, podLoft, remapV, sectionPlate, smoothProfile, sweep, tex, texturedWall, trackCoords, trackPrism, tube, type PodLoftParams, type Pt,
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
 * - along s: the control pod 5554.5 → 5590 (silver aluminium `podLoft`, top 12.5 under the
 *   canopy, which starts over its shoulder at 5566.5; its glass band as a `podBand` ring, a
 *   dark-blue sign band under it, the dark-glass race-control corner and the portholes) on the
 *   OSM cap prism of the 1F (the medical centre), the media section 5590 →
 *   5625 (a straight 2F / 3F glass body, no terraces), block 12 with the flat podium terrace,
 *   the eleven team blocks with their stepped terraces, the 88 → 92 paddock-information box and
 *   the T1 nose 92 → 103.3 (the same loft mirrored, top 11); seven stair towers on the paddock
 *   side (0.3 m proud of the tiled wall); the garage row's piers, folded white-framed glass door leaves (team blocks), ribbed shutters
 *   (block 12 and the 49–55 caps), odd number plates, the podium bay's concrete backdrop;
 * - the seven screens (three on the canopy, one facing the paddock, four trackside on posts —
 *   SCREENS.mount).
 *
 * The down-facing white surfaces (canopy soffit, 3F soffit, beam and door-head undersides, the
 * rear canopy) are their own merge `pitShellSoffit` on `soffitShellMat` = shellMat plus the
 * `EMISSIVE.soffitBounce` stand-in for the apron bounce (a downward normal gets no sun and only
 * the dark lower hemisphere, so they rendered olive-khaki); the 2F drip-line balustrade's plates
 * are `pitRailGlass` on the transparent `railGlassMat`.
 *
 * Everything static and single-material is merged; repeated pieces (terrace seats, rail posts,
 * 3F columns, door leaves) are instanced per 60 m bay so the follow cameras can cull them.
 * Shadow policy: shell / canopy / caps / pods / towers cast + receive; seats, railings, columns,
 * leaves, plates, screens and glass receive only. The pit wall, the Leader Tower and the
 * perches are pit-lane.ts, the paddock behind is paddock.ts; the materials the three share come
 * from `pitMaterials(ctx)`.
 *
 * Commit 3 of I1-b (`PIT_BUILDING.v2.interior / roof / rostrum / guests`):
 * - the garage interiors (pitbox.jpg): white expanded-metal side walls on the block boundaries
 *   (fence003 cutout tinted white, the chain-link canvas without the pack), the 1 m team-colour
 *   band along the floor's front edge (`pitInteriorBands`, one InstancedMesh with
 *   instanceColor, 12 mm above the floor), the white pit-room wall at the back with a rear door
 *   per pit — open on the team blocks (a rolled shutter under the header, the paddock visible
 *   through the garage), a closed ribbed shutter on block 12 and the caps — and the WASH: the
 *   mesh and pit-room materials carry `EMISSIVE.garageWash` (luminance 0.11, a lift over the
 *   shade, no halo; the floor reads its concrete map unlit), so the shaded pit-side facade of
 *   the reproduced 14:00 still reads as lit interiors. The equipment is a prop set (`registerPropSet('ops', 'ops-garage')`: one
 *   InstancedMesh per prototype and 250 m cell, receive-only, every piece at
 *   lateral ≤ `interior.equipmentFront` so the chase-lens column and the car box stay clear):
 *   tool-wall units, roll cabinets (metal_tool_chest), shelves (steel_frame_shelves_01), tyre
 *   stacks in team-colour blankets with a bare tyre on top (`tyreMaps`), the monitor desk
 *   (pc_monitors, a 3 × 2 screen wall with `EMISSIVE.opsMonitor` otherwise), the 17 m lighting
 *   truss under the ceiling, cable drums and crates (plastic_crate_02) — the pack models as the
 *   near level where the tier draws GLBs, the procedural boxes always (`glbOr`);
 * - the rear elevation: the 1F canopy over the rear doors (soffit 4.35 → 3.81, 0.3 thick) on
 *   round columns every 9.5 m (`pitRearColumns-<bay>`), the tiled 2F / 3F paddock wall
 *   (rectangular_facade_tiles, `pitRearUpper`) with the 2F window band and the 3F row of small
 *   windows (`pitRearWindows`, one 19 m block per repeat), the spur's 2F bridge over the
 *   paddock road and the glass band of its tunnel hall;
 * - the roof plant: HVAC boxes, the three antennas over the media section, black lattice
 *   pylons for every roof screen (`pitScreenPylons`);
 * - the podium at 5632: the chequered backdrop on the concrete wall, the three-step black
 *   rostrum, the fictional JAPANESE GRAND PRIX banner on the fascia (`pitPodium`);
 * - the terrace guests: `figures.terraceSlots` (seated, 85 % of the 2F / 3F seats of the eleven
 *   team blocks) through `buildOpsFigures(ctx, slots, 'ops-terrace')`, counted in
 *   `stats.infield['ops-terrace']` and never in the crowd's statistics.
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
const INT = V2.interior
const REAR_DOOR = INT.rearDoor
/** the pit-room wall: its garage face on the garage back line, `INT.wallT` thick towards the paddock */
const WALL_OUT = GARAGE_BACK - INT.wallT // −51.9
const RC = V2.rearCanopy
/** the rear canopy slab thickness (unverified, the section draws a thin slab) */
const RC_T = 0.3
/** the rear canopy's soffit height at a lateral between its two ends */
const rearSoffitAt = (lat: number) => RC.soffit[0] + ((lat - RC.from) / (RC.to - RC.from)) * (RC.soffit[1] - RC.soffit[0])
/** the 2F / 3F paddock wall starts on the rear canopy's top */
const REAR_BASE = RC.soffit[0] + RC_T // 4.65
/** the paddock elevation's glazing (rearUpperTexture rows): the 2F window band and the 3F row of small windows, heights above the road plane (unverified, pphi-3) */
const REAR_WINDOWS: { band2F: Pt; row3F: Pt } = { band2F: [6.3, 7.8], row3F: [10.6, 11.6] }
const ROOF = V2.roof
const ROSTRUM = V2.rostrum

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

/**
 * The paddock elevation's glazing, one 19 m block per repeat, two atlas rows (canvas top →
 * bottom): 0 = the 2F window band (continuous tinted glazing, a mullion every 1.9 m, a sill
 * line), 1 = the 3F row of small windows in a dark aluminium spandrel band (eight per block).
 */
function rearUpperTexture(k: number): THREE.Texture {
  const w = 2048, h = 256
  const rowH = h / 2
  const { c, ctx } = canvas(w, h, k)
  // row 0: the 2F band
  const g = ctx.createLinearGradient(0, 0, 0, rowH)
  g.addColorStop(0, '#8ea3b4')
  g.addColorStop(1, '#5f7686')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, rowH)
  ctx.fillStyle = '#2d3238'
  for (let i = 0; i <= 10; i++) ctx.fillRect(Math.min(w - 6, i * (w / 10) - 3), 0, 6, rowH)
  ctx.fillRect(0, 0, w, 6)
  ctx.fillRect(0, rowH - 8, w, 8)
  // row 1: the 3F spandrel with its small windows
  ctx.fillStyle = '#4a4e54'
  ctx.fillRect(0, rowH, w, rowH)
  const n = 8, cw = w / n
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = '#1f2326'
    ctx.fillRect(i * cw + cw * 0.2, rowH + 22, cw * 0.6, rowH - 44)
    ctx.fillStyle = '#7d93a4'
    ctx.fillRect(i * cw + cw * 0.2 + 4, rowH + 26, cw * 0.6 - 8, rowH - 52)
  }
  return tex(c)
}

/** Procedural facade tiles (the fallback for rectangular_facade_tiles): 4 × 8 light-grey panels with dark joints per 2 m tile. */
function facadeTilesTexture(k: number): THREE.Texture {
  const w = 256, h = 256
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#8d8a84'
  ctx.fillRect(0, 0, w, h)
  const cols = 4, rows = 8
  const tw = w / cols, th = h / rows
  let seed = 3
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = 0.92 + rnd() * 0.12
      ctx.fillStyle = `rgb(${Math.round(214 * v)}, ${Math.round(216 * v)}, ${Math.round(213 * v)})`
      ctx.fillRect(i * tw + 2, j * th + 2, tw - 4, th - 4)
    }
  }
  return tex(c)
}

/**
 * The podium atlas, two rows: 0 = the chequered backdrop (podium.jpg: a black / white chequer
 * with the circuit's name on a white lozenge — no logos), 1 = the fictional event banner on the
 * fascia (white, a red diagonal band, the words from PIT_TEXTS).
 */
function podiumTexture(k: number): THREE.Texture {
  const w = 1024, h = 512
  const rowH = h / 2
  const { c, ctx } = canvas(w, h, k)
  chequer(ctx, 0, 0, w, rowH, 64, '#141414', '#f6f6f4')
  ctx.fillStyle = '#f6f6f4'
  ctx.beginPath()
  ctx.moveTo(w * 0.28, rowH * 0.5)
  ctx.lineTo(w * 0.5, rowH * 0.28)
  ctx.lineTo(w * 0.72, rowH * 0.5)
  ctx.lineTo(w * 0.5, rowH * 0.72)
  ctx.closePath()
  ctx.fill()
  label(ctx, PIT_TEXTS[0]!, w / 2, rowH / 2, 44, '#141414', 800, 'center', w * 0.36)
  // the banner
  ctx.fillStyle = '#f8f8f6'
  ctx.fillRect(0, rowH, w, rowH)
  ctx.fillStyle = COLOURS.circuitRed.lit
  ctx.beginPath()
  ctx.moveTo(0, rowH)
  ctx.lineTo(w * 0.26, rowH)
  ctx.lineTo(w * 0.2, h)
  ctx.lineTo(0, h)
  ctx.closePath()
  ctx.fill()
  label(ctx, PIT_TEXTS[10]!, w * 0.62, rowH + rowH * 0.42, 96, '#141414', 900, 'center', w * 0.66)
  label(ctx, PIT_TEXTS[6]!, w * 0.62, rowH + rowH * 0.78, 48, COLOURS.circuitRed.lit, 700, 'center', w * 0.5)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** The scrutineering band over the 49–55 caps' fascia (PIT_BUILDING.v2.plates.capText): a white strip, the word in dark letters between two red rules. */
function capBandTexture(k: number): THREE.Texture {
  const w = 1024, h = 96
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#f8f8f6'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = COLOURS.circuitRed.lit
  ctx.fillRect(0, 6, w, 6)
  ctx.fillRect(0, h - 12, w, 6)
  label(ctx, PIT_BUILDING.v2.plates.capText, w / 2, h / 2, 56, '#141414', 900, 'center', w - 80)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** The garages' monitor wall: 3 × 2 dark screens in a black frame (map) and their glow alone (emissiveMap, EMISSIVE.opsMonitor). */
function monitorTextures(k: number): { map: THREE.Texture; emissive: THREE.Texture } {
  const w = 256, h = 160
  const a = canvas(w, h, k)
  const e = canvas(w, h, k)
  a.ctx.fillStyle = '#17191c'
  a.ctx.fillRect(0, 0, w, h)
  e.ctx.fillStyle = '#000000'
  e.ctx.fillRect(0, 0, w, h)
  const cols = 3, rows = 2
  const cw = w / cols, ch = h / rows
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cw + 6, y = j * ch + 6, sw = cw - 12, sh = ch - 12
      a.ctx.fillStyle = '#0d1420'
      a.ctx.fillRect(x, y, sw, sh)
      e.ctx.fillStyle = '#9fc4ff'
      e.ctx.fillRect(x, y, sw, sh)
      // faint timing rows, dimmer in the glow map
      for (let r = 0; r < 5; r++) {
        a.ctx.fillStyle = r % 2 ? '#16233a' : '#1b2b46'
        a.ctx.fillRect(x + 4, y + 6 + r * (sh - 12) / 5, sw - 8, (sh - 12) / 5 - 2)
        e.ctx.fillStyle = r % 2 ? '#6f8fc0' : '#87a8d8'
        e.ctx.fillRect(x + 4, y + 6 + r * (sh - 12) / 5, sw - 8, (sh - 12) / 5 - 2)
      }
    }
  }
  return { map: tex(a.c, THREE.ClampToEdgeWrapping), emissive: tex(e.c, THREE.ClampToEdgeWrapping) }
}

// ---------------------------------------------------------------- the builder

export function buildPitBuilding(ctx: EnvBuildContext): { buildingRoofMat: THREE.MeshStandardMaterial } {
  const { track, ground, group, boxes, quality, assets: reg } = ctx
  const L = track.length
  const k = quality.textureScale
  const { plasterTile, shellMat, soffitShellMat, podMat, pierMat, buildingRoofMat, glassMat, railGlassMat, darkMat, interiorMat, railMat, seatMat, lampMat, boardMat, concreteMat } = pitMaterials(ctx)
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTexture(k), roughness: 0.55 })
  const doorMat = new THREE.MeshStandardMaterial({ map: doorAtlas(k), roughness: 0.6 })
  // the garage-interior wash (EMISSIVE.garageWash): an emissive colour changes no program, the
  // mesh / pit-room materials below carry it so the shaded fronts read as lit interiors; the
  // floor is lit by the sky alone and reads its concrete map (the photo's floor is darker than
  // the apron — I1 review V3)
  const wash = { emissive: EMISSIVE.garageWash.color, emissiveIntensity: EMISSIVE.garageWash.intensity * emissiveScale() }
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
  // the garages' side walls: white expanded metal (the fence003 cutout tinted white; the chain-link canvas without the pack), metre UVs both ways
  const meshMat = cutoutFromAssets(reg, 'fence003', {
    quality, tile: 2, handBuiltUv: true, normalScale: 0.4, extra: { color: 0xf4f4f2, metalness: 0.4, ...wash },
    fallback: () => {
      const map = chainLinkTexture().clone()
      map.repeat.set(5, 5)
      return new THREE.MeshStandardMaterial({ map, color: 0xf4f4f2, ...cutoutParams(quality), side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4, ...wash })
    },
  })
  // the pit-room wall at the back of the garages, seen from both sides through the rear doors
  const pitRoomMat = new THREE.MeshStandardMaterial({ color: 0xe8eae8, roughness: 0.85, side: THREE.DoubleSide, ...wash })
  // the 2F / 3F paddock wall: light panels (pphi-4, padoc.jpg) with the joints from the
  // rectangular_facade_tiles normal / ARM under a flat albedo — the tile photo's own albedo is
  // a dark warm grey (mean sRGB 88,86,79) and rendered as a brown wall in full sun (I1 review
  // V5); the window bands are their own canvas
  const tilesTile = tileMetres(reg, 'tex/rectangular_facade_tiles/diff', 2)
  const tilesMat = reg
    ? pbrFromAssets(reg, 'rectangular_facade_tiles', { fallback: () => new THREE.MeshStandardMaterial({ map: facadeTilesTexture(k), roughness: 0.7 }), handBuiltUv: true, normalScale: 0.6, noMap: true, extra: { color: 0xdcdedb } })
    : new THREE.MeshStandardMaterial({ map: facadeTilesTexture(k), roughness: 0.7 })
  const windowMat = new THREE.MeshStandardMaterial({ map: rearUpperTexture(k), roughness: 0.25, metalness: 0.5 })
  const podiumMat = boardMat(podiumTexture(k))
  const monitor = monitorTextures(k)
  const monitorMat = new THREE.MeshStandardMaterial({ map: monitor.map, roughness: 0.5, emissive: 0xffffff, emissiveMap: monitor.emissive, emissiveIntensity: EMISSIVE.opsMonitor.intensity * emissiveScale() })
  /** plain colours of the roof plant and the procedural equipment, shared through the prop cache */
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const hvacMat = plain(0x9a9ea2, 0.6, 0.3)
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
  /** the canopy starts over the control pod's shoulder (pphi-4: the canopy line runs above the pod, its nose protrudes) */
  const CANOPY0 = track.wrap(POD0 + 12) // ≈ 5566.5
  const BLOCK12_END = track.wrap(S0 + PIT_BLOCK) // 5644: the podium terrace ends, the stepped terraces begin
  const LINK1 = track.wrap(T1.info.sRange[1]) // 92: the paddock-information box ends, the T1 nose begins
  const NOSE1 = track.wrap(T1.sRange[1]) // 103.3
  const cores = PIT_CORES.map(([a, b]) => [track.wrap(a), track.wrap(b)] as const)
  const blocks = GARAGE_ORDER.map((id) => TEAMS[id])
  /** the canopy underside at a lateral */
  const canopyUnder = (lat: number) => canopyTopAt(lat) - CANOPY_T

  const shell: THREE.BufferGeometry[] = []
  /** the down-facing white surfaces (canopy soffit, 3F soffit, beam and door-head undersides, rear canopy soffit): soffitShellMat, see pitMaterials */
  const downShell: THREE.BufferGeometry[] = []
  const roof: THREE.BufferGeometry[] = []
  const glass: THREE.BufferGeometry[] = []
  /** the 2F drip-line balustrade's clear plates: railGlassMat (transparent), see pitMaterials */
  const railGlass: THREE.BufferGeometry[] = []
  const bandGlass: THREE.BufferGeometry[] = []
  const darkGlass: THREE.BufferGeometry[] = []
  const floor: THREE.BufferGeometry[] = []
  const ceiling: THREE.BufferGeometry[] = []
  const interior: THREE.BufferGeometry[] = []
  const rails: THREE.BufferGeometry[] = []
  const soffits: THREE.BufferGeometry[] = []
  const shutters: THREE.BufferGeometry[] = []
  const plates: THREE.BufferGeometry[] = []
  const pitRoom: THREE.BufferGeometry[] = []
  const rearLower: THREE.BufferGeometry[] = []
  const rearUpper: THREE.BufferGeometry[] = []
  const rearWindows: THREE.BufferGeometry[] = []
  const garageMesh: THREE.BufferGeometry[] = []
  const podiumGeos: THREE.BufferGeometry[] = []
  const pylons: THREE.BufferGeometry[] = []

  // --- the 1F garage row 5590 → 88: floor, ceiling, header, fascia beam, soffit ---------------------
  {
    floor.push(sweep(track, [[GARAGE_BACK, 0.025], [SHUTTER, 0.025]], ROW0, S1, floorTile))
    ceiling.push(sweep(track, [[SHUTTER, CEIL], [GARAGE_BACK, CEIL]], ROW0, S1, ceilTile))
    // the pit-room wall's header over the rear doors (its garage face) and the front header's inner face over the openings
    pitRoom.push(sweep(track, [[GARAGE_BACK, CEIL], [GARAGE_BACK, REAR_DOOR.h]], ROW0, S1, 4))
    interior.push(sweep(track, [[SHUTTER, DOOR_H], [SHUTTER, CEIL]], ROW0, S1, 4))
    // the header's lane face over the openings, its underside (the door head at 3.0, faces down)
    // and its top (4.6, faces up into the slab void) — the 0.35 m band between the door plane
    // and the pier face would otherwise be a see-through slot up to the 3F soffit (I1 review F2)
    shell.push(sweep(track, [[PIER_FACE, CEIL], [PIER_FACE, DOOR_H]], ROW0, S1, plasterTile))
    downShell.push(sweep(track, [[PIER_FACE, DOOR_H], [SHUTTER, DOOR_H]], ROW0, S1, plasterTile))
    shell.push(sweep(track, [[SHUTTER, CEIL], [PIER_FACE, CEIL]], ROW0, S1, plasterTile))
    // the fascia beam: its underside (faces down, bounce-lit) and its inner face
    downShell.push(sweep(track, [[DRIP, FASCIA_LO], [DRIP - BEAM_DEPTH, FASCIA_LO]], ROW0, S1, plasterTile))
    shell.push(sweep(track, [[DRIP - BEAM_DEPTH, FASCIA_LO], [DRIP - BEAM_DEPTH, CEIL]], ROW0, S1, plasterTile))
    soffits.push(sweep(track, [[DRIP - BEAM_DEPTH, CEIL], [PIER_FACE, CEIL]], ROW0, S1, soffitTile))
    // the fascia: one atlas row per segment — blocks alternate the two panel variants, cores and the media 1F are plain
    const fascia: THREE.BufferGeometry[] = []
    // canvas row `row` counts from the top; a CanvasTexture's v = 0 is the bottom (flipY), so row r is v ∈ [(2 − r) / 3, (3 − r) / 3]
    const band = (a: number, b: number, row: number) => fascia.push(remapV(texturedWall(track, a, b, DRIP, FASCIA_LO, FASCIA_HI, forwardDelta(a, b, L), 1), (2 - row) / 3 + 0.004, (3 - row) / 3 - 0.004))
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) band(track.wrap(garageS(g) - PIT_BLOCK / 2), track.wrap(garageS(g) + PIT_BLOCK / 2), g % 2)
    for (const [a, b] of cores) band(a, b, 2)
    band(ROW0, S0, 2)
    const fm = new THREE.Mesh(mergeGeometries(fascia, false)!, fasciaMat)
    for (const g of fascia) g.dispose()
    fm.name = 'pitFascia'
    fm.receiveShadow = true
    group.add(fm)
    // the rear (pp4s2-4): the pit-room header's paddock face and underside, the 1F canopy over
    // the rear doors — soffit 4.35 at the wall → 3.81 at its edge, a 0.3 m slab whose top meets
    // the 2F wall — and its end plates; the round columns under its edge are instanced below
    rearLower.push(sweep(track, [[WALL_OUT, REAR_DOOR.h], [WALL_OUT, RC.soffit[0]]], ROW0, S1, plasterTile))
    rearLower.push(sweep(track, [[GARAGE_BACK, REAR_DOOR.h], [WALL_OUT, REAR_DOOR.h]], ROW0, S1, plasterTile))
    downShell.push(sweep(track, [[GARAGE_BACK, RC.soffit[0]], [RC.to, RC.soffit[1]]], ROW0, S1, plasterTile))
    rearLower.push(sweep(track, [[RC.to, RC.soffit[1]], [RC.to, RC.soffit[1] + RC_T]], ROW0, S1, plasterTile))
    roof.push(sweep(track, [[RC.to, RC.soffit[1] + RC_T], [REAR_WALL, REAR_BASE]], ROW0, S1, 4))
    const rcOutline: Pt[] = [[GARAGE_BACK, RC.soffit[0]], [RC.to, RC.soffit[1]], [RC.to, RC.soffit[1] + RC_T], [REAR_WALL, REAR_BASE]]
    rearLower.push(sectionPlate(track, ROW0, rcOutline, false), sectionPlate(track, S1, rcOutline, true))
    const rcH = rearSoffitAt(RC.columns.lateral) + 0.3
    const rcGeo = new THREE.CylinderGeometry(RC.columns.d / 2, RC.columns.d / 2, rcH, 12)
    rcGeo.translate(0, rcH / 2 - 0.3, 0)
    const rcM: THREE.Matrix4[] = []
    const rcS: number[] = []
    const rowLen = forwardDelta(ROW0, S1, L)
    for (let d = RC.columns.pitch / 2; d < rowLen; d += RC.columns.pitch) {
      rcM.push(frameAt(track, ROW0 + d, RC.columns.lateral, 0, m4()))
      rcS.push(track.wrap(ROW0 + d))
    }
    for (const inst of bucketedInstancedMeshes(rcGeo, railMat, rcM, null, (i) => Math.floor(rcS[i]! / 60), { name: 'pitRearColumns', receiveShadow: true })) group.add(inst)
  }

  // --- the 2F / 3F body 5590 → 92: back wall, canopy, terraces, media section, link block ----------
  {
    // the paddock wall of the upper floors: facade tiles from the rear canopy's top to the roof
    // (its inner face shows from the 3F terrace, drawn with the terrace below), the 2F window
    // band and the 3F row of small windows 3 cm proud of it, one 19 m block per repeat
    rearUpper.push(sweep(track, [[REAR_WALL, REAR_BASE], [REAR_WALL, canopyTopAt(REAR_WALL)]], ROW0, LINK1, tilesTile))
    const WIN_FACE = REAR_WALL - 0.03
    rearWindows.push(remapV(texturedWall(track, ROW0, LINK1, WIN_FACE, REAR_WINDOWS.band2F[0], REAR_WINDOWS.band2F[1], PIT_BLOCK, -1), 0.5 + 0.004, 1 - 0.004))
    rearWindows.push(remapV(texturedWall(track, ROW0, LINK1, WIN_FACE, REAR_WINDOWS.row3F[0], REAR_WINDOWS.row3F[1], PIT_BLOCK, -1), 0.004, 0.5 - 0.004))
    // the canopy: top (roof colour) with the front lip, underside (white) back to the rear edge
    const lipBack = CANOPY_FRONT - CANOPY_LIP
    const top: Pt[] = [...CANOPY.filter(([x]) => x < lipBack - 0.05), [lipBack, canopyTopAt(lipBack)], [lipBack, canopyTopAt(CANOPY_FRONT) + CANOPY_LIP], [CANOPY_FRONT, canopyTopAt(CANOPY_FRONT) + CANOPY_LIP], [CANOPY_FRONT, canopyUnder(CANOPY_FRONT)]]
    const underCurve: Pt[] = [...CANOPY].reverse().map(([x, y]) => [x, y - CANOPY_T] as Pt)
    roof.push(sweep(track, top, CANOPY0, LINK1, 4))
    downShell.push(sweep(track, underCurve, CANOPY0, LINK1, plasterTile))
    shell.push(sweep(track, [[REAR_WALL, canopyUnder(REAR_WALL)], [REAR_WALL, canopyTopAt(REAR_WALL)]], CANOPY0, LINK1, plasterTile))
    const canopyOutline: Pt[] = [...top, ...underCurve.slice(1)]
    shell.push(sectionPlate(track, CANOPY0, canopyOutline, false), sectionPlate(track, LINK1, canopyOutline, true))

    // 3F terrace 5625 → 88: the wall's inner face, the deck, five rows, the parapet, the 3F soffit
    const t3: Pt[] = [[REAR_WALL + REAR_WALL_T, canopyUnder(REAR_WALL + REAR_WALL_T)], [REAR_WALL + REAR_WALL_T, F3], [T3.deck.lateral, F3]]
    for (let r = T3.rows - 1; r >= 0; r--) {
      const lat = T3.frontRow.lateral - r * ROW3_TREAD
      const y = T3.frontRow.y + r * ROW3_RISER
      t3.push([lat - ROW3_TREAD, y], [lat, y])
    }
    t3.push([T3.frontRow.lateral, PARAPET_TOP], [T3.parapet.lateral, PARAPET_TOP], [T3.parapet.lateral, SOFFIT3])
    shell.push(sweep(track, t3, S0, S1, plasterTile))
    downShell.push(sweep(track, [[T3.parapet.lateral, SOFFIT3], [LOUNGE, SOFFIT3]], S0, S1, plasterTile))
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
    // the 2F drip-line glass rail: two-faced clear plates (railGlassMat, transparent — the seated
    // guests show through, pitph-12 / podium.jpg), a top tube, posts every 1.5 m
    railGlass.push(sweep(track, [[DRIP, F2 + RAIL_H - 0.05], [DRIP, F2 + 0.1]], ROW0, S1, 3), sweep(track, [[DRIP, F2 + 0.1], [DRIP, F2 + RAIL_H - 0.05]], ROW0, S1, 3))
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
    // the hall's glass band on its three outer faces and the 2F bridge over the paddock road
    // (pphi-3: a closed link 5.05 → 8.55 with a window band each side)
    const hallMid = track.wrap((sp.sRange[0] + sp.sRange[1]) / 2)
    const hallLen = sp.sRange[1] - sp.sRange[0]
    const hallDepth = BACK + 0.2 - sp.lateral[1]
    boxes.place(hallMid, (BACK + 0.2 + sp.lateral[1]) / 2, hallLen + 0.06, hallDepth + 0.06, 2.0, glassMat, 1.2, true, false)
    const br = V2.spur.bridge
    const brMid = track.wrap((br.sRange[0] + br.sRange[1]) / 2)
    const brLen = br.sRange[1] - br.sRange[0]
    const brDepth = br.lateral[0] - br.lateral[1]
    boxes.place(brMid, (br.lateral[0] + br.lateral[1]) / 2, brLen, brDepth, br.y[1] - br.y[0], shellMat, br.y[0], true, true)
    boxes.place(brMid, (br.lateral[0] + br.lateral[1]) / 2, brLen + 0.06, brDepth - 1.0, 1.4, glassMat, br.y[0] + 1.0, true, false)
  }

  // --- the pods: the control tower (final corner) and the T1 nose --------------------------------------
  {
    // The control pod is the whole final-corner end of the 2F / 3F volume: a bullet nose rounded
    // in plan and elevation, its tip on the glass band's mid line, sitting on the 1F cap. Its
    // top (POD.top 12.5, pphi-4 / ct-13) stays UNDER the canopy, which runs over the pod's
    // shoulder from CANOPY0 — the nose protrudes — so there is no tail easing (I1 review V6).
    const bandY = POD.band
    const pod: PodLoftParams = {
      track, s0: POD0, s1: ROW0 - 0.02, front: DRIP + 0.9, back: BACK + 1.2,
      bottom: F2, mid: (bandY[0] + bandY[1]) / 2, top: POD.top,
      nose: { plan: 18, top: 9, bottom: 6 }, tail: null, tile: plasterTile, band: null,
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
    // white frames and a pale, barely metallic pane (pitbox.jpg / podium.jpg: white-framed,
    // near-clear leaves — the dark frame + reflective glassMat read as black slabs beside the
    // light piers, I1 review V10); a plain colour, so the same program as glassMat
    const leafPaneMat = new THREE.MeshStandardMaterial({ color: 0xc9d5dc, roughness: 0.15, metalness: 0.2, envMapIntensity: 1.2 })
    for (const inst of bucketedInstancedMeshes(leafGeo, [railMat, leafPaneMat], leafM, null, (i) => Math.floor(leafS[i]! / 60), { name: 'pitDoorLeaves', receiveShadow: true })) group.add(inst)
    // number plates (odd scheme, PIT_BUILDING.v2.plates): plate n centred on the +s pier of pit
    // n, on the pier's lane face at y 2.3 — below the fascia beam (FASCIA_LO 2.85 on the drip
    // line) so the TV / onboard / grandstand lenses see it (podium.jpg puts the plates on the
    // piers; on the header at 3.55 they were hidden behind the beam from every camera)
    const plateGeo = new THREE.PlaneGeometry(0.35, 0.35).rotateY(Math.PI / 2)
    const PLATE_Y = 2.3
    const plate = (n: number, pierS: number) => {
      const p = atlasUv(plateGeo.clone(), n)
      p.applyMatrix4(frameAt(track, pierS, PIER_FACE + 0.02, PLATE_Y, m4()))
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
    doorPlate.applyMatrix4(frameAt(track, cores[5]![0] + 1.5, PIER_FACE + 0.02, PLATE_Y, m4()))
    add([door, doorPlate], doorMat, 'pitPodiumDoor', false)
    // the chequered backdrop on the concrete wall's terrace face, the three black steps in front
    // of it (P1 centre, P2 / P3 either side) and the event banner over the bay's fascia
    const [bw, bh] = podium.backdrop
    const backdrop = remapV(new THREE.PlaneGeometry(bw - 0.1, bh - 0.1).rotateY(Math.PI / 2), 0.5 + 0.004, 1 - 0.004)
    backdrop.applyMatrix4(frameAt(track, podium.s, LOUNGE + 0.15 + 0.15 + 0.02, F2 + 0.3 + (bh - 0.1) / 2, m4()))
    podiumGeos.push(backdrop)
    for (const [ds, h] of ROSTRUM.steps) boxes.place(podium.s + ds, ROSTRUM.lateral, ROSTRUM.size, ROSTRUM.size, h, darkMat, F2, true, false)
    const banner = remapV(new THREE.PlaneGeometry(podium.width, FASCIA_HI - FASCIA_LO - 0.1).rotateY(Math.PI / 2), 0.004, 0.5 - 0.004)
    banner.applyMatrix4(frameAt(track, podium.s, DRIP + 0.03, (FASCIA_LO + FASCIA_HI) / 2, m4()))
    podiumGeos.push(banner)
    // the scrutineering band on the caps' plain fascia (plan I1-b: PIT_TEXTS' cap band, PIT_BUILDING.v2.plates.capText)
    const capMid = track.wrap(ROW0 + forwardDelta(ROW0, S0, L) / 2)
    const capBand = new THREE.PlaneGeometry(10, 0.8).rotateY(Math.PI / 2)
    capBand.applyMatrix4(frameAt(track, capMid, DRIP + 0.03, (FASCIA_LO + FASCIA_HI) / 2, m4()))
    add([capBand], boardMat(capBandTexture(k)), 'pitCapBand', false)

    // --- the interiors (PIT_BUILDING.v2.interior, pitbox.jpg) ------------------------------------
    // side walls: one expanded-metal plate on every block boundary (DoubleSide cutout, metre UVs
    // from the plate's own lateral / height coordinates)
    const sideWall: Pt[] = [[SHUTTER, 0.025], [GARAGE_BACK, 0.025], [GARAGE_BACK, CEIL], [SHUTTER, CEIL]]
    const plateS = new Set<number>()
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) for (const e of [garageS(g) - PIT_BLOCK / 2, garageS(g) + PIT_BLOCK / 2]) plateS.add(Math.round(track.wrap(e) * 100) / 100)
    for (const s of plateS) garageMesh.push(sectionPlate(track, s, sideWall, true))
    // the ceiling strips (EMISSIVE.garageStrip), three rows per block
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) for (const lat of INT.strips) boxes.place(garageS(g), lat, PIT_BLOCK - 6, 0.5, 0.12, lampMat, CEIL - 0.1, true, false)
    // the team-colour band along the floor's front edge: one instance per team block, 12 mm
    // above the floor (≥ LAYER_MIN_STEP: the low tier has no polygon offset)
    const bands: { m: THREE.Matrix4; color: THREE.Color }[] = []
    for (let g = 0; g < blocks.length; g++) bands.push({ m: boxes.matrix(garageS(g), SHUTTER - INT.teamBand / 2, 0.012, 0.025, true, m4()), color: new THREE.Color(blocks[g]!.body) })
    boxes.instanced(PIT_BLOCK - 2 * BLOCK_PIER, INT.teamBand, 0.012, bands, 0.5, false, 'pitInteriorBands')
    // the pit-room wall: piers between the rear doors on every pier position of the row, the
    // cores and the media stub solid; the doors open (a rolled shutter under the header) on the
    // team blocks, closed ribbed shutters on block 12 and the caps
    const rearPierW = PIT_BOX - REAR_DOOR.w
    for (const s of piers.keys()) boxes.place(s, GARAGE_BACK - INT.wallT / 2, rearPierW, INT.wallT, REAR_DOOR.h, pitRoomMat, 0, true, false)
    for (const [a, b] of cores) boxes.place(track.wrap(a + forwardDelta(a, b, L) / 2), GARAGE_BACK - INT.wallT / 2, forwardDelta(a, b, L) - rearPierW, INT.wallT, REAR_DOOR.h, pitRoomMat, 0, true, false)
    if (stub > 0.05) boxes.place(ROW0 + stub / 2, GARAGE_BACK - INT.wallT / 2, stub, INT.wallT, REAR_DOOR.h, pitRoomMat, 0, true, false)
    const rearShutter = new THREE.PlaneGeometry(REAR_DOOR.w, REAR_DOOR.h)
    for (const o of openings) {
      if (o.team) {
        boxes.place(o.s, GARAGE_BACK - INT.wallT / 2, REAR_DOOR.w, 0.35, 0.35, darkMat, REAR_DOOR.h - 0.35, true, false)
        continue
      }
      for (const [lat, facing] of [[GARAGE_BACK - 0.05, 1], [WALL_OUT + 0.05, -1]] as const) {
        const g = rearShutter.clone().rotateY((facing * Math.PI) / 2)
        const uv = g.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * REAR_DOOR.w) / shutterTile, (uv.getY(i) * REAR_DOOR.h) / shutterTile)
        g.applyMatrix4(frameAt(track, o.s, lat, REAR_DOOR.h / 2, m4()))
        shutters.push(g)
      }
    }
    // the equipment: prototypes (pack model as the near level where the tier draws GLBs, the
    // procedural box always — plan §横断 4), placed per block in the garage frame (x across
    // the track, z along it), every piece at lateral ≤ INT.equipmentFront. A pack prototype
    // comes with its long side along local x (`orientPack`), so the procedural stand-in of a
    // GLB-or-proc pair is built the same way and both are placed with the quarter turn `Q`
    const box = (w: number, h: number, d: number, mat: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0) => {
      const g = new THREE.BoxGeometry(w, h, d)
      g.translate(x, y + h / 2, z)
      return { geometry: g, material: mat }
    }
    /** a procedural prototype from parts, the parts of one material merged first (one group = one draw per material) */
    const proc = (id: string, parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[]) => {
      const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
      for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p.geometry.index ? p.geometry.toNonIndexed() : p.geometry])
      return procProp(id, [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0]! : mergeGeometries(geos, false)! })))
    }
    const dark = plain(0x2c2f33, 0.6, 0.3)
    const steel = plain(0x8a8f95, 0.5, 0.6)
    const red = plain(0x9b1c1c, 0.5, 0.3)
    const blue = plain(0x2b5bb0, 0.6, 0.1)
    const wood = plain(0x8a7452, 0.9, 0)
    const toolWall = proc('tool-wall', [box(0.6, 2.0, 3.0, dark), box(0.62, 0.04, 3.02, steel, 0, 0.98), box(0.62, 0.04, 3.02, steel, 0, 1.48)])
    const cabinetProc = proc('roll-cabinet', [box(0.75, 1.0, 0.5, red), box(0.77, 0.03, 0.52, dark, 0, 1.0)])
    const cabinet = glbOr(ctx, 'model/props/metal_tool_chest', { front: 'none', scaleTo: { height: 1.0 } }, cabinetProc)
    const shelfParts = [box(1.2, 0.03, 0.5, steel, 0, 0.3), box(1.2, 0.03, 0.5, steel, 0, 0.9), box(1.2, 0.03, 0.5, steel, 0, 1.5)]
    for (const x of [-0.58, 0.58]) for (const z of [-0.24, 0.24]) shelfParts.push(box(0.03, 1.8, 0.03, steel, x, 0, z))
    const shelvesProc = proc('shelves', shelfParts)
    const shelves = glbOr(ctx, 'model/props/steel_frame_shelves_01', { front: 'none', scaleTo: { height: 1.8 } }, shelvesProc)
    const blanket = procProp('tyre-blanket', [{ geometry: new THREE.CylinderGeometry(0.37, 0.37, 0.92, 16).translate(0, 0.46, 0), material: plain(0xffffff, 0.8, 0) }])
    const tyre = (() => {
      // an F1 tyre lying flat (LatheGeometry, six profile points → tyreMaps' v bands: inner sidewall, shoulder, tread, shoulder, outer sidewall)
      const r = 0.36, rim = 0.23, wdt = 0.305
      const pts = [[rim, 0], [r - 0.05, 0], [r, 0.04], [r, wdt - 0.04], [r - 0.05, wdt], [rim, wdt]].map(([x, y]) => new THREE.Vector2(x, y))
      const maps = tyreMaps('M', COMPOUND_COLORS.M)
      const mat = new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap ?? null, roughnessMap: maps.roughnessMap ?? null, roughness: 1, metalness: 0 })
      return procProp('tyre', [{ geometry: new THREE.LatheGeometry(pts, 20), material: mat }])
    })()
    const desk = proc('monitor-desk', [box(0.7, 0.85, 2.4, dark), box(0.72, 0.03, 2.42, steel, 0, 0.85)])
    const monitorProc = proc('monitor-wall', [box(2.4, 1.4, 0.08, monitorMat), box(0.05, 1.4, 0.06, dark, -1.1, 0, 0.02), box(0.05, 1.4, 0.06, dark, 1.1, 0, 0.02)])
    const monitors = glbOr(ctx, 'model/pit/pc_monitors', { front: 'none', scaleTo: { long: 2.4 } }, monitorProc)
    const truss = (() => {
      const g = latticeGeometry({ height: 17, baseHalf: 0.15, topHalf: 0.15, panel: 1.0, leg: 0.03, ring: 0.02, brace: 0.02, braces: quality.infield.detail })
      g.rotateX(Math.PI / 2)
      g.translate(0, 0.15, -8.5)
      return procProp('lighting-truss', [{ geometry: g, material: plain(0x1f2124, 0.5, 0.6) }])
    })()
    const drum = procProp('cable-drum', [{ geometry: new THREE.CylinderGeometry(0.4, 0.4, 0.5, 14).rotateX(Math.PI / 2).translate(0, 0.4, 0), material: wood }])
    const crateProc = procProp('crate', [box(0.6, 0.35, 0.4, blue)])
    const crate = glbOr(ctx, 'model/props/plastic_crate_02', { front: 'none', scaleTo: { long: 0.6 } }, crateProc)
    const sets = new Map<PropProto, PropSet>()
    const set = (proto: PropProto, far?: PropProto) => {
      let ps = sets.get(proto)
      if (!ps) sets.set(proto, (ps = { proto, placements: [] as PropPlacement[], ...(far && far !== proto ? { far } : {}) }))
      return ps
    }
    const put = (ps: PropSet, s: number, lat: number, y: number, yaw = 0, color?: THREE.Color, along = 0) => {
      const m = frameAt(track, s, lat, y, m4())
      if (yaw) m.multiply(new THREE.Matrix4().makeRotationY(yaw))
      // a long piece follows the road's fall along s like the ceiling above it (frameAt is level)
      if (along > 0) {
        const grade = (track.pointAt(s + along / 2, lat, _a, 0).y - track.pointAt(s - along / 2, lat, _b, 0).y) / along
        m.multiply(new THREE.Matrix4().makeRotationX(-Math.atan(grade)))
      }
      ps.placements.push(color ? { m, color } : { m })
    }
    const _a = new THREE.Vector3(), _b = new THREE.Vector3()
    const Q = Math.PI / 2
    for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
      const c = garageS(g)
      const team = blocks[g]
      put(set(shelves, shelvesProc), c + 8.5, -44.5, 0.025, Q)
      put(set(shelves, shelvesProc), c + 8.5, -46.2, 0.025, Q)
      put(set(desk), c, -51.2, 0.025)
      put(set(monitors, monitorProc), c, -51.2, 0.875, Q)
      put(set(truss), c, -40.3, 4.25, 0, undefined, 17)
      for (const [ds, dy] of [[-3, 0], [-3.65, 0], [-3, 0.35], [-3.65, 0.35]]) put(set(crate, crateProc), c + ds!, -49.6, 0.025 + dy!, Q)
      if (!team) continue
      const colour = new THREE.Color(team.body)
      put(set(toolWall), c - 7, -47, 0.025)
      put(set(toolWall), c + 7, -47, 0.025)
      put(set(cabinet, cabinetProc), c - 8.5, -41, 0.025, Q)
      put(set(cabinet, cabinetProc), c - 8.5, -43, 0.025, Q)
      put(set(cabinet, cabinetProc), c + 8.5, -41, 0.025, Q)
      for (const [ds, lat] of [[-7, -33], [-7, -36], [7, -33], [7, -36], [-5.5, -34.5], [5.5, -34.5]]) {
        put(set(blanket), c + ds!, lat!, 0.025, 0, colour)
        put(set(tyre), c + ds!, lat!, 0.025 + 0.92)
      }
      put(set(drum), c + 3.5, -49.5, 0.025)
      put(set(drum), c + 4.5, -49.5, 0.025)
    }
    registerPropSet(ctx, 'ops', 'ops-garage', [...sets.values()], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: true })
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
      const pitch = V2.guests.seatPitch
      const n = Math.floor(len / pitch)
      const start = s0 + (len - (n - 1) * pitch) / 2
      for (let i = 0; i < n; i++) {
        const s = start + i * pitch
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
        // two black lattice pylons from the canopy's top to the panel's top edge (ROOF.pylon), the panel box between them
        bottom = sc.base
        const roofY = canopyTopAt(sc.lateral)
        const pylonH = sc.base + sc.height - roofY
        for (const ds of [-sc.width / 2 + 0.5, sc.width / 2 - 0.5]) {
          const g = latticeGeometry({ height: pylonH, baseHalf: ROOF.pylon.half, topHalf: ROOF.pylon.half, panel: ROOF.pylon.panel, leg: 0.07, ring: 0.05, brace: 0.035, braces: quality.infield.detail })
          g.applyMatrix4(frameAt(track, sc.s + ds, sc.lateral, roofY - 0.05, m4()))
          pylons.push(g)
        }
        boxes.place(sc.s, sc.lateral, sc.width - 1.6, 1.2, sc.height, darkMat, sc.base, true)
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
    add(pylons, darkMat, 'pitScreenPylons', true)
  }

  // --- the roof plant: HVAC boxes on the canopy over the first ten blocks, three antennas over the media section
  {
    const hv = ROOF.hvac
    for (let i = 0; i < hv.n; i++) {
      const s = garageS(i % PIT_GARAGE_COUNT) + 4
      boxes.place(s, hv.lateral, hv.size[0], hv.size[1], hv.size[2], hvacMat, canopyTopAt(hv.lateral) - 0.04, true, true)
    }
    const an = ROOF.antennas
    for (let i = 0; i < an.n; i++) {
      const s = an.s + (i - (an.n - 1) / 2) * an.pitch
      const base = canopyTopAt(an.lateral) - 0.05
      boxes.place(s, an.lateral, 0.08, 0.08, an.h, darkMat, base, true, false)
      for (const dy of [an.h - 0.4, an.h - 1.0, an.h - 1.6]) boxes.place(s, an.lateral, 0.03, 0.8 - (an.h - dy) * 0.15, 0.03, darkMat, base + dy, true, false)
    }
  }

  // --- the terrace guests (figures.ts terraceSlots): seated on the 2F / 3F rows of the team blocks
  buildOpsFigures(ctx, terraceSlots(track), 'ops-terrace')

  // --- merge the building's meshes --------------------------------------------------------------------
  add(shell, shellMat, 'pitShell', true)
  add(downShell, soffitShellMat, 'pitShellSoffit', true)
  add(roof, buildingRoofMat, 'pitCanopy', true)
  add(glass, glassMat, 'pitGlass', false)
  add(railGlass, railGlassMat, 'pitRailGlass', false)
  add(bandGlass, bandGlassMat, 'controlPodGlass', false)
  add(darkGlass, darkGlassMat, 'pitDarkGlass', false)
  add(floor, floorMat, 'pitInterior', false)
  add(ceiling, ceilingMat, 'pitInteriorCeiling', false)
  add(interior, interiorMat, 'pitInteriorWalls', false)
  add(pitRoom, pitRoomMat, 'pitInteriorRoom', false)
  add(garageMesh, meshMat, 'pitInteriorMesh', false)
  add(rearLower, shellMat, 'pitRearLower', true)
  add(rearUpper, tilesMat, 'pitRearUpper', true)
  add(rearWindows, windowMat, 'pitRearWindows', false)
  add(podiumGeos, podiumMat, 'pitPodium', false)
  add(soffits, soffitMat, 'pitSoffit', false)
  add(shutters, shutterMat, 'pitShutters', false)
  add(plates, doorMat, 'pitPlates', false)
  add(rails, railMat, 'pitRails', false)

  return { buildingRoofMat }
}
