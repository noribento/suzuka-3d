#!/usr/bin/env node
/**
 * Static scene cost (plan §0b): builds the scene in plain Node through `app-runtime.mjs`
 * (no browser, no asset pack — the numbers are the NoAssets figures), drains the far field if the
 * build has one, and walks the scene graph: Σ triangles (indexed count / 3, else position count / 3;
 * an InstancedMesh counts × its instance count), mesh and InstancedMesh counts, per top-level
 * group (`terrain`, `ground:*`, `stand-*`, `farField/<kind>`, other), the far-field statistics
 * and the byte size + licence header of the generated data files. The totals are compared with
 * `static.<tier>NoAssets` and `data` in scripts/perf-budgets.json.
 *
 *   node scripts/audit/scene-cost.mjs --tier high|low [--strict] [--all]
 *
 * Exit 1 only with --strict AND when the budget section carries `measured: true` — C0 lands the
 * tool with placeholder budgets that report only; C2 sets the measured values (+10 %) and flips
 * the flag, which is when `pnpm check` starts failing on growth.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tier = flag('--tier', 'high')
const strict = args.includes('--strict')
const showAll = args.includes('--all')
if (tier !== 'high' && tier !== 'low') { console.error('--tier high|low'); process.exit(2) }

const budgets = JSON.parse(readFileSync(path.join(ROOT, 'scripts/perf-budgets.json'), 'utf8'))
const staticBudget = budgets.static[`${tier}NoAssets`]
const dataBudget = budgets.data

const t0 = performance.now()
const scene = await buildScene({ tier })
const tBuild = performance.now() - t0
const farField = scene.env.farField ?? null
const t1 = performance.now()
if (farField?.drain) farField.drain()
const tDrain = performance.now() - t1

// ---------------------------------------------------------------- walk
const trianglesOf = (mesh) => {
  const g = mesh.geometry
  if (!g) return 0
  const range = g.drawRange
  const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
  const drawn = range && range.count !== Infinity ? Math.min(n, range.count) : n
  const tris = Math.floor(drawn / 3)
  return mesh.isInstancedMesh ? tris * mesh.count : tris
}

/** the table row a top-level child belongs to: terrain, ground:<kind>, stand-<id>, farField/<kind>, other:<name> */
const rowOf = (top, child) => {
  const name = top.name || ''
  if (name === 'terrain') return 'terrain'
  if (name === 'ground') return child?.name?.startsWith('ground:') ? child.name : 'ground:other'
  if (name.startsWith('ground:')) return name
  if (name.startsWith('stand-')) return name
  if (name === 'farField') return `farField/${(child?.name ?? '').split('-')[0] || 'other'}`
  return name ? `other:${name}` : 'other'
}

const rows = new Map()
const total = { triangles: 0, meshes: 0, instancedMeshes: 0, instances: 0 }
const bump = (key, mesh) => {
  const r = rows.get(key) ?? { triangles: 0, meshes: 0, instancedMeshes: 0, instances: 0 }
  const tris = trianglesOf(mesh)
  r.triangles += tris; total.triangles += tris
  if (mesh.isInstancedMesh) { r.instancedMeshes++; total.instancedMeshes++; r.instances += mesh.count; total.instances += mesh.count } else { r.meshes++; total.meshes++ }
  rows.set(key, r)
}
const walkTop = (top, child) => {
  const key = rowOf(top, child)
  const start = child ?? top
  start.traverse((o) => { if (o.isMesh || o.isInstancedMesh) bump(key, o) })
}
for (const group of [scene.env.group, scene.trackMeshes.group, scene.whiteLines]) {
  if (group.isMesh) { bump('other:whiteLines', group); continue }
  for (const top of group.children) {
    if (top.name === 'ground' || top.name === 'farField') for (const child of top.children) walkTop(top, child)
    else walkTop(top, null)
  }
}

// ---------------------------------------------------------------- data files
const headerOk = (file, needles) => {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n')
  return needles.every((n) => head.includes(n))
}
const DATA_FILES = [
  { glob: /^suzuka-surroundings.*\.ts$/, needles: ['OpenStreetMap contributors', 'ODbL'] },
  { glob: /^suzuka-dem.*\.ts$/, needles: ['国土地理院'] },
  { glob: /^suzuka-facilities\.ts$/, needles: ['OpenStreetMap contributors', 'ODbL'] },
]
const dataDir = path.join(ROOT, 'app/data')
const dataRows = []
let generatedBytes = 0
const { readdirSync } = await import('node:fs')
for (const name of readdirSync(dataDir).sort()) {
  const rule = DATA_FILES.find((d) => d.glob.test(name))
  if (!rule) continue
  const file = path.join(dataDir, name)
  const bytes = existsSync(file) ? statSync(file).size : 0
  generatedBytes += bytes
  dataRows.push({ name, bytes, header: headerOk(file, rule.needles) })
}

// ---------------------------------------------------------------- report
const fmt = (n) => n.toLocaleString('en-US')
const ffStats = farField?.stats?.() ?? null
const measured = staticBudget?.measured === true
const problems = []
const status = (value, budget) => {
  if (budget === undefined) return '-'
  const over = value > budget
  if (over) problems.push(`${value} > ${budget}`)
  return over ? (measured ? 'FAIL' : 'over (unmeasured)') : 'ok'
}

console.log(`scene-cost: tier ${tier}, no assets — build ${tBuild.toFixed(0)} ms, farField ${farField ? `drain ${tDrain.toFixed(0)} ms` : 'absent'}`)
console.log('| group | triangles | meshes | instanced | instances |')
console.log('| --- | --- | --- | --- | --- |')
const sorted = [...rows.entries()].sort((a, b) => b[1].triangles - a[1].triangles)
const shown = showAll ? sorted : sorted.filter(([k, r]) => r.triangles >= 20000 || k === 'terrain' || k.startsWith('ground:') || k.startsWith('farField/'))
for (const [k, r] of shown) console.log(`| ${k} | ${fmt(r.triangles)} | ${r.meshes} | ${r.instancedMeshes} | ${fmt(r.instances)} |`)
const hidden = sorted.length - shown.length
if (hidden) console.log(`| (${hidden} more rows under 20k triangles, --all lists them) | ${fmt(sorted.filter((x) => !shown.includes(x)).reduce((s, [, r]) => s + r.triangles, 0))} | | | |`)
console.log(`| **total** | ${fmt(total.triangles)} | ${total.meshes} | ${total.instancedMeshes} | ${fmt(total.instances)} |`)

console.log(`\nbudget static.${tier}NoAssets (measured: ${measured})`)
console.log('| metric | budget | measured | status |')
console.log('| --- | --- | --- | --- |')
const staticMetrics = [
  ['triangles', total.triangles],
  ['meshes', total.meshes],
  ['instancedMeshes', total.instancedMeshes],
  ['farFieldEntries', ffStats?.entries ?? 0],
]
for (const [k, v] of staticMetrics) console.log(`| ${k} | ${staticBudget?.[k] === undefined ? '-' : fmt(staticBudget[k])} | ${fmt(v)} | ${status(v, staticBudget?.[k])} |`)
if (ffStats) console.log(`farField stats: ${JSON.stringify(ffStats)}`)

const dataMeasured = dataBudget?.measured === true
console.log(`\nbudget data (measured: ${dataMeasured})`)
console.log('| file | bytes | header |')
console.log('| --- | --- | --- |')
for (const d of dataRows) console.log(`| ${d.name} | ${fmt(d.bytes)} | ${d.header ? 'ok' : 'MISSING'} |`)
const dataOver = generatedBytes > (dataBudget?.generatedBytes ?? Infinity)
const badHeaders = dataRows.filter((d) => !d.header)
console.log(`| **generated total** | ${fmt(generatedBytes)} | ≤ ${fmt(dataBudget?.generatedBytes ?? 0)} ${dataOver ? (dataMeasured ? 'FAIL' : 'over (unmeasured)') : 'ok'} |`)
// a missing licence header is a real defect regardless of the measured flag (the header is the
// ODbL / 国土地理院 attribution the generated file must carry)
const hardProblems = badHeaders.map((d) => `${d.name}: licence header missing`)
if (dataOver && dataMeasured) hardProblems.push(`generated data ${generatedBytes} > ${dataBudget.generatedBytes}`)
if (measured) hardProblems.push(...problems.map((p) => `static: ${p}`))

console.log(`\nscene-cost: ${tier} — ${((performance.now() - t0) / 1000).toFixed(1)} s, ${hardProblems.length} problem(s)${problems.length && !measured ? `, ${problems.length} over the unmeasured placeholder(s)` : ''}${strict ? ' (strict)' : ''}`)
for (const p of hardProblems) console.log(`  - ${p}`)
if (strict && hardProblems.length) process.exit(1)
