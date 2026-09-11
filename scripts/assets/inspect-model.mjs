#!/usr/bin/env node
/**
 * Print what a model drop contains before writing its sources.mjs entry: the node tree with full
 * paths (what `dropNodes` / `keepNodes` regexes match), every mesh primitive with its triangle
 * count, material, alphaMode, doubleSided and texture slots (what `dropParts` and `texEncode`
 * classify), the image list with pixel size, bytes and mimeType, and totals.
 *
 *   node scripts/assets/inspect-model.mjs <file.zip | scene.gltf | model.glb>
 *
 * A zip (Sketchfab download) is extracted to .cache/assets-work/inspect/<name>/ and the single
 * .gltf / .glb inside is inspected; a .gltf with external buffers and textures is read in place.
 */
import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { WORK, ensureDir, zipExtract, sniffImage, fmtKB, fmtMB } from './lib.mjs'
import { readModel, textureSlots, textureImage } from './retouch-glb.mjs'

const input = process.argv[2]
if (!input || !existsSync(input)) { console.error('usage: inspect-model.mjs <zip|gltf|glb>'); process.exit(2) }

let file = input
if (/\.zip$/i.test(input)) {
  const dir = join(WORK, 'inspect', basename(input).replace(/\.zip$/i, ''))
  rmSync(dir, { recursive: true, force: true })
  const members = zipExtract(input, ensureDir(dir))
  const models = members.filter(m => /\.(gltf|glb)$/i.test(m))
  if (models.length !== 1) { console.error(`${input}: expected one .gltf/.glb, found ${models.length}: ${models.join(', ')}`); process.exit(1) }
  file = join(dir, models[0])
  console.log(`${input} → ${models[0]}  (${members.length} members${members.some(m => /license\.txt$/i.test(m)) ? ', license.txt present' : ', NO license.txt'})`)
}

const model = readModel(file)
const { json } = model
const nodes = json.nodes ?? []
const meshes = json.meshes ?? []
const materials = json.materials ?? []
const nodeName = (n) => n.name || '(unnamed)'

/** Triangles of a primitive from its index (or vertex) count and topology. */
function triangles (prim) {
  const acc = json.accessors[prim.indices ?? prim.attributes.POSITION]
  const count = acc?.count ?? 0
  const mode = prim.mode ?? 4
  if (mode === 4) return Math.floor(count / 3)
  if (mode === 5 || mode === 6) return Math.max(0, count - 2)
  return 0
}

const slotName = (slot) => slot.replace(/^pbrMetallicRoughness\./, '').replace(/^extensions\.KHR_materials_/, '').replace(/^extensions\./, '')
const meshTris = new Map()
let totalTris = 0
let totalPrims = 0
const meshLines = []

// Node tree (all scenes, then any orphan roots) with full paths — a mesh is listed under every node that instances it.
const seen = new Set()
const walkNode = (i, path, depth) => {
  const n = nodes[i]
  const p = path ? `${path}/${nodeName(n)}` : nodeName(n)
  seen.add(i)
  const mesh = n.mesh != null ? meshes[n.mesh] : null
  const tris = mesh ? mesh.primitives.reduce((s, pr) => s + triangles(pr), 0) : 0
  const xf = [n.translation && 'T', n.rotation && 'R', n.scale && 'S', n.matrix && 'M'].filter(Boolean).join('')
  console.log(`${'  '.repeat(depth)}${nodeName(n)}${mesh ? `  [mesh ${n.mesh}${mesh.name ? ` "${mesh.name}"` : ''}: ${mesh.primitives.length} prim, ${tris.toLocaleString()} tris]` : ''}${xf ? `  {${xf}}` : ''}${depth ? '' : `  ← ${p}`}`)
  if (mesh) {
    if (!meshTris.has(n.mesh)) meshTris.set(n.mesh, tris)
    for (const [k, prim] of mesh.primitives.entries()) {
      const mat = prim.material != null ? materials[prim.material] : null
      const slots = mat ? textureSlots(mat).map(s => `${slotName(s.slot)}→img ${textureImage(json.textures?.[s.texture] ?? {})}`) : []
      meshLines.push(`  ${p}  #${k}  ${triangles(prim).toLocaleString().padStart(8)} tris  mat ${mat ? `"${mat.name ?? ''}"` : '-'}  ${mat?.alphaMode ?? 'OPAQUE'}${mat?.doubleSided ? ' 2-sided' : ''}  ${slots.join(', ') || '(no textures)'}${prim.attributes.COLOR_0 != null ? '  COLOR_0' : ''}`)
      totalPrims++
      totalTris += triangles(prim)
    }
  }
  for (const c of n.children ?? []) walkNode(c, p, depth + 1)
}
console.log('NODES (full path after ←; a regex in dropNodes / keepNodes is tested on that path)')
for (const scene of json.scenes ?? []) for (const r of scene.nodes ?? []) walkNode(r, '', 0)
const isChild = new Set(nodes.flatMap(n => n.children ?? []))
for (const [i] of nodes.entries()) if (!seen.has(i) && !isChild.has(i)) walkNode(i, '', 0)

console.log('\nPRIMITIVES (per node instance)')
for (const l of meshLines) console.log(l)

console.log('\nIMAGES')
let totalImgBytes = 0
const imageRows = []
for (const [i, img] of model.images.entries()) {
  let w, h
  if (img.format === 'ktx2') { const k = sniffImage(img.data); w = k.width; h = k.height } else { const m = await sharp(img.data).metadata(); w = m.width; h = m.height }
  totalImgBytes += img.data.length
  imageRows.push({ i, name: img.name, w, h })
  const users = materials.flatMap((m, mi) => textureSlots(m).filter(s => textureImage(json.textures?.[s.texture] ?? {}) === i).map(s => `${m.name ?? '#' + mi}:${slotName(s.slot)}`))
  console.log(`  ${String(i).padStart(3)}  ${(img.name || '(unnamed)').padEnd(40)} ${`${w}×${h}`.padStart(9)} ${fmtKB(img.data.length).padStart(8)}  ${img.mimeType.padEnd(11)} ${users.join(', ') || '(unused)'}`)
}

const uniqueTris = [...meshTris.values()].reduce((s, t) => s + t, 0)
const geomBytes = model.views.reduce((s, v) => s + (v.meshopt ? v.meshopt.length : v.data.length), 0) - (json.images ?? []).reduce((s, im) => s + (im.bufferView != null ? model.views[im.bufferView].byteLength : 0), 0)
console.log(`\nTOTAL: ${totalTris.toLocaleString()} tris in ${totalPrims} primitives (${uniqueTris.toLocaleString()} unique across ${meshTris.size} meshes), ${nodes.length} nodes, ${materials.length} materials, ${model.images.length} images ${fmtMB(totalImgBytes)}, geometry ${fmtMB(Math.max(0, geomBytes))}, extensions ${(json.extensionsUsed ?? []).join(' ') || '-'}`)
