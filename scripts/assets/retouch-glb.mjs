#!/usr/bin/env node
/**
 * Trademark / part surgery on a glTF or GLB before it is packed: blur or fill rectangles of the
 * embedded images (badges, number plates, sponsor decals) and drop primitives by material or
 * mesh name (a separate "logo" mesh). Plain Node + sharp — no gltf-transform, so the JSON is
 * edited in place and the BIN is rebuilt with 4-byte-aligned buffer views.
 *
 *   node scripts/assets/retouch-glb.mjs <in.glb|in.gltf> <out.glb> --spec '<json>'
 *   node scripts/assets/retouch-glb.mjs --dump <in.glb|in.gltf> <dir>   # every image as PNG + a table
 *
 * Spec (also the `retouch` / `dropParts` / `keepBox` fields of a sources.mjs entry, passed
 * in-process by import-misc.mjs):
 *   { retouch: [{ image: <index | name regex>, op: 'blur' | 'fill', rects: [[u0, v0, u1, v1], …],
 *                 colour?: '#rrggbb', sigma?: number }, …],
 *     dropParts: <regex source>,
 *     keepBox: { min?: [x, y, z], max?: [x, y, z] } }
 * Rects are glTF UV space (origin top-left, 0–1). Retouched images are re-encoded as PNG when
 * they carry alpha and JPEG q92 otherwise; KTX2 images cannot be retouched (run this before the
 * texture encode, as the importer does). `--dump` is how the rectangles get decided: look at the
 * PNGs, write the spec. `keepBox` is scene space (node transforms applied, y up, the model's own
 * units — inspect-model.mjs prints the extents): a triangle survives only when all three of its
 * vertices lie inside; a null / missing bound is open. It is for a drop whose single primitive
 * also holds a backdrop or a second prop (Sketchfab merges the author's objects into one mesh),
 * which no node or material regex can separate; unreferenced vertices go in gltfpack.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ensureDir, gltfBuffers, readGltfJson, sniffImage, fmtKB } from './lib.mjs'

export const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', ktx2: 'image/ktx2' }

// ---------------------------------------------------------------------------------------------
// Read / write

/**
 * Parse a .glb or .gltf into `{ json, views, images }`: every bufferView resolved to
 * `{ data, meshopt, byteLength }` (its own Buffer, or — for a gltfpack output — the
 * EXT_meshopt_compression bytes, passed through untouched), every image to
 * `{ data, name, mimeType, format }`. Images are detached from their buffer views so they can be
 * replaced freely; `writeGlb` re-embeds them.
 */
export function readModel (file) {
  const { json, bin } = readGltfJson(file)
  const dir = dirname(file)
  const buffers = gltfBuffers(json, bin, dir)
  const slice = (buffer, byteOffset = 0, byteLength) => {
    const b = buffers[buffer]
    if (!b) throw new Error(`${basename(file)}: buffer ${buffer} has no data`)
    return b.subarray(byteOffset, byteOffset + byteLength)
  }
  const views = (json.bufferViews ?? []).map((bv) => {
    const ext = bv.extensions?.EXT_meshopt_compression
    if (ext) return { data: null, meshopt: slice(ext.buffer, ext.byteOffset, ext.byteLength), byteLength: bv.byteLength }
    return { data: slice(bv.buffer, bv.byteOffset, bv.byteLength), meshopt: null, byteLength: bv.byteLength }
  })
  const images = (json.images ?? []).map((img) => {
    let data
    if (img.bufferView != null) data = views[img.bufferView].data
    else if (img.uri?.startsWith('data:')) data = Buffer.from(img.uri.slice(img.uri.indexOf(',') + 1), 'base64')
    else data = readFileSync(join(dir, decodeURIComponent(img.uri)))
    if (!data) throw new Error(`${basename(file)}: image ${img.name ?? ''} has no bytes`)
    const { format } = sniffImage(data)
    const name = img.name ?? (img.uri && !img.uri.startsWith('data:') ? basename(decodeURIComponent(img.uri)).replace(/\.[^.]+$/, '') : '')
    return { data, name, mimeType: img.mimeType ?? MIME_BY_FORMAT[format] ?? 'application/octet-stream', format }
  })
  return { json, views, images }
}

/** Every object carrying a `bufferView` index outside `json.images` (accessors, sparse, extensions). */
function viewRefs (json) {
  const refs = []
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { obj.forEach(visit); return }
    if (typeof obj.bufferView === 'number') refs.push(obj)
    for (const [k, v] of Object.entries(obj)) if (k !== 'images' || obj !== json) visit(v)
  }
  visit(json)
  return refs
}

const align4 = (n) => (n + 3) & ~3

/**
 * Serialise the model as a self-contained GLB: buffer 0 is the BIN chunk (views 4-byte aligned,
 * images embedded at the end); meshopt-compressed views keep their compressed bytes in the BIN
 * and their placeholder in buffer 1, the fallback buffer, exactly as gltfpack lays them out.
 */
export function writeGlb (file, { json, views, images }) {
  const refs = viewRefs(json)
  const used = [...new Set(refs.map(r => r.bufferView))].sort((a, b) => a - b)
  const remap = new Map(used.map((old, i) => [old, i]))
  for (const r of refs) r.bufferView = remap.get(r.bufferView)
  const parts = []
  const bufferViews = []
  let offset = 0
  let fallback = 0
  const appendRaw = (data) => {
    const pad = align4(offset) - offset
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad }
    const at = offset
    parts.push(data)
    offset += data.length
    return at
  }
  const append = (data, extra) => {
    bufferViews.push({ buffer: 0, byteOffset: appendRaw(data), byteLength: data.length, ...extra })
    return bufferViews.length - 1
  }
  for (const old of used) {
    const { buffer, byteOffset, byteLength, extensions, ...extra } = json.bufferViews[old]
    const v = views[old]
    if (v.meshopt) {
      const meshopt = { ...extensions.EXT_meshopt_compression, buffer: 0, byteOffset: appendRaw(v.meshopt) }
      fallback = align4(fallback)
      bufferViews.push({ buffer: 1, byteOffset: fallback, byteLength: v.byteLength, ...extra, extensions: { ...extensions, EXT_meshopt_compression: meshopt } })
      fallback += v.byteLength
    } else {
      append(v.data, { ...extra, ...(extensions ? { extensions } : {}) })
    }
  }
  json.images = images.map((img, i) => {
    const def = { ...(json.images?.[i] ?? {}) }
    delete def.uri
    def.mimeType = img.mimeType
    if (img.name) def.name = img.name
    def.bufferView = append(img.data)
    return def
  })
  if (!json.images.length) delete json.images
  json.bufferViews = bufferViews
  const binPad = align4(offset) - offset
  if (binPad) { parts.push(Buffer.alloc(binPad)); offset += binPad }
  json.buffers = [{ byteLength: offset }]
  if (fallback) json.buffers.push({ byteLength: fallback, extensions: { EXT_meshopt_compression: { fallback: true } } })
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = align4(jsonBuf.length) - jsonBuf.length
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)])
  const bin = Buffer.concat(parts)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBuf.length + (bin.length ? 8 + bin.length : 0), 8)
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return [h, data] }
  ensureDir(dirname(file))
  writeFileSync(file, Buffer.concat([header, ...chunk(0x4e4f534a, jsonBuf), ...(bin.length ? chunk(0x004e4942, bin) : [])]))
}

// ---------------------------------------------------------------------------------------------
// Queries

/** Texture slots of a material, extensions included: `{ slot, texture }` with slot such as `pbrMetallicRoughness.baseColorTexture`. */
export function textureSlots (material) {
  const out = []
  const visit = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const p = path ? `${path}.${k}` : k
      if (typeof v.index === 'number' && /texture$/i.test(k)) out.push({ slot: p, texture: v.index })
      else visit(v, p)
    }
  }
  visit(material, '')
  return out
}

/** Image index behind a texture (`source`, or the basisu / webp extension source). */
export const textureImage = (tex) => tex.extensions?.KHR_texture_basisu?.source ?? tex.extensions?.EXT_texture_webp?.source ?? tex.source

/** For every image: the materials and slots that use it, e.g. `[{ material, name, slot, alphaMode }]`. */
export function imageUses (json) {
  const uses = (json.images ?? []).map(() => [])
  const materials = json.materials ?? []
  for (const [material, mat] of materials.entries()) {
    for (const { slot, texture } of textureSlots(mat)) {
      const image = textureImage(json.textures?.[texture] ?? {})
      if (image != null && uses[image]) uses[image].push({ material, name: mat.name ?? '', slot, alphaMode: mat.alphaMode ?? 'OPAQUE' })
    }
  }
  return uses
}

const toRegExp = (v) => (v instanceof RegExp ? v : new RegExp(v, 'i'))

/** Indices of the images selected by a retouch op: a number, or a regex on the image name. */
export function selectImages (model, sel) {
  if (typeof sel === 'number') return [sel]
  const re = toRegExp(sel)
  return model.images.map((img, i) => (re.test(img.name) ? i : -1)).filter(i => i >= 0)
}

// ---------------------------------------------------------------------------------------------
// Edits

/** Blur / fill the rectangles of the selected images; re-encodes PNG (alpha) or JPEG q92. */
export async function retouchImages (model, ops) {
  for (const op of ops ?? []) {
    const idx = selectImages(model, op.image)
    if (!idx.length) throw new Error(`retouch: no image matches ${op.image}`)
    for (const i of idx) {
      const img = model.images[i]
      if (img.format === 'ktx2') throw new Error(`retouch: image ${i} (${img.name}) is KTX2 — retouch before the texture encode`)
      const meta = await sharp(img.data).metadata()
      const { width: w, height: h } = meta
      const layers = []
      for (const [u0, v0, u1, v1] of op.rects) {
        const left = Math.max(0, Math.floor(Math.min(u0, u1) * w))
        const top = Math.max(0, Math.floor(Math.min(v0, v1) * h))
        const rw = Math.min(w - left, Math.max(1, Math.ceil(Math.abs(u1 - u0) * w)))
        const rh = Math.min(h - top, Math.max(1, Math.ceil(Math.abs(v1 - v0) * h)))
        if (op.op === 'fill') {
          layers.push({ input: { create: { width: rw, height: rh, channels: 4, background: op.colour ?? '#808080' } }, left, top })
        } else {
          // A sigma of a quarter of the short side turns a badge into a smooth patch of its own
          // mean colour; the region is extracted first so the blur does not bleed outside.
          const sigma = op.sigma ?? Math.max(1, Math.min(rw, rh) / 4)
          const region = await sharp(img.data).extract({ left, top, width: rw, height: rh }).blur(sigma).png().toBuffer()
          layers.push({ input: region, left, top })
        }
      }
      const out = sharp(img.data).composite(layers)
      const png = !!meta.hasAlpha
      img.data = png ? await out.png({ compressionLevel: 6 }).toBuffer() : await out.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      img.format = png ? 'png' : 'jpeg'
      img.mimeType = MIME_BY_FORMAT[img.format]
    }
  }
}

/** Remove primitives whose material or mesh name matches; meshes left empty go too. */
export function dropParts (model, pattern) {
  if (!pattern) return 0
  const re = toRegExp(pattern)
  const { json } = model
  let dropped = 0
  for (const mesh of json.meshes ?? []) {
    const before = mesh.primitives.length
    if (re.test(mesh.name ?? '')) mesh.primitives = []
    else mesh.primitives = mesh.primitives.filter(p => !(p.material != null && re.test(json.materials?.[p.material]?.name ?? '')))
    dropped += before - mesh.primitives.length
  }
  const keep = (json.meshes ?? []).map(m => m.primitives.length > 0)
  const remap = new Map()
  json.meshes = (json.meshes ?? []).filter((m, i) => { if (keep[i]) remap.set(i, remap.size); return keep[i] })
  for (const node of json.nodes ?? []) {
    if (node.mesh == null) continue
    if (remap.has(node.mesh)) node.mesh = remap.get(node.mesh)
    else { delete node.mesh; delete node.skin; delete node.weights }
  }
  return dropped
}

const COMPONENT = {
  5120: { size: 1, read: 'readInt8', write: 'writeInt8' },
  5121: { size: 1, read: 'readUInt8', write: 'writeUInt8' },
  5122: { size: 2, read: 'readInt16LE', write: 'writeInt16LE' },
  5123: { size: 2, read: 'readUInt16LE', write: 'writeUInt16LE' },
  5125: { size: 4, read: 'readUInt32LE', write: 'writeUInt32LE' },
  5126: { size: 4, read: 'readFloatLE', write: 'writeFloatLE' },
}
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** Every element of an accessor as an array of numbers (dense, non-sparse; a meshopt view cannot be read). */
function readAccessor (model, index) {
  const a = model.json.accessors[index]
  if (a.sparse || a.bufferView == null) throw new Error(`accessor ${index} is sparse or empty`)
  const view = model.views[a.bufferView]
  if (!view.data) throw new Error(`accessor ${index} is meshopt-compressed — clip before gltfpack`)
  const bv = model.json.bufferViews[a.bufferView]
  const comp = COMPONENT[a.componentType]
  const n = ELEMENTS[a.type]
  const stride = bv.byteStride ?? comp.size * n
  const norm = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] : 0
  const out = new Array(a.count)
  for (let i = 0; i < a.count; i++) {
    const e = new Array(n)
    for (let c = 0; c < n; c++) {
      const v = view.data[comp.read]((a.byteOffset ?? 0) + i * stride + c * comp.size)
      e[c] = norm ? Math.max(v / norm, -1) : v
    }
    out[i] = e
  }
  return out
}

/** Column-major 4×4 product a·b. */
const mul4 = (a, b) => {
  const r = new Array(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]
  return r
}

/** A node's local matrix from `matrix` or its TRS (column-major, as glTF stores it). */
function nodeMatrix (n) {
  if (n.matrix) return n.matrix
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1]
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  ]
  for (let r = 0; r < 3; r++) { m[r] *= sx; m[4 + r] *= sy; m[8 + r] *= sz }
  return m
}

/**
 * Keep only the triangles inside a scene-space box (see the module comment). Returns the number
 * of triangles dropped. The index accessor of every clipped primitive is rewritten (a non-indexed
 * one becomes indexed); the vertex buffers are left alone — gltfpack drops what nothing indexes.
 */
export function clipTriangles (model, box) {
  if (!box) return 0
  const { json } = model
  const lo = box.min ?? [], hi = box.max ?? []
  const inside = (p) => p.every((v, c) => (lo[c] == null || v >= lo[c]) && (hi[c] == null || v <= hi[c]))
  // one world matrix per mesh: a mesh instanced twice with different transforms has no single
  // scene-space box, so that is refused rather than guessed
  const world = new Map()
  const visit = (i, M) => {
    const n = json.nodes[i]
    const W = mul4(M, nodeMatrix(n))
    if (n.mesh != null) {
      const prev = world.get(n.mesh)
      if (prev && prev.some((v, k) => Math.abs(v - W[k]) > 1e-9)) throw new Error(`keepBox: mesh ${n.mesh} is instanced with different transforms`)
      world.set(n.mesh, W)
    }
    for (const c of n.children ?? []) visit(c, W)
  }
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (const scene of json.scenes ?? []) for (const r of scene.nodes ?? []) visit(r, I4)
  let dropped = 0
  for (const [mi, mesh] of (json.meshes ?? []).entries()) {
    const W = world.get(mi)
    if (!W) continue
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) throw new Error(`keepBox: mesh ${mi} has a non-triangle primitive (mode ${prim.mode})`)
      const pos = readAccessor(model, prim.attributes.POSITION).map(([x, y, z]) => [
        W[0] * x + W[4] * y + W[8] * z + W[12],
        W[1] * x + W[5] * y + W[9] * z + W[13],
        W[2] * x + W[6] * y + W[10] * z + W[14],
      ])
      const ok = pos.map(inside)
      const idx = prim.indices != null ? readAccessor(model, prim.indices).map(v => v[0]) : pos.map((_, k) => k)
      const kept = []
      for (let k = 0; k + 2 < idx.length; k += 3) {
        if (ok[idx[k]] && ok[idx[k + 1]] && ok[idx[k + 2]]) kept.push(idx[k], idx[k + 1], idx[k + 2])
        else dropped++
      }
      if (kept.length === idx.length) continue
      if (!kept.length) throw new Error(`keepBox: mesh ${mi} primitive has no triangle inside`)
      // a fresh index view: uint32 when the vertex count needs it, the compact uint16 otherwise
      const wide = pos.length > 65535
      const comp = COMPONENT[wide ? 5125 : 5123]
      const data = Buffer.alloc(kept.length * comp.size)
      kept.forEach((v, k) => data[comp.write](v, k * comp.size))
      model.views.push({ data, meshopt: null, byteLength: data.length })
      json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: data.length, target: 34963 })
      json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: wide ? 5125 : 5123, count: kept.length, type: 'SCALAR' })
      prim.indices = json.accessors.length - 1
    }
  }
  return dropped
}

/** Drop materials, textures, samplers and images nothing references any more (index-remapping). */
export function pruneModel (model) {
  const { json } = model
  const compact = (list, isUsed) => {
    const remap = new Map()
    const out = (list ?? []).filter((_, i) => { if (isUsed(i)) remap.set(i, remap.size); return isUsed(i) })
    return { out, remap }
  }
  const usedMat = new Set((json.meshes ?? []).flatMap(m => m.primitives.map(p => p.material).filter(x => x != null)))
  const mats = compact(json.materials, i => usedMat.has(i))
  for (const m of json.meshes ?? []) for (const p of m.primitives) if (p.material != null) p.material = mats.remap.get(p.material)
  json.materials = mats.out
  const usedTex = new Set(json.materials.flatMap(m => textureSlots(m).map(s => s.texture)))
  const texs = compact(json.textures, i => usedTex.has(i))
  const relink = (obj) => {
    for (const v of Object.values(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      if (typeof v.index === 'number' && texs.remap.has(v.index)) v.index = texs.remap.get(v.index)
      else relink(v)
    }
  }
  json.materials.forEach(relink)
  json.textures = texs.out
  const usedImg = new Set(json.textures.map(textureImage).filter(x => x != null))
  const usedSmp = new Set(json.textures.map(t => t.sampler).filter(x => x != null))
  const imgs = compact(model.images, i => usedImg.has(i))
  const smps = compact(json.samplers, i => usedSmp.has(i))
  for (const t of json.textures) {
    if (t.source != null) t.source = imgs.remap.get(t.source)
    for (const ext of ['KHR_texture_basisu', 'EXT_texture_webp']) if (t.extensions?.[ext]?.source != null) t.extensions[ext].source = imgs.remap.get(t.extensions[ext].source)
    if (t.sampler != null) t.sampler = smps.remap.get(t.sampler)
  }
  json.images = (json.images ?? []).filter((_, i) => usedImg.has(i))
  model.images = imgs.out
  json.samplers = smps.out
  for (const k of ['materials', 'textures', 'images', 'samplers']) if (!json[k].length) delete json[k]
}

/** Apply a whole spec in place: retouch rectangles, drop parts, clip to the box, prune. Returns what changed. */
export async function retouchModel (model, spec) {
  await retouchImages(model, spec.retouch)
  const dropped = dropParts(model, spec.dropParts)
  const clipped = clipTriangles(model, spec.keepBox)
  pruneModel(model)
  return { retouched: (spec.retouch ?? []).length, dropped, clipped }
}

/** Write every image to `dir` as PNG (KTX2 as-is) and return the table rows. */
export async function dumpImages (model, dir) {
  ensureDir(dir)
  const uses = imageUses(model.json)
  const rows = []
  for (const [i, img] of model.images.entries()) {
    const safe = (img.name || 'image').replace(/[^\w.-]+/g, '_')
    let width, height, file
    if (img.format === 'ktx2') {
      const k = sniffImage(img.data)
      width = k.width
      height = k.height
      file = join(dir, `${i}_${safe}.ktx2`)
      writeFileSync(file, img.data)
    } else {
      const m = await sharp(img.data).metadata()
      width = m.width
      height = m.height
      file = join(dir, `${i}_${safe}.png`)
      await sharp(img.data).png().toFile(file)
    }
    rows.push({ i, name: img.name, width, height, bytes: img.data.length, mimeType: img.mimeType, uses: uses[i].map(u => `${u.name || '#' + u.material}:${u.slot.replace(/^pbrMetallicRoughness\./, '')}${u.alphaMode !== 'OPAQUE' ? ` (${u.alphaMode})` : ''}`), file })
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args[0] === '--dump') {
    const [input, dir] = args.slice(1)
    if (!input || !dir) { console.error('usage: retouch-glb.mjs --dump <in> <dir>'); process.exit(2) }
    const rows = await dumpImages(readModel(input), dir)
    for (const r of rows) console.log(`${String(r.i).padStart(3)}  ${(r.name || '(unnamed)').padEnd(36)} ${`${r.width}×${r.height}`.padStart(9)} ${fmtKB(r.bytes).padStart(8)}  ${r.mimeType.padEnd(11)} ${r.uses.join(', ') || '(unused)'}`)
    console.log(`${rows.length} images → ${dir}`)
  } else {
    const specArg = args[args.indexOf('--spec') + 1]
    const [input, output] = args.filter((a, i) => a !== '--spec' && args[i - 1] !== '--spec')
    if (!input || !output || !args.includes('--spec') || !specArg) { console.error("usage: retouch-glb.mjs <in> <out.glb> --spec '<json>'"); process.exit(2) }
    if (!existsSync(input)) { console.error(`${input} not found`); process.exit(2) }
    const model = readModel(input)
    const r = await retouchModel(model, JSON.parse(specArg))
    writeGlb(output, model)
    console.log(`${basename(output)}: ${r.retouched} retouch ops, ${r.dropped} primitives dropped, ${r.clipped} triangles clipped, ${model.images.length} images, ${fmtKB(readFileSync(output).length)}`)
  }
}
