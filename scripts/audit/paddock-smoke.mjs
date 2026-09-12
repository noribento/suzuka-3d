#!/usr/bin/env node
/**
 * Paddock smoke (I2 — the paddock behind the pit building; dev-only — not part of `pnpm check`):
 * builds the scene on both tiers through app-runtime.mjs (no asset pack → the procedural
 * fallbacks), drains the far field and checks the common I-phase facts (smoke-common.mjs): no
 * deferred job failed, every `ops-*` / `infield-*` / `paddock-*` object has finite vertices and
 * stands inside the circuit ring 775428456, `buildMs.paddock` finite once the builder reports.
 * Then the phase's own facts:
 *
 *  I2-a  the ground rows: every I2-a GROUND_AREAS row (A パドック南列 / センターハウス回廊 /
 *        B パドック / B パドック斜め区画 / E パドック / E パドック接続 / サービスハウス前庭 /
 *        センターハウス芝島) is a ring of the built plan, `plan.ownerAt` at a sample point inside
 *        each is that row, its area is inside A9's 20 m² < A < 20,000 m², and the sample point's
 *        drawn face (ground.builtY) is the row's kind — on both tiers; the grass island's kerb
 *        (`paddockIslandKerb`) is one mesh tagged GROUND_OBJECTS.islandKerb with the ring's
 *        length, every vertex finite and within the rule's sink / crown of the drawn ground;
 *        the paddock material is the pack-less fallback here (assets === null: a plain map,
 *        no PBR maps) and the ground:paddock face exists.
 *  I2-b  the buildings (PADDOCK_BUILDINGS): the team-office modules are one InstancedMesh set
 *        (`teamOffices*`) whose instance count is the table's (Σ modules + the WC block), and
 *        every module's floor (its instance matrix's y) is PADDOCK_PLANE.floor over the paddock
 *        plane at the module's −s end, |y − (roadPlane(s0) − drop + floor)| ≤ 0.02; the A block,
 *        the centre house (16 columns, the canopy, the glass band, the paving decal with
 *        uncovered ≈ 0), the SMSC, the fuel station (2 island kerbs = markObject islandKerb, the
 *        canopy), the service house / tyre garage, the vehicle base, the tunnel heads and the
 *        masts exist as named meshes with finite vertices; the fence (`paddockFence`, vertical
 *        faces only — every triangle normal |ny| < 0.05) is ≥ 600 m long with its posts and
 *        3 gates; the lamps (`infield-lamps`) count ≥ 20; every `paddock*` / `teamOffices*` /
 *        `centreHouse*` / `infield-*` object stands inside the circuit ring (`paddockBuildings` /
 *        `paddockRoofs` are the other BUILDINGS rows — CIRCUIT PLAZA is outside — and are skipped); `stats.infield`
 *        carries the same counts; `buildMs.paddock` is finite.
 *
 *   node scripts/audit/paddock-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, smokeArgs, standPoints, trisOf } from './smoke-common.mjs'
import { insideRing } from './ring.mjs'

const { tiers, check, finish, glb } = smokeArgs('paddock-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))

/** the I2-a rows and a lap-frame sample point inside each (windowed to the row's own stretch) */
const ROWS = [
  { name: 'A パドック南列', kind: 'paddock', at: [5670, -134], window: [5600, 5742] },
  { name: 'センターハウス回廊', kind: 'paddock', at: [5752, -134], window: [5742, 5806] },
  { name: 'B パドック', kind: 'paddock', at: [20, -126], window: [5806, 48] },
  { name: 'B パドック斜め区画', kind: 'paddock', at: [80, -142], window: [66, 96] },
  { name: 'E パドック（ピット入口駐車場）', kind: 'paddock', at: [5420, -60], window: [5340, 5510] },
  { name: 'E パドック接続', kind: 'paddock', at: [5512, -68], window: [5480, 5536] },
  { name: 'サービスハウス前庭', kind: 'paddock', at: [5690, -165], window: [5600, 5770] },
  { name: 'センターハウス芝島', kind: 'grassArea', at: [spec.PADDOCK_ISLAND.s, spec.PADDOCK_ISLAND.lateral], window: [5750, 5800] },
]

for (const tier of tiers) {
  console.log(`\npaddock-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['paddock'], rootPrefix: /^(ops|infield)-/ })
  void roots
  const { env, track, plan, ground } = scene

  // --- I2-a: the ground rows ---------------------------------------------------------------------
  const v = new THREE.Vector3()
  for (const row of ROWS) {
    const spec_ = spec.GROUND_AREAS.find((a) => a.name === row.name)
    check(!!spec_ && spec_.kind === row.kind, `GROUND_AREAS '${row.name}' is a ${row.kind} row`)
    const ring = plan.rings.find((r) => r.area?.name === row.name)
    check(!!ring, `plan ring '${row.name}' resolved`)
    if (!ring) continue
    const pts = ring.ring.outer
    let a2 = 0
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p.x * q.z - q.x * p.z }
    const area = Math.abs(a2) / 2
    check(area > 20 && area < 20000, `  ring area ${area.toFixed(0)} m² (A9: 20 < A < 20,000)`)
    track.pointAt(track.wrap(row.at[0]), row.at[1], v, 0)
    const owner = plan.ownerAt(v.x, v.z, row.window)
    check(owner.name === row.name, `  plan.ownerAt(s ${row.at[0]}, lat ${row.at[1]}) = ${owner.kind}/${owner.name}`)
    const face = ground.builtY(v.x, v.z)
    check(face?.kind === row.kind, `  drawn face there: ${face ? `${face.kind} (src ${face.src})` : 'none'}`)
  }
  // --- I2-a: the grass island's kerb (an object on the drawn ground) -------------------------------
  {
    const kerb = env.group.getObjectByName('paddockIslandKerb')
    check(!!kerb && kerb.isMesh, `paddockIslandKerb mesh exists`)
    if (kerb) {
      const tag = kerb.userData.groundObject
      const rule = groundMod.GROUND_OBJECTS.islandKerb
      const len = 2 * Math.PI * spec.PADDOCK_ISLAND.radius
      check(tag?.kind === 'islandKerb' && tag.sink === rule.sink && tag.crown === rule.crown && Math.abs(tag.length - len) < 0.01, `  markObject islandKerb, length ${tag?.length?.toFixed(1)} m (ring ${len.toFixed(1)})`)
      const pos = kerb.geometry.attributes.position
      let nan = 0, low = Infinity, high = -Infinity
      kerb.updateWorldMatrix(true, false)
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(kerb.matrixWorld)
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) { nan++; continue }
        const dy = v.y - ground.standY(v.x, v.z)
        low = Math.min(low, dy); high = Math.max(high, dy)
      }
      check(nan === 0 && Math.abs(low + rule.sink) < 0.003 && Math.abs(high - rule.crown) < 0.003, `  ${pos.count} vertices finite, ${(low * 1000).toFixed(0)} mm … +${(high * 1000).toFixed(0)} mm off the drawn ground (rule −${rule.sink * 1000} / +${rule.crown * 1000})`)
      const n = kerb.geometry.attributes.normal
      let down = 0
      for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) down++
      check(down === 0, `  kerb normals point up (${down} down)`)
      check(env.stats?.infield?.['paddock-islandKerb'] === 1, `  stats.infield['paddock-islandKerb'] = ${env.stats?.infield?.['paddock-islandKerb']}`)
    }
  }
  // --- I2-a: the paddock face and its pack-less material -------------------------------------------
  {
    const face = scene.groundMeshes.faces.find((f) => f.kind === 'paddock')
    check(!!face, `ground:paddock face exists (${face?.tris ?? 0} triangles)`)
    const m = face?.mesh.material
    check(!!m && !!m.map && !m.normalMap, `  paddock material without the pack: plain map, no PBR maps (${m ? m.type : 'none'})`)
  }
  // --- I2-b: the buildings, the fence, the lamps, the masts ------------------------------------------
  {
    const infield = env.stats?.infield ?? {}
    const named = []
    env.group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && /^(paddock(?!Buildings|Roofs)|teamOffices|centreHouse|concretePaddock)/.test(o.name)) named.push(o) })
    const byName = (re) => named.filter((o) => re.test(o.name))
    const nan = finiteVertices(named)
    check(named.length > 0 && nan.nan === 0, `${named.length} paddock* / teamOffices* / centreHouse* meshes, ${fmt(nan.vertices)} vertices, no NaN (${nan.nan})`)
    const pts = standPoints(named)
    const outside = pts.filter(([x, z]) => !insideRing(x, z))
    check(outside.length === 0, `  every paddock mesh / instance inside the circuit ring (${outside.length} outside${outside.length ? `: ${outside.slice(0, 3).map((p) => p[2]).join(', ')}` : ''})`)
    // team offices: the instance count and every module's floor
    const offices = byName(/^teamOffices/)
    const expected = spec.PADDOCK_BUILDINGS.filter((b) => b.kind === 'teamOffices').reduce((n, b) => n + (b.modules || 1), 0)
    let instances = 0, worstFloor = 0
    const O = spec.PADDOCK_OFFICE, P = spec.PADDOCK_PLANE
    const latMid = (O.lateral[0] + O.lateral[1]) / 2
    const m4 = new THREE.Matrix4()
    for (const im of offices) {
      im.updateWorldMatrix(true, false)
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m4)
        m4.premultiply(im.matrixWorld)
        v.setFromMatrixPosition(m4)
        instances++
        // the module's −s end: back half a module from its centre along the frame's Z
        const z = new THREE.Vector3(m4.elements[8], m4.elements[9], m4.elements[10]).normalize()
        const rowLen = im.name.startsWith('teamOffices-') ? null : O.module
        const len = rowLen ?? (() => { const r = spec.PADDOCK_BUILDINGS.find((b) => im.name.includes(b.id)); return r ? r.sRange[1] - r.sRange[0] : O.module })()
        const end = v.clone().addScaledVector(z, -len / 2)
        const near = track.nearestOnRange(end.x, end.z, 5560, 120, 40)
        const expectedY = track.pointAt(track.wrap(near.s), latMid, new THREE.Vector3(), 0).y - P.drop + P.floor
        worstFloor = Math.max(worstFloor, Math.abs(v.y - expectedY))
      }
    }
    check(instances === expected, `teamOffices instances ${instances} = table ${expected} (${offices.length} IM buckets)`)
    check(worstFloor <= 0.02, `  every module floor within 20 mm of roadPlane(s0) − ${P.drop} + ${P.floor} (worst ${(worstFloor * 1000).toFixed(0)} mm)`)
    check(infield['paddock-offices'] === expected, `  stats.infield['paddock-offices'] = ${infield['paddock-offices']}`)
    for (const name of ['paddockOfficeA', 'centreHouse', 'centreHouseRoof', 'centreHouseGlass', 'centreHouseWindows', 'centreHouseBalcony', 'centreHouseCanopy', 'centreHouseColumns', 'paddockPaving', 'paddockSmsc', 'paddockFuelCanopy', 'paddockFuelColumns', 'paddockFuelIslands', 'paddockFuelKiosk', 'paddock-service_house', 'paddock-tyre_garage', 'paddockVehicleBase', 'paddockTunnelHeads', 'paddockRetainingWalls', 'paddockFence', 'paddockGates', 'paddockMasts', 'paddockGlass', 'paddockRails', 'concretePaddockSteps', 'paddockOpenings']) {
      const o = env.group.getObjectByName(name)
      check(!!o && o.geometry.attributes.position.count > 0, `  mesh '${name}' exists (${o ? trisOf(o) : 0} tris)`)
    }
    // the centre house: 16 columns (12-sided cylinders: 12 × 4 triangles each), the paving decal
    const cols = env.group.getObjectByName('centreHouseColumns')
    check(!!cols && infield['paddock-centreHouseColumns'] === 16 && trisOf(cols) === 16 * 48, `centre house columns 16 (stats ${infield['paddock-centreHouseColumns']}, ${cols ? trisOf(cols) : 0} tris)`)
    const paving = env.group.getObjectByName('paddockPaving')
    check(!!paving?.userData.decal && paving.userData.decal.rung === groundMod.LAYER.paddock.hatch && paving.userData.decal.uncovered < 1, `  paddockPaving decal at LAYER.paddock.hatch, uncovered ${paving?.userData.decal?.uncovered?.toFixed(1)} m² of ${paving?.userData.decal?.area?.toFixed(0)} m²`)
    // the fuel islands: an object of the islandKerb rule
    const islands = env.group.getObjectByName('paddockFuelIslands')
    check(islands?.userData.groundObject?.kind === 'islandKerb' && islands.userData.groundObject.length > 10, `fuel islands markObject islandKerb, ${islands?.userData.groundObject?.length?.toFixed(1)} m`)
    // the fence: vertical cards only, its length and posts and gates
    const fence = env.group.getObjectByName('paddockFence')
    if (fence) {
      const n = fence.geometry.attributes.normal
      let tilted = 0
      for (let i = 0; i < n.count; i++) if (Math.abs(n.getY(i)) > 0.05) tilted++
      check(tilted === 0, `paddockFence: ${trisOf(fence)} cards, every normal horizontal (${tilted} tilted)`)
    }
    const fenceM = infield['paddock-fenceM'] ?? 0
    check(fenceM >= 600, `  fence length ${fenceM} m (≥ 600 — the four OSM ways + the yard edge measured 633 at I2-b)`)
    const posts = byName(/^paddockFencePosts/)
    const postN = posts.reduce((n, im) => n + im.count, 0)
    check(postN >= fenceM / spec.PADDOCK_FENCE.postPitch * 0.8, `  fence posts ${postN} (≥ length / ${spec.PADDOCK_FENCE.postPitch} × 0.8)`)
    check(infield['paddock-gates'] === spec.PADDOCK_FENCE.gates.length, `  gates ${infield['paddock-gates']} = table ${spec.PADDOCK_FENCE.gates.length}`)
    // the lamps and the masts
    check((infield['infield-lamps'] ?? 0) >= 20, `infield-lamps ${infield['infield-lamps']} (≥ 20)`)
    check(infield['paddock-masts'] === spec.PADDOCK_MASTS.at.length && (infield['infield-flood-heads'] ?? 0) === spec.PADDOCK_MASTS.at.length * spec.PADDOCK_MASTS.heads, `masts ${infield['paddock-masts']}, flood heads ${infield['infield-flood-heads']}`)
    check((infield['infield-office-shutters'] ?? 0) === (expected - 1) * O.rooms && (infield['infield-office-aircon'] ?? 0) === (expected - 1) * O.rooms, `office shutters ${infield['infield-office-shutters']} / aircon ${infield['infield-office-aircon']} = ${(expected - 1) * O.rooms}`)
    check(infield['paddock-tunnelHeads'] === 2 && infield['paddock-buildings'] === spec.PADDOCK_BUILDINGS.length, `tunnel heads ${infield['paddock-tunnelHeads']}, buildings ${infield['paddock-buildings']} = table ${spec.PADDOCK_BUILDINGS.length}`)
  }
}

finish()
