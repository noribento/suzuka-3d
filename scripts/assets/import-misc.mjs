#!/usr/bin/env node
/**
 * Convert misc/dl (fetch.mjs output) and the user's drops in misc/ into public/assets/ with
 * content-hashed filenames, and write public/assets-manifest.json, CREDITS.md and
 * app/data/credits.ts from the same data so the credits can never drift from what ships.
 *
 *   node scripts/assets/import-misc.mjs            # build everything, then self-check
 *   node scripts/assets/import-misc.mjs --check    # verify only (CI): manifest ↔ files, licences,
 *                                                  # budgets, KTX2 mip chains, credits up to date
 *   node scripts/assets/import-misc.mjs --only tex/withered_grass   # rebuild a subset
 *
 * Textures (sharp → ktx):
 *   - resized to the source's target resolution `res` (512 / 1K, 2K only for withered_grass);
 *     `fetchRes` is the resolution of the download when the site has no file at `res`
 *   - arm packed as R = AO (1.0 when absent), G = roughness, B = metalness (0 when absent)
 *   - diff → KTX2 ETC1S (Basis-LZ) sRGB; nor_gl → KTX2 UASTC linear + zstd; arm / opacity → KTX2
 *     ETC1S linear; always with a full mip chain (compressed textures cannot generate mips at
 *     runtime, and anisotropy needs them). Without `ktx` the fallback is WebP (q80 colour, q90
 *     data, near-lossless when there is alpha).
 *   - `pixels: true` → WebP (lossless at ≤ 512²) instead of KTX2: the runtime needs the pixels
 *     (drawImage / getImageData into a DataArrayTexture), which a GPU-compressed file cannot give.
 * Models (`packModel`, one pipeline, every stage opt-in per source — see sources.mjs "Map roles"):
 *   prepare (`dropNodes` / `keepNodes` / `overrideImages`) → gltf-transform prune → resize
 *   (`maxTex`, default 1K) → retouch (`retouch` / `dropParts`, retouch-glb.mjs) → `texEncode`
 *   (gltf-transform uastc for normal + alpha-tested textures, etc1s for the rest, KTX2 inside the
 *   GLB via KHR_texture_basisu) → `gltfpack -cc -kn -km [-si R]` (EXT_meshopt_compression +
 *   quantisation, node and material names kept — the runtime classifies bark / leaf by material
 *   name — simplification only when the source asks). Without `texEncode` the textures inside a
 *   GLB stay PNG/JPEG exactly as before, so the shipped GLBs are not churned.
 *
 * Budgets enforced by --check (plan §6 → R phase): Σ public/assets ≤ 200 MB, RGBA8-equivalent
 * VRAM ≤ 512 MB, licences ⊂ {CC0-1.0, CC-BY-3.0, CC-BY-4.0, Apache-2.0}, nothing from misc/ref.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import sharp from 'sharp'
import { read as readKtx, KHR_DF_TRANSFER_SRGB } from 'three/examples/jsm/libs/ktx-parse.module.js'
import { SOURCES, LICENCES, RES_PX } from './sources.mjs'
import {
  ROOT, MISC, DL, DL_INDEX, PUBLIC_ASSETS, MANIFEST, WORK, GLTFPACK, GLTF_TRANSFORM,
  ensureDir, readJson, writeJson, sha256, sha256File, walk, zipExtract, findKtx, ktxEnv, npx, run,
  gltfImages, sniffImage, fmtMB, fmtKB,
} from './lib.mjs'
import { MIME_BY_FORMAT, readModel, writeGlb, retouchModel, imageUses, selectImages } from './retouch-glb.mjs'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const onlyArg = args[args.indexOf('--only') + 1]
const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null

const OUT_TEX = join(PUBLIC_ASSETS, 'tex')
const OUT_MODELS = join(PUBLIC_ASSETS, 'models')
const CREDITS_MD = join(ROOT, 'CREDITS.md')
const CREDITS_TS = join(ROOT, 'app', 'data', 'credits.ts')
const BASIS_SRC = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis')
const BASIS_DST = join(ROOT, 'public', 'basis')
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm', 'README.md']
/**
 * R phase (柵の外のリアリズム): the user raised the pack from 80 MB / 250 MB to 200 MB / 512 MB to
 * make room for the photoreal trees, road-side furniture, houses and vehicles. Download size is
 * what a first visit pays; the VRAM figure is the RGBA8-equivalent estimate below.
 */
const BUDGET_BYTES = 200 * 1048576
const BUDGET_VRAM = 512 * 1048576
/** Textures inside models are capped at this unless the source sets a smaller `maxTex`. */
const MAX_MODEL_TEX = 1024
const MIP_OVERHEAD = 1.33
/**
 * Bytes per texel resident on the GPU. KTX2 (Basis-LZ / UASTC) transcodes to BC7 or ASTC 4×4 on
 * desktop three (8 bpp; older GPUs get BC1/ETC1 at 4 bpp, so 1 B/px is the ceiling) — whether it
 * is a stand-alone .ktx2 or a KHR_texture_basisu image inside a GLB; images that are still
 * PNG/JPEG/WebP (inside a GLB, or a `pixels: true` texture) are decoded and uploaded as RGBA8.
 * The budget is for real VRAM — measured strictly as RGBA8 the pack would be far over.
 */
const BYTES_PER_TEXEL = { ktx2: 1, uncompressed: 4 }

const ktx = findKtx()
const dlIndex = readJson(DL_INDEX, {})

// ---------------------------------------------------------------------------------------------
// Textures

const pow2 = (n) => 2 ** Math.round(Math.log2(n))

/**
 * Load one map as 8-bit raw pixels at ≤ target px. `channels` forces the layout we want. Output
 * dimensions are snapped to powers of two: BC7 / S3TC uploads reject a level whose side is not a
 * multiple of 4 (preconcrete_wall_001_long is 3:1 → 1024×341 as shipped), and POT keeps the mip
 * chain regular. A non-square source keeps its physical aspect via `aspect` in the manifest.
 */
async function loadRaw (file, target, channels) {
  let img = sharp(file, { limitInputPixels: false })
  const meta = await img.metadata()
  const scale = Math.min(1, target / Math.max(meta.width, meta.height))
  const w = Math.min(target, pow2(meta.width * scale))
  const h = Math.min(target, pow2(meta.height * scale))
  if (w !== meta.width || h !== meta.height) {
    img = img.resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
  }
  if (channels === 1) img = img.extractChannel(0)
  else if (channels === 3) img = img.removeAlpha()
  else if (channels === 4) img = img.ensureAlpha()
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== channels) throw new Error(`${file}: expected ${channels} channels, got ${info.channels}`)
  return { data, width: info.width, height: info.height, channels, sourceWidth: meta.width, sourceHeight: meta.height }
}

/** R = AO or 1.0, G = roughness, B = metalness or 0 — one linear texture for MeshStandardMaterial. */
async function packArm (spec, locate, target) {
  const rough = await loadRaw(locate(spec.rough), target, 1)
  const { width, height } = rough
  const opt = async (s) => {
    const file = locate(s)
    if (!file) return null
    const m = await loadRaw(file, target, 1)
    if (m.width !== width || m.height !== height) throw new Error(`arm pack: ${file} is ${m.width}×${m.height}, roughness is ${width}×${height}`)
    return m
  }
  const ao = await opt(spec.ao)
  const metal = await opt(spec.metal)
  const n = width * height
  const out = Buffer.alloc(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = ao ? ao.data[i] : 255
    out[i * 3 + 1] = rough.data[i]
    out[i * 3 + 2] = metal ? metal.data[i] : 0
  }
  return { data: out, width, height, channels: 3, packed: { ao: !!ao, metal: !!metal }, sourceWidth: rough.sourceWidth, sourceHeight: rough.sourceHeight }
}

/**
 * Encode raw pixels to KTX2 (preferred) or WebP; returns { buffer, ext, format }. `pixels`
 * sources always get WebP — lossless at ≤ 512², near-lossless q90 above — because the runtime
 * reads them back with drawImage, which no GPU-compressed format allows.
 */
async function encodeTexture (raw, role, name, { pixels = false } = {}) {
  const srgb = role === 'diff'
  const { data, width, height, channels } = raw
  if (pixels) {
    const lossless = Math.max(width, height) <= 512
    const buffer = await sharp(data, { raw: { width, height, channels } })
      .webp(lossless ? { lossless: true, effort: 6 } : { quality: 90, nearLossless: true, effort: 6 })
      .toBuffer()
    return { buffer, ext: 'webp', format: 'webp' }
  }
  const png = sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 3 })
  if (ktx) {
    const dir = ensureDir(join(WORK, 'tex'))
    const pngFile = join(dir, `${name}.png`)
    const outFile = join(dir, `${name}.ktx2`)
    await png.toFile(pngFile)
    const format = (channels === 4 ? 'R8G8B8A8' : 'R8G8B8') + (srgb ? '_SRGB' : '_UNORM')
    const cmd = [
      'create', '--format', format, '--assign-tf', srgb ? 'srgb' : 'linear',
      '--generate-mipmap', '--mipmap-filter', 'kaiser',
    ]
    // Normals need UASTC (ETC1S smears the tangent-space gradients); zstd only applies there,
    // Basis-LZ already has its own entropy coding and ktx refuses --zstd with it.
    if (role === 'nor_gl') cmd.push('--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18')
    else cmd.push('--encode', 'basis-lz', '--clevel', '2', '--qlevel', '192')
    cmd.push(pngFile, outFile)
    run(ktx.bin, cmd)
    const buffer = readFileSync(outFile)
    verifyKtx2(buffer, `${name}.ktx2`, srgb)
    return { buffer, ext: 'ktx2', format: 'ktx2' }
  }
  const buffer = await sharp(data, { raw: { width, height, channels } })
    .webp({ quality: srgb ? 80 : 90, nearLossless: channels === 4 || role === 'opacity', effort: 6 })
    .toBuffer()
  return { buffer, ext: 'webp', format: 'webp' }
}

/** Header sanity: full mip chain and the DFD transfer function we asked for. */
function verifyKtx2 (buffer, label, srgb) {
  const c = readKtx(new Uint8Array(buffer))
  const want = Math.floor(Math.log2(Math.max(c.pixelWidth, c.pixelHeight))) + 1
  if (c.levels.length !== want) throw new Error(`${label}: ${c.levels.length} mip levels, expected ${want}`)
  const tf = c.dataFormatDescriptor[0]?.transferFunction
  const isSrgb = tf === KHR_DF_TRANSFER_SRGB
  if (srgb !== undefined && isSrgb !== srgb) throw new Error(`${label}: DFD transfer is ${isSrgb ? 'sRGB' : 'linear'}, expected ${srgb ? 'sRGB' : 'linear'}`)
  return { width: c.pixelWidth, height: c.pixelHeight, levels: c.levels.length, srgb: isSrgb }
}

async function importTexture (src, assets) {
  const assetName = src.key.split('/')[1]
  const target = RES_PX[src.res]
  if (!target) throw new Error(`${src.key}: res ${src.res} is not one of ${Object.keys(RES_PX).join('/')}`)
  const dlDir = join(DL, src.key)
  let locate
  let zipUrl
  if (src.zip) {
    const zipFile = join(dlDir, src.zip)
    if (!existsSync(zipFile)) throw new Error(`${src.key}: ${zipFile} missing — run fetch.mjs`)
    const dir = join(WORK, 'zip', assetName)
    rmSync(dir, { recursive: true, force: true })
    const members = zipExtract(zipFile, ensureDir(dir))
    zipUrl = src.files[src.zip]
    locate = (suffix) => {
      const optional = suffix.endsWith('?')
      const s = optional ? suffix.slice(0, -1) : suffix
      const m = members.find(f => /\.(jpe?g|png)$/i.test(f) && basename(f).replace(/\.[^.]+$/, '').endsWith(s))
      if (!m && !optional) throw new Error(`${src.key}: no *${s}.jpg in ${src.zip}`)
      return m ? join(dir, m) : null
    }
  } else {
    locate = (rel) => {
      const f = join(dlDir, rel)
      if (!existsSync(f)) throw new Error(`${src.key}: ${f} missing — run fetch.mjs`)
      return f
    }
  }
  for (const [role, spec] of Object.entries(src.maps)) {
    let raw
    let sourceFile
    if (typeof spec === 'object') {
      raw = await packArm(spec, locate, target)
      sourceFile = locate(spec.rough)
    } else {
      sourceFile = locate(spec)
      const meta = await sharp(sourceFile).metadata()
      const channels = role === 'diff' ? (meta.hasAlpha ? 4 : 3) : role === 'opacity' ? 1 : 3
      raw = await loadRaw(sourceFile, target, channels)
      if (role === 'opacity') {
        // Replicate the mask to RGB: a 1-channel Basis-LZ texture would transcode to R-only
        // formats on some GPUs and three would read a black mask.
        const n = raw.width * raw.height
        const rgb = Buffer.alloc(n * 3)
        for (let i = 0; i < n; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = raw.data[i]
        raw = { ...raw, data: rgb, channels: 3 }
      }
    }
    const name = `${assetName}_${role}`
    const enc = await encodeTexture(raw, role, name, { pixels: !!src.pixels })
    const hash = sha256(enc.buffer)
    const file = `${name}.${hash.slice(0, 8)}.${enc.ext}`
    ensureDir(OUT_TEX)
    writeFileSync(join(OUT_TEX, file), enc.buffer)
    const sourceRel = src.zip ? basename(sourceFile) : relative(dlDir, sourceFile)
    const sourceUrl = src.zip ? `${zipUrl}#${sourceRel}` : src.files[sourceRel]
    assets[`${src.key}/${role}`] = {
      kind: 'texture',
      path: `/assets/tex/${file}`,
      format: enc.format,
      bytes: enc.buffer.length,
      width: raw.width,
      height: raw.height,
      colorSpace: role === 'diff' ? 'srgb' : 'linear',
      role,
      ...(src.tile ? { tile: src.tile } : {}),
      // Source width / height — the physical tile is `tile` × `tile / aspect` metres.
      ...(raw.sourceWidth !== raw.sourceHeight ? { aspect: Number((raw.sourceWidth / raw.sourceHeight).toFixed(4)) } : {}),
      ...(raw.packed ? { packed: raw.packed } : {}),
      // `pixels`: shipped as WebP so the runtime can read the texels back (facade array layers).
      ...(src.pixels ? { pixels: true } : {}),
      source: {
        site: src.site,
        name: src.name,
        pageUrl: src.pageUrl,
        url: sourceUrl,
        licence: src.licence,
        author: src.author,
        ...(src.authorUrl ? { authorUrl: src.authorUrl } : {}),
        sha256Source: src.zip ? sha256File(join(dlDir, src.zip)) : sha256File(sourceFile),
      },
      modified: true,
      ...(src.pixels ? { modifications: ['resized / repacked (lossless WebP)'] } : {}),
    }
    console.log(`  ${role.padEnd(8)} ${raw.width}×${raw.height} ${enc.format.padEnd(5)} ${fmtKB(enc.buffer.length).padStart(8)}  ${file}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Models

/** `{ width, height, format }` of every image in a glTF/GLB; KTX2 (KHR_texture_basisu) read from its header. */
async function textureDims (file) {
  const dims = []
  for (const img of gltfImages(file)) {
    if (img.format === 'ktx2') dims.push({ width: img.width, height: img.height, format: 'ktx2' })
    else {
      const m = await sharp(img.data).metadata()
      dims.push({ width: m.width, height: m.height, format: img.format === 'unknown' ? (m.format ?? 'unknown') : img.format })
    }
  }
  return dims
}

const fmtRe = (re) => (re instanceof RegExp ? re.source : String(re))
/** Source fields documented as RegExp also accept a pattern string (case-insensitive). */
const toRe = (v) => (v == null || v instanceof RegExp ? v : new RegExp(String(v), 'i'))

/**
 * Prepare stage: node selection and image overrides on the parsed JSON, before anything is
 * packed. `keepNodes` / `dropNodes` are tested on the node's full name path (`Root/Pine_1/LOD0`,
 * as inspect-model.mjs prints it) — a dropped node just loses its mesh, gltf-transform prune
 * then removes the mesh, its accessors, materials and images, and the empty leaf node.
 * `overrideImages` swaps an image's bytes for a file next to the source (a re-drawn atlas).
 */
function prepareModel (model, src, srcDir) {
  const notes = []
  const { json } = model
  if (src.dropNodes || src.keepNodes) {
    const keep = toRe(src.keepNodes)
    const drop = toRe(src.dropNodes)
    const nodes = json.nodes ?? []
    let dropped = 0
    let kept = 0
    const visit = (i, path) => {
      const n = nodes[i]
      const p = path ? `${path}/${n.name || '(unnamed)'}` : (n.name || '(unnamed)')
      if (n.mesh != null) {
        if ((keep && !keep.test(p)) || (drop && drop.test(p))) { delete n.mesh; delete n.skin; delete n.weights; dropped++ } else kept++
      }
      for (const c of n.children ?? []) visit(c, p)
    }
    for (const scene of json.scenes ?? []) for (const r of scene.nodes ?? []) visit(r, '')
    if (!kept) throw new Error(`keepNodes / dropNodes left no mesh node (keep ${fmtRe(src.keepNodes)}, drop ${fmtRe(src.dropNodes)})`)
    notes.push(`${dropped} mesh nodes dropped (${[src.keepNodes && `keep /${fmtRe(src.keepNodes)}/`, src.dropNodes && `drop /${fmtRe(src.dropNodes)}/`].filter(Boolean).join(', ')})`)
  }
  if (src.overrideImages) {
    for (const [sel, rel] of Object.entries(src.overrideImages)) {
      const idx = selectImages(model, /^\d+$/.test(sel) ? Number(sel) : sel)
      if (!idx.length) throw new Error(`overrideImages: no image matches ${sel}`)
      const file = join(srcDir, rel)
      if (!existsSync(file)) throw new Error(`overrideImages: ${file} missing`)
      const data = readFileSync(file)
      const { format } = sniffImage(data)
      if (!MIME_BY_FORMAT[format]) throw new Error(`overrideImages: ${rel} is not PNG / JPEG / WebP / KTX2`)
      for (const i of idx) model.images[i] = { ...model.images[i], data, format, mimeType: MIME_BY_FORMAT[format] }
    }
    notes.push(`images replaced (${Object.values(src.overrideImages).join(', ')})`)
  }
  return notes
}

/**
 * Texture encode stage: KTX2 inside the GLB. Normal maps and the base colour of MASK / BLEND
 * materials (leaf cards, fences) default to UASTC — ETC1S smears tangent gradients and eats the
 * alpha edge — everything else to ETC1S. gltf-transform can only select textures by slot or by
 * image name, so the images are tagged `__tx<i>__` for the run and renamed back afterwards.
 * Already-KTX2 images are skipped by gltf-transform, which is what makes two passes possible.
 */
function encodeModelTextures (cur, work, enc) {
  if (!ktx) throw new Error('texEncode needs the ktx CLI (misc/tools/ktx/bin or $KTX_BIN)')
  const model = readModel(cur)
  const uses = imageUses(model.json)
  const mode = { default: enc.default ?? 'etc1s', normal: enc.normal ?? 'uastc', alpha: enc.alpha ?? 'uastc' }
  for (const [k, v] of Object.entries(mode)) if (!['etc1s', 'uastc', 'none'].includes(v)) throw new Error(`texEncode.${k}: ${v} is not etc1s / uastc / none`)
  const plan = model.images.map((img, i) => {
    if (img.format === 'ktx2' || !uses[i].length) return 'none'
    const encoders = uses[i].map(u => mode[/normalTexture$/i.test(u.slot) ? 'normal' : u.alphaMode !== 'OPAQUE' && /(baseColor|diffuse)Texture$/i.test(u.slot) ? 'alpha' : 'default'])
    return encoders.includes('uastc') ? 'uastc' : encoders.every(e => e === 'none') ? 'none' : 'etc1s'
  })
  const names = model.images.map(img => img.name)
  model.images.forEach((img, i) => { img.name = `${img.name}__tx${i}__` })
  let file = join(work, 'tagged.glb')
  writeGlb(file, model)
  const passes = [
    ['uastc', ['--level', '2', '--zstd', '18']],
    ['etc1s', enc.quality ? ['--quality', String(enc.quality)] : []],
  ]
  for (const [encoder, args] of passes) {
    const idx = plan.map((e, i) => (e === encoder ? i : -1)).filter(i => i >= 0)
    if (!idx.length) continue
    const out = join(work, `${encoder}.glb`)
    // micromatch with `contains`: a bare token or a brace list of tokens, matched on the image name.
    const pattern = idx.length === plan.length ? [] : ['--pattern', idx.length === 1 ? `__tx${idx[0]}__` : `{${idx.map(i => `__tx${i}__`).join(',')}}`]
    npx(GLTF_TRANSFORM, [encoder, file, out, ...args, ...pattern], { env: ktxEnv() })
    file = out
  }
  const done = readModel(file)
  done.images.forEach((img, i) => { img.name = names[i] })
  for (const [i, img] of done.images.entries()) if (plan[i] !== 'none' && img.format !== 'ktx2') throw new Error(`texEncode: image ${i} (${names[i]}) is still ${img.format} after ${plan[i]}`)
  const encoded = join(work, 'encoded.glb')
  writeGlb(encoded, done)
  const counts = Object.fromEntries(['uastc', 'etc1s'].map(e => [e, plan.filter(p => p === e).length]).filter(([, n]) => n))
  return { file: encoded, note: `textures GPU-compressed to KTX2 (${Object.entries(counts).map(([e, n]) => `${n} ${e}`).join(', ')})` }
}

/**
 * gltf/glb → meshopt GLB in public/assets/models; returns the manifest fragment. `src` is the
 * sources.mjs entry: every stage below is skipped unless its field is set, so an entry with
 * nothing but `maxTex` produces the same GLB as before (plus `-km`). `srcDir` is where
 * `overrideImages` paths resolve.
 */
async function packModel (input, outName, src = {}, srcDir = dirname(input)) {
  const maxTex = src.maxTex ?? MAX_MODEL_TEX
  const work = ensureDir(join(WORK, 'models', outName))
  const modifications = ['meshopt compression (gltfpack -cc)']
  let cur = input
  if (src.dropNodes || src.keepNodes || src.overrideImages) {
    const model = readModel(cur)
    modifications.push(...prepareModel(model, src, srcDir))
    const prepared = join(work, 'prepared.glb')
    writeGlb(prepared, model)
    const pruned = join(work, 'pruned.glb')
    npx(GLTF_TRANSFORM, ['prune', prepared, pruned])
    cur = pruned
  }
  const dims = await textureDims(cur)
  if (dims.some(d => Math.max(d.width, d.height) > maxTex)) {
    const resized = join(work, 'resized.glb')
    npx(GLTF_TRANSFORM, ['resize', cur, resized, '--width', String(maxTex), '--height', String(maxTex)])
    cur = resized
    modifications.push(`textures resized to ≤ ${maxTex} px`)
  }
  if (src.retouch || src.dropParts) {
    const model = readModel(cur)
    const r = await retouchModel(model, { retouch: src.retouch, dropParts: src.dropParts })
    const retouched = join(work, 'retouched.glb')
    writeGlb(retouched, model)
    cur = retouched
    if (r.retouched) modifications.push(`trademarks retouched (${src.retouch.reduce((n, op) => n + op.rects.length, 0)} rectangles blurred / filled)`)
    if (src.dropParts) modifications.push(`parts dropped (${r.dropped} primitives matching /${fmtRe(src.dropParts)}/)`)
  }
  if (src.texEncode) {
    const r = encodeModelTextures(cur, work, src.texEncode)
    cur = r.file
    modifications.push(r.note)
  }
  const packed = join(work, 'packed.glb')
  // -cc: meshopt compression (textures are embedded in .glb output by default), -kn: keep node
  // names so a pack that holds several trees stays addressable per node (gltfpack would
  // otherwise merge everything into one mesh), -km: keep material names — the runtime tells
  // bark from leaves by them. Nothing is simplified unless the source asks (`simplify`).
  const simplify = src.simplify != null ? ['-si', String(src.simplify)] : []
  npx(GLTFPACK, ['-i', cur, '-o', packed, '-cc', '-kn', '-km', ...simplify])
  if (simplify.length) modifications.push(`simplified to ${src.simplify} of the triangles (gltfpack -si)`)
  const buffer = readFileSync(packed)
  const hash = sha256(buffer)
  const file = `${outName}.${hash.slice(0, 8)}.glb`
  ensureDir(OUT_MODELS)
  writeFileSync(join(OUT_MODELS, file), buffer)
  const textures = await textureDims(packed)
  console.log(`  ${outName.padEnd(34)} glb ${fmtKB(buffer.length).padStart(8)}  tex ${textures.map(t => `${t.width}×${t.height}${t.format === 'ktx2' ? 'k' : ''}`).join(' ') || '-'}  ${file}`)
  return { path: `/assets/models/${file}`, bytes: buffer.length, textures, modifications }
}

function sourceBlock (src, extra) {
  return {
    site: src.site,
    name: src.name,
    pageUrl: src.pageUrl,
    licence: src.licence,
    author: src.author,
    ...(src.authorUrl ? { authorUrl: src.authorUrl } : {}),
    ...(src.credit ? { credit: src.credit } : {}),
    ...extra,
  }
}

/** The manifest entry of one packed model. */
function modelEntry (m, source) {
  return {
    kind: 'model',
    path: m.path,
    format: 'glb',
    bytes: m.bytes,
    role: 'model',
    textures: m.textures,
    source,
    modified: true,
    modifications: m.modifications,
  }
}

async function importRemoteModel (src, assets) {
  const dir = join(DL, src.key)
  let input
  if (src.resolver === 'polyhaven-api') {
    const gltf = walk(dir).find(f => f.endsWith('.gltf'))
    if (!gltf) throw new Error(`${src.key}: no .gltf under ${dir} — run fetch.mjs`)
    input = join(dir, gltf)
  } else {
    input = join(dir, src.entry)
    if (!existsSync(input)) throw new Error(`${src.key}: ${input} missing — run fetch.mjs`)
  }
  const outName = src.key.split('/').slice(1).join('_')
  const m = await packModel(input, outName, src, dir)
  const rel = relative(dir, input).split('\\').join('/')
  assets[src.key] = modelEntry(m, sourceBlock(src, {
    url: dlIndex[`${src.key}/${rel}`]?.url ?? src.files?.[rel] ?? src.apiUrl,
    sha256Source: sha256File(input),
  }))
}

/** Sketchfab's license.txt is the authoritative title / source / author for the credit line. */
function parseSketchfabLicence (text) {
  const get = (k) => text.match(new RegExp(`^\\*\\s*${k}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const authorLine = get('author') ?? ''
  const am = authorLine.match(/^(.*?)\s*\((https?:[^)]+)\)/)
  return {
    title: get('title'),
    source: get('source'),
    author: am ? am[1] : authorLine || undefined,
    authorUrl: am ? am[2] : undefined,
    licence: get('license type')?.match(/CC-BY-4\.0|CC0-1\.0|CC-BY-3\.0/)?.[0],
  }
}

async function importLocalModel (src, assets) {
  const miscRel = (p) => relative(MISC, p).split('\\').join('/')

  if (src.zip) {
    const drop = findDrop(src.miscRoots, src.zip)
    if (!drop) {
      console.warn(`  ${src.key}: ${fmtRe(src.zip)} not found under misc/ (${src.miscRoots.join(', ')}) — skipped`)
      return
    }
    const { root, file: zipFile } = drop
    if (miscRel(root).startsWith('ref')) throw new Error(`${src.key}: refusing to import from misc/ref`)
    const zipName = basename(zipFile)
    const dir = join(WORK, 'zip', src.key.split('/').pop())
    rmSync(dir, { recursive: true, force: true })
    const members = zipExtract(zipFile, ensureDir(dir))
    const licMember = members.find(m => basename(m).toLowerCase() === src.licenceFile.toLowerCase())
    if (!licMember) throw new Error(`${src.key}: ${zipName} has no ${src.licenceFile}`)
    const licText = readFileSync(join(dir, licMember), 'utf8')
    if (!licText.includes(src.licenceMarker)) throw new Error(`${src.key}: ${src.licenceFile} does not say ${src.licenceMarker}`)
    const parsed = parseSketchfabLicence(licText)
    if (parsed.licence && parsed.licence !== src.licence) throw new Error(`${src.key}: licence file says ${parsed.licence}, sources.mjs says ${src.licence}`)
    // Default entry: Sketchfab's scene.gltf, or the one .glb of a hand-made zip.
    const entryMatch = src.entry ? nameMatcher(src.entry) : (name) => /^scene\.gltf$|\.glb$/i.test(name)
    const entries = members.filter(m => /\.(gltf|glb)$/i.test(m) && entryMatch(basename(m)))
    if (!entries.length) throw new Error(`${src.key}: ${src.entry ? fmtRe(src.entry) : 'scene.gltf / *.glb'} not in ${zipName}`)
    if (entries.length > 1 && !src.entry) throw new Error(`${src.key}: ${zipName} has several models (${entries.join(', ')}) — set entry`)
    const outName = src.key.split('/').slice(1).join('_')
    const m = await packModel(join(dir, entries[0]), outName, src, root)
    assets[src.key] = modelEntry(m, sourceBlock({
      ...src,
      name: parsed.title ?? src.name,
      pageUrl: parsed.source ?? src.pageUrl,
      author: parsed.author ?? src.author,
      authorUrl: parsed.authorUrl ?? src.authorUrl,
    }, {
      url: parsed.source ?? src.pageUrl,
      sha256Source: sha256File(zipFile),
      miscPath: miscRel(zipFile),
      licenceEvidence: `${zipName}!${licMember}`,
    }))
    return
  }

  const root = src.miscRoots.map(r => join(MISC, r)).find(existsSync)
  if (!root) {
    console.warn(`  ${src.key}: not found under misc/ (${src.miscRoots.join(', ')}) — skipped`)
    return
  }
  if (miscRel(root).startsWith('ref')) throw new Error(`${src.key}: refusing to import from misc/ref`)
  const licFile = join(root, src.licenceFile)
  if (!existsSync(licFile) || !readFileSync(licFile, 'utf8').includes(src.licenceMarker)) {
    throw new Error(`${src.key}: ${licFile} missing or does not say ${src.licenceMarker}`)
  }
  const [globDir, globPat] = src.glob.split('/')
  const re = new RegExp('^' + globPat.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i')
  const files = walk(join(root, globDir)).filter(f => re.test(f))
  if (!files.length) throw new Error(`${src.key}: no ${src.glob} under ${root}`)
  for (const f of files) {
    const input = join(root, globDir, f)
    const sub = src.subKey(f)
    const outName = `${src.key.split('/').slice(1).join('_')}_${sub}`
    const m = await packModel(input, outName, src, root)
    assets[`${src.key}/${sub}`] = modelEntry(m, sourceBlock(src, {
      url: src.pageUrl,
      sha256Source: sha256File(input),
      miscPath: miscRel(input),
      licenceEvidence: miscRel(licFile),
    }))
  }
}

// ---------------------------------------------------------------------------------------------
// Credits (generated from the manifest, never hand-edited)

const FIXED_CREDITS = [
  {
    kind: 'data',
    title: 'OpenStreetMap',
    author: 'OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL-1.0',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    modified: true,
    attribution: 'Footprints derived from OpenStreetMap data © OpenStreetMap contributors, ODbL 1.0',
  },
  {
    kind: 'data',
    title: '基盤地図情報 数値標高モデル（DEM5A）・シームレス空中写真',
    author: '国土地理院',
    url: 'https://maps.gsi.go.jp/development/ichiran.html',
    licence: '国土地理院コンテンツ利用規約（政府標準利用規約 2.0 準拠）',
    licenceUrl: 'https://www.gsi.go.jp/LAW/2930-index.html',
    modified: true,
    attribution: '標高・配置の一部は「基盤地図情報 数値標高モデル（DEM5A）」「シームレス空中写真」（国土地理院）（https://maps.gsi.go.jp/development/ichiran.html）をもとに作成',
  },
  {
    kind: 'software',
    title: 'Basis Universal transcoder (public/basis/)',
    author: 'Binomial LLC',
    url: 'https://github.com/BinomialLLC/basis_universal',
    licence: 'Apache-2.0',
    licenceUrl: LICENCES['Apache-2.0'].url,
    modified: false,
    attribution: 'Basis Universal transcoder © Binomial LLC, Apache License 2.0 — see public/basis/README.md',
  },
]

/** One credit per source asset (a texture's three maps share a line). */
function buildCredits (manifest) {
  const byPage = new Map()
  for (const [key, a] of Object.entries(manifest.assets)) {
    const s = a.source
    const id = s.pageUrl
    if (!byPage.has(id)) {
      byPage.set(id, {
        kind: 'asset',
        title: s.name,
        author: s.author,
        ...(s.authorUrl ? { authorUrl: s.authorUrl } : {}),
        url: s.pageUrl,
        site: s.site,
        licence: s.licence,
        licenceUrl: LICENCES[s.licence]?.url ?? '',
        modified: Object.values(manifest.assets).some(x => x.source.pageUrl === id && x.modified),
        keys: [],
        modifications: new Set(),
      })
    }
    const c = byPage.get(id)
    c.keys.push(key)
    for (const m of a.modifications ?? (a.kind === 'texture' ? ['resized / repacked / GPU-compressed'] : ['meshopt compression (gltfpack -cc)'])) c.modifications.add(m)
    if (s.credit) c.credit = s.credit
  }
  const credits = [...byPage.values()].map((c) => {
    const mods = [...c.modifications].join(', ')
    let attribution
    if (c.site === 'Sketchfab') {
      // Sketchfab's required wording, verbatim from the model's license.txt, plus what changed.
      attribution = `This work is based on "${c.title}" (${c.url}) by ${c.author} (${c.authorUrl}) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)` + (mods ? ` — modified (${mods})` : '')
    } else {
      // CC0: courtesy line. A source may dictate its preferred wording (Quaternius' License.txt).
      const who = c.credit ? `${c.credit} — "${c.title}"` : `"${c.title}" by ${c.author}`
      attribution = `${who} (${c.site}, ${c.url}), ${LICENCES[c.licence]?.name ?? c.licence}` + (mods ? ` — modified (${mods})` : '')
    }
    delete c.credit
    const { keys, modifications, site, ...rest } = c
    return { ...rest, site, attribution, keys: keys.sort() }
  })
  credits.sort((a, b) => a.site.localeCompare(b.site) || a.title.localeCompare(b.title))
  return credits
}

function renderCreditsMd (manifest, credits) {
  const L = []
  L.push('# Credits')
  L.push('')
  L.push('<!-- GENERATED by scripts/assets/import-misc.mjs from public/assets-manifest.json — do not edit by hand. -->')
  L.push('')
  L.push('Suzuka 3D ships third-party textures and models in `public/assets/` (high-quality tier only). Every file there is CC0 or CC-BY; the exact source, licence and hash of each is recorded in `public/assets-manifest.json`. Reference material that is only *looked at* (photographs, seating charts, aerial tiles) is not distributed and is not listed here.')
  L.push('')
  L.push('## Third-party assets')
  L.push('')
  const bySite = new Map()
  for (const c of credits) { if (!bySite.has(c.site)) bySite.set(c.site, []); bySite.get(c.site).push(c) }
  for (const [site, list] of bySite) {
    L.push(`### ${site}`)
    L.push('')
    for (const c of list) {
      L.push(`- ${c.attribution}`)
      const files = c.keys.length > 6 ? `\`${c.keys[0].split('/').slice(0, -1).join('/')}/*\` (${c.keys.length} files)` : c.keys.map(k => `\`${k}\``).join(', ')
      L.push(`  - licence: [${c.licence}](${c.licenceUrl}) · files: ${files}`)
    }
    L.push('')
  }
  L.push('## Data')
  L.push('')
  for (const c of FIXED_CREDITS.filter(c => c.kind === 'data')) L.push(`- ${c.attribution} — [${c.licence}](${c.licenceUrl})`)
  L.push('')
  L.push('## Software shipped with the site')
  L.push('')
  for (const c of FIXED_CREDITS.filter(c => c.kind === 'software')) L.push(`- ${c.attribution} — [${c.licence}](${c.licenceUrl})`)
  L.push('')
  L.push('## Tools used to convert the assets')
  L.push('')
  const t = manifest.tools
  L.push(`- sharp ${t.sharp} (resize, channel packing, WebP), KTX-Software ${t.ktx ?? 'not available — WebP fallback'} (KTX2 Basis-LZ / UASTC), ${t.gltfpack} (meshopt), ${t.gltfTransform} (texture resize)`)
  L.push('')
  L.push(`Generated ${manifest.generated} · ${Object.keys(manifest.assets).length} files · ${fmtMB(Object.values(manifest.assets).reduce((s, a) => s + a.bytes, 0))}`)
  L.push('')
  return L.join('\n')
}

function renderCreditsTs (manifest, credits) {
  // Single-quoted TS string literals, as in the rest of the repo.
  const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const L = []
  L.push('/**')
  L.push(' * Third-party attribution shown in the in-app credits panel.')
  L.push(' *')
  L.push(' * GENERATED by scripts/assets/import-misc.mjs from public/assets-manifest.json — do not edit by')
  L.push(' * hand; rerun the importer. CC0 lines are courtesy, CC-BY lines (Sketchfab wording) are required.')
  L.push(' */')
  L.push('')
  L.push('export interface Credit {')
  L.push("  kind: 'asset' | 'data' | 'software'")
  L.push('  title: string')
  L.push('  author: string')
  L.push('  authorUrl?: string')
  L.push('  url: string')
  L.push('  /** Site or dataset the asset came from (assets only). */')
  L.push('  site?: string')
  L.push('  /** SPDX id where one exists. */')
  L.push('  licence: string')
  L.push('  licenceUrl: string')
  L.push('  modified: boolean')
  L.push('  /** Ready-to-display attribution line (Sketchfab format for CC-BY models). */')
  L.push('  attribution: string')
  L.push('}')
  L.push('')
  L.push('export const CREDITS: Credit[] = [')
  for (const c of [...credits, ...FIXED_CREDITS]) {
    L.push('  {')
    L.push(`    kind: ${q(c.kind)},`)
    L.push(`    title: ${q(c.title)},`)
    L.push(`    author: ${q(c.author)},`)
    if (c.authorUrl) L.push(`    authorUrl: ${q(c.authorUrl)},`)
    L.push(`    url: ${q(c.url)},`)
    if (c.site) L.push(`    site: ${q(c.site)},`)
    L.push(`    licence: ${q(c.licence)},`)
    L.push(`    licenceUrl: ${q(c.licenceUrl)},`)
    L.push(`    modified: ${c.modified},`)
    L.push(`    attribution: ${q(c.attribution)},`)
    L.push('  },')
  }
  L.push(']')
  L.push('')
  L.push(`export const ASSETS_GENERATED = ${q(manifest.generated)}`)
  L.push('')
  return L.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Check

function check () {
  const problems = []
  const warn = (m) => problems.push(m)
  if (!existsSync(MANIFEST)) return [`manifest ${MANIFEST} missing`]
  const manifest = readJson(MANIFEST)
  if (manifest.version !== 1) warn(`manifest version ${manifest.version}, expected 1`)
  const assets = manifest.assets ?? {}
  const onDisk = new Set(walk(PUBLIC_ASSETS).map(f => `/assets/${f}`))
  const inManifest = new Set(Object.values(assets).map(a => a.path))
  for (const p of onDisk) if (!inManifest.has(p)) warn(`${p} is in public/assets but not in the manifest`)
  for (const p of inManifest) if (!onDisk.has(p)) warn(`${p} is in the manifest but not on disk`)
  const localRoots = SOURCES.filter(s => s.resolver === 'misc-local').flatMap(s => s.miscRoots)
  let bytes = 0
  let vram = 0
  let vramRgba8 = 0
  const texVram = (w, h, format) => {
    vramRgba8 += w * h * 4 * MIP_OVERHEAD
    vram += w * h * (format === 'ktx2' ? BYTES_PER_TEXEL.ktx2 : BYTES_PER_TEXEL.uncompressed) * MIP_OVERHEAD
  }
  for (const [key, a] of Object.entries(assets)) {
    const file = join(ROOT, 'public', a.path.slice(1))
    if (!existsSync(file)) continue
    const buf = readFileSync(file)
    bytes += a.bytes
    if (buf.length !== a.bytes) warn(`${key}: ${buf.length} bytes on disk, manifest says ${a.bytes}`)
    const h8 = basename(a.path).split('.').at(-2)
    if (sha256(buf).slice(0, 8) !== h8) warn(`${key}: content hash ${sha256(buf).slice(0, 8)} ≠ filename ${h8}`)
    if (!LICENCES[a.source?.licence]) warn(`${key}: licence ${a.source?.licence} not in ${Object.keys(LICENCES).join('/')}`)
    if (a.source?.miscPath) {
      if (/^ref(\/|$)/.test(a.source.miscPath) || a.source.miscPath.includes('/ref/')) warn(`${key}: copied from misc/ref (${a.source.miscPath})`)
      const declared = localRoots.some(r => r === '.' ? !a.source.miscPath.includes('/') : a.source.miscPath.startsWith(r + '/'))
      if (!declared) warn(`${key}: misc path ${a.source.miscPath} is not a declared CC source root`)
      if (existsSync(MISC) && a.source.licenceEvidence && !a.source.licenceEvidence.includes('!')) {
        const src = SOURCES.find(s => key === s.key || key.startsWith(s.key + '/'))
        const lic = join(MISC, a.source.licenceEvidence)
        if (src && existsSync(lic) && !readFileSync(lic, 'utf8').includes(src.licenceMarker)) warn(`${key}: ${lic} no longer says ${src.licenceMarker}`)
      }
    }
    if (a.kind === 'texture') {
      texVram(a.width, a.height, a.format)
      if (a.format === 'ktx2') {
        try {
          const info = verifyKtx2(buf, key, a.colorSpace === 'srgb')
          if (info.width !== a.width || info.height !== a.height) warn(`${key}: KTX2 is ${info.width}×${info.height}, manifest says ${a.width}×${a.height}`)
        } catch (err) { warn(err.message) }
      }
    } else {
      // Model textures: PNG/JPEG inside the GLB → decoded to RGBA8 on upload; KTX2
      // (KHR_texture_basisu, `texEncode`) → transcoded like a stand-alone .ktx2, and its mip
      // chain is verified the same way.
      for (const t of a.textures ?? []) texVram(t.width, t.height, t.format === 'ktx2' ? 'ktx2' : 'uncompressed')
      if ((a.textures ?? []).some(t => t.format === 'ktx2')) {
        try {
          const imgs = gltfImages(file)
          if (imgs.length !== a.textures.length) warn(`${key}: ${imgs.length} images in the GLB, manifest lists ${a.textures.length}`)
          imgs.forEach((img, i) => {
            if (img.format !== (a.textures[i]?.format ?? 'ktx2') && a.textures[i]) warn(`${key}: image ${i} is ${img.format}, manifest says ${a.textures[i].format}`)
            if (img.format === 'ktx2') verifyKtx2(img.data, `${key} image ${i}`)
          })
        } catch (err) { warn(err.message) }
      }
    }
  }
  if (bytes > BUDGET_BYTES) warn(`public/assets is ${fmtMB(bytes)} > budget ${fmtMB(BUDGET_BYTES)}`)
  if (vram > BUDGET_VRAM) warn(`estimated RGBA8 VRAM ${fmtMB(vram)} > budget ${fmtMB(BUDGET_VRAM)}`)
  for (const f of BASIS_FILES) {
    const dst = join(BASIS_DST, f)
    if (!existsSync(dst)) warn(`public/basis/${f} missing`)
    else if (existsSync(join(BASIS_SRC, f)) && sha256File(dst) !== sha256File(join(BASIS_SRC, f))) warn(`public/basis/${f} differs from node_modules/three (re-run the importer after a three update)`)
  }
  const credits = buildCredits(manifest)
  if (!existsSync(CREDITS_MD) || readFileSync(CREDITS_MD, 'utf8') !== renderCreditsMd(manifest, credits)) warn('CREDITS.md is stale — rerun import-misc.mjs')
  if (!existsSync(CREDITS_TS) || readFileSync(CREDITS_TS, 'utf8') !== renderCreditsTs(manifest, credits)) warn('app/data/credits.ts is stale — rerun import-misc.mjs')
  console.log(`check: ${Object.keys(assets).length} assets, ${fmtMB(bytes)} on disk (≤ ${fmtMB(BUDGET_BYTES)}), est. VRAM ${fmtMB(vram)} (≤ ${fmtMB(BUDGET_VRAM)}; strict RGBA8 ${fmtMB(vramRgba8)}), ${[...onDisk].length} files, ktx2 ${Object.values(assets).filter(a => a.format === 'ktx2').length}`)
  return problems
}

// ---------------------------------------------------------------------------------------------
// Build

async function build () {
  ensureDir(WORK)
  const previous = only ? readJson(MANIFEST, { assets: {} }).assets : {}
  const assets = {}
  if (only) for (const [k, v] of Object.entries(previous)) assets[k] = v
  const failures = []
  console.log(`import → ${PUBLIC_ASSETS}  (ktx: ${ktx ? `${ktx.bin} v${ktx.version}` : 'NOT FOUND → WebP fallback'})`)
  for (const src of SOURCES) {
    if (src.kind === 'reference') continue
    if (only && !only.has(src.key)) continue
    for (const k of Object.keys(assets)) if (k === src.key || k.startsWith(src.key + '/')) delete assets[k]
    console.log(`${src.key} — ${src.site}: ${src.name}`)
    try {
      if (src.kind === 'texture') await importTexture(src, assets)
      else if (src.resolver === 'misc-local') await importLocalModel(src, assets)
      else await importRemoteModel(src, assets)
    } catch (err) {
      failures.push(`${src.key}: ${err.message}`)
      console.log(`  ✗ ${err.message.split('\n')[0]}`)
    }
  }
  // public/assets is entirely generated: drop whatever the manifest no longer references so a
  // re-encode never leaves two hashes of the same texture behind.
  const keep = new Set(Object.values(assets).map(a => a.path))
  for (const f of walk(PUBLIC_ASSETS)) {
    if (!keep.has(`/assets/${f}`)) { rmSync(join(PUBLIC_ASSETS, f)); console.log(`  pruned ${f}`) }
  }
  const sorted = Object.fromEntries(Object.keys(assets).sort().map(k => [k, assets[k]]))
  const manifest = {
    version: 1,
    generated: new Date().toISOString(),
    tools: {
      sharp: sharp.versions.sharp,
      ktx: ktx ? ktx.version : null,
      gltfpack: GLTFPACK,
      gltfTransform: GLTF_TRANSFORM,
    },
    assets: sorted,
  }
  writeJson(MANIFEST, manifest)
  const credits = buildCredits(manifest)
  writeFileSync(CREDITS_MD, renderCreditsMd(manifest, credits))
  ensureDir(dirname(CREDITS_TS))
  writeFileSync(CREDITS_TS, renderCreditsTs(manifest, credits))
  // The Basis transcoder is fetched at runtime from /basis/ (KTX2Loader.setTranscoderPath);
  // keep it in lock-step with the installed three so the loader's version check stays quiet.
  mkdirSync(BASIS_DST, { recursive: true })
  for (const f of BASIS_FILES) copyFileSync(join(BASIS_SRC, f), join(BASIS_DST, f))

  const total = Object.values(sorted).reduce((s, a) => s + a.bytes, 0)
  console.log(`\n${Object.keys(sorted).length} assets, ${fmtMB(total)} → ${relative(ROOT, MANIFEST)}, CREDITS.md, app/data/credits.ts, public/basis/`)
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

if (!checkOnly) await build()
const problems = check()
if (problems.length) {
  console.error('\nCHECK FAILED:\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('check: OK')
