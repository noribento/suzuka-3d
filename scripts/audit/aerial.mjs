#!/usr/bin/env node
/**
 * Fetches the 国土地理院 seamless aerial tiles (z18) covering the circuit and stitches them into
 * one north-up mosaic under .cache/audit/ (never committed — the tiles are 国土地理院 material and
 * only serve as a reference for scripts/audit/overlay.mjs).
 *
 *   node scripts/audit/aerial.mjs            # fetch missing tiles, write mosaic.jpg + meta.json
 *   node scripts/audit/aerial.mjs --force    # re-stitch even when the mosaic exists
 *
 * 出典: 「シームレス空中写真」（国土地理院）https://maps.gsi.go.jp/development/ichiran.html
 */
import '../ts-hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const sharp = require('sharp')
const { Track } = await import('../../app/sim/track.ts')

export const CACHE = path.join(ROOT, '.cache/audit')
const TILES = path.join(CACHE, 'tiles')
fs.mkdirSync(TILES, { recursive: true })
const force = process.argv.includes('--force')

// the same equirectangular frame as CENTERLINE_EN (scripts/facilities/build-facilities.mjs)
export const LAT0 = 34.844581633720921
export const LON0 = 136.53282038953489
const R = 6378137
const D = Math.PI / 180
export const KX = Math.cos(LAT0 * D) * R * D
export const KY = R * D
const Z = 18
const NT = 2 ** Z

const track = new Track()
const k = track.enScale
const worldToLonLat = (x, z) => [LON0 + x / k / KX, LAT0 + -z / k / KY]
const lonLatToTile = (lon, lat) => {
  const lr = lat * D
  return [((lon + 180) / 360) * NT, ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * NT]
}
const MARGIN = 170
const b = track.bounds
const corners = [[b.minX - MARGIN, b.minZ - MARGIN], [b.maxX + MARGIN, b.minZ - MARGIN], [b.minX - MARGIN, b.maxZ + MARGIN], [b.maxX + MARGIN, b.maxZ + MARGIN]].map(([x, z]) => lonLatToTile(...worldToLonLat(x, z)))
const x0 = Math.floor(Math.min(...corners.map((c) => c[0])))
const x1 = Math.floor(Math.max(...corners.map((c) => c[0])))
const y0 = Math.floor(Math.min(...corners.map((c) => c[1])))
const y1 = Math.floor(Math.max(...corners.map((c) => c[1])))
const nx = x1 - x0 + 1, ny = y1 - y0 + 1
const mosaic = path.join(CACHE, 'mosaic.jpg')
const metaFile = path.join(CACHE, 'meta.json')
if (fs.existsSync(mosaic) && fs.existsSync(metaFile) && !force) {
  console.log(`mosaic exists: ${mosaic} (use --force to re-stitch)`)
  process.exit(0)
}
console.log(`tiles x ${x0}..${x1} (${nx}), y ${y0}..${y1} (${ny}) = ${nx * ny} tiles, mosaic ${nx * 256} × ${ny * 256}`)

const jobs = []
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y])
let done = 0, missing = 0
async function worker() {
  while (jobs.length) {
    const [x, y] = jobs.shift()
    const file = path.join(TILES, `${Z}_${x}_${y}.jpg`)
    if ((fs.existsSync(file) && fs.statSync(file).size > 0) || fs.existsSync(file + '.missing')) { done++; continue }
    const url = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${Z}/${x}/${y}.jpg`
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'suzuka3d-audit/0.1 (bhyg756@gmail.com)' }, signal: AbortSignal.timeout(30000) })
        if (res.status === 404) { missing++; fs.writeFileSync(file + '.missing', ''); break }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
        break
      } catch (e) {
        if (attempt === 2) console.warn(`failed ${url}: ${e.message}`)
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
    done++
    if (done % 40 === 0) console.log(`  ${done} tiles`)
  }
}
await Promise.all([worker(), worker(), worker(), worker()])
console.log(`tiles ready, ${missing} missing`)

const W = nx * 256, H = ny * 256
const layers = []
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
  const file = path.join(TILES, `${Z}_${x}_${y}.jpg`)
  if (fs.existsSync(file) && fs.statSync(file).size > 0) layers.push({ input: file, left: (x - x0) * 256, top: (y - y0) * 256 })
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } }).composite(layers).jpeg({ quality: 88 }).toFile(mosaic)
fs.writeFileSync(metaFile, JSON.stringify({ z: Z, x0, y0, nx, ny, W, H, LAT0, LON0, KX, KY, k, mPerPx: (156543.03392 * Math.cos(LAT0 * D)) / NT }, null, 2))
console.log(`mosaic ${W} × ${H} written to ${mosaic}`)
