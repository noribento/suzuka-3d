import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { COLOURS, GARAGE_ORDER, PIT_BLOCK, PIT_BOX_STRIP, PIT_BUILDING, PIT_GARAGE_COUNT, SCREENS, garageS } from '~/data/suzuka-facilities-spec'
import { OSM_PIT_BUILDING } from '~/data/suzuka-facilities'
import { forwardDelta, signedDelta } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { bucketedInstancedMeshes } from './instancing'
import {
  addMerged, canvas, chequer, clipD, frameAt, label, PANEL_COLOURS, PIT_TEXTS, pitMaterials, podLoft, sectionPlate, sweep, tex, texturedWall, trackCoords, trackPrism, tube, type Pt,
} from './pit-geometry'

/**
 * The pit building (plan I1), built from the OSM footprint (way 184422099) and the hand-authored
 * spec — v1 section until I1-b rebuilds it from the 2009 drawings (PIT_BUILDING v2):
 *
 * - the body is SWEPT IN TRACK COORDINATES (s along the lap, lateral across) so its floors,
 *   terraces and roof follow the 2.8 % fall of the pit straight the way the real apron does (the
 *   DEM shows the building is laterally level but drops 9.7 m end to end);
 * - the two rounded / chamfered end caps and the rear service spur are prisms over the OSM
 *   vertices, also placed per vertex on the track surface so they meet the swept body;
 * - the white streamlined control-tower pod on the final-corner roof (`podLoft`), the garages
 *   (piers, doors, plates, placeholder interiors), the podium recess on the 2F terrace, the
 *   terrace seats / railings / roof columns and the seven screens (three on the roof, four
 *   trackside on posts — SCREENS.mount).
 *
 * Everything static and single-material is merged; repeated pieces (terrace seats, railing
 * posts) are instanced per 60 m bay so the follow cameras can cull them. Shadow policy: shell /
 * roof / caps / pod cast + receive; seats, railings, interior props, lamps, doors, screens and
 * glass receive only. The pit wall, the Leader Tower and the perches are pit-lane.ts, the
 * paddock behind is paddock.ts; the materials the three share come from `pitMaterials(ctx)`.
 *
 * Returns the roof material because the marshal huts (props.ts) and the paddock reuse it for
 * their roofs, which keeps them in the same merged mesh.
 */

// ---------------------------------------------------------------- section constants (metres, v1)

const FRONT = PIT_BUILDING.front // −25.1: garage doors and piers
const BACK = PIT_BUILDING.back // −56.7: paddock face
const F2 = PIT_BUILDING.floors[1] // 7.8: 2F terrace deck
const F3 = PIT_BUILDING.floors[2] // 12.3: 3F terrace deck
const ROOF = PIT_BUILDING.roofTop // 15.5
const DOOR_H = PIT_BUILDING.garage.doorHeight // 4.1
const PIER = PIT_BUILDING.garage.pier // 0.95
const BOX = PIT_BUILDING.garage.boxPitch // 7.083
// One team block of the 2009 dossier (4 pits × 4.75 m); the 7 m cores between the 8-pit groups
// are not modelled yet — the swept body, doors and interiors below still assume a uniform pitch
// (I1 rebuilds the section from the dossier).
const PITCH = PIT_BLOCK // 19
/** half a bay of terrace seating either side of the block centre */
const BAY_HALF = PITCH / 2 - 0.5
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

// ---------------------------------------------------------------- canvas textures

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
      label(ctx, PIT_TEXTS[i]!, x + slot / 2, h / 2, 62, '#ffffff', 900, 'center', slot - 40)
    } else if (kind === 3) {
      // a blank white box with the thin seam lines of the real cladding
      ctx.fillStyle = 'rgba(0,0,0,0.06)'
      ctx.fillRect(x + 8, h / 2 - 1, slot - 16, 2)
    } else {
      label(ctx, PIT_TEXTS[i]!, x + slot / 2, h / 2, 64, kind === 0 ? '#1d1f22' : COLOURS.circuitRed.lit, 900, 'center', slot - 28)
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

// ---------------------------------------------------------------- the builder

export function buildPitBuilding(ctx: EnvBuildContext): { buildingRoofMat: THREE.MeshStandardMaterial } {
  const { track, ground, group, boxes, quality } = ctx
  const L = track.length
  const k = quality.textureScale
  const { plasterTile, shellMat, podMat, pierMat, buildingRoofMat, glassMat, darkMat, interiorMat, railMat, seatMat, lampMat, boardMat } = pitMaterials(ctx)
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTexture(k), roughness: 0.55 })
  const rearMat = new THREE.MeshStandardMaterial({ map: rearTexture(k), roughness: 0.7 })
  const doorMat = new THREE.MeshStandardMaterial({ map: doorAtlas(k), roughness: 0.6 })
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)

  // --- extents: the box strip (12 blocks + 6 cores, 270 m) sets the swept body, the caps take the rest
  const S0 = track.wrap(PIT_BOX_STRIP[0]) // 5625, final-corner end
  const S1 = track.wrap(PIT_BOX_STRIP[1]) // 88, T1 end
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
    // podium; bay 12 is the control tower, see above). Flanks just proud of the fascia and inside
    // the paddock wall: the real pod does not overhang the terraces, and a narrower body keeps
    // the nose from reading as a bulb. The top eases down to the roof upturn over the last 6 m
    // so the tail meets the roof without a step.
    const geo = podLoft({
      track, s0: PIT_BUILDING.controlPod.sRange[0], s1: podS0 - 0.02,
      front: FASCIA_FACE + 0.9, back: BACK + 1.2,
      bottom: FASCIA_TOP, mid: 10, top: PIT_BUILDING.controlPod.top,
      nose: { plan: 18, top: 18, bottom: 9 }, tail: { top: ROOF + 0.4, ease: 6 }, tile: plasterTile,
    })
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
    // boxes at the old uniform pitch over the strip, number 1 at the T1 end; box k (from the
    // final-corner end) starts at S0 + k·BOX (placeholder until I1 lays out the 4.75 m pits and cores)
    const nBoxes = Math.floor(stripLen / BOX)
    for (let kk = 0; kk <= nBoxes; kk++) {
      const sb = S0 + kk * BOX
      boxes.place(sb, FRONT - 0.3, PIER, 0.6, DOOR_H, pierMat, 0, true)
      if (kk === nBoxes) break
      const num = nBoxes - kk
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
      const spans: [number, number][] = g === PIT_GARAGE_COUNT - 1 ? [[podS1 + 0.6, c + BAY_HALF]] : [[c - 7.2, c + 7.2]]
      for (const [a, b] of spans) {
        for (let r = 0; r < ROWS; r++) {
          const lat = STEPS_BACK + r * TREAD + 0.42
          seatRow(a, b, lat, STEP_TOP - (r + 1) * RISER)
        }
      }
      // 3F: two rows along the open terrace (none in the pod)
      const a3 = signedDelta(podS0, c - BAY_HALF, L) < 0 ? podS0 + 0.5 : c - BAY_HALF
      if (signedDelta(a3, c + BAY_HALF, L) > 2) for (const lat of [-23.1, -24.1]) seatRow(a3, c + BAY_HALF, lat, F3)
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

  // --- the screens: three on the pit-building roof, four trackside on posts (SCREENS.mount) -------
  // One material and one merged face mesh for all of them, whichever way they are mounted.
  {
    const screenMat = boardMat(screenTexture(k), 0.9)
    const faces: THREE.BufferGeometry[] = []
    for (const sc of SCREENS) {
      /** height of the panel's bottom above the road plane at (s, lateral) */
      let bottom: number
      if (sc.mount === 'roof') {
        // TODO(I1-b): a roof screen whose base is below the v1 roof slab (the paddock screen on
        // the v2 canopy's rear edge) has no frame to stand on yet — skipped until the canopy lands
        if (sc.base < ROOF + 0.3) continue
        bottom = sc.base
        const frame = sc.base - ROOF // frame height above the roof slab
        for (const ds of [-sc.width / 2 + 0.3, sc.width / 2 - 0.3]) for (const dl of [-0.4, 0.4]) boxes.place(sc.s + ds, sc.lateral + dl, 0.3, 0.3, frame, darkMat, ROOF, true, false)
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
      front.applyMatrix4(frameAt(track, sc.s, sc.lateral + toward * 0.62, bottom + sc.height / 2, new THREE.Matrix4()))
      faces.push(front)
      if (sc.faces === 2) {
        const rear = new THREE.PlaneGeometry(sc.width - 0.4, sc.height - 0.4).rotateY(-Math.PI / 2)
        rear.applyMatrix4(frameAt(track, sc.s, sc.lateral - 0.62, bottom + sc.height / 2, new THREE.Matrix4()))
        faces.push(rear)
      }
    }
    add(faces, screenMat, 'pitScreens', false)
  }


  // --- merge the building shells --------------------------------------------------------------------
  add(shell, shellMat, 'pitShell', true)
  add(roof, buildingRoofMat, 'pitRoof', true)
  add(glass, glassMat, 'pitGlass', false)
  add(interior, interiorMat, 'pitInterior', false)
  add(rails, railMat, 'pitRails', false)

  return { buildingRoofMat }
}
