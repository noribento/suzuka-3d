import * as THREE from 'three'

/**
 * Low-poly parked-car bodies (plan §2d): seven silhouettes of 60–90 triangles each, built from
 * two lofted side profiles (the lower shell to the belt line, the narrower cabin above it),
 * two axle blocks for the wheels and four lamp quads — the kei truck from a cab-over cab and a
 * box bed instead. Pure three — no project imports — so the impostor bake page
 * (scripts/assets/bake/car-impostor.html) can load this module transpiled and draw exactly the
 * geometry the runtime instances inside 500 m. The photo-textured GLB bodies that replace four
 * of these inside `CAR_PARK.lod.hero` are car-glb.ts; these stay the fallback everywhere (the
 * low tier, Node, a missing pack) and the 260–500 m level behind the GLBs.
 *
 * Frame: the car stands on y = 0 with its nose towards +Z and its width along X; the origin
 * is the centre of the footprint. A yaw θ about +Y turns the nose to world (sin θ, cos θ),
 * which is also the impostor shader's facing convention (`aInfo.z`), so one angle serves both.
 *
 * Part mask: the `color` attribute is RGBA. RGB is the part's own colour and A says whether
 * the runtime tint (the instance colour = the paintwork) applies: body panels are white with
 * A = 1 (they take the tint as is), glass / tyres / lamps carry their fixed colour with A = 0.
 * `patchCarVertexColour` installs the vertex-shader line that reads it in each of its three
 * modes — the same rule the bake's mask pass renders into the atlas's R channel.
 */
export type CarBody = 'minivan' | 'kei' | 'suv' | 'hatch' | 'sedan' | 'coach' | 'keitruck' | 'truck'

/**
 * atlas-row order (CAR_LAYOUT in ~/data/impostor-atlas.ts): the row of a body is its index here.
 * The 'truck' (the teams' transporters, plan I-phase) is not a car-park body: no atlas row, no
 * place in CAR_MIX — the ops layer instances it directly.
 */
export const CAR_BODIES: readonly CarBody[] = ['minivan', 'kei', 'suv', 'hatch', 'sedan', 'coach', 'keitruck']

/** overall length × width × height (m) */
export const CAR_DIMS: Record<CarBody, { l: number; w: number; h: number }> = {
  minivan: { l: 4.7, w: 1.7, h: 1.85 },
  kei: { l: 3.4, w: 1.48, h: 1.65 },
  suv: { l: 4.5, w: 1.85, h: 1.7 },
  hatch: { l: 4.0, w: 1.7, h: 1.5 },
  sedan: { l: 4.6, w: 1.8, h: 1.45 },
  coach: { l: 12, w: 2.5, h: 3.5 },
  /** the 軽トラ: the kei class's 3.4 × 1.48 m box, a cab-over cab 1.8 m tall over a flat bed */
  keitruck: { l: 3.4, w: 1.48, h: 1.8 },
  /** a 大型 box truck (the transporters photographed in the paddock): 12.0 m cab-over, 2.5 m wide, 3.9 m box */
  truck: { l: 12.0, w: 2.5, h: 3.9 },
}

/**
 * The car-park mix (plan §2d); the coach share is added separately, only near the gates. Kei
 * cars (wagon + truck) are a third of the parc — the 2025 share of 軽自動車 in Mie's registrations
 * is 38 %, less at a race meeting, where the visitors' minivans and SUVs are over-represented.
 */
export const CAR_MIX: readonly { body: CarBody; weight: number }[] = [
  { body: 'minivan', weight: 25 },
  { body: 'kei', weight: 27 },
  { body: 'keitruck', weight: 6 },
  { body: 'suv', weight: 17 },
  { body: 'hatch', weight: 13 },
  { body: 'sedan', weight: 12 },
]

/**
 * Paintwork from the 2026 car-park photo (white / pearl 38, black 24, silver / grey 20, dark red
 * 6, blue 5, other 7 %). sRGB hex; a jitter of the lightness per car is applied by the picker.
 */
export const CAR_COLOURS: readonly { hex: string; weight: number; name: string }[] = [
  { hex: '#f2f1ec', weight: 30, name: 'white' },
  { hex: '#e9e6dc', weight: 8, name: 'pearl' },
  { hex: '#141416', weight: 24, name: 'black' },
  { hex: '#b8babd', weight: 11, name: 'silver' },
  { hex: '#6d6f72', weight: 9, name: 'grey' },
  { hex: '#6a1018', weight: 6, name: 'dark red' },
  { hex: '#1f3d78', weight: 5, name: 'blue' },
  { hex: '#8a6a3a', weight: 2, name: 'bronze' },
  { hex: '#3d5a3a', weight: 2, name: 'green' },
  { hex: '#c9b47a', weight: 2, name: 'beige' },
  { hex: '#d8531e', weight: 1, name: 'orange' },
]

const _c = new THREE.Color()

/** pick a body from the car mix (`r` in [0, 1)) */
export function pickCarBody(r: number): CarBody {
  let sum = 0
  for (const m of CAR_MIX) sum += m.weight
  let acc = 0
  for (const m of CAR_MIX) {
    acc += m.weight / sum
    if (r < acc) return m.body
  }
  return CAR_MIX[CAR_MIX.length - 1]!.body
}

/** pick a paint colour (`r` selects, `j` in [0, 1) jitters the lightness a little); linear rgb in `out` */
export function pickCarColour(r: number, j: number, out: THREE.Color): THREE.Color {
  let sum = 0
  for (const c of CAR_COLOURS) sum += c.weight
  let acc = 0
  let hex = CAR_COLOURS[0]!.hex
  for (const c of CAR_COLOURS) {
    acc += c.weight / sum
    if (r < acc) { hex = c.hex; break }
  }
  _c.set(hex)
  const k = 0.92 + j * 0.16
  return out.setRGB(Math.min(1, _c.r * k), Math.min(1, _c.g * k), Math.min(1, _c.b * k))
}

// ---------------------------------------------------------------------------------------------
// geometry

type RGBA = readonly [number, number, number, number]
const BODY: RGBA = [1, 1, 1, 1]
const GLASS: RGBA = [0.09, 0.11, 0.13, 0]
const TYRE: RGBA = [0.05, 0.05, 0.055, 0]
const HEADLAMP: RGBA = [0.96, 0.96, 0.9, 0]
const TAILLAMP: RGBA = [0.7, 0.07, 0.05, 0]
const UNDER: RGBA = [0.12, 0.12, 0.12, 0]

/** non-indexed triangle soup with per-face colour */
class Soup {
  pos: number[] = []
  col: number[] = []

  /** one triangle; winding is corrected so the face normal points away from `inside` */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, rgba: RGBA, inside: THREE.Vector3) {
    const ab = b.clone().sub(a), ac = c.clone().sub(a)
    const n = ab.cross(ac)
    const toIn = inside.clone().sub(a)
    const flip = n.dot(toIn) > 0
    const p = flip ? [a, c, b] : [a, b, c]
    for (const v of p) {
      this.pos.push(v.x, v.y, v.z)
      this.col.push(rgba[0], rgba[1], rgba[2], rgba[3])
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, rgba: RGBA, inside: THREE.Vector3) {
    this.tri(a, b, c, rgba, inside)
    this.tri(a, c, d, rgba, inside)
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4))
    g.computeVertexNormals()
    return g
  }
}

/** a side profile in (z, y): convex, counter-clockwise seen from +X (front-bottom first, then up over the top and back) */
type Profile = readonly (readonly [number, number])[]

/**
 * Loft a convex (z, y) profile across x ∈ [−hw, +hw]: two fan caps and one quad per profile edge.
 * `colourOf` decides the part of each side quad from its outward normal (ny up, nz forward);
 * the caps are `capColour`. `skipBottom` drops the quad of the edge that closes the profile
 * (the underside, never seen).
 */
function loft(s: Soup, profile: Profile, hw: number, capColour: RGBA, colourOf: (ny: number, nz: number) => RGBA, skipBottom: boolean) {
  const n = profile.length
  let cz = 0, cy = 0
  for (const [z, y] of profile) { cz += z; cy += y }
  const inside = new THREE.Vector3(0, cy / n, cz / n)
  const L = (i: number) => new THREE.Vector3(-hw, profile[i]![1], profile[i]![0])
  const R = (i: number) => new THREE.Vector3(hw, profile[i]![1], profile[i]![0])
  // caps
  for (let i = 1; i < n - 1; i++) {
    s.tri(L(0), L(i), L(i + 1), capColour, inside)
    s.tri(R(0), R(i), R(i + 1), capColour, inside)
  }
  // sides
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (skipBottom && j === 0) continue
    const [z0, y0] = profile[i]!, [z1, y1] = profile[j]!
    // outward normal of the edge in (z, y): rotate the edge direction by −90°
    const ez = z1 - z0, ey = y1 - y0
    const len = Math.hypot(ez, ey) || 1
    const nz = ey / len, ny = -ez / len
    s.quad(L(i), R(i), R(j), L(j), colourOf(ny, nz), inside)
  }
}

/** a box without its top face (the axle blocks: the top is inside the shell) */
function axleBlock(s: Soup, z: number, hw: number, r: number, len: number) {
  const x0 = -hw, x1 = hw, y0 = 0.02, y1 = r * 2, z0 = z - len / 2, z1 = z + len / 2
  const inside = new THREE.Vector3(0, (y0 + y1) / 2, z)
  const v = (x: number, y: number, zz: number) => new THREE.Vector3(x, y, zz)
  s.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), UNDER, inside) // bottom
  s.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), TYRE, inside) // front
  s.quad(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), TYRE, inside) // rear
  s.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), TYRE, inside) // left
  s.quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1), TYRE, inside) // right
}

/**
 * An axis-aligned box (x0..x1 × y0..y1 × z0..z1) in one colour, faces named by the axis they look
 * along dropped through `skip` ('-y' the underside, '+y' the top, …): the kei truck's bed walls,
 * tailgate and chassis rail. 2 triangles per kept face.
 */
function box(s: Soup, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, rgba: RGBA, skip: readonly string[] = []) {
  const inside = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  if (!skip.includes('-y')) s.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), rgba, inside)
  if (!skip.includes('+y')) s.quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), rgba, inside)
  if (!skip.includes('+z')) s.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), rgba, inside)
  if (!skip.includes('-z')) s.quad(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), rgba, inside)
  if (!skip.includes('-x')) s.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), rgba, inside)
  if (!skip.includes('+x')) s.quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1), rgba, inside)
}

/** a lamp quad standing 1 cm proud of a vertical end face at z */
function lamp(s: Soup, x: number, y: number, z: number, w: number, h: number, forward: boolean, rgba: RGBA) {
  const zz = z + (forward ? 0.01 : -0.01)
  const inside = new THREE.Vector3(x, y, forward ? z - 1 : z + 1)
  const v = (dx: number, dy: number) => new THREE.Vector3(x + dx, y + dy, zz)
  s.quad(v(-w / 2, -h / 2), v(w / 2, -h / 2), v(w / 2, h / 2), v(-w / 2, h / 2), rgba, inside)
}

interface CarSpec {
  /** belt line (top of the lower shell) and sill (bottom of the shell) heights */
  belt: number
  sill: number
  /** z of the bonnet's end (the cabin's front base), the windscreen top, the roof's rear edge, the cabin's rear base */
  zb: number
  zw: number
  zt: number
  ztb: number
  /** bonnet rise from the grille top to the belt line at zb */
  hood: number
  /** cabin width as a share of the body width (tumblehome) */
  cabinW: number
  /** axle positions (z) and tyre radius */
  axles: number[]
  tyre: number
}

const SPECS: Record<Exclude<CarBody, 'coach' | 'keitruck' | 'truck'>, CarSpec> = {
  minivan: { belt: 1.0, sill: 0.26, zb: 1.45, zw: 0.7, zt: -2.25, ztb: -2.3, hood: 0.1, cabinW: 0.94, axles: [1.45, -1.45], tyre: 0.32 },
  kei: { belt: 0.92, sill: 0.24, zb: 0.95, zw: 0.45, zt: -1.6, ztb: -1.65, hood: 0.08, cabinW: 0.95, axles: [1.15, -1.15], tyre: 0.28 },
  suv: { belt: 1.06, sill: 0.34, zb: 1.0, zw: 0.3, zt: -1.9, ztb: -2.15, hood: 0.14, cabinW: 0.92, axles: [1.35, -1.35], tyre: 0.36 },
  hatch: { belt: 0.9, sill: 0.22, zb: 1.05, zw: 0.25, zt: -1.5, ztb: -1.92, hood: 0.16, cabinW: 0.9, axles: [1.25, -1.25], tyre: 0.31 },
  sedan: { belt: 0.9, sill: 0.2, zb: 1.15, zw: 0.2, zt: -0.95, ztb: -1.6, hood: 0.16, cabinW: 0.9, axles: [1.4, -1.4], tyre: 0.32 },
}

function carShell(kind: Exclude<CarBody, 'coach' | 'keitruck' | 'truck'>): THREE.BufferGeometry {
  const { l, w, h } = CAR_DIMS[kind]
  const p = SPECS[kind]
  const s = new Soup()
  const zf = l / 2, zr = -l / 2
  // lower shell: front bottom → bumper → grille → bonnet end (belt) → rear belt → rear bumper → rear bottom
  const lower: Profile = [
    [zf - 0.14, p.sill],
    [zf, p.sill + 0.28],
    [zf - 0.04, p.belt - p.hood],
    [p.zb, p.belt],
    [zr + 0.03, p.belt + 0.02],
    [zr, p.sill + 0.3],
    [zr + 0.06, p.sill],
  ]
  loft(s, lower, w / 2, BODY, () => BODY, true)
  // cabin: front base → windscreen top → roof rear → rear base; sides are glass, the roof is body
  const cab: Profile = [
    [p.zb, p.belt - 0.01],
    [p.zw, h],
    [p.zt, h],
    [p.ztb, p.belt - 0.01],
  ]
  loft(s, cab, (w / 2) * p.cabinW, GLASS, (ny) => (ny > 0.8 ? BODY : GLASS), true)
  for (const z of p.axles) axleBlock(s, z, w / 2 - 0.04, p.tyre, p.tyre * 1.7)
  const ly = p.sill + 0.28 + (p.belt - p.hood - p.sill - 0.28) * 0.55
  lamp(s, -w * 0.32, ly, zf - 0.02, w * 0.22, 0.14, true, HEADLAMP)
  lamp(s, w * 0.32, ly, zf - 0.02, w * 0.22, 0.14, true, HEADLAMP)
  const ty = p.sill + 0.3 + (p.belt - p.sill - 0.3) * 0.6
  lamp(s, -w * 0.36, ty, zr + 0.02, w * 0.16, 0.16, false, TAILLAMP)
  lamp(s, w * 0.36, ty, zr + 0.02, w * 0.16, 0.16, false, TAILLAMP)
  return s.geometry()
}

function coachShell(): THREE.BufferGeometry {
  const { l, w, h } = CAR_DIMS.coach
  const s = new Soup()
  const zf = l / 2, zr = -l / 2
  const sill = 0.4, belt = 1.35, glassTop = 2.45
  // lower body up to the belt line (the front rakes back a little)
  const lower: Profile = [
    [zf - 0.1, sill],
    [zf, sill + 0.4],
    [zf, belt],
    [zr, belt],
    [zr, sill + 0.4],
    [zr + 0.1, sill],
  ]
  loft(s, lower, w / 2, BODY, () => BODY, true)
  // the window band, inset 3 cm: the windscreen is the raked front face
  const band: Profile = [
    [zf - 0.02, belt - 0.01],
    [zf - 0.3, glassTop],
    [zr + 0.05, glassTop],
    [zr + 0.02, belt - 0.01],
  ]
  loft(s, band, w / 2 - 0.03, GLASS, () => GLASS, true)
  // roof block over the band
  const roof: Profile = [
    [zf - 0.3, glassTop - 0.01],
    [zf - 0.45, h],
    [zr + 0.2, h],
    [zr + 0.05, glassTop - 0.01],
  ]
  loft(s, roof, w / 2 - 0.02, BODY, () => BODY, true)
  for (const z of [3.9, -2.4, -3.8]) axleBlock(s, z, w / 2 - 0.05, 0.5, 0.9)
  lamp(s, -w * 0.34, sill + 0.55, zf, 0.5, 0.25, true, HEADLAMP)
  lamp(s, w * 0.34, sill + 0.55, zf, 0.5, 0.25, true, HEADLAMP)
  lamp(s, -w * 0.4, sill + 0.7, zr, 0.22, 0.4, false, TAILLAMP)
  lamp(s, w * 0.4, sill + 0.7, zr, 0.22, 0.4, false, TAILLAMP)
  return s.geometry()
}

/**
 * The kei truck (軽トラ): a cab-over cab on the front 1.45 m — vertical front, raked windscreen,
 * flat roof, glass sides above the belt — and a flat bed behind it with 0.3 m drop sides and a
 * tailgate, standing on a dark chassis rail; the front axle sits under the cab, the rear one
 * under the bed. 94 triangles.
 */
function keitruckShell(): THREE.BufferGeometry {
  const { l, w, h } = CAR_DIMS.keitruck
  const s = new Soup()
  const zf = l / 2, zr = -l / 2
  const sill = 0.3, belt = 1.02, bed = 0.66, side = 0.3, wall = 0.04
  const cabRear = zf - 1.45
  // the cab below the belt line: bumper, the vertical front, the belt, the cab's back wall
  const lower: Profile = [
    [zf - 0.08, sill],
    [zf, sill + 0.22],
    [zf, belt],
    [cabRear, belt],
    [cabRear, sill],
  ]
  loft(s, lower, w / 2, BODY, () => BODY, true)
  // the cab above the belt: the raked windscreen, the flat roof, the back wall (body); side glass
  const cab: Profile = [
    [zf - 0.02, belt - 0.01],
    [zf - 0.42, h],
    [cabRear + 0.04, h],
    [cabRear, belt - 0.01],
  ]
  loft(s, cab, (w / 2) * 0.95, GLASS, (ny, nz) => (ny > 0.8 || nz < -0.5 ? BODY : GLASS), true)
  // the bed: floor, two drop sides, the headboard and the tailgate as thin walls; the chassis rail under it
  const hw = w / 2, bedFront = cabRear - 0.05
  box(s, -hw + wall, hw - wall, bed - 0.02, bed, zr + wall, bedFront, UNDER, ['-y', '+z', '-z', '-x', '+x'])
  box(s, -hw, -hw + wall, bed - 0.02, bed + side, zr, bedFront, BODY, ['-y'])
  box(s, hw - wall, hw, bed - 0.02, bed + side, zr, bedFront, BODY, ['-y'])
  box(s, -hw + wall, hw - wall, bed - 0.02, bed + side, bedFront - wall, bedFront, BODY, ['-y', '-x', '+x'])
  box(s, -hw + wall, hw - wall, bed - 0.02, bed + side, zr, zr + wall, BODY, ['-y', '-x', '+x'])
  box(s, -hw + 0.14, hw - 0.14, sill, bed - 0.02, zr + 0.05, bedFront, UNDER, ['+y', '+z'])
  axleBlock(s, zf - 0.95, hw - 0.04, 0.28, 0.48)
  axleBlock(s, zr + 0.75, hw - 0.04, 0.28, 0.48)
  lamp(s, -w * 0.33, sill + 0.42, zf - 0.02, w * 0.2, 0.14, true, HEADLAMP)
  lamp(s, w * 0.33, sill + 0.42, zf - 0.02, w * 0.2, 0.14, true, HEADLAMP)
  lamp(s, -w * 0.38, bed - 0.14, zr + 0.02, w * 0.12, 0.12, false, TAILLAMP)
  lamp(s, w * 0.38, bed - 0.14, zr + 0.02, w * 0.12, 0.12, false, TAILLAMP)
  return s.geometry()
}

/**
 * The box truck (a Japanese 大型 transporter as photographed in the paddock, plan I-phase): a
 * cab-over cab on the front 2.3 m — vertical front, raked windscreen, flat roof, glass sides
 * above the belt, body colour below — a box body behind it a step taller than the cab with a
 * tail-lift platform folded against its rear, a dark chassis under everything, three axles
 * (front under the cab, tandem under the rear of the box). ≈ 120 triangles; the body panels take
 * the instance tint like every other shell (A = 1), so a plain white truck is the default.
 */
function truckShell(): THREE.BufferGeometry {
  const { l, w, h } = CAR_DIMS.truck
  const s = new Soup()
  const zf = l / 2, zr = -l / 2
  const sill = 0.45, belt = 1.45, cabH = 3.0, cabRear = zf - 2.3, boxFront = cabRear - 0.15, boxFloor = 1.05
  // the cab below the belt line: bumper, the vertical front, the belt, the cab's back wall
  const lower: Profile = [
    [zf - 0.1, sill],
    [zf, sill + 0.3],
    [zf, belt],
    [cabRear, belt],
    [cabRear, sill],
  ]
  loft(s, lower, w / 2, BODY, () => BODY, true)
  // the cab above the belt: the raked windscreen, the flat roof, the back wall (body); side glass
  const cab: Profile = [
    [zf - 0.02, belt - 0.01],
    [zf - 0.35, cabH],
    [cabRear + 0.05, cabH],
    [cabRear, belt - 0.01],
  ]
  loft(s, cab, (w / 2) * 0.96, GLASS, (ny, nz) => (ny > 0.8 || nz < -0.5 ? BODY : GLASS), true)
  // the box body: floor at boxFloor, roof at h, from just behind the cab to the rear
  const hw = w / 2
  box(s, -hw, hw, boxFloor, h, zr, boxFront, BODY, ['-y'])
  // the tail-lift platform, folded up against the rear doors, and the chassis rail with the fuel tank's bulk
  box(s, -hw + 0.15, hw - 0.15, boxFloor - 0.05, boxFloor + 1.5, zr - 0.06, zr, UNDER, ['+z'])
  box(s, -hw + 0.3, hw - 0.3, sill, boxFloor, zr + 0.3, boxFront, UNDER, ['+y'])
  axleBlock(s, zf - 1.5, hw - 0.05, 0.5, 0.75)
  axleBlock(s, zr + 2.3, hw - 0.05, 0.5, 0.75)
  axleBlock(s, zr + 1.0, hw - 0.05, 0.5, 0.75)
  lamp(s, -w * 0.36, sill + 0.55, zf - 0.02, 0.4, 0.2, true, HEADLAMP)
  lamp(s, w * 0.36, sill + 0.55, zf - 0.02, 0.4, 0.2, true, HEADLAMP)
  lamp(s, -w * 0.4, boxFloor - 0.2, zr - 0.05, 0.2, 0.3, false, TAILLAMP)
  lamp(s, w * 0.4, boxFloor - 0.2, zr - 0.05, 0.2, 0.3, false, TAILLAMP)
  return s.geometry()
}

const cache = new Map<CarBody, THREE.BufferGeometry>()

/**
 * The body geometry of `kind` (cached; non-indexed, position / normal / RGBA colour), standing
 * on y = 0, nose +Z. 60–90 triangles each.
 */
export function carBodyGeometry(kind: CarBody): THREE.BufferGeometry {
  let g = cache.get(kind)
  if (!g) {
    g = kind === 'coach' ? coachShell() : kind === 'keitruck' ? keitruckShell() : kind === 'truck' ? truckShell() : carShell(kind)
    g.computeBoundingSphere()
    cache.set(kind, g)
  }
  return g
}

/**
 * Install the vertex-colour rule on a material with `vertexColors: true` drawing these bodies:
 *  - 'tint':  rgb = mix(part, part × instanceColor, a) — the runtime (paintwork from the instance)
 *  - 'plain': rgb = part (a ignored) — the bake's colour pass (body white, lit)
 *  - 'mask':  rgb = (a, 0, 0) — the bake's mask pass (R = where the tint applies)
 * The alpha of `vColor` is forced to 1 so the RGBA attribute never leaks into the fragment alpha.
 */
export function patchCarVertexColour<T extends THREE.Material>(mat: T, mode: 'tint' | 'plain' | 'mask'): T {
  const line = mode === 'tint'
    ? `#ifdef USE_INSTANCING_COLOR
        vColor = vec4( mix( color.rgb, color.rgb * instanceColor.rgb, color.a ), 1.0 );
        #else
        vColor = vec4( color.rgb, 1.0 );
        #endif`
    : mode === 'plain'
      ? 'vColor = vec4( color.rgb, 1.0 );'
      : 'vColor = vec4( color.a, 0.0, 0.0, 1.0 );'
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', line)
  }
  mat.customProgramCacheKey = () => `carBody|${mode}`
  return mat
}

/** the runtime body material: paintwork from the instance colour through the part mask */
export function carBodyMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.22, color: 0xffffff })
  return patchCarVertexColour(mat, 'tint')
}
