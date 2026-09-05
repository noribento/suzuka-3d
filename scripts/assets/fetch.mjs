#!/usr/bin/env node
/**
 * Download every remote source in sources.mjs into misc/dl/<key>/ and record sha256 + bytes +
 * fetch date in misc/dl/index.json. Files already present with a matching hash are skipped.
 *
 *   node scripts/assets/fetch.mjs               # fetch what is missing / changed
 *   node scripts/assets/fetch.mjs --print-pins  # print a PINS literal to paste into sources.mjs
 *   node scripts/assets/fetch.mjs --only tex/withered_grass,model/veg/shrub_03
 *
 * Resolvers: direct (URL as written), polypizza (static GLB, needs the Mozilla UA),
 * ambientcg-redirect (302 → CDN zip), polyhaven-api (the .bin folder of a Poly Haven model is not
 * derivable, so files.gltf.<res>.gltf.include is read from api.polyhaven.com), kenney-scrape (the
 * zip URL carries a build hash that changes on re-release, so it is re-read from the asset page;
 * the URL in sources.mjs is the last known good one). misc-local entries are only checked for
 * presence and licence text — the user places those by hand.
 *
 * Integrity: Poly Haven publishes md5 per file → verified. Everything is compared against the
 * sha256 PINS in sources.mjs when present; a mismatch is a hard failure (exit 1), never silently
 * re-pinned.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SOURCES, PINS, UA } from './sources.mjs'
import {
  DL, DL_INDEX, MISC, download, fetchJson, fetchText, md5, readJson, sha256, sha256File, writeJson, fmtKB,
} from './lib.mjs'

const args = process.argv.slice(2)
const printPins = args.includes('--print-pins')
const onlyArg = args[args.indexOf('--only') + 1]
const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null

const index = readJson(DL_INDEX, {})
const failures = []
let downloaded = 0
let skipped = 0

/** Resolve the concrete file list of a source: { relpath: { url, md5? } }. */
async function resolveFiles (src) {
  switch (src.resolver) {
    case 'direct':
    case 'polypizza':
    case 'ambientcg-redirect':
      return Object.fromEntries(Object.entries(src.files).map(([rel, url]) => [rel, { url }]))
    case 'polyhaven-api': {
      const api = await fetchJson(src.apiUrl, { ua: UA })
      const g = api?.gltf?.[src.res]?.gltf
      if (!g) throw new Error(`${src.key}: api has no gltf.${src.res}`)
      const files = { [basename(g.url)]: { url: g.url, md5: g.md5 } }
      for (const [rel, o] of Object.entries(g.include ?? {})) files[rel] = { url: o.url, md5: o.md5 }
      return files
    }
    case 'kenney-scrape': {
      const rel = Object.keys(src.files)[0]
      let url = src.files[rel]
      try {
        const html = await fetchText(src.pageUrl, { ua: UA })
        const m = html.match(new RegExp(`https://kenney\\.nl/media/pages/assets/${src.slug}/[^'"\\s]+\\.zip`))
        if (m) url = m[0]
        else console.warn(`  ${src.key}: zip link not found on ${src.pageUrl}; using last known URL`)
      } catch (err) {
        console.warn(`  ${src.key}: page scrape failed (${err.message}); using last known URL`)
      }
      return { [rel]: { url } }
    }
    default:
      throw new Error(`${src.key}: unknown resolver ${src.resolver}`)
  }
}

async function fetchSource (src) {
  const files = await resolveFiles(src)
  for (const [rel, info] of Object.entries(files)) {
    const id = `${src.key}/${rel}`
    const dest = join(DL, src.key, rel)
    const pin = PINS[id]
    if (existsSync(dest)) {
      const have = sha256File(dest)
      const want = pin ?? index[id]?.sha256
      if (want && have === want) {
        if (!index[id]) index[id] = { url: info.url, sha256: have, bytes: readFileSync(dest).length, fetched: new Date().toISOString() }
        skipped++
        continue
      }
      if (pin && have !== pin) console.warn(`  ${id}: on-disk hash differs from pin — re-downloading`)
    }
    process.stdout.write(`  ↓ ${id} … `)
    const buf = await download(info.url, dest, { ua: UA })
    const hash = sha256(buf)
    if (info.md5 && md5(buf) !== info.md5) {
      failures.push(`${id}: md5 mismatch (api ${info.md5}, got ${md5(buf)})`)
      console.log('MD5 MISMATCH')
      continue
    }
    if (pin && hash !== pin) {
      failures.push(`${id}: sha256 mismatch\n    pinned ${pin}\n    got    ${hash}\n    url    ${info.url}`)
      console.log('SHA256 MISMATCH')
      continue
    }
    index[id] = { url: info.url, sha256: hash, bytes: buf.length, fetched: new Date().toISOString() }
    downloaded++
    console.log(fmtKB(buf.length))
  }
}

/** misc-local: report whether the user drop is present and its licence file says what we expect. */
function checkLocal (src) {
  const root = (src.miscRoots ?? []).map(r => join(MISC, r)).find(existsSync)
  if (!root) {
    console.log(`  · ${src.key}: not present (expected under misc/${src.miscRoots.join(' | misc/')})`)
    return
  }
  const licPath = src.zip ? null : join(root, src.licenceFile)
  if (licPath && !existsSync(licPath)) {
    failures.push(`${src.key}: licence file ${licPath} missing`)
    return
  }
  if (licPath && !readFileSync(licPath, 'utf8').includes(src.licenceMarker)) {
    failures.push(`${src.key}: ${licPath} does not contain "${src.licenceMarker}"`)
    return
  }
  const what = src.zip ? (existsSync(join(root, src.zip)) ? src.zip : 'ZIP MISSING') : 'licence OK'
  if (what === 'ZIP MISSING') { console.log(`  · ${src.key}: not present (${src.zip})`); return }
  console.log(`  ✓ ${src.key}: ${root.slice(MISC.length + 1) || '.'} (${what})`)
}

if (printPins) {
  const keys = Object.keys(index).sort()
  console.log('export const PINS = {')
  for (const k of keys) console.log(`  '${k}': '${index[k].sha256}',`)
  console.log('}')
  process.exit(0)
}

console.log(`fetch → ${DL}`)
for (const src of SOURCES) {
  if (only && !only.has(src.key)) continue
  console.log(`${src.key} [${src.resolver}] ${src.site} — ${src.name}`)
  try {
    if (src.resolver === 'misc-local') checkLocal(src)
    else await fetchSource(src)
  } catch (err) {
    failures.push(`${src.key}: ${err.message}`)
    console.log(`  ✗ ${err.message}`)
  }
}
writeJson(DL_INDEX, index)

const total = Object.values(index).reduce((s, e) => s + e.bytes, 0)
console.log(`\n${downloaded} downloaded, ${skipped} up to date, ${Object.keys(index).length} files indexed (${(total / 1048576).toFixed(1)} MB)`)
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '))
  process.exit(1)
}
