import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { APEX_SPEED_TARGETS, CIRCUIT, OVERTAKE_ZONES, TV_CAMERA_SPOTS } from '~/data/suzuka'
import { signedDelta, type Track } from '~/sim/track'
import { ribbonGeometry } from './track-mesh'
import type { EnvBuildContext } from './environment'
import { brakingRubberTexture, labelTexture } from './textures'
import { EMISSIVE, emissiveScale } from './emissive'
import { OSM_POWER_LINES, OSM_POWER_TOWERS } from '~/data/suzuka-power'
import { OSM_BUILDINGS, OSM_PIT_BUILDING, OSM_RACEWAY, type OsmFeature } from '~/data/suzuka-facilities'
import { BUILDINGS } from '~/data/suzuka-facilities-spec'
import { MARSHAL_POSTS, OFFSET_LANES, TV_MAST_OVERRIDES } from '~/data/suzuka-barriers-spec'
import { addRoadSurface } from './track-mesh'
import { ASPHALT_TILE_M, asphaltMaps } from './textures'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Trackside props: braking-distance boards, sector boards, marshal posts with their flags and
 * digital-flag panels, the rubbered-in braking zones, the TV camera masts and the overhead
 * power lines behind the circuit. The marshal huts go through the shared
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
      track.pointAt(s, lateral, _p, y + ground.yAt(s, lateral))
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
        track.pointAt(s, lat, _p, ground.yAt(s, lat))
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
      track.pointAt(s, lat, _p, ground.yAt(s, lat))
      for (const dx of [-1, 1]) {
        const post = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6)
        const hh = track.headingAt(s)
        post.translate(_p.x + hh.tx * dx * 1.0, _p.y + 1.0, _p.z + hh.tz * dx * 1.0)
        postGeos.push(post)
      }
    })
    // marshal posts at the huts the aerial shows (MARSHAL_POSTS), each with a flag pole, a green
    // flag and the EM Motorsport LED digital-flag panel (2018) a few metres before it. They used
    // to be dropped every 330 m alternating sides, which stood them in gravel traps, inside the C
    // terrace and on the racing line's verge (2026-09 audit).
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
      track.pointAt(poleS, lat, _p, ground.yAt(poleS, lat))
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
      // the panel faces the cars from a post between the hut and the road
      const panelS = s - 3.2
      const panelLat = lat - side * 1.2
      const pm = new THREE.Matrix4()
      orient(panelS, panelLat, 2.05, pm)
      flagPanels.push(pm)
      track.pointAt(panelS, panelLat, _p, ground.yAt(panelS, panelLat))
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
    // lit rubber so the streaks take the asphalt's shading (polygon offset keeps it off the road
    // surface on the reversed-Z path; three flips the offset sign there)
    // Kept light: at 0.7 opacity over the whole road width this painted the T1, hairpin and
    // chicane braking zones black from above (2026-09 audit). The real rubber sits in the two
    // driven lanes and only darkens the surface a little.
    const rubberMat = new THREE.MeshStandardMaterial({ map: rubberTex, alphaMap: rubberTex, color: 0x2a2a2c, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const geos: THREE.BufferGeometry[] = []
    for (const z of OVERTAKE_ZONES) {
      const from = z.s - 60
      const to = z.s + 30
      // the two lanes the cars brake in (the same u the asphalt tile rubbers in), not the full width
      for (const c of [-0.38, 0.38]) {
        geos.push(ribbonGeometry(track, from, to, (s) => track.halfWidthAt(s) * (c + 0.3), (s) => track.halfWidthAt(s) * (c - 0.3), () => 0.006, () => 0.006, 2, 10))
      }
    }
    const rubber = new THREE.Mesh(mergeGeometries(geos, false)!, rubberMat)
    rubber.renderOrder = 1
    rubber.name = 'brakingRubber'
    group.add(rubber)
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
      track.pointAt(s, lat, _p, ground.yAt(s, lat))
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
  buildOsmBuildings(ctx)
  buildSecondaryPaving(ctx)

  return { flagTime }
}

// ---------------------------------------------------------------- OSM building massing

/** eaves height (m) of an OSM building from its tags, else from its use and footprint area */
function buildingHeight(f: OsmFeature, area: number): number {
  const t = f.tags
  const explicit = Number(t.height)
  if (explicit > 0) return explicit
  const levels = Number(t['building:levels'])
  if (levels > 0) return levels * 3.2 + 0.6
  const name = t.name ?? ''
  const kind = t.building ?? 'yes'
  if (kind === 'roof') return 4.0
  if (kind === 'industrial' || kind === 'warehouse') return area > 3000 ? 12 : 9
  // the hotel wings (ノース館 / ウエスト館 / イースト館 / サウス館) are 4–5 storeys, the main building more
  if (name.includes('ホテル')) return 19
  if (name.endsWith('館')) return 14.5
  if (name.includes('コースター')) return 16
  if (area < 60) return 3.2
  if (area < 300) return 4.5
  if (area < 1500) return 7
  if (area < 5000) return 10
  return 12
}

/**
 * Every OSM building on the modelled terrain that no other builder owns (the pit building, the
 * spec'd buildings and the paddock box are the pit complex's): the Motopia park and its hotel
 * behind the final corner, the works and warehouses behind the Esses and Turn 3, the west-area
 * huts and gates. Flat massing — walls from the footprint, a level roof at the eaves height above
 * the footprint's highest ground — in three material groups (park / works / canopies).
 */
function buildOsmBuildings(ctx: EnvBuildContext) {
  const { track, terrain, group, keepOut } = ctx
  const cx = track.center.x, cz = track.center.z
  const inside = (x: number, z: number) => Math.abs(x - cx) < 1600 && Math.abs(z - cz) < 1200
  const owned = new Set<number>([OSM_PIT_BUILDING.id, ...BUILDINGS.map((b) => b.osmWay).filter((id): id is number => id !== null)])
  const inPaddock = (f: OsmFeature) => {
    const [s, lat] = f.centroid
    return lat < -57 && lat > -135 && (s > 5530 || s < 260) && !f.fold
  }
  const groups: Record<'park' | 'works' | 'canopy', { walls: THREE.BufferGeometry[]; roofs: THREE.BufferGeometry[] }> = {
    park: { walls: [], roofs: [] },
    works: { walls: [], roofs: [] },
    canopy: { walls: [], roofs: [] },
  }
  const k = track.enScale
  const v = new THREE.Vector3()
  let count = 0
  for (const f of OSM_BUILDINGS) {
    if (!f.closed || f.en.length < 3 || owned.has(f.id) || inPaddock(f)) continue
    // centroid and ground range of the footprint
    let ce = 0, cn = 0
    for (const [e, n] of f.en) {
      ce += e / f.en.length
      cn += n / f.en.length
    }
    track.enToWorld(ce, cn, v)
    if (!inside(v.x, v.z)) continue
    // buildings right beside the road were never modelled as boxes here: 6 m clearance of the verge
    const near = terrain.distanceToTrack(v.x, v.z, 80)
    if (near.i >= 0 && near.d < track.halfWidthAt(near.s) + 6) continue
    let area = 0
    let gMin = Infinity, gMax = -Infinity, rMax = 0
    for (let i = 0; i < f.en.length; i++) {
      const [e0, n0] = f.en[i]!, [e1, n1] = f.en[(i + 1) % f.en.length]!
      area += (e0 * n1 - e1 * n0) / 2
      track.enToWorld(e0, n0, v)
      const g = terrain.meshHeightAt(v.x, v.z)
      if (g < gMin) gMin = g
      if (g > gMax) gMax = g
      rMax = Math.max(rMax, Math.hypot(e0 - ce, n0 - cn) * k)
    }
    area = Math.abs(area)
    if (area < 12) continue
    const kind = f.tags.building ?? 'yes'
    const eaves = buildingHeight(f, area)
    const base = gMin - 0.4
    const height = eaves + Math.min(6, gMax - gMin) + 0.4
    const shape = new THREE.Shape(f.en.map(([e, n]) => new THREE.Vector2(e, n)))
    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
    // local EN (x = e, y = n, z = up) → world (x = e·k, y = z + base, z = −n·k)
    geo.applyMatrix4(new THREE.Matrix4().set(k, 0, 0, 0, 0, 0, 1, base, 0, -k, 0, 0, 0, 0, 0, 1))
    // ExtrudeGeometry's UVs are in shape units (metres): scale to a 4 m tile
    const uv = geo.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 4, uv.getY(i) / 4)
    const bucket = kind === 'roof' ? groups.canopy : kind === 'industrial' || kind === 'warehouse' ? groups.works : groups.park
    for (const g of geo.groups) {
      const part = new THREE.BufferGeometry()
      for (const name of ['position', 'normal', 'uv']) {
        const a = geo.getAttribute(name) as THREE.BufferAttribute
        part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(g.start * a.itemSize, (g.start + g.count) * a.itemSize), a.itemSize))
      }
      ;(g.materialIndex === 0 ? bucket.roofs : bucket.walls).push(part)
    }
    geo.dispose()
    track.enToWorld(ce, cn, v)
    keepOut.push({ x: v.x, z: v.z, r: rMax + 6 })
    count++
  }
  const mats = {
    park: [new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.8 }), new THREE.MeshStandardMaterial({ color: 0x9d9a94, roughness: 0.9 })],
    works: [new THREE.MeshStandardMaterial({ color: 0xc9d0d6, roughness: 0.6, metalness: 0.15 }), new THREE.MeshStandardMaterial({ color: 0x8b9298, roughness: 0.7, metalness: 0.2 })],
    canopy: [new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.8 }), new THREE.MeshStandardMaterial({ color: 0xb8b4ac, roughness: 0.8 })],
  }
  for (const key of ['park', 'works', 'canopy'] as const) {
    const g = groups[key]
    for (const [geos, mat, name] of [[g.walls, mats[key][0]!, 'Walls'], [g.roofs, mats[key][1]!, 'Roofs']] as const) {
      if (!geos.length) continue
      const merged = mergeGeometries(geos, false)
      for (const x of geos) x.dispose()
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = `osm${key[0]!.toUpperCase()}${key.slice(1)}${name}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }
  if (import.meta.dev) console.info(`[props] ${count} OSM buildings massed`)
}

// ---------------------------------------------------------------- secondary paving

/**
 * Asphalt ribbon along a world polyline (open or closed), `width` metres wide, draped on the
 * terrain mesh with `lift`; mitred joints from the averaged segment normals.
 */
function polylineRibbon(pts: THREE.Vector3[], width: number, closed: boolean, yAt: (x: number, z: number) => number, lift: number, tileM: number): THREE.BufferGeometry | null {
  const n = pts.length
  if (n < 2) return null
  const count = closed ? n + 1 : n
  const pos = new Float32Array(count * 6)
  const uv = new Float32Array(count * 4)
  const idx: number[] = []
  let along = 0
  const dir = new THREE.Vector3(), prev = new THREE.Vector3(), next = new THREE.Vector3(), side = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    const p = pts[i % n]!
    const a = pts[(i - 1 + n) % n]!, b = pts[(i + 1) % n]!
    prev.copy(p).sub(a).setY(0)
    next.copy(b).sub(p).setY(0)
    if (!closed && i === 0) prev.copy(next)
    if (!closed && i === n - 1) next.copy(prev)
    if (prev.lengthSq() > 0) prev.normalize()
    if (next.lengthSq() > 0) next.normalize()
    dir.copy(prev).add(next)
    if (dir.lengthSq() < 1e-6) dir.copy(next)
    dir.normalize()
    side.set(dir.z, 0, -dir.x).multiplyScalar(width / 2)
    if (i > 0) along += p.distanceTo(pts[(i - 1) % n]!)
    for (const [j, sgn] of [[0, 1], [1, -1]] as const) {
      const x = p.x + side.x * sgn, z = p.z + side.z * sgn
      const o = (i * 2 + j) * 3
      pos[o] = x
      pos[o + 1] = yAt(x, z) + lift
      pos[o + 2] = z
      uv[(i * 2 + j) * 2] = j
      uv[(i * 2 + j) * 2 + 1] = along / tileM
    }
    if (i < count - 1) {
      // (left, right, forward-left) is counter-clockwise seen from above: the ribbon faces up
      const q = i * 2
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * The asphalt that is not the Grand Prix lap: the two-wheel chicanes and slip roads (200R, the
 * Astemo chicane and its bypass, the bike pit entry), the West Course pit lane, the South Course
 * loop inside the west section and the kart tracks beside the Motopia park — all OSM raceway
 * ways with surface=asphalt that are not part of the lap. Draped on the terrain, so they read as
 * the grey ribbons the TV wide shots show across the infield.
 */
function buildSecondaryPaving(ctx: EnvBuildContext) {
  const { track, terrain, group, keepOut } = ctx
  const maps = asphaltMaps(false)
  // the run-off asphalt's own surface treatment (macro variation + detail), so the strips match the road
  const mat = new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.roughnessMap, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  addRoadSurface(mat, new THREE.Vector2(1, ASPHALT_TILE_M / 300), 9)
  const cx = track.center.x, cz = track.center.z
  const inside = (x: number, z: number) => Math.abs(x - cx) < 1600 && Math.abs(z - cz) < 1200
  /** the lap itself, its pit lane and the two-wheel / kart ways: widths by role */
  const widthOf = (f: OsmFeature): number => {
    const name = f.tags.name ?? ''
    if (name.includes('カート')) return 7
    if (name.includes('南コース')) return 10
    if (name.includes('Pit Lane')) return 10
    return 9
  }
  const geos: THREE.BufferGeometry[] = []
  let count = 0
  // the ways that touch the lap (two-wheel chicanes, slip roads, the West Course pit lane) are
  // built as offset lanes in the track frame by lanes.ts — a terrain ribbon along their raw
  // polyline used to lie across the racing surface
  const lanes = new Set(OFFSET_LANES.map((l) => l.osmWay))
  for (const f of OSM_RACEWAY) {
    // the lap's own ways sit on the centreline (dmin ≈ 0 and their s range covers them): skip
    // anything that hugs the road for its whole length; keep what leaves it
    if (f.lateral[1] - f.lateral[0] < 6 && f.dmin < 4) continue
    if (f.tags.name === 'Pit Lane' || lanes.has(f.id) || f.dmin < 8) continue
    const pts = f.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
    if (!pts.every((p) => inside(p.x, p.z))) continue
    const g = polylineRibbon(pts, widthOf(f), f.closed, (x, z) => terrain.meshHeightAt(x, z), 0.06, ASPHALT_TILE_M)
    if (!g) continue
    geos.push(g)
    // the kart and South Course loops are tree-free inside as well as on the ribbon
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
  if (geos.length) {
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (merged) {
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = 'secondaryPaving'
      mesh.receiveShadow = true
      mesh.renderOrder = 1
      group.add(mesh)
    }
  }
  if (import.meta.dev) console.info(`[props] ${count} secondary paved ways`)
}

/**
 * The 77 kV overhead lines around the circuit (OSM power=tower / power=line, see
 * app/data/suzuka-power.ts): lattice pylons behind Turns 1–2, the main straight and the west
 * side are in every TV wide shot. One instanced lattice prototype (legs following the taper, ring
 * and X bracing, three pairs of cross-arms with insulator strings) stands on the terrain at each
 * tower; six catenary cables run between consecutive line vertices as plain lines.
 */
function buildPowerLines(ctx: EnvBuildContext) {
  const { track, terrain, group, quality } = ctx
  const H = 42
  const baseHalf = 3.6
  const topHalf = 1.1
  const arms = [{ y: 27, len: 7.5 }, { y: 33, len: 6.5 }, { y: 39, len: 5.5 }]
  const insulator = 1.3
  // only what stands on the modelled terrain (3400 × 2600 m around the track centre)
  const cx = track.center.x, cz = track.center.z
  const inside = (x: number, z: number) => Math.abs(x - cx) < 1650 && Math.abs(z - cz) < 1250

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  const parts: THREE.BufferGeometry[] = []
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
    const d = b.clone().sub(a)
    const len = d.length()
    const g = new THREE.BoxGeometry(w, len, w)
    g.translate(0, len / 2, 0)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()))
    g.translate(a.x, a.y, a.z)
    parts.push(g)
  }
  const halfAt = (y: number) => baseHalf + (topHalf - baseHalf) * (y / H)
  const rings = [0, 6, 12, 18, 24, 30, 36, H]
  for (let i = 0; i < rings.length - 1; i++) {
    const y0 = rings[i]!, y1 = rings[i + 1]!
    const h0 = halfAt(y0), h1 = halfAt(y1)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(V(sx * h0, y0, sz * h0), V(sx * h1, y1, sz * h1), 0.28)
    // ring at the top of the panel and an X brace on each of the four faces
    bar(V(-h1, y1, -h1), V(h1, y1, -h1), 0.12)
    bar(V(h1, y1, -h1), V(h1, y1, h1), 0.12)
    bar(V(h1, y1, h1), V(-h1, y1, h1), 0.12)
    bar(V(-h1, y1, h1), V(-h1, y1, -h1), 0.12)
    for (const f of [-1, 1]) {
      bar(V(-h0, y0, f * h0), V(h1, y1, f * h1), 0.1)
      bar(V(h0, y0, f * h0), V(-h1, y1, f * h1), 0.1)
      bar(V(f * h0, y0, -h0), V(f * h1, y1, h1), 0.1)
      bar(V(f * h0, y0, h0), V(f * h1, y1, -h1), 0.1)
    }
  }
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
    p.y = terrain.meshHeightAt(p.x, p.z) - 0.3
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
      const ya = terrain.meshHeightAt(a.x, a.z), yb = terrain.meshHeightAt(b.x, b.z)
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
    const cables = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x15161a }))
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
