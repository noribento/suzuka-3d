import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COMPOUND_COLORS, TEAMS } from '~/data/drivers'
import { PIT_EQUIPMENT, fromStop, perchOnPlatform, pitEquipmentPlacements, type OpsPlacement } from '~/data/ops-spec'
import { EMISSIVE, emissiveScale } from './emissive'
import type { EnvBuildContext } from './environment'
import { registerPropSet, type PropPlacement, type PropSet } from './infield-lod'
import type { OpsPartial } from './ops'
import { frameAt } from './pit-geometry'
import { glbOr, procProp, propMaterial, type PropProto } from './props-pack'
import { tyreMaps } from './textures'

/**
 * The ops layer's pit-lane equipment (plan I3-c), drawn from `pitEquipmentPlacements()`
 * (ops-spec section C — every row a footprint the guard checks; nothing here invents a
 * coordinate, the sub-parts that hang on a row read `PIT_EQUIPMENT`):
 *
 *  - per team block on the apron: the gantry (two 0.25² posts on the garage side of the stopped
 *    car, a beam along s between their tops, two arms across the car at the wheel lines that
 *    reach `laneReach` past the stop line but never past the keep-out edge, the signal box with
 *    its four lamps under the front arm, the four wheel guns on their hoses under the arms —
 *    the guns are the one thing over the stopped-car rectangle, 1.15 m up), three tyre stacks
 *    (a team-colour blanket, `instanceColor`, with a bare tyre on top — `tyreMaps` like the
 *    garage stacks), the front / rear jacks, the fuel drum + hose trolley inside the garage,
 *    the monitor stand (two screens on a frame, `EMISSIVE.opsMonitor`);
 *  - per core: five green cones in front of its doors, the cable ramps (yellow / black, 1 m
 *    segments) across the apron on its centre line, 10 mm over the concrete (≥ LAYER_MIN_STEP;
 *    InstancedMesh, so G8 skips them);
 *  - one wheeled extinguisher in front of every pit's +s pier (48);
 *  - the pit-wall perches v2 (mount 'wall'): an aluminium tube frame 5.5 × 1.3 × 2.6 on the
 *    walkway (1.0 wide on the fixed platform's deck between its parapet and the wall), the
 *    floor at +1.0, the desk with four monitors facing the seated crew, three stools (seat
 *    +1.45 — I3-d's `perchSeats` sit there), the team-colour canopy (`instanceColor`), two
 *    umbrellas on the walkway just past the frame's ends; a pit board propped upright beside each; the fixed platform's
 *    two TV cameras on tripods and a monitor stand. pit-lane.ts's v1 perches are gone.
 *
 * Prototypes: a pack model as the near level where the tier draws GLBs (`glbOr`: impact
 * wrench, trolley jack, pc monitors, pit board, fire extinguisher, cone pack, security camera)
 * over the procedural stand-in that Node and the low tier always draw; GLB / procedural pairs
 * are built with their long side along local x (`orientPack`'s PCA) and both placed with the
 * same quarter turn `Q`, the procedural-only pieces straight in the track frame (x = +lateral,
 * z = +s). Instanced per 250 m cell through `registerPropSet(ctx, 'ops', …)` as four sets —
 * `ops-pitEquipment`, `ops-perches`, `ops-cones`, `ops-cables` — with `Quality.infield.propsNearM`
 * / `propsFarM`, receive-only (nothing here is building-class, plan §横断 6). Materials: plain
 * colours through `propMaterial` (shared), two emissives (the screens: `opsMonitor`; the green
 * lamps: `pitExitLight`) as plain colours with an emissive uniform, the tyre's map / normal /
 * roughness set — no new program combination (§横断 7). Reports every row as `equipment`.
 */

const Q = Math.PI / 2
const _t = new THREE.Matrix4()
const _r = new THREE.Matrix4()

/** the garage-floor height in the road frame (pit-building.ts pitInterior) */
const INTERIOR_FLOOR = 0.025
/** the cable ramps' lift over the apron: ≥ LAYER_MIN_STEP (8 mm) so the low tier's log depth keeps them above the concrete */
const RAMP_LIFT = 0.01

type Part = { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }

export function buildOpsPit(ctx: EnvBuildContext): OpsPartial {
  const { track, ground, quality } = ctx
  const rows = pitEquipmentPlacements()
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const box = (w: number, h: number, d: number, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0): Part => ({ geometry: new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), material })
  const cyl = (r: number, h: number, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0, seg = 8, open = false): Part => ({ geometry: new THREE.CylinderGeometry(r, r, h, seg, 1, open).translate(x, y + h / 2, z), material })
  /** a procedural prototype: the parts of one material merged first (one group = one draw per material) */
  const proc = (id: string, parts: Part[]): PropProto => {
    const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
    for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p.geometry.index ? p.geometry.toNonIndexed() : p.geometry])
    return procProp(id, [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0]! : mergeGeometries(geos, false)! })))
  }

  // --- materials -------------------------------------------------------------------------------------
  const dark = plain(0x24272b, 0.6, 0.3)
  const steel = plain(0x8d9298, 0.45, 0.6)
  const alu = plain(0xc9ccd0, 0.35, 0.7)
  const white = plain(0xffffff, 0.8, 0)
  const red = plain(0xc8201c, 0.5, 0.2)
  const yellow = plain(0xe8b400, 0.7, 0.1)
  const black = plain(0x141414, 0.8, 0.1)
  const green = plain(0x2f9e4a, 0.7, 0.05)
  const grey = plain(0x9a9ea2, 0.6, 0.2)
  const es = emissiveScale()
  /** a lit screen: a dark blue face with the opsMonitor glow (a plain colour + an emissive uniform — no map) */
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 0.35, metalness: 0.1, emissive: EMISSIVE.opsMonitor.color, emissiveIntensity: EMISSIVE.opsMonitor.intensity * es })
  /** the gantry's 'go' lamps: the pit-exit signal's green, sub-threshold */
  const lampOnMat = new THREE.MeshStandardMaterial({ color: 0x1a6a30, roughness: 0.4, emissive: EMISSIVE.pitExitLight.color, emissiveIntensity: EMISSIVE.pitExitLight.intensity * es })
  const lampOffMat = plain(0x5a1010, 0.4, 0.1)
  const tyreMat = (() => {
    const maps = tyreMaps('M', COMPOUND_COLORS.M)
    return new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap ?? null, roughnessMap: maps.roughnessMap ?? null, roughness: 1, metalness: 0 })
  })()

  // --- prototypes ------------------------------------------------------------------------------------
  const P = PIT_EQUIPMENT
  const G = P.gantry
  const gantryPost = proc('gantry-post', [box(G.post, G.h, G.post, steel), box(G.post + 0.15, 0.02, G.post + 0.15, dark)])
  /**
   * The gantry's top, one prototype in the beam row's frame (origin = the row's centre lateral,
   * y = the arms' underside): the beam along s on the garage-side line `gx.g` (the posts'
   * centres), the arms across at the wheel lines out to `gx.l`, the signal box under the front
   * arm over the stop line `gx.s`, the hoses down to the guns' tops. Every beam row has the
   * same shape (the offsets are the table's), so one prototype serves all blocks.
   */
  const beamRow = rows.find((r) => r.id.startsWith('gantry-beam'))
  const gx = beamRow ? { g: fromStop(G.dLat) - beamRow.lateral, s: fromStop(0) - beamRow.lateral, l: fromStop(G.laneReach) - beamRow.lateral } : { g: 0, s: 0, l: 0 }
  const gantryTop = (() => {
    const beamY = beamRow?.y ?? 0
    const parts: Part[] = [box(G.beam, G.beam, 2 * G.dS, steel, gx.g, G.arm.section, 0)]
    for (const z of G.arm.dS) parts.push(box(Math.max(0.3, gx.l - gx.g), G.arm.section, G.arm.section, steel, (gx.g + gx.l) / 2, 0, z))
    // the signal box: hanging under the front arm, its lamps on the face towards the driver (−s)
    const [lw, lAcross, lh] = G.lights.size
    const lightBase = G.lights.top - lh - beamY
    parts.push(box(lAcross, lh, lw, dark, gx.s, lightBase, G.lights.dS))
    for (let i = 0; i < G.lights.lamps; i++) {
      const col = i % 2, tier = Math.floor(i / 2)
      const lamp = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8).rotateX(Q).translate(gx.s + (col - 0.5) * 0.16, lightBase + 0.1 + tier * 0.16, G.lights.dS - lw / 2 - 0.015)
      parts.push({ geometry: lamp, material: tier === 0 ? lampOnMat : lampOffMat })
    }
    // the hoses: from the arms' underside down to the guns' tops
    const gunTop = G.guns.bottom + G.guns.size[2] - beamY
    for (const z of G.arm.dS) for (const dLat of G.guns.dLat) parts.push(cyl(0.012, -gunTop, dark, gx.s + dLat, gunTop, z, 4, true))
    return proc('gantry-top', parts)
  })()
  const gunProc = proc('wheel-gun', [box(G.guns.size[0], G.guns.size[2], G.guns.size[1], dark, 0, -G.guns.size[2] / 2), cyl(0.03, 0.08, steel, G.guns.size[0] / 2, -0.04, 0, 6)])
  const gun = glbOr(ctx, 'model/pit/impact_wrench', { id: 'wheel-gun-glb', nodes: /\/Object_2(\/|$)/, scaleTo: { long: G.guns.size[0] }, front: 'none', origin: 'centre' }, gunProc)
  const blanket = proc('tyre-blanket', [cyl(0.36, 1.0, white, 0, 0, 0, 16)])
  const tyreTop = (() => {
    const r = 0.36, rim = 0.23, wdt = 0.305
    const pts = [[rim, 0], [r - 0.05, 0], [r, 0.04], [r, wdt - 0.04], [r - 0.05, wdt], [rim, wdt]].map(([x, y]) => new THREE.Vector2(x, y))
    return procProp('tyre-top', [{ geometry: new THREE.LatheGeometry(pts, 20), material: tyreMat }])
  })()
  const [jl, jw, jh] = P.jacks.size
  const jackProc = proc('jack', [box(jl * 0.7, jh * 0.6, jw * 0.8, dark, -jl * 0.15, 0, 0), cyl(0.07, jh * 0.4, steel, -jl * 0.3, jh * 0.6, 0, 8), { geometry: new THREE.BoxGeometry(jl * 0.55, 0.04, 0.04).rotateZ(0.35).translate(jl * 0.2, jh * 0.55, 0), material: steel }])
  const jack = glbOr(ctx, 'model/pit/trolley_jack', { id: 'jack-glb', scaleTo: { long: jl }, front: 'none' }, jackProc)
  const [fl, fw, fh] = P.fuel.size
  const fuel = proc('fuel-trolley', [box(fw, 0.12, fl, dark, 0, 0.15), cyl(0.3, fh - 0.3, steel, -0.1, 0.27, -0.2, 14), { geometry: new THREE.TorusGeometry(0.22, 0.05, 6, 14).rotateY(Q).translate(0.2, 0.75, 0.35), material: black }, ...[-fw / 2 + 0.1, fw / 2 - 0.1].flatMap((x) => [-fl / 2 + 0.15, fl / 2 - 0.15].map((z) => ({ geometry: new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8).rotateZ(Q).translate(x, 0.1, z), material: black })))])
  const [mw, mh] = P.perch.monitors.size
  const monitorProc = proc('monitor', [box(mw, mh, 0.04, dark), box(mw - 0.04, mh - 0.04, 0.005, screenMat, 0, 0.02, 0.022), box(0.12, 0.02, 0.12, dark, 0, -0.02, -0.02)])
  const monitor = glbOr(ctx, 'model/pit/pc_monitors', { id: 'monitor-glb', nodes: /SM_widescreen_(monitor_1|stand_2)/, scaleTo: { long: mw }, front: 'moreArea' }, monitorProc)
  const [sl, sw, sh] = P.monitor.size
  const monitorFrame = proc('monitor-frame', [box(sw, 0.04, sl, dark), ...[-sl / 2 + 0.1, sl / 2 - 0.1].map((z) => cyl(0.02, sh - 0.04, alu, 0, 0.04, z, 6)), box(0.04, 0.04, sl, alu, 0, sh - 0.08, 0)])
  const coneProc = proc('cone', [box(0.36, 0.03, 0.36, black), { geometry: new THREE.ConeGeometry(0.17, P.cones.size[2] - 0.03, 10).translate(0, (P.cones.size[2] - 0.03) / 2 + 0.03, 0), material: green }])
  const cone = glbOr(ctx, 'model/trackside/cone_pack', { id: 'cone-glb', nodes: /\/Object_3(\/|$)/, scaleTo: { height: P.cones.size[2] }, front: 'none' }, coneProc)
  const [rl, rw, rh] = P.cableRamps.size
  const ramp = proc('cable-ramp', [box(rw, rh, rl, yellow), box(0.18, 0.004, rl + 0.002, black, -rw / 2 + 0.2, rh, 0), box(0.18, 0.004, rl + 0.002, black, rw / 2 - 0.2, rh, 0)])
  const exProc = proc('extinguisher', [cyl(0.16, 0.78, red, 0, 0.12, 0.05, 12), cyl(0.05, 0.1, steel, 0, 0.9, 0.05, 6), { geometry: new THREE.CylinderGeometry(0.14, 0.14, 0.05, 10).rotateZ(Q).translate(-0.19, 0.14, -0.1), material: black }, { geometry: new THREE.CylinderGeometry(0.14, 0.14, 0.05, 10).rotateZ(Q).translate(0.19, 0.14, -0.1), material: black }])
  const extinguisher = glbOr(ctx, 'model/props/korean_fire_extinguisher_01', { id: 'extinguisher-glb', scaleTo: { height: P.extinguishers.size[2] - 0.05 }, front: 'none' }, exProc)
  // the perches: the frame in two widths (the walkway's, the platform deck's), stools, canopy, umbrellas
  const [pl, , ph] = P.perch.size
  const perchFrame = (id: string, w: number): PropProto => {
    const parts: Part[] = []
    // the posts 6 cm in from the frame's sides: the wall-side ones clear the advertising band on the wall face
    for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) for (const z of [-pl / 2 + 0.02, pl / 2 - 0.02]) parts.push(cyl(0.02, ph, alu, x, 0, z, 6))
    for (const y of [P.perch.floor, ph - 0.02]) for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) parts.push({ geometry: new THREE.CylinderGeometry(0.02, 0.02, pl, 6, 1, true).rotateX(Q).translate(x, y, 0), material: alu })
    for (const z of [-pl / 2 + 0.02, pl / 2 - 0.02]) parts.push({ geometry: new THREE.CylinderGeometry(0.02, 0.02, w, 6, 1, true).rotateZ(Q).translate(0, P.perch.floor, z), material: alu })
    // the guard rail on the lane side (the crew's back) and the floor plate, the desk on the wall side
    parts.push({ geometry: new THREE.CylinderGeometry(0.02, 0.02, pl, 6, 1, true).rotateX(Q).translate(-w / 2 + 0.06, P.perch.floor + 1.0, 0), material: alu })
    parts.push(box(w - 0.06, 0.04, pl - 0.06, dark, 0, P.perch.floor - 0.04))
    parts.push(box(0.4, 0.03, pl - 0.3, dark, w / 2 - 0.24, P.perch.desk))
    parts.push(box(0.04, P.perch.desk - P.perch.floor, 0.04, alu, w / 2 - 0.06, P.perch.floor, -pl / 2 + 0.2), box(0.04, P.perch.desk - P.perch.floor, 0.04, alu, w / 2 - 0.06, P.perch.floor, pl / 2 - 0.2))
    return proc(id, parts)
  }
  const frameWalk = perchFrame('perch-frame', P.perch.size[1])
  const frameDeck = perchFrame('perch-frame-deck', P.perch.onPlatform.width)
  const stool = proc('stool', [box(0.4, 0.05, 0.4, dark, 0, 0.4), ...[-0.16, 0.16].flatMap((x) => [-0.16, 0.16].map((z) => cyl(0.015, 0.4, alu, x, 0, z, 5)))])
  const canopy = (id: string, w: number) => proc(id, [box(w + 0.2, P.perch.canopy, pl + 0.2, white)])
  const canopyWalk = canopy('perch-canopy', P.perch.size[1])
  const canopyDeck = canopy('perch-canopy-deck', P.perch.onPlatform.width)
  const umbrella = proc('umbrella', [cyl(0.015, P.perch.umbrella.top, alu, 0, 0, 0, 5), { geometry: new THREE.ConeGeometry(P.perch.umbrella.d / 2, 0.28, 10, 1, true).translate(0, P.perch.umbrella.top - 0.14, 0), material: propMaterial(ctx.props, { color: 0xf4f4f0, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }) }])
  const [bl, , bh] = P.board.size
  const boardProc = proc('pit-board', [box(bl, 0.5, 0.03, white, 0, bh - 0.5), box(bl, 0.03, 0.035, dark, 0, bh - 0.5), cyl(0.02, bh - 0.5, alu, 0, 0, 0, 6)])
  const board = glbOr(ctx, 'model/pit/pit_board', { id: 'pit-board-glb', scaleTo: { height: bh }, front: 'none' }, boardProc)
  const camProc = proc('tv-camera', [box(0.5, 0.22, 0.24, dark, 0, 0, 0), cyl(0.07, 0.14, black, 0.27, 0.04, 0, 8), box(0.12, 0.08, 0.16, grey, -0.1, 0.22, 0)])
  const cam = glbOr(ctx, 'model/props/security_camera_01', { id: 'tv-camera-glb', scaleTo: { long: 0.5 }, front: 'none' }, camProc)
  const tripod = proc('tripod', [...[0, 1, 2].map((i) => ({ geometry: new THREE.CylinderGeometry(0.012, 0.012, P.platform.head / Math.cos(0.3), 5, 1, true).rotateZ(0.3).rotateY((i * 2 * Math.PI) / 3).translate(0, P.platform.head / 2, 0), material: alu })), box(0.16, 0.04, 0.16, dark, 0, P.platform.head - 0.04)])
  const [pml, , pmh] = P.platform.monitorSize
  const platformStand = proc('platform-monitor-stand', [box(0.5, 0.04, pml, dark), cyl(0.02, pmh - 0.04, alu, 0, 0.04, 0, 6)])

  // --- the sets --------------------------------------------------------------------------------------
  const sets = new Map<PropProto, PropSet>()
  const setOf = (proto: PropProto, far?: PropProto): PropSet => {
    let ps = sets.get(proto)
    if (!ps) sets.set(proto, (ps = { proto, placements: [] as PropPlacement[], ...(far && far !== proto ? { far } : {}) }))
    return ps
  }
  const equipment: PropProto[] = [gantryPost, gantryTop, gun, blanket, tyreTop, jack, fuel, monitor, monitorFrame, extinguisher]
  const perches: PropProto[] = [frameWalk, frameDeck, stool, canopyWalk, canopyDeck, umbrella, board, cam, tripod, platformStand]
  /** the base height of a row: the drawn ground on the apron, the garage floor inside, the road frame on the wall */
  const baseOf = (p: OpsPlacement): number => (p.mount === 'wall' ? 0 : p.mount === 'interior' ? INTERIOR_FLOOR : ground.standAt(p.s, p.lateral)) + (p.y ?? 0)
  /** the row's frame (its centre, its base) with an optional yaw and a local offset */
  const at = (p: OpsPlacement, yaw = 0, dx = 0, dy = 0, dz = 0): THREE.Matrix4 => {
    const m = frameAt(track, p.s, p.lateral, baseOf(p), new THREE.Matrix4())
    if (dx || dy || dz) m.multiply(_t.makeTranslation(dx, dy, dz))
    if (yaw) m.multiply(_r.makeRotationY(yaw))
    return m
  }
  const put = (ps: PropSet, m: THREE.Matrix4, color?: THREE.Color) => ps.placements.push(color ? { m, color } : { m })
  const teamColour = (p: OpsPlacement) => (p.team ? new THREE.Color(TEAMS[p.team].body) : undefined)

  for (const p of rows) {
    const [id] = p.id.split('-')
    switch (id) {
      case 'gantry': {
        if (p.id.startsWith('gantry-post')) put(setOf(gantryPost), at(p))
        else {
          put(setOf(gantryTop), at(p))
          // the guns hang under the arms over the wheels (the pair's long side along x → the quarter turn)
          for (const z of G.arm.dS) for (const dLat of G.guns.dLat) put(setOf(gun, gunProc), at(p, Q, gx.s + dLat, G.guns.bottom + G.guns.size[2] / 2 - (p.y ?? 0), z))
        }
        break
      }
      case 'tyres':
        put(setOf(blanket), at(p), teamColour(p))
        put(setOf(tyreTop), at(p, 0, 0, 1.0, 0))
        break
      case 'jack':
        put(setOf(jack, jackProc), at(p, Q))
        break
      case 'fuel':
        put(setOf(fuel), at(p))
        break
      case 'monitor': {
        // the stand faces the car (+lateral): the screens at 1.2 / 1.55 on the wall-side face
        put(setOf(monitorFrame), at(p))
        for (const y of [sh - 0.75, sh - 0.37]) for (const z of [-0.3, 0.3]) put(setOf(monitor, monitorProc), at(p, Q, 0.04, y, z))
        break
      }
      case 'extinguisher':
        put(setOf(extinguisher, exProc), at(p, Q))
        break
      case 'cone':
        put(setOf(cone, coneProc), at(p))
        break
      case 'cable':
        put(setOf(ramp), at(p, 0, 0, RAMP_LIFT, 0))
        break
      case 'perch': {
        const block = Number(p.id.split('-')[1])
        const deck = perchOnPlatform(block)
        const w = p.size[1]
        put(setOf(deck ? frameDeck : frameWalk), at(p))
        put(setOf(deck ? canopyDeck : canopyWalk), at(p, 0, 0, ph, 0), teamColour(p))
        for (const dS of P.perch.seatsDS) put(setOf(stool), at(p, 0, -w / 2 + 0.3, P.perch.floor, dS))
        // the umbrellas stand on the walkway / deck just past the frame's ends (under the canopy they would pierce it)
        for (const z of [-pl / 2 - P.perch.umbrella.dS, pl / 2 + P.perch.umbrella.dS]) put(setOf(umbrella), at(p, 0, 0, 0, z))
        // the monitors on the desk face the seated crew (−lateral): the pair's front is +z → yaw −Q
        const n = P.perch.monitors.n
        for (let i = 0; i < n; i++) put(setOf(monitor, monitorProc), at(p, -Q, w / 2 - 0.24, P.perch.desk + 0.03, (i - (n - 1) / 2) * (mw + 0.2)))
        break
      }
      case 'board':
        put(setOf(board, boardProc), at(p, Q))
        break
      case 'tvcam':
        put(setOf(tripod), at(p))
        put(setOf(cam, camProc), at(p, 0, 0, P.platform.head, 0))
        break
      case 'platform':
        put(setOf(platformStand), at(p))
        put(setOf(monitor, monitorProc), at(p, -Q, 0, pmh - mh, 0))
        break
    }
  }
  const pick = (protos: PropProto[]) => protos.map((pr) => sets.get(pr)).filter((s): s is PropSet => !!s)
  const levels = { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }
  registerPropSet(ctx, 'ops', 'ops-pitEquipment', pick(equipment), levels, { receiveShadow: true })
  registerPropSet(ctx, 'ops', 'ops-perches', pick(perches), levels, { receiveShadow: true })
  registerPropSet(ctx, 'ops', 'ops-cones', pick([cone]), levels, { receiveShadow: true })
  registerPropSet(ctx, 'ops', 'ops-cables', pick([ramp]), levels, { receiveShadow: true })
  return { placements: rows, stats: { equipment: rows.length } }
}
