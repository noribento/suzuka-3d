import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { APEX_SPEED_TARGETS, OVERTAKE_ZONES } from '~/data/suzuka'
import { signedDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal } from './ground'
import type { DecalQuad } from './ground-mesh'
import { brakingRubberTexture, labelTexture } from './textures'
import { OSM_POWER_LINES, OSM_POWER_TOWERS } from '~/data/suzuka-power'
import { GROUND_AREAS } from '~/data/suzuka-facilities-spec'
import { osmWay } from './trackside'
import { barGeometry, latticeParts } from './lattice'
import { cameraSide } from './tv-lens'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Trackside props: braking-distance boards, the rubbered-in braking zones and the overhead
 * power lines behind the circuit. (The OSM buildings of the surroundings used to be massed here
 * too; app/three/buildings.ts owns them since plan §2c. The marshal posts, their flags and light
 * panels moved to app/three/marshal-posts.ts at I4-a, and the 'SECTOR 2 / 3' boards went with
 * them — Suzuka has no sector boards, `CIRCUIT.sectors` is timing only. The TV camera towers are
 * tv-towers.ts since I4-b.) `hutRoofMat` is the pit building's roof material (unused since
 * I4-a; kept for the call site). Returns the flag-wave clock (also left on
 * `group.userData.flagTime`), advanced per frame — the caller's when given (buildEnvironment
 * shares one clock with the paddock's flags).
 */
export function buildTracksideProps(ctx: EnvBuildContext, _hutRoofMat: THREE.Material, flagTime: { value: number } = { value: 0 }): { flagTime: { value: number } } {
  const { track, ground, group } = ctx

  // --- trackside furniture: the distance boards ---------------------------------------------
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.6 })
    const boardGeos: Record<string, THREE.Matrix4[]> = { '150': [], '100': [], '50': [] }
    const postGeos: THREE.BufferGeometry[] = []
    const orient = (s: number, lateral: number, y: number, out: THREE.Matrix4) => {
      const h = track.headingAt(s)
      track.pointAt(s, lateral, _p, y + ground.standAt(s, lateral))
      _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
      _q.setFromRotationMatrix(_m)
      out.compose(_p, _q, new THREE.Vector3(1, 1, 1))
    }
    // braking boards before every corner that has a braking zone
    for (const c of track.corners) {
      const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(signedDelta(t.s, c.apex, track.length)) < 60)
      if (!tgt || tgt.kmh > 240) continue
      const side: 1 | -1 = c.sign > 0 ? -1 : 1 // outside of the corner
      for (const [label, dist] of [['150', 150], ['100', 100], ['50', 50]] as const) {
        const s = c.from - dist
        const lat = side * (track.halfWidthAt(s) + 3.2)
        const m = new THREE.Matrix4()
        orient(s, lat, 1.55, m)
        boardGeos[label]!.push(m)
        track.pointAt(s, lat, _p, ground.standAt(s, lat))
        const post = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6)
        post.translate(_p.x, _p.y + 0.55, _p.z)
        postGeos.push(post)
      }
    }
    // boards face the approaching cars (back along the track)
    const boardGeo = new THREE.PlaneGeometry(0.9, 0.9)
    boardGeo.rotateY(Math.PI)
    for (const [label, mats] of Object.entries(boardGeos)) {
      if (!mats.length) continue
      const mat = new THREE.MeshStandardMaterial({ map: labelTexture(label, '#1848a0', '#ffffff'), roughness: 0.6, side: THREE.DoubleSide })
      const inst = new THREE.InstancedMesh(boardGeo, mat, mats.length)
      mats.forEach((m, i) => inst.setMatrixAt(i, m))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = true
      group.add(inst)
    }
    // one merged mesh for every post placed above
    group.add(new THREE.Mesh(mergeGeometries(postGeos, false)!, postMat))
    group.userData.flagTime = flagTime
  }

  // --- rubbered-in braking zones (dark streaks laid down before the slow corners) ---------------
  {
    const rubberTex = brakingRubberTexture()
    // lit rubber so the streaks take the asphalt's shading: a decal on the DRAWN road (ground.decal),
    // LAYER.road.rubber up — soft (no depth write), so nothing z-fights it, but a ribbon of its own
    // chorded 33 mm under the road's fold at the hairpin and was invisible there
    // Kept light: at 0.7 opacity over the whole road width this painted the T1, hairpin and
    // chicane braking zones black from above (2026-09 audit). The real rubber sits in the two
    // driven lanes and only darkens the surface a little.
    const rubberMat = new THREE.MeshStandardMaterial({ map: rubberTex, alphaMap: rubberTex, color: 0x2a2a2c, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const quads: DecalQuad[] = []
    const L = track.length
    for (const z of OVERTAKE_ZONES) {
      const from = z.s - 60
      const to = z.s + 30
      // the two lanes the cars brake in (the same u the asphalt tile rubbers in), not the full width
      for (const c of [-0.38, 0.38]) {
        const l: Fn = (s) => track.halfWidthAt(s) * (c + 0.3), r: Fn = (s) => track.halfWidthAt(s) * (c - 0.3)
        const rows = ground.plan.lattice(from, to, 2)
        for (let i = 0; i < rows.length - 1; i++) {
          const sa = rows[i]!, sb = rows[i + 1]!
          const xz: number[] = []
          for (const [s, lat] of [[sa, r(sa)], [sa, l(sa)], [sb, l(sb)], [sb, r(sb)]] as const) {
            track.pointAt(s, lat, _p, 0)
            xz.push(_p.x, _p.z)
          }
          track.pointAt((sa + sb) / 2, (l(sa) + r(sa)) / 2, _p, 0)
          quads.push({ xz, yHint: _p.y, attrs: (x, zz) => {
            const p = track.nearestOnRange(x, zz, sa, sb, 2)
            const f = (p.lateral - r(p.s)) / (l(p.s) - r(p.s))
            return [1 - Math.min(1, Math.max(0, f)), signedDelta(from, p.s, L) / 10]
          } })
        }
      }
    }
    const built = ground.decal(quads, LAYER.road.rubber, [{ name: 'uv', size: 2 }])
    if (built.geo) {
      const rubber = new THREE.Mesh(built.geo, rubberMat)
      rubber.renderOrder = 1
      rubber.name = 'brakingRubber'
      markDecal(rubber, LAYER.road.rubber, built.stats)
      group.add(rubber)
    }
  }

  buildPowerLines(ctx)
  keepOutSecondaryPaving(ctx)

  return { flagTime }
}

// ---------------------------------------------------------------- secondary paving

/**
 * The asphalt that is not the Grand Prix lap — the South Course loop, the kart tracks, the loop
 * outside the final corner — is GROUND: the `way` rows of GROUND_AREAS, drawn by ground-mesh.ts
 * on the field. What the props still own is keeping the trees off them: the kart and South
 * Course loops are tree-free inside as well as on the ribbon.
 */
function keepOutSecondaryPaving(ctx: EnvBuildContext) {
  const { track, keepOut } = ctx
  let count = 0
  for (const a of GROUND_AREAS) {
    if (!('way' in a.footprint)) continue
    const f = osmWay(a.footprint.way)
    if (!f) continue
    const pts = f.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
    if (f.closed) {
      let ce = 0, cn = 0
      for (const p of pts) {
        ce += p.x / pts.length
        cn += p.z / pts.length
      }
      let r = 0
      for (const p of pts) r = Math.max(r, Math.hypot(p.x - ce, p.z - cn))
      if (r < 120) keepOut.push({ x: ce, z: cn, r: r + 8 })
      else for (const p of pts) keepOut.push({ x: p.x, z: p.z, r: 14 })
    } else for (const p of pts) keepOut.push({ x: p.x, z: p.z, r: 10 })
    count++
  }
  if (import.meta.dev) console.info(`[props] ${count} secondary paved ways kept tree-free`)
}

/**
 * The 77 kV overhead lines around the circuit (OSM power=tower / power=line, see
 * app/data/suzuka-power.ts): lattice pylons behind Turns 1–2, the main straight and the west
 * side are in every TV wide shot. One instanced lattice prototype (legs following the taper, ring
 * and X bracing, three pairs of truss cross-arms — two chords and three diagonals each — with a
 * suspension insulator string of four discs under every tip, and a 3 m mast on the peak for the
 * overhead ground wire) stands on the terrain at each tower; six catenary conductors plus the
 * ground wire run between consecutive line vertices as plain lines. ≈ 2.4 k triangles per tower,
 * a few dozen towers, one InstancedMesh.
 */
/** metres from the camera over which the power cables fade to nothing */
const CABLE_FADE = [250, 700] as const

function buildPowerLines(ctx: EnvBuildContext) {
  const { track, ground, group, quality } = ctx
  const H = 42
  const baseHalf = 3.6
  const topHalf = 1.1
  const arms = [{ y: 27, len: 7.5 }, { y: 33, len: 6.5 }, { y: 39, len: 5.5 }]
  /** insulator string length (m): the conductor hangs this far under the arm tip */
  const insulator = 1.3
  /** the overhead-ground-wire mast on the peak (m) */
  const peak = 3
  // only what stands on the modelled terrain (3400 × 2600 m around the track centre)
  const cx = track.center.x, cz = track.center.z
  const inside = (x: number, z: number) => Math.abs(x - cx) < 1650 && Math.abs(z - cz) < 1250

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  // the body is the shared lattice (lattice.ts); the cross-arms and insulators are the pylon's own
  const parts: THREE.BufferGeometry[] = latticeParts({ height: H, baseHalf, topHalf, panel: 6, leg: 0.28, ring: 0.12, brace: 0.1, braces: true })
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => parts.push(barGeometry(a, b, w))
  const halfAt = (y: number) => baseHalf + (topHalf - baseHalf) * (y / H)
  const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t)
  for (const a of arms) {
    for (const sx of [-1, 1]) {
      // the arm is a Warren truss: the top chord leaves the body 1 m over the arm line and
      // droops to the tip 0.5 m over it, the bottom chord leaves 1.4 m under it and rises to
      // the tip; a post closes the tip and three diagonals zigzag between the chords
      const T0 = V(sx * halfAt(a.y + 1.0), a.y + 1.0, 0), T1 = V(sx * a.len, a.y + 0.5, 0)
      const B0 = V(sx * halfAt(a.y - 1.4), a.y - 1.4, 0), B1 = V(sx * a.len, a.y, 0)
      bar(T0, T1, 0.14)
      bar(B0, B1, 0.14)
      bar(B1, T1, 0.1)
      bar(B0, lerp(T0, T1, 1 / 3), 0.08)
      bar(lerp(T0, T1, 1 / 3), lerp(B0, B1, 2 / 3), 0.08)
      bar(lerp(B0, B1, 2 / 3), T1, 0.08)
      // the suspension string: a rod with four sheds at 0.3 m, the conductor clamp at its end
      bar(B1, V(sx * a.len, a.y - insulator, 0), 0.1)
      for (let k = 0; k < 4; k++) {
        const disc = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8)
        disc.translate(sx * a.len, a.y - 0.25 - k * 0.3, 0)
        parts.push(disc)
      }
    }
  }
  // the peak: a mast for the overhead ground wire, stayed to the top ring's corners
  bar(V(0, H, 0), V(0, H + peak, 0), 0.14)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(V(sx * topHalf, H, sz * topHalf), V(0, H + peak, 0), 0.08)
  const towerGeo = mergeGeometries(parts, false)!
  for (const g of parts) g.dispose()
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x6d7378, roughness: 0.55, metalness: 0.7 })

  // tower yaw: the direction of the line through it (nearest line vertex within 3 m)
  const towers: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = []
  const lineVerts: { p: THREE.Vector3; dir: THREE.Vector3 }[] = []
  for (const line of OSM_POWER_LINES) {
    const pts = line.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!
      lineVerts.push({ p: pts[i]!, dir: b.clone().sub(a).setY(0).normalize() })
    }
  }
  for (const t of OSM_POWER_TOWERS) {
    const p = track.enToWorld(t.en[0], t.en[1], new THREE.Vector3())
    if (!inside(p.x, p.z)) continue
    p.y = ground.standY(p.x, p.z) - 0.3
    let best: (typeof lineVerts)[number] | null = null
    let bd = 9
    for (const v of lineVerts) {
      const d = Math.hypot(v.p.x - p.x, v.p.z - p.z)
      if (d < bd) { bd = d; best = v }
    }
    towers.push({ pos: p, dir: best ? best.dir : V(0, 0, 1) })
  }
  if (towers.length) {
    const inst = new THREE.InstancedMesh(towerGeo, towerMat, towers.length)
    towers.forEach((t, i) => {
      // local +z along the line, +x across it (the cross-arms)
      _m.makeBasis(V(t.dir.z, 0, -t.dir.x), V(0, 1, 0), t.dir)
      _q.setFromRotationMatrix(_m)
      inst.setMatrixAt(i, new THREE.Matrix4().compose(t.pos, _q, V(1, 1, 1)))
    })
    inst.instanceMatrix.needsUpdate = true
    inst.castShadow = quality.treeShadows
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    inst.name = 'pylons'
    group.add(inst)
  }

  // cables: six conductors per span (three arms × two sides, hung `insulator` under the tips)
  // and the ground wire on the peak, each a parabola with ~3 % sag
  const runs = [...arms.flatMap((a) => [-1, 1].map((sx) => ({ off: sx * a.len, y: a.y - insulator }))), { off: 0, y: H + peak }]
  const pos: number[] = []
  for (const line of OSM_POWER_LINES) {
    const pts = line.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!
      if (!inside(a.x, a.z) || !inside(b.x, b.z)) continue
      const ya = ground.standY(a.x, a.z), yb = ground.standY(b.x, b.z)
      const dir = b.clone().sub(a).setY(0)
      const span = dir.length()
      if (span < 20 || span > 700) continue
      dir.normalize()
      const perp = V(dir.z, 0, -dir.x)
      const sag = Math.min(12, span * 0.032)
      const N = 10
      for (const run of runs) {
        for (let k = 0; k < N; k++) {
          for (const t of [k / N, (k + 1) / N]) {
            const x = a.x + (b.x - a.x) * t + perp.x * run.off
            const z = a.z + (b.z - a.z) * t + perp.z * run.off
            const y = ya + (yb - ya) * t + run.y - sag * 4 * t * (1 - t)
            pos.push(x, y, z)
          }
        }
      }
    }
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    // a conductor is 30 mm: a 1 px line is already 10× too wide at 250 m, and from the overview
    // (1.8 km) seven of them read as black bands across the fields — fade them out with distance
    // the way coverage does (invisible past 700 m, as in every aerial photo)
    const mat = new THREE.LineBasicMaterial({ color: 0x15161a, transparent: true, depthWrite: false })
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vCableDist;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvCableDist = -mvPosition.z;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCableDist;')
        .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.a *= 1.0 - smoothstep(${CABLE_FADE[0].toFixed(1)}, ${CABLE_FADE[1].toFixed(1)}, vCableDist);`)
    }
    mat.customProgramCacheKey = () => 'powerCables'
    const cables = new THREE.LineSegments(geo, mat)
    cables.name = 'powerCables'
    group.add(cables)
  }
}

/** Which side of the track a trackside camera stands on — lives with the TV lenses (tv-lens.ts) since I4-b; re-exported for the boards and signs. */
export { cameraSide }
