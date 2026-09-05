import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FERRIS_WHEEL, SEASON, SEASONS } from '~/data/suzuka-facilities-spec'
import type { EnvBuildContext } from './environment'
import { bucketedInstancedMeshes } from './instancing'

const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

/**
 * Ferris wheel (the Suzuka landmark beside the main straight). The returned group is added to
 * `group`; its child named 'wheel' turns (the caller animates it), so it must be kept out of
 * `freezeStatic`.
 */
export function buildFerrisWheel(ctx: EnvBuildContext): THREE.Group {
  const { track, terrain, group } = ctx
  const ferrisWheel = new THREE.Group()
  {
    // the real サーキットホイール: OSM footprint centroid behind the final-corner stands, 50.4 m
    // high, 48 m across, 36 gondolas (see FERRIS_WHEEL); it stands on ground ~7.6 m above the track
    track.enToWorld(FERRIS_WHEEL.en[0], FERRIS_WHEEL.en[1], _p)
    const groundY = terrain.meshHeightAt(_p.x, _p.z)
    ferrisWheel.position.set(_p.x, groundY, _p.z)
    const h = track.headingAt(FERRIS_WHEEL.s)
    _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz))
    ferrisWheel.quaternion.setFromRotationMatrix(_m)
    const R = FERRIS_WHEEL.diameter / 2
    const hub = FERRIS_WHEEL.height - R
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5, metalness: 0.3 })
    const wheel = new THREE.Group()
    wheel.name = 'wheel'
    wheel.position.set(0, hub, 0)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.7, 8, 48), whiteMat)
    const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 3, 0.4, 8, 48), whiteMat)
    rim.castShadow = true
    wheel.add(rim, rim2)
    const spokeGeo = new THREE.BoxGeometry(0.4, R * 2, 0.4)
    const gondolaGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6)
    const colors = [0xe63946, 0x2a9d8f, 0xf4a261, 0x457b9d, 0xffb703, 0x8ecae6]
    for (let i = 0; i < 12; i++) {
      const spoke = new THREE.Mesh(spokeGeo, whiteMat)
      spoke.rotation.z = (i / 12) * Math.PI
      wheel.add(spoke)
    }
    for (let i = 0; i < FERRIS_WHEEL.gondolas; i++) {
      const a = (i / FERRIS_WHEEL.gondolas) * Math.PI * 2
      const g = new THREE.Mesh(gondolaGeo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.4 }))
      g.position.set(Math.cos(a) * R, Math.sin(a) * R, 0)
      g.name = 'gondola'
      wheel.add(g)
    }
    ferrisWheel.add(wheel)
    const legGeo = new THREE.BoxGeometry(1.2, hub * 1.08, 1.2)
    for (const [dx, dz] of [[-14, 3], [14, 3], [-14, -3], [14, -3]]) {
      const leg = new THREE.Mesh(legGeo, whiteMat)
      leg.position.set(dx! / 2, hub / 2, dz!)
      leg.rotation.z = dx! > 0 ? -0.3 : 0.3
      leg.castShadow = true
      ferrisWheel.add(leg)
    }
    group.add(ferrisWheel)
  }
  return ferrisWheel
}

type TreeKind = 'evergreen' | 'bare' | 'blossom'

/** Fill (or add) a constant `color` attribute so the merged prototype can carry a per-part tint mask. */
function tinted(g: THREE.BufferGeometry, r: number, gr: number, b: number): THREE.BufferGeometry {
  const n = (g.attributes.position as THREE.BufferAttribute).count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = r
    col[i * 3 + 1] = gr
    col[i * 3 + 2] = b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

/**
 * One instanced prototype per silhouette, trunk included. The trunk is merged into the canopy
 * and told apart by a vertex-colour mask that the per-instance tint multiplies: the canopy
 * vertices are white (so they take the instance colour as is) and the trunk a warm brown
 * (dark green × brown = a dark trunk, pink × brown = a cherry's dark bark). One geometry per
 * kind is what keeps the draw count at what the old single evergreen cost.
 */
function treePrototype(kind: 'evergreen' | 'deciduous'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  if (kind === 'evergreen') {
    // cedar / cypress: two stacked cones on a stout trunk
    const c1 = new THREE.ConeGeometry(3.2, 7, 7)
    c1.translate(0, 6.5, 0)
    const c2 = new THREE.ConeGeometry(2.4, 5, 7)
    c2.translate(0, 9.5, 0)
    parts.push(tinted(c1, 1, 1, 1), tinted(c2, 1, 1, 1))
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 4, 6)
    trunk.translate(0, 2, 0)
    // lighter than the deciduous bark: it is multiplied by a very dark canopy tint
    parts.push(tinted(trunk, 1.0, 0.72, 0.5))
  } else {
    // bare / budding broadleaf or cherry: a thin trunk, three leaning branches and a loose
    // crown of four blobs — sparse enough to read as twigs when grey-brown, full enough to
    // read as blossom when pink
    const trunk = new THREE.CylinderGeometry(0.14, 0.24, 4.4, 6)
    trunk.translate(0, 2.2, 0)
    parts.push(tinted(trunk, 0.42, 0.3, 0.22))
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4
      const br = new THREE.CylinderGeometry(0.05, 0.1, 2.6, 5)
      br.translate(0, 1.3, 0)
      br.rotateZ(0.55)
      br.rotateY(a)
      br.translate(0, 4.1, 0)
      parts.push(tinted(br, 0.42, 0.3, 0.22))
    }
    const blobs: [number, number, number, number][] = [
      [0, 6.1, 0, 1.6],
      [1.15, 5.4, 0.3, 1.25],
      [-0.9, 5.6, -0.8, 1.2],
      [0.2, 5.3, 1.15, 1.1],
    ]
    for (const [x, y, z, r] of blobs) {
      const b = new THREE.SphereGeometry(r, 6, 4)
      b.translate(x, y, z)
      parts.push(tinted(b, 1, 1, 1))
    }
  }
  return mergeGeometries(parts, false)!
}

/**
 * Trees in the season's palette (spec SEASONS[SEASON].trees; late March = 60 % dark evergreen,
 * 30 % bare or budding deciduous, 10 % cherry in full bloom). The cherries are concentrated
 * where the photos show them — around the hairpin, outside the S-curves, in the park behind the
 * main grandstand and the main gate — and rare elsewhere. `quality.trees` instances scattered
 * over the terrain, kept off the track, the pit / paddock zone, the grandstands and the Ferris
 * wheel. Placement draws from `rng` in a fixed order, so the caller's seeded generator decides
 * the woods; run this after the Ferris wheel is placed.
 */
export function buildTrees(ctx: EnvBuildContext, ferrisWheel: THREE.Group) {
  const { track, terrain, quality, rng, group, standZones, keepOut } = ctx
  const season = SEASONS[SEASON]
  const evergreenGeo = treePrototype('evergreen')
  const deciduousGeo = treePrototype('deciduous')
  const count = quality.trees
  const treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true })
  const evergreens: THREE.Matrix4[] = []
  const evergreenColors: THREE.Color[] = []
  const deciduous: THREE.Matrix4[] = []
  const deciduousColors: THREE.Color[] = []
  const blossom = new THREE.Color(season.blossom)
  const blossomDeep = new THREE.Color('#e9a9be')
  const b = track.bounds
  let placed = 0
  let tries = 0
  const wheelPos = ferrisWheel.position
  // the park / main gate lie 150–450 m behind the main grandstand — beyond the 200 m reach of
  // the track search below, so they are tested against three anchor points instead
  const park = [5550, 5750, 80].map((s) => track.pointAt(s, 300, new THREE.Vector3()))
  const inCherryZone = (x: number, z: number, near: { i: number; s: number; lateral: number }): boolean => {
    if (near.i >= 0) {
      if (near.s >= 2600 && near.s <= 2800) return true
      if (near.s >= 1000 && near.s <= 1400 && near.lateral > 0) return true
    }
    for (const p of park) if (Math.hypot(x - p.x, z - p.z) < 190) return true
    return false
  }
  while (placed < count && tries < count * 40) {
    tries++
    const x = rng.range(b.minX - 420, b.maxX + 420)
    const z = rng.range(b.minZ - 380, b.maxZ + 380)
    const near = terrain.distanceToTrack(x, z, 200)
    if (near.d < 44) continue
    if (near.i >= 0) {
      const s = near.s
      const inPitZone = s >= 5540 || s <= 90
      if (inPitZone && near.lateral > -125 && near.lateral < 80) continue
      let inStand = false
      for (const { from, to, side, lateralBack } of standZones) {
        const inS = from < to ? s >= from - 15 && s <= to + 15 : s >= from - 15 || s <= to + 15
        if (inS && Math.sign(near.lateral) === side && Math.abs(near.lateral) < lateralBack + 26) inStand = true
      }
      if (inStand) continue
    }
    if (Math.hypot(x - wheelPos.x, z - wheelPos.z) < 60) continue
    // buildings and paving placed by the other builders
    let blocked = false
    for (const k of keepOut) {
      if (Math.hypot(x - k.x, z - k.z) < k.r) {
        blocked = true
        break
      }
    }
    if (blocked) continue
    // denser woods further from the track
    if (near.d < 120 && rng.next() < 0.55) continue
    // kind: the season's mix, with the cherries pulled into their zones (rare outside them)
    const r = rng.next()
    let kind: TreeKind
    if (season.trees.blossom > 0 && inCherryZone(x, z, near)) kind = r < 0.5 ? 'blossom' : r < 0.72 ? 'bare' : 'evergreen'
    else {
      const stray = season.trees.blossom * 0.3
      kind = r < stray ? 'blossom' : r < stray + season.trees.bare ? 'bare' : 'evergreen'
    }
    const y = terrain.meshHeightAt(x, z)
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * Math.PI * 2)
    if (kind === 'evergreen') {
      const sc = rng.range(0.7, 1.45)
      _s.set(sc, sc * rng.range(0.85, 1.2), sc)
      evergreens.push(new THREE.Matrix4().compose(_p.set(x, y - 0.3, z), _q, _s))
      // cedar / cypress / pine: dark, slightly blue-green, low saturation
      evergreenColors.push(new THREE.Color().setHSL(0.33 + rng.next() * 0.09, 0.26 + rng.next() * 0.18, 0.08 + rng.next() * 0.08))
    } else {
      const sc = kind === 'blossom' ? rng.range(0.75, 1.15) : rng.range(0.6, 1.05)
      _s.set(sc, sc * rng.range(0.9, 1.15), sc)
      deciduous.push(new THREE.Matrix4().compose(_p.set(x, y - 0.2, z), _q, _s))
      if (kind === 'blossom') deciduousColors.push(blossom.clone().lerp(blossomDeep, rng.next() * 0.6))
      // twigs and early buds: grey-brown, a hint of green on some
      else deciduousColors.push(new THREE.Color().setHSL(0.08 + rng.next() * 0.06, 0.12 + rng.next() * 0.14, 0.2 + rng.next() * 0.12))
    }
    placed++
  }
  // one InstancedMesh per terrain chunk (16) and prototype so the follow cameras and the cascades
  // cull the far side of the circuit; trees cast only where the tier allows
  const bucketOf = (_i: number, m: THREE.Matrix4) => terrain.chunkIndex(m.elements[12]!, m.elements[14]!)
  for (const inst of bucketedInstancedMeshes(evergreenGeo, treeMat, evergreens, evergreenColors, bucketOf, { castShadow: quality.treeShadows, name: 'evergreens' })) group.add(inst)
  for (const inst of bucketedInstancedMeshes(deciduousGeo, treeMat, deciduous, deciduousColors, bucketOf, { castShadow: quality.treeShadows, name: 'deciduous' })) group.add(inst)
}
