import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { APEX_SPEED_TARGETS, CIRCUIT, OVERTAKE_ZONES, TV_CAMERA_SPOTS } from '~/data/suzuka'
import { signedDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal } from './ground'
import type { DecalQuad } from './ground-mesh'
import { brakingRubberTexture, labelTexture } from './textures'
import { EMISSIVE, emissiveScale } from './emissive'
import { OSM_POWER_LINES, OSM_POWER_TOWERS } from '~/data/suzuka-power'
import { GROUND_AREAS } from '~/data/suzuka-facilities-spec'
import { MARSHAL_POSTS, TV_MAST_OVERRIDES } from '~/data/suzuka-barriers-spec'
import { osmWay } from './trackside'
import { barrierLateralAt } from './barriers'
import { barGeometry, latticeParts } from './lattice'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Trackside props: braking-distance boards, sector boards, marshal posts with their flags and
 * digital-flag panels, the rubbered-in braking zones, the TV camera masts and the overhead
 * power lines behind the circuit. (The OSM buildings of the surroundings used to be massed here
 * too; app/three/buildings.ts owns them since plan §2c.) The marshal huts go through the shared
 * `boxes` placer (the caller flushes it); `hutRoofMat` is the pit building's roof material, so
 * the hut roofs merge into the same mesh as the rest of that material.
 * Returns the flag-wave clock (also left on `group.userData.flagTime`), advanced per frame.
 */
export function buildTracksideProps(ctx: EnvBuildContext, hutRoofMat: THREE.Material): { flagTime: { value: number } } {
  const { track, ground, group, boxes } = ctx
  const hw = track.halfWidth
  const flagTime = { value: 0 }

  // --- trackside furniture: distance boards, marshal posts, sector boards -------------------------
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
    // sector boards at the timing lines
    const sectorGeo = new THREE.PlaneGeometry(2.4, 1.0)
    sectorGeo.rotateY(Math.PI)
    CIRCUIT.sectors.forEach((s, i) => {
      const side = cameraSide(track, s)
      const lat = side * (track.halfWidthAt(s) + 4)
      const mesh = new THREE.Mesh(sectorGeo, new THREE.MeshStandardMaterial({ map: labelTexture(`SECTOR ${i + 2}`, '#111111', '#ffffff', 512, 224, 96), roughness: 0.6, side: THREE.DoubleSide }))
      const m = new THREE.Matrix4()
      orient(s, lat, 2.4, m)
      mesh.applyMatrix4(m)
      group.add(mesh)
      track.pointAt(s, lat, _p, ground.standAt(s, lat))
      for (const dx of [-1, 1]) {
        const post = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6)
        const hh = track.headingAt(s)
        post.translate(_p.x + hh.tx * dx * 1.0, _p.y + 1.0, _p.z + hh.tz * dx * 1.0)
        postGeos.push(post)
      }
    })
    // marshal posts at the huts the aerial shows (MARSHAL_POSTS), each with a flag pole, a green
    // flag and ONE head-height LED digital-flag panel (EM Motorsport, 2018) a few metres before
    // it, on a grey pole at the fence line — the light-panel photo shows a single panel bracketed
    // off the fence post, no mast. They used to be dropped every 330 m alternating sides, which
    // stood them in gravel traps, inside the C terrace and on the racing line's verge (2026-09 audit).
    const flagPanels: THREE.Matrix4[] = []
    const hutMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 })
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1f8a3f, roughness: 0.7 })
    const flagGeos: THREE.BufferGeometry[] = []
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x1fa34a, roughness: 0.9, side: THREE.DoubleSide })
    for (const post of MARSHAL_POSTS) {
      const s = post.s
      const lat = post.lateral
      const side: 1 | -1 = lat >= 0 ? 1 : -1
      boxes.place(s, lat, 2.4, 1.8, 1.3, hutMat, 0, false, false)
      boxes.place(s, lat, 2.4, 1.85, 0.25, stripeMat, 0.6, false, false)
      boxes.place(s, lat, 2.5, 1.9, 0.12, hutRoofMat, 1.3, false, false)
      const poleS = s + 1.8
      track.pointAt(poleS, lat, _p, ground.standAt(poleS, lat))
      const pole = new THREE.CylinderGeometry(0.03, 0.03, 3.6, 6)
      pole.translate(_p.x, _p.y + 1.8, _p.z)
      postGeos.push(pole)
      const flag = new THREE.PlaneGeometry(1.0, 0.7, 8, 2)
      const h = track.headingAt(poleS)
      // hang from the pole top, trailing along the track direction; per-vertex phase in uv.x
      flag.translate(0.5, 0, 0)
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tx, 0, h.tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-h.tz, 0, h.tx))
      m.setPosition(_p.x, _p.y + 3.2, _p.z)
      flag.applyMatrix4(m)
      flagGeos.push(flag)
      // the panel faces the cars from a 0.08 m pole 0.3 m on the track side of the barrier line
      // (the fence line), so it stands clear of the wall top and in front of the mesh; where no
      // run is tabled there it stays between the hut and the road
      const panelS = s - 3.2
      const fenceLat = barrierLateralAt(track, panelS, side)
      const panelLat = fenceLat !== null ? fenceLat - side * 0.3 : lat - side * 1.2
      const pm = new THREE.Matrix4()
      orient(panelS, panelLat, 2.05, pm)
      flagPanels.push(pm)
      track.pointAt(panelS, panelLat, _p, ground.standAt(panelS, panelLat))
      const panelPost = new THREE.CylinderGeometry(0.04, 0.04, 1.75, 6)
      panelPost.translate(_p.x, _p.y + 0.875, _p.z)
      postGeos.push(panelPost)
    }
    // one merged mesh for every post and pole placed above (the marshal poles included)
    group.add(new THREE.Mesh(mergeGeometries(postGeos, false)!, postMat))
    {
      // LED face towards the approaching cars, dark housing just behind it; the glow sits under the
      // bloom threshold (EMISSIVE.digitalFlag), so it reads as a lit panel rather than a lamp
      const faceGeo = new THREE.PlaneGeometry(0.9, 0.55)
      faceGeo.rotateY(Math.PI)
      const faceMat = new THREE.MeshStandardMaterial({ color: 0x0a0f0c, emissive: EMISSIVE.digitalFlag.color, emissiveIntensity: EMISSIVE.digitalFlag.intensity * emissiveScale(), roughness: 0.4 })
      const faces = new THREE.InstancedMesh(faceGeo, faceMat, flagPanels.length)
      const housingGeo = new THREE.BoxGeometry(1.0, 0.66, 0.1)
      housingGeo.translate(0, 0, 0.06)
      const housings = new THREE.InstancedMesh(housingGeo, new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.6, metalness: 0.3 }), flagPanels.length)
      flagPanels.forEach((m, i) => {
        faces.setMatrixAt(i, m)
        housings.setMatrixAt(i, m)
      })
      faces.instanceMatrix.needsUpdate = true
      housings.instanceMatrix.needsUpdate = true
      faces.name = 'digitalFlags'
      housings.receiveShadow = true
      group.add(faces, housings)
    }
    const flags = new THREE.Mesh(mergeGeometries(flagGeos, false)!, flagMat)
    flags.name = 'flags'
    flags.frustumCulled = false
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = flagTime
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = uv.x;
          transformed.y += sin(uTime * 5.0 + position.x * 2.0 + position.z * 2.0 + w * 6.0) * 0.06 * w;
          transformed.x += cos(uTime * 3.7 + w * 5.0 + position.z) * 0.05 * w;`)
    }
    group.add(flags)
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

  // --- TV camera masts -------------------------------------------------------------------------
  {
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.6, metalness: 0.5 })
    const mastGeo = new THREE.CylinderGeometry(0.18, 0.25, 9, 8)
    const camGeo = new THREE.BoxGeometry(0.7, 0.5, 1.1)
    const masts = new THREE.InstancedMesh(mastGeo, mastMat, TV_CAMERA_SPOTS.length)
    const cams = new THREE.InstancedMesh(camGeo, mastMat, TV_CAMERA_SPOTS.length)
    TV_CAMERA_SPOTS.forEach((s, i) => {
      // a few of the generated spots land in a gravel trap or a run-off; those carry an override
      const lat = TV_MAST_OVERRIDES[s] ?? cameraSide(track, s) * (hw + 9)
      track.pointAt(s, lat, _p, ground.standAt(s, lat))
      masts.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 3.5, _p.z))
      cams.setMatrixAt(i, _m.makeTranslation(_p.x, _p.y + 8.3, _p.z))
    })
    masts.instanceMatrix.needsUpdate = true
    cams.instanceMatrix.needsUpdate = true
    masts.castShadow = true
    masts.name = 'tvMasts'
    group.add(masts, cams)
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
 * and X bracing, three pairs of cross-arms with insulator strings) stands on the terrain at each
 * tower; six catenary cables run between consecutive line vertices as plain lines.
 */
/** metres from the camera over which the power cables fade to nothing */
const CABLE_FADE = [250, 700] as const

function buildPowerLines(ctx: EnvBuildContext) {
  const { track, ground, group, quality } = ctx
  const H = 42
  const baseHalf = 3.6
  const topHalf = 1.1
  const arms = [{ y: 27, len: 7.5 }, { y: 33, len: 6.5 }, { y: 39, len: 5.5 }]
  const insulator = 1.3
  // only what stands on the modelled terrain (3400 × 2600 m around the track centre)
  const cx = track.center.x, cz = track.center.z
  const inside = (x: number, z: number) => Math.abs(x - cx) < 1650 && Math.abs(z - cz) < 1250

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  // the body is the shared lattice (lattice.ts); the cross-arms and insulators are the pylon's own
  const parts: THREE.BufferGeometry[] = latticeParts({ height: H, baseHalf, topHalf, panel: 6, leg: 0.28, ring: 0.12, brace: 0.1, braces: true })
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => parts.push(barGeometry(a, b, w))
  const halfAt = (y: number) => baseHalf + (topHalf - baseHalf) * (y / H)
  for (const a of arms) {
    bar(V(-a.len, a.y, 0), V(a.len, a.y, 0), 0.22)
    bar(V(-a.len, a.y + 1.2, 0), V(-halfAt(a.y + 1.2), a.y + 1.2, 0), 0.1)
    bar(V(a.len, a.y + 1.2, 0), V(halfAt(a.y + 1.2), a.y + 1.2, 0), 0.1)
    for (const sx of [-1, 1]) bar(V(sx * a.len, a.y, 0), V(sx * a.len, a.y - insulator, 0), 0.14)
  }
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

  // cables: six per span (three arms × two sides), a parabola with ~3 % sag
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
      for (const arm of arms) {
        for (const sx of [-1, 1]) {
          for (let k = 0; k < N; k++) {
            for (const t of [k / N, (k + 1) / N]) {
              const x = a.x + (b.x - a.x) * t + perp.x * sx * arm.len
              const z = a.z + (b.z - a.z) * t + perp.z * sx * arm.len
              const y = ya + (yb - ya) * t + arm.y - insulator - sag * 4 * t * (1 - t)
              pos.push(x, y, z)
            }
          }
        }
      }
    }
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    // a conductor is 30 mm: a 1 px line is already 10× too wide at 250 m, and from the overview
    // (1.8 km) six of them read as black bands across the fields — fade them out with distance
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

/** Which side of the track a trackside camera should stand on (outside of the nearest corner). */
export function cameraSide(track: Track, s: number): 1 | -1 {
  let k = 0
  for (let d = -40; d <= 40; d += 10) k += track.kappaAt(s + d)
  if (Math.abs(k) < 1e-4) return 1
  return k > 0 ? -1 : 1
}
