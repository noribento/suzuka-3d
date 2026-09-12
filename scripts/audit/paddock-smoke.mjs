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
 *        masts exist as named meshes with finite vertices; the 16 canopy columns (XZ clusters of
 *        `centreHouseColumns`) stand inside 0.97 of the canopy ellipse (`centreHouseCanopy`
 *        userData.canopy, track frame) and ≥ 2.4 m outside the OSM ring 184430907 (off the 2 m
 *        balcony and its rail); the masts are 2 vertex clusters of `paddockMasts` and the tunnel
 *        heads 2 of `paddockTunnelHeads`; the fence (`paddockFence`, vertical faces only — every
 *        triangle normal |ny| < 0.05, and every card's bottom edge within 0.15 m of ground.standY at
 *        1 m samples off the ground's seams: the cards are split at the post pitch over the relief;
 *        a sample where the ground steps ≥ 0.2 m within 1 m — the drawn faces' edges against the
 *        bare terrain, 0.26 high / 0.6 low until P7 — is skipped) is ≥ 600 m long with
 *        its posts and 3 gates; the lamps (`infield-lamps`) count ≥ 20, none on a water face and
 *        none inside a roller door's no-parking hatch; every `paddock*` / `teamOffices*` /
 *        `centreHouse*` / `infield-*` object stands inside the circuit ring (`paddockBuildings` /
 *        `paddockRoofs` are the other BUILDINGS rows — CIRCUIT PLAZA is outside — and are skipped); `stats.infield`
 *        carries the same counts; `buildMs.paddock` is finite.
 *  I2-c  the car parks (PADDOCK_PARKING / PADDOCK_BAY): one `paddockBayLines-<id>` decal per block
 *        at LAYER.paddock.line with uncovered < 1 m² (every kept bay stands on a drawn paddock face,
 *        so its lines do too); the hatches (`paddockHatches`, LAYER.paddock.hatch, opaque) number
 *        the office roller doors (stats 'infield-office-shutters'); the cars (`infield-paddock-cars`)
 *        number min(Quality.infield.paddockCars, Σ round(occupancy × kept)) (≥ 250 high / ≥ 110
 *        low — the bays are real-size 2.5 × 5 rectangles laid out in world metres, so the E lot
 *        inside the final corner holds fewer than the old frame-pitch trapezoids), every two L0
 *        car centres ≥ 2.2 m apart (pitch 2.5 − 2 × posJitter), every one on a
 *        `paddock` face (ground.builtY), inside no PADDOCK_BUILDINGS footprint, outside the sim's
 *        pit envelope (PIT_ENVELOPE.keepOut about Track.pitLateralAt), off the E lot's broadcast
 *        strip s 5440–5510, inside the circuit ring; `group.userData.paddockParking` (walked /
 *        kept / rejects / cars per block) sums to the same numbers; the covered cars are
 *        PADDOCK_BAY.coveredCars in the A block.
 *
 *   node scripts/audit/paddock-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` builds the high tier once more with the pack's car GLBs (kei_wagon / kei_truck / van_h100
 * / covered_car) behind a stub asset registry (stub-registry.mjs, like furniture-smoke --glb) and
 * checks the GLB path of the cars: the kinds with a model draw their `car-<kind>-glb` prototype at
 * L0, a far level L1 follows with the procedural bodies, the count is still the budget, every
 * vertex finite.
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, infieldRoots, smokeArgs, standPoints, trisOf } from './smoke-common.mjs'
import { insideRing } from './ring.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const { tiers, check, finish, glb } = smokeArgs('paddock-smoke')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))
const fac = await import(path.join(ROOT, 'app/data/suzuka-facilities.ts'))
const vehicles = await import(path.join(ROOT, 'app/three/vehicles.ts'))

/** a merged mesh's vertices → XZ cluster centres (greedy, `radius` m) — how many columns / masts / heads a mesh holds */
function xzClusters(mesh, radius) {
  if (!mesh) return []
  const pos = mesh.geometry.attributes.position
  const out = []
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const c = out.find((k) => Math.hypot(k.x / k.n - x, k.z / k.n - z) <= radius)
    if (c) { c.x += x; c.z += z; c.n++ } else out.push({ x, z, n: 1 })
  }
  return out.map((k) => [k.x / k.n, k.z / k.n])
}
const inPoly = (x, z, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside } return inside }
const segDist = (x, z, poly) => { let best = Infinity; for (let i = 0; i < poly.length; i++) { const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length]; const dx = bx - ax, dz = bz - az; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1))); best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t)) } return best }

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
    // every column outside the balcony (≥ 2.4 m from the OSM ring) and under the canopy's rim (≤ 0.97 of its ellipse)
    const canopy = env.group.getObjectByName('centreHouseCanopy')
    const C = canopy?.userData.canopy
    if (cols && C) {
      const centres = xzClusters(cols, 1.0)
      const ringW = fac.osmFeature(184430907).en.map(([e, n]) => { track.enToWorld(e, n, v); return [v.x, v.z] })
      const h = track.headingAt(C.s)
      track.pointAt(C.s, C.lateral, v, 0)
      let maxE = 0, minD = Infinity
      for (const [x, z] of centres) {
        const dx = x - v.x, dz = z - v.z
        const ds = dx * h.tx + dz * h.tz, dl = dx * h.tz - dz * h.tx
        maxE = Math.max(maxE, Math.hypot(ds / C.b, dl / C.a))
        minD = Math.min(minD, inPoly(x, z, ringW) ? -1 : segDist(x, z, ringW))
      }
      check(centres.length === 16 && maxE <= 0.97 && minD >= 2.4, `  ${centres.length} column clusters: ≤ ${maxE.toFixed(3)} of the canopy ellipse ${2 * C.a} × ${2 * C.b}, ≥ ${minD.toFixed(2)} m outside the ring (≥ 2.4 = balcony 2 + radius + 0.25)`)
    } else check(false, `  centreHouseCanopy.userData.canopy present for the column test`)
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
      // every card's bottom edge (verts 0 → 1 of each 6-vertex quad, sunk 0.05) on the drawn ground at 1 m samples,
      // where the ground is continuous: a sample next to a seam (the ground steps ≥ 0.2 m within 1 m along the
      // card — the drawn faces meet the bare terrain at the E lot's / pit-entry's edges with steps of 0.26 high / 0.6 low
      // until P7) is skipped, since no card between two feet can follow a step
      const pos = fence.geometry.attributes.position
      let worst = 0, cards = 0, seams = 0
      for (let i = 0; i < pos.count; i += 6) {
        cards++
        const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i), bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1)
        const len = Math.hypot(bx - ax, bz - az)
        const n = Math.max(1, Math.ceil(len))
        const ux = (bx - ax) / (len || 1), uz = (bz - az) / (len || 1)
        for (let k = 0; k <= n; k++) {
          const t = k / n
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t
          const g = ground.standY(x, z)
          let seam = false
          for (const d of [-1, -0.5, 0.5, 1]) if (Math.abs(ground.standY(x + ux * d, z + uz * d) - g) >= 0.2) seam = true
          if (seam) { seams++; continue }
          const gap = ay + (by - ay) * t + 0.05 - g
          if (Math.abs(gap) > Math.abs(worst)) worst = gap
        }
      }
      check(Math.abs(worst) <= 0.15, `  ${cards} cards' bottom edges within 0.15 m of ground.standY at 1 m samples off the seams (worst ${(worst * 100).toFixed(0)} cm, ${seams} seam samples skipped)`)
    }
    const fenceM = infield['paddock-fenceM'] ?? 0
    check(fenceM >= 600, `  fence length ${fenceM} m (≥ 600 — the four OSM ways + the yard edge measured 633 at I2-b)`)
    const posts = byName(/^paddockFencePosts/)
    const postN = posts.reduce((n, im) => n + im.count, 0)
    check(postN >= fenceM / spec.PADDOCK_FENCE.postPitch * 0.8, `  fence posts ${postN} (≥ length / ${spec.PADDOCK_FENCE.postPitch} × 0.8)`)
    check(infield['paddock-gates'] === spec.PADDOCK_FENCE.gates.length, `  gates ${infield['paddock-gates']} = table ${spec.PADDOCK_FENCE.gates.length}`)
    // the lamps: the count, none on a water face, none inside a roller door's hatch
    check((infield['infield-lamps'] ?? 0) >= 20, `infield-lamps ${infield['infield-lamps']} (≥ 20)`)
    {
      const lampIM = []
      for (const o of infieldRoots(env, /^infield-lamps/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) lampIM.push(m) })
      const lp = standPoints(lampIM)
      const water = lp.filter(([x, z]) => ground.builtY(x, z)?.kind === 'water').length
      check(lp.length === infield['infield-lamps'] && water === 0, `  ${lp.length} lamp instances at L0, none on a water face (${water})`)
      const doorIM = []
      for (const o of infieldRoots(env, /^infield-office-shutters/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) doorIM.push(m) })
      const doorS = standPoints(doorIM).map(([x, z]) => plan.project(x, z, [5560, 120]).s)
      const hh = spec.PADDOCK_BAY.hatch.size / 2
      let inHatch = 0
      for (const [x, z] of lp) {
        const pr = plan.project(x, z, [5560, 120])
        if (pr.d > 200 || Math.abs(pr.lateral - spec.PADDOCK_BAY.hatch.lateral) > hh + 0.06) continue
        if (doorS.some((d) => Math.abs(track.wrap(pr.s - d + track.length / 2) - track.length / 2) < hh + 0.06)) inHatch++
      }
      check(doorS.length > 0 && inHatch === 0, `  no lamp inside a roller door's no-parking hatch (${inHatch} of ${lp.length}, ${doorS.length} doors)`)
    }
    // the masts and the tunnel heads: vertex clusters of the merged meshes
    const mastClusters = xzClusters(env.group.getObjectByName('paddockMasts'), 6)
    const headClusters = xzClusters(env.group.getObjectByName('paddockTunnelHeads'), 12)
    check(mastClusters.length === spec.PADDOCK_MASTS.at.length && infield['paddock-masts'] === spec.PADDOCK_MASTS.at.length && (infield['infield-flood-heads'] ?? 0) === spec.PADDOCK_MASTS.at.length * spec.PADDOCK_MASTS.heads, `masts ${mastClusters.length} lattice clusters = table ${spec.PADDOCK_MASTS.at.length} (stats ${infield['paddock-masts']}), flood heads ${infield['infield-flood-heads']}`)
    check(headClusters.length === 2 && infield['paddock-tunnelHeads'] === 2, `tunnel heads ${headClusters.length} vertex clusters (stats ${infield['paddock-tunnelHeads']})`)
    check((infield['infield-office-shutters'] ?? 0) === (expected - 1) * O.rooms && (infield['infield-office-aircon'] ?? 0) === (expected - 1) * O.rooms, `office shutters ${infield['infield-office-shutters']} / aircon ${infield['infield-office-aircon']} = ${(expected - 1) * O.rooms}`)
    check(infield['paddock-buildings'] === spec.PADDOCK_BUILDINGS.length, `buildings ${infield['paddock-buildings']} = table ${spec.PADDOCK_BUILDINGS.length}`)
  }
  // --- I2-c: the car parks — bay lines, hatches, parked cars ---------------------------------------------
  {
    const infield = env.stats?.infield ?? {}
    const q = scene.quality
    const report = env.group.userData.paddockParking ?? []
    check(report.length === spec.PADDOCK_PARKING.length, `paddockParking report: ${report.length} blocks = table ${spec.PADDOCK_PARKING.length}`)
    for (const row of spec.PADDOCK_PARKING) {
      const mesh = env.group.getObjectByName(`paddockBayLines-${row.id}`)
      const d = mesh?.userData.decal
      check(!!d && d.rung === groundMod.LAYER.paddock.line && !d.soft && d.uncovered < 1, `  paddockBayLines-${row.id}: ${mesh ? trisOf(mesh) : 0} tris at LAYER.paddock.line, uncovered ${d?.uncovered?.toFixed(2)} m² of ${d?.area?.toFixed(1)} m²`)
      const r = report.find((b) => b.id === row.id)
      const rej = r ? Object.entries(r.rejects).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') : '-'
      check(!!r && r.kept > 0 && r.cars > 0, `  block ${row.id}: ${r?.kept} of ${r?.walked} bays kept (${rej || 'no rejects'}), ${r?.cars} cars`)
    }
    const keptTotal = report.reduce((n, b) => n + b.kept, 0), carsTotal = report.reduce((n, b) => n + b.cars, 0)
    check(infield['paddock-bays'] === keptTotal, `  stats.infield['paddock-bays'] = ${infield['paddock-bays']} = Σ kept ${keptTotal}`)
    // the hatches: one per office roller door
    const hatches = env.group.getObjectByName('paddockHatches')
    const hd = hatches?.userData.decal
    check(!!hd && hd.rung === groundMod.LAYER.paddock.hatch && hd.uncovered < 1 && infield['paddock-hatches'] === infield['infield-office-shutters'], `paddockHatches ${infield['paddock-hatches']} = roller doors ${infield['infield-office-shutters']}, LAYER.paddock.hatch, uncovered ${hd?.uncovered?.toFixed(2)} m² of ${hd?.area?.toFixed(0)} m²`)
    check(!!hd && Math.abs(hd.area - infield['paddock-hatches'] * spec.PADDOCK_BAY.hatch.size ** 2) < 1, `  hatch outline area ${hd?.area?.toFixed(1)} m² = ${infield['paddock-hatches']} × ${spec.PADDOCK_BAY.hatch.size}²`)
    // the cars: the budget, and where every one stands
    const budget = q.infield.paddockCars
    const cars = infield['infield-paddock-cars'] ?? 0
    // the occupancy's demand, block by block (the builder rounds per block; the scaled-down case settles on the budget)
    const want = report.reduce((n, b) => n + (spec.PADDOCK_PARKING.find((r) => r.id === b.id)?.occupancy ?? 0) * b.kept, 0)
    const wantRounded = report.reduce((n, b) => n + Math.round((spec.PADDOCK_PARKING.find((r) => r.id === b.id)?.occupancy ?? 0) * b.kept), 0)
    const expectCars = want > budget ? budget : wantRounded
    check(cars === expectCars && cars === carsTotal && cars >= (tier === 'high' ? 250 : 110), `infield-paddock-cars ${cars} = min(Quality.infield.paddockCars ${budget}, occupancy demand ${wantRounded}) (report Σ ${carsTotal}; ≥ ${tier === 'high' ? 250 : 110})`)
    check(infield['paddock-coveredCars'] === spec.PADDOCK_BAY.coveredCars, `  covered cars ${infield['paddock-coveredCars']} = PADDOCK_BAY.coveredCars ${spec.PADDOCK_BAY.coveredCars}`)
    const carMeshes = new Map()
    for (const o of infieldRoots(env, /^infield-paddock-cars-/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) carMeshes.set(m.uuid, m) })
    const pts = standPoints([...carMeshes.values()])
    const E = spec.PIT_ENVELOPE
    const polys = spec.PADDOCK_BUILDINGS.map((b) => {
      if (b.osmWay !== undefined) { const f = fac.osmFeature(b.osmWay); return f ? f.en.map(([e, n]) => { track.enToWorld(e, n, v); return [v.x, v.z] }) : null }
      if (!b.lateral) return null
      return [[b.sRange[0], b.lateral[0]], [b.sRange[1], b.lateral[0]], [b.sRange[1], b.lateral[1]], [b.sRange[0], b.lateral[1]]].map(([s, l]) => { track.pointAt(track.wrap(s), l, v, 0); return [v.x, v.z] })
    }).filter(Boolean)
    let offFace = 0, inFoot = 0, inEnv = 0, inStrip = 0, outRing = 0
    for (const [x, z] of pts) {
      const f = ground.builtY(x, z)
      if (!f || f.kind !== 'paddock') offFace++
      if (polys.some((p) => inPoly(x, z, p))) inFoot++
      if (!insideRing(x, z)) outRing++
      const pr = plan.project(x, z)
      const c = track.pitLateralAt(pr.s)
      if (c !== null && pr.lateral >= c - E.keepOut.back && pr.lateral <= Math.max(c + E.keepOut.front, -track.halfWidthAt(pr.s))) inEnv++
      // the E lot's broadcast strip: windowed to the pit-entry straight
      const pe = plan.project(x, z, [5300, 5560])
      if (pe.d < 120 && pe.s >= 5440 && pe.s <= 5510 && pe.lateral < -25) inStrip++
    }
    check(pts.length === cars, `  ${pts.length} car instances at L0 = stats ${cars}`)
    // rigid bays: no two cars closer than the pitch less the position jitter (2.5 − 2 × 0.15)
    {
      const minGap = spec.PADDOCK_BAY.bayW - 2 * vehicles.CAR_PARK.posJitter
      let minD = Infinity, close = 0
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
        if (d < minGap) close++
        if (d < minD) minD = d
      }
      check(close === 0, `  every two car centres ≥ ${minGap.toFixed(1)} m apart (min ${minD.toFixed(2)} m, ${close} pairs closer)`)
    }
    check(offFace === 0, `  every car on a paddock face (${offFace} off)`)
    check(inFoot === 0, `  no car inside a PADDOCK_BUILDINGS footprint (${inFoot})`)
    check(inEnv === 0, `  no car in the sim's pit envelope (${inEnv})`)
    check(inStrip === 0, `  no car on the E lot's broadcast strip s 5440–5510 (${inStrip})`)
    check(outRing === 0, `  every car inside the circuit ring (${outRing} outside)`)
    check('infield-paddock-cars' in infield && 'infield-lamps' in infield, `  stats.infield keys 'infield-paddock-cars', 'infield-lamps' present`)
  }
}

// --- --glb: the cars' GLB path on the high tier behind the stub registry ---------------------------------
if (glb) {
  console.log('\npaddock-smoke: tier high + car GLBs (stub registry)')
  const reg = await stubRegistry(['model/vehicles/kei_wagon', 'model/vehicles/kei_truck', 'model/vehicles/van_h100', 'model/props/covered_car'])
  const scene = await buildSceneWith('high', reg)
  const { env } = scene
  const infield = env.stats?.infield ?? {}
  const meshes = []
  for (const o of infieldRoots(env, /^infield-paddock-cars-/)) o.traverse((m) => { if (m.isInstancedMesh) meshes.push(m) })
  const names = new Set(meshes.map((m) => m.name.replace(/-L(\d)-\d+$/, '-L$1')))
  const l0 = [...names].filter((n) => /-L0$/.test(n)), l1 = [...names].filter((n) => /-L1$/.test(n))
  check(['kei', 'keitruck', 'minivan'].every((k) => l0.includes(`infield-paddock-cars-car-${k}-glb-L0`)), `L0 draws the GLB kinds (${l0.filter((n) => /-glb-/.test(n)).map((n) => n.replace('infield-paddock-cars-', '')).join(', ')})`)
  check(l1.length > 0 && l1.every((n) => !/-glb-/.test(n)), `L1 is procedural (${l1.length} prototypes)`)
  const fv = finiteVertices(meshes)
  check(fv.nan === 0, `  ${meshes.length} InstancedMeshes, ${fmt(fv.vertices)} vertices, no NaN (${fv.nan})`)
  const l0Count = meshes.filter((m) => /-L0-/.test(m.name)).reduce((n, m) => n + m.count, 0)
  const budget = scene.quality.infield.paddockCars
  const report = env.group.userData.paddockParking ?? []
  const want = report.reduce((n, b) => n + (spec.PADDOCK_PARKING.find((r) => r.id === b.id)?.occupancy ?? 0) * b.kept, 0)
  check(l0Count === infield['infield-paddock-cars'] && l0Count <= budget && (want > budget ? l0Count === budget : l0Count >= 250), `  ${l0Count} cars at L0 = stats ${infield['infield-paddock-cars']}, ≤ Quality.infield.paddockCars ${budget} (occupancy demand ${want.toFixed(0)})`)
  const covered = meshes.find((m) => /covered-car-L0-/.test(m.name))
  check(!!covered && covered.count === spec.PADDOCK_BAY.coveredCars && covered.geometry.attributes.position.count > 3 * 60, `  covered_car GLB at L0: ${covered?.count} instances, ${covered ? trisOf(covered) / covered.count : 0} tris each`)
}

finish()
