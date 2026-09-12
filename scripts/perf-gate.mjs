#!/usr/bin/env node
/**
 * Render-cost gate: compares a .perf JSON written by scripts/perf-probe.mjs against the ceilings
 * in scripts/perf-budgets.json (plan §0a) and prints one markdown row per tier / mode / metric.
 *
 *   node scripts/perf-gate.mjs --latest                         # newest .perf/*.json
 *   node scripts/perf-gate.mjs --file .perf/after-phase6-….json --strict
 *   node scripts/perf-gate.mjs --latest --against .perf/before-phase2-….json   # Δ column vs another run
 *   node scripts/perf-gate.mjs --latest --budgets scripts/perf-budgets.json
 *
 * The formulas are stated in the budget file's "comment" and implemented here once:
 *   mean:     FAIL > budget × (1 + band), WARN > budget × warnAt
 *   max:      FAIL > budget × maxRatio (per tier/mode)
 *   setupMs:  WARN > budget, FAIL > budget × (1 + band.setupMs)
 *   loadMs:   WARN > budget (never FAIL)
 *   programs: max over the tier's mode walk (first sampled row skipped) must be ≤ budget
 *   errors:   every row's errors[] must be empty
 * Rows are keyed by tier + modeKey (1 overview … 5 tv); modeKey 6 (director) and the fixed
 * viewpoints of perf-probe --views (modeKey 'view:<name>') are report-only — they never gate,
 * and the views are left out of the programs walk (they come after it; their own max is a
 * report row).
 * Exit code 1 only with --strict and at least one FAIL.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def
}
const strict = args.includes('--strict')
const budgetsPath = path.resolve(ROOT, flag('--budgets', 'scripts/perf-budgets.json'))
const againstPath = flag('--against', null)

/** the newest .perf/*.json by mtime (the probe writes one file per run) */
function latestPerf() {
  const dir = path.join(ROOT, '.perf')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
  if (!files.length) throw new Error('no .perf/*.json — run scripts/perf-probe.mjs first')
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}
const filePath = args.includes('--latest') ? latestPerf() : flag('--file', null) ? path.resolve(ROOT, flag('--file')) : null
if (!filePath) {
  console.error('usage: node scripts/perf-gate.mjs [--file <json> | --latest] [--budgets <json>] [--against <json>] [--strict]')
  process.exit(2)
}

const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'))
const run = JSON.parse(readFileSync(filePath, 'utf8'))
const against = againstPath ? JSON.parse(readFileSync(path.resolve(ROOT, againstPath), 'utf8')) : null

const MODE_OF = { 1: 'overview', 2: 'heli', 3: 'chase', 4: 'onboard', 5: 'tv', 6: 'director' }
const TIER_OF = { 0: 'low', 1: 'high' }
const { band, warnAt } = budgets.policy

const tierOf = (r) => r.tier ?? TIER_OF[r.tierParam] ?? String(r.tierParam)
/** a fixed viewpoint row from perf-probe --views: reported, never gated */
const isView = (r) => typeof r.modeKey === 'string' && r.modeKey.startsWith('view:')
const modeOf = (r) => (isView(r) ? r.modeKey : MODE_OF[r.modeKey] ?? r.mode ?? String(r.modeKey))
const rowKey = (r) => `${tierOf(r)}/${r.modeKey}`
const againstRows = new Map((against?.results ?? []).map((r) => [rowKey(r), r]))

const fmtN = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : String(v))
const fmtDelta = (cur, prev) => {
  if (typeof cur !== 'number' || typeof prev !== 'number') return '-'
  const d = cur - prev
  const pct = prev ? ` (${d >= 0 ? '+' : ''}${((d / prev) * 100).toFixed(1)} %)` : ''
  return `${d >= 0 ? '+' : ''}${fmtN(d)}${pct}`
}

const rows = []
let fails = 0, warns = 0
const push = (tier, mode, metric, budget, measured, delta, status) => {
  if (status === 'FAIL') fails++
  else if (status === 'warn') warns++
  rows.push([tier, mode, metric, budget, measured, delta, status])
}

/** mean gate: FAIL over budget × (1 + band), WARN over budget × warnAt */
const gateMean = (measured, budget, b) => (measured > budget * (1 + b) ? 'FAIL' : measured > budget * warnAt ? 'warn' : 'ok')

for (const r of run.results) {
  const tier = tierOf(r), mode = modeOf(r)
  const tb = budgets.tiers[tier]
  const mb = isView(r) ? undefined : tb?.modes?.[mode]
  const reportOnly = !mb
  const prev = againstRows.get(rowKey(r))
  if (!r.calls) {
    push(tier, mode, 'sample', '-', 'missing', '-', 'FAIL')
    continue
  }
  for (const metric of ['calls', 'triangles']) {
    const b = band[metric]
    const budget = mb?.[metric]
    const maxLimit = budget ? budget * (mb.maxRatio?.[metric] ?? 1.6) : null
    push(tier, mode, `${metric}.mean`, reportOnly ? '(report)' : fmtN(budget), fmtN(r[metric].mean), fmtDelta(r[metric].mean, prev?.[metric]?.mean), reportOnly ? 'ok' : gateMean(r[metric].mean, budget, b))
    push(tier, mode, `${metric}.max`, reportOnly ? '(report)' : fmtN(Math.round(maxLimit)), fmtN(r[metric].max), fmtDelta(r[metric].max, prev?.[metric]?.max), reportOnly ? 'ok' : r[metric].max > maxLimit ? 'FAIL' : 'ok')
    if (r[metric].p90 !== undefined) push(tier, mode, `${metric}.p90`, '(report)', fmtN(r[metric].p90), fmtDelta(r[metric].p90, prev?.[metric]?.p90), 'ok')
  }
  push(tier, mode, 'errors', '0', String(r.errors?.length ?? 0), '-', (r.errors?.length ?? 0) > 0 ? 'FAIL' : 'ok')
}

// per-tier figures: setupMs / loadMs are the same on every row of a tier; programs is the max over
// the mode walk with the first sampled row skipped (compiles are still landing during it)
const byTier = new Map()
const viewsByTier = new Map()
for (const r of run.results) {
  if (!r.calls) continue
  const tier = tierOf(r)
  const bucket = isView(r) ? viewsByTier : byTier
  if (!bucket.has(tier)) bucket.set(tier, [])
  bucket.get(tier).push(r)
}
for (const [tier, list] of byTier) {
  const tb = budgets.tiers[tier]
  if (!tb) continue
  const first = list[0]
  const prev = (against?.results ?? []).filter((r) => tierOf(r) === tier && !isView(r))
  if (tb.setupMs !== undefined) {
    const s = first.setupMs
    const status = typeof s !== 'number' ? 'FAIL' : s > tb.setupMs * (1 + band.setupMs) ? 'FAIL' : s > tb.setupMs ? 'warn' : 'ok'
    push(tier, '*', 'setupMs', fmtN(tb.setupMs), fmtN(s), fmtDelta(s, prev[0]?.setupMs), status)
  }
  if (tb.loadMs !== undefined) push(tier, '*', 'loadMs', `${fmtN(tb.loadMs)} (warn)`, fmtN(first.loadMs), fmtDelta(first.loadMs, prev[0]?.loadMs), first.loadMs > tb.loadMs ? 'warn' : 'ok')
  if (tb.programs !== undefined) {
    const walk = list.length > 1 ? list.slice(1) : list
    const programs = Math.max(...walk.map((r) => r.programs ?? 0))
    const prevWalk = prev.length > 1 ? prev.slice(1) : prev
    const prevPrograms = prevWalk.length ? Math.max(...prevWalk.map((r) => r.programs ?? 0)) : undefined
    push(tier, '*', 'programs.max', fmtN(tb.programs), fmtN(programs), fmtDelta(programs, prevPrograms), programs > tb.programs ? 'FAIL' : 'ok')
    const viewRows = viewsByTier.get(tier) ?? []
    if (viewRows.length) {
      const viewPrograms = Math.max(...viewRows.map((r) => r.programs ?? 0))
      const prevViews = (against?.results ?? []).filter((r) => tierOf(r) === tier && isView(r))
      push(tier, 'views', 'programs.max', '(report)', fmtN(viewPrograms), fmtDelta(viewPrograms, prevViews.length ? Math.max(...prevViews.map((r) => r.programs ?? 0)) : undefined), 'ok')
    }
  }
}

console.log(`perf-gate: ${path.relative(ROOT, filePath)} vs ${path.relative(ROOT, budgetsPath)} (baseline ${budgets.baseline})${against ? `, Δ vs ${path.relative(ROOT, path.resolve(ROOT, againstPath))}` : ''}`)
console.log('| tier | mode | metric | budget | measured | Δ vs against | status |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows) console.log(`| ${row.join(' | ')} |`)
console.log(`${fails} FAIL, ${warns} warn, ${rows.length - fails - warns} ok${strict ? ' (strict)' : ''}`)
if (strict && fails) process.exit(1)
