import * as THREE from 'three'
import { FLAG_COLOURS, figuresAt, flagPlacements, type FigureRole, type OpsFigure, type OpsPlacement } from '~/data/ops-spec'
import type { EnvBuildContext } from './environment'
import { FIGURE_POSES, buildOpsFigures, type FigurePlacement, type FigurePose } from './figures'
import { registerPropSet, type PropPlacement, type PropSet } from './infield-lod'
import type { OpsPartial } from './ops'
import { frameAt } from './pit-geometry'
import { procProp, propMaterial, type PropProto } from './props-pack'
import { barrierLateralAt } from './trackside'

/**
 * The ops layer's people and flags (plan I3-d / I3-e), drawn from ops-spec section D:
 *
 *  - `figuresAt()` — the pit crews (`crewSlots` / `perchSeats` per team block), the officials,
 *    the orange marshals with white helmets, the photographers and the paddock staff — converted
 *    from the track frame into figures.ts `FigurePlacement`s: `(s, lateral)` → world through
 *    `track.pointAt`, the height from `ground.standAt` for the figures standing on the ground
 *    (apron / yard / paddock) and from the road frame (`track.pointAt`'s yOffset = the row's
 *    `y`) for the mounted ones (the perch floor, the fixed platform's deck, the podium's 2F
 *    terrace); `yawDeg` (0 = +s, +90 = +lateral) → the crowd's yaw convention (`atan2(dx, dz)`
 *    of the look direction). One `buildOpsFigures` call per role — the far-field entries
 *    `ops-figures-crew` / `-officials` / `-marshals` / `-photographers` / `-staff` (kind 'ops',
 *    per 250 m cell: the 3D level within `Quality.infield.figures3dM` with the pack, the
 *    impostors to `figuresFarM`) — sharing the crowd's three programs and nothing of its budget.
 *  - `flagPlacements()` — the E paddock's eight 9 m poles with fictional tricolours: one
 *    procedural prototype per colour pair (pole + three bands, plain colours through
 *    `propMaterial`, the bands two-sided like the paddock gate flags of paddock.ts), instanced
 *    through `registerPropSet(ctx, 'ops', 'ops-flags', …)`. Static: the trackside's flag wave is
 *    an `onBeforeCompile` program of props.ts (plan §横断 7 forbids a new program here) and the
 *    paddock's own poles are static too.
 *
 * Reports `figures`, `byRole`, `impostors`, `near3d`, `mode` (Node / low tier = 'procedural',
 * the pack's baked atlas = 'baked') and the flag rows as `equipment`; the flag rows are the
 * placements it hands the umbrella (figures are `figuresAt()` rows, never `OpsPlacement`s).
 */

const _p = new THREE.Vector3()
const _t = new THREE.Matrix4()

/** the groups one `buildOpsFigures` call draws, in the order of the far-field entry names */
const GROUPS: { role: FigureRole; name: string }[] = [
  { role: 'crew', name: 'ops-figures-crew' },
  { role: 'official', name: 'ops-figures-officials' },
  { role: 'marshal', name: 'ops-figures-marshals' },
  { role: 'photographer', name: 'ops-figures-photographers' },
  { role: 'staff', name: 'ops-figures-staff' },
]

const POSES = new Set<string>(FIGURE_POSES)

/** a row's pose as figures.ts knows it (an unknown name stands) */
function poseOf(f: OpsFigure): FigurePose {
  return f.pose && POSES.has(f.pose) ? (f.pose as FigurePose) : 'stand'
}

/**
 * One `figuresAt()` row in world space: the mounted rows ('wall' / 'roof') stand at `y` in the
 * road frame like the pit lane and the pit building are swept, the rest on the drawn ground.
 */
export function figureToWorld(ctx: Pick<EnvBuildContext, 'track' | 'ground'>, f: OpsFigure): FigurePlacement {
  const { track, ground } = ctx
  const s = track.wrap(f.s)
  const mounted = f.mount === 'wall' || f.mount === 'roof'
  // `ground.standAt` is relative to the road plane (a yOffset for `pointAt`), like a mounted row's `y`
  track.pointAt(s, f.lateral, _p, (mounted ? 0 : ground.standAt(s, f.lateral)) + (f.y ?? 0))
  const y = _p.y
  const h = track.headingAt(s)
  const a = ((f.yawDeg ?? 0) * Math.PI) / 180
  // the look direction: cos along +s (tx, tz), sin along +lateral (tz, −tx)
  const dx = Math.cos(a) * h.tx + Math.sin(a) * h.tz
  const dz = Math.cos(a) * h.tz - Math.sin(a) * h.tx
  const out: FigurePlacement = { x: _p.x, y, z: _p.z, yaw: Math.atan2(dx, dz), pose: poseOf(f), role: f.role }
  if (f.team) out.team = f.team
  return out
}

export function buildOpsPeople(ctx: EnvBuildContext): OpsPartial {
  const { track, ground, quality } = ctx
  // the fence-window photographers (I4-c) need the barrier lines: the same resolver the guards use
  const rows = figuresAt({ lineAt: (s, side) => barrierLateralAt(track, s, side) })
  // --- the figures, one prop set per role -----------------------------------------------------------
  const byRole = new Map<FigureRole, FigurePlacement[]>()
  for (const f of rows) {
    let list = byRole.get(f.role)
    if (!list) byRole.set(f.role, (list = []))
    list.push(figureToWorld(ctx, f))
  }
  const stats: OpsPartial['stats'] = { figures: 0, byRole: {}, impostors: 0, near3d: 0, mode: 'none' }
  for (const g of GROUPS) {
    const list = byRole.get(g.role)
    if (!list?.length) continue
    const st = buildOpsFigures(ctx, list, g.name)
    stats.figures! += st.figures
    stats.impostors! += st.impostors
    stats.near3d! += st.near3d
    for (const [role, n] of Object.entries(st.byRole)) stats.byRole![role as FigureRole] = (stats.byRole![role as FigureRole] ?? 0) + n
    if (st.mode !== 'none') stats.mode = st.mode
  }
  // --- the flags: one prototype per colour pair, instanced ------------------------------------------
  const flags = flagPlacements()
  if (flags.length) {
    const pole = propMaterial(ctx.props, { color: 0xb9bcc0, roughness: 0.45, metalness: 0.6 })
    const band = (hex: string) => propMaterial(ctx.props, { color: hex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })
    const protos = new Map<string, PropProto>()
    const protoFor = (tint: [string, string], h: number): PropProto => {
      const key = tint.join('|')
      let proto = protos.get(key)
      if (proto) return proto
      // the pole along +y, the flag (1.6 × 1.0, three 0.33 m bands) hung from 0.7 m below its top, trailing to −s (local −z)
      const poleGeo = new THREE.CylinderGeometry(0.04, 0.05, h, 6).translate(0, h / 2, 0)
      const bandGeo = (k: number) => new THREE.PlaneGeometry(1.6, 1.0 / 3).rotateY(Math.PI / 2).translate(0.02, h - 0.7 - (k + 0.5) / 3, -0.8)
      proto = procProp(`flag-${protos.size}`, [
        { geometry: poleGeo, material: pole },
        { geometry: bandGeo(0), material: band(tint[0]) },
        { geometry: bandGeo(1), material: band('#f4f4f0') },
        { geometry: bandGeo(2), material: band(tint[1]) },
      ])
      protos.set(key, proto)
      return proto
    }
    const sets = new Map<PropProto, PropSet>()
    for (const p of flags) {
      const proto = protoFor(p.tint ?? FLAG_COLOURS[0]!, p.size[2])
      let set = sets.get(proto)
      if (!set) sets.set(proto, (set = { proto, placements: [] as PropPlacement[] }))
      const m = frameAt(track, track.wrap(p.s), p.lateral, ground.standAt(track.wrap(p.s), p.lateral) + (p.y ?? 0), new THREE.Matrix4())
      if (p.yawDeg) m.multiply(_t.makeRotationY((p.yawDeg * Math.PI) / 180))
      set.placements.push({ m: m.clone() })
    }
    registerPropSet(ctx, 'ops', 'ops-flags', [...sets.values()], { nearM: quality.infield.propsNearM, farM: quality.infield.propsFarM }, { receiveShadow: false })
  }
  const placements: OpsPlacement[] = flags
  return { placements, stats: { ...stats, equipment: flags.length } }
}
