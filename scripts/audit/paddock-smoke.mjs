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
 *
 *   node scripts/audit/paddock-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

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
  const { roots } = await commonChecks(scene, check, { buildKeys: ['paddock'], rootPrefix: /^(ops|infield|paddock)-/ })
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
}

finish()
