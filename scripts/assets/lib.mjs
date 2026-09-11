/**
 * Shared helpers for the asset pipeline (fetch.mjs / import-misc.mjs).
 *
 * Everything here is plain Node (26+): sha256, HTTP downloads with a User-Agent, a minimal
 * zip reader (the box has no `unzip`, and we only need stored/deflated members), tool lookup
 * (`ktx` from misc/tools first, then PATH) and a glTF/GLB image probe (format sniffing incl.
 * KTX2) used to decide whether a model's textures need resizing before meshopt packing and to
 * charge them to the VRAM budget afterwards.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MISC = join(ROOT, 'misc')
export const DL = join(MISC, 'dl')
export const DL_INDEX = join(DL, 'index.json')
export const PUBLIC_ASSETS = join(ROOT, 'public', 'assets')
export const MANIFEST = join(ROOT, 'public', 'assets-manifest.json')
/** Intermediates (PNG for ktx, extracted zips, resized glb). `.cache` is already gitignored. */
export const WORK = join(ROOT, '.cache', 'assets-work')

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const sha256File = (file) => sha256(readFileSync(file))
export const md5 = (buf) => createHash('md5').update(buf).digest('hex')

export const ensureDir = (dir) => { mkdirSync(dir, { recursive: true }); return dir }
export const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)
export const writeJson = (file, data) => { ensureDir(dirname(file)); writeFileSync(file, JSON.stringify(data, null, 2) + '\n') }
export const fmtMB = (bytes) => (bytes / 1048576).toFixed(2) + ' MB'
export const fmtKB = (bytes) => (bytes / 1024).toFixed(0) + ' KB'

/** Recursively list files (relative paths, forward slashes) under a directory. */
export function walk (dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p, base))
    else out.push(p.slice(base.length + 1).split('\\').join('/'))
  }
  return out.sort()
}

// ---------------------------------------------------------------------------------------------
// HTTP

/**
 * Download `url` to `dest` (atomic: writes dest.part, then renames by re-writing). Retries a
 * few times because dl.polyhaven.org occasionally resets long transfers. Returns the buffer.
 */
export async function download (url, dest, { ua, headers = {}, retries = 3 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, ...headers }, redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const type = res.headers.get('content-type') ?? ''
      // A 200 that is really an HTML error page (CDN block, login wall) must not be cached as
      // an asset; every source we use serves a binary type.
      if (/text\/html/i.test(type) && !/\.html?$/.test(url)) {
        throw new Error(`got text/html (${buf.length} B) for ${url} — blocked or moved?`)
      }
      ensureDir(dirname(dest))
      writeFileSync(dest, buf)
      return buf
    } catch (err) {
      lastErr = err
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

export async function fetchText (url, { ua, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': ua, ...headers }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

export async function fetchJson (url, opts) {
  return JSON.parse(await fetchText(url, opts))
}

// ---------------------------------------------------------------------------------------------
// Minimal zip reader (central directory + stored/deflate). No ZIP64: our biggest zip is 44 MB.

export function zipEntries (buf) {
  // End-of-central-directory record is within the last 64 KB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory entry')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    entries.push({ name, method, csize, usize, localOff, dir: name.endsWith('/') })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function zipRead (buf, entry) {
  const lo = entry.localOff
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`zip: bad local header for ${entry.name}`)
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.csize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`)
}

/** Extract every file of a zip into `dir`; returns the list of relative paths written. */
export function zipExtract (zipFile, dir) {
  const buf = readFileSync(zipFile)
  const written = []
  for (const e of zipEntries(buf)) {
    if (e.dir) continue
    // Never let a hostile archive escape the target directory.
    const rel = e.name.split('/').filter(seg => seg && seg !== '..').join('/')
    const dest = join(dir, rel)
    ensureDir(dirname(dest))
    writeFileSync(dest, zipRead(buf, e))
    written.push(rel)
  }
  return written
}

// ---------------------------------------------------------------------------------------------
// Tools

let ktxBinCache
/** `ktx` CLI: $KTX_BIN, then misc/tools/ktx/bin, then PATH. Returns null when unavailable. */
export function findKtx () {
  if (ktxBinCache !== undefined) return ktxBinCache
  const candidates = [process.env.KTX_BIN, join(MISC, 'tools', 'ktx', 'bin', 'ktx'), 'ktx'].filter(Boolean)
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (r.status === 0 && /ktx version/i.test(r.stdout + r.stderr)) {
      const version = (r.stdout + r.stderr).match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown'
      ktxBinCache = { bin, version }
      return ktxBinCache
    }
  }
  ktxBinCache = null
  return null
}

/** `env` for `run` / `npx` that puts the directory of the found `ktx` first on PATH. */
export function ktxEnv () {
  const k = findKtx()
  if (!k) return {}
  const dir = dirname(k.bin)
  return dir === '.' ? {} : { PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
}

export const GLTFPACK = 'gltfpack@1.2.0'
export const GLTF_TRANSFORM = '@gltf-transform/cli@4.5.0'

/**
 * Run a command, failing loudly with its output on a non-zero exit. `env` is merged over
 * process.env — gltf-transform's ktx commands find `ktx` through PATH only, so callers prepend
 * misc/tools/ktx/bin (see `ktxEnv`) instead of asking the user to install it globally.
 */
export function run (cmd, args, { cwd, quiet = true, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1048576, env: env ? { ...process.env, ...env } : process.env })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\nexit ${r.status}\n${r.stdout}\n${r.stderr}`)
  }
  if (!quiet && (r.stdout || r.stderr)) console.log(r.stdout + r.stderr)
  return r
}

/** `npx --yes <pkg> args…` — pinned versions, cached by npm after the first run. */
export function npx (pkg, args, opts) {
  return run('npx', ['--yes', pkg, ...args], opts)
}

// ---------------------------------------------------------------------------------------------
// glTF / GLB image probe

/** KTX2 file identifier: «KTX 20»\r\n\x1A\n. */
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Sniff an image buffer: `format` is 'ktx2' | 'png' | 'jpeg' | 'webp' | 'unknown'. KTX2 also
 * yields width / height from the fixed header (sharp cannot open it; readers that need the
 * mip chain use three's ktx-parse), the other formats leave the dimensions to sharp.
 */
export function sniffImage (buf) {
  if (buf.length >= 44 && buf.subarray(0, 12).equals(KTX2_MAGIC)) {
    return { format: 'ktx2', width: buf.readUInt32LE(20), height: buf.readUInt32LE(24), levels: buf.readUInt32LE(36) }
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return { format: 'png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'jpeg' }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp' }
  return { format: 'unknown' }
}

/** Split a GLB into its JSON object and BIN chunk; `bin` is undefined for a .gltf. */
export function readGltfJson (file) {
  const buf = readFileSync(file)
  if (buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67) {
    // GLB: header (12) + chunks. Chunk 0 is JSON, chunk 1 (if present) is BIN.
    let off = 12
    const chunks = []
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off)
      const type = buf.readUInt32LE(off + 4)
      chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) })
      off += 8 + len
    }
    return { json: JSON.parse(chunks[0].data.toString('utf8')), bin: chunks.find(c => c.type === 0x004e4942)?.data, glb: true }
  }
  return { json: JSON.parse(buf.toString('utf8')), bin: undefined, glb: false }
}

/**
 * Resolve every `buffers[i]` of a parsed glTF to a Buffer (BIN chunk, data URI or external file).
 * Only buffer 0 may be the GLB BIN chunk; a later uri-less buffer is an EXT_meshopt_compression
 * fallback buffer whose bytes do not exist (undefined).
 */
export function gltfBuffers (json, bin, dir) {
  return (json.buffers ?? []).map((b, i) => {
    if (b.uri == null) return i === 0 ? bin : undefined
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64')
    return readFileSync(join(dir, decodeURIComponent(b.uri)))
  })
}

/**
 * Return the images referenced by a .glb or .gltf (embedded buffer views, data URIs and external
 * files) as `{ data, name, mimeType, format }`, in `json.images` order. `format` comes from the
 * bytes, not the declared mimeType, so a KTX2 texture (KHR_texture_basisu) is recognised even
 * when the writer forgot the mimeType. Used to measure textures before and after packing.
 */
export function gltfImages (file) {
  const { json, bin } = readGltfJson(file)
  const dir = dirname(file)
  const buffers = gltfBuffers(json, bin, dir)
  return (json.images ?? []).map((img) => {
    let data
    if (img.bufferView != null) {
      const bv = json.bufferViews[img.bufferView]
      const b = buffers[bv.buffer]
      data = b.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
    } else if (img.uri?.startsWith('data:')) {
      data = Buffer.from(img.uri.slice(img.uri.indexOf(',') + 1), 'base64')
    } else {
      data = readFileSync(join(dir, decodeURIComponent(img.uri)))
    }
    return { data, name: img.name ?? (img.uri ? basename(decodeURIComponent(img.uri)) : ''), mimeType: img.mimeType, ...sniffImage(data) }
  })
}

export const fileBytes = (file) => statSync(file).size

/**
 * `zip` / `entry` matcher: a RegExp, a glob-like string (`*`, `?`) or an exact name, tested on
 * the basename case-insensitively. Sketchfab names the zip after the model title, which the
 * user does not always keep, so most entries use a glob.
 */
export function nameMatcher (pat) {
  if (pat instanceof RegExp) return (name) => pat.test(name)
  if (/[*?]/.test(pat)) {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return (name) => re.test(name)
  }
  return (name) => name.toLowerCase() === pat.toLowerCase()
}

/** First file directly under the first misc root that matches `pat`; `null` when nothing does. */
export function findDrop (roots, pat) {
  const match = nameMatcher(pat)
  for (const r of roots) {
    const root = join(MISC, r)
    if (!existsSync(root)) continue
    const hit = readdirSync(root, { withFileTypes: true }).filter(e => e.isFile() && match(e.name)).map(e => e.name).sort()[0]
    if (hit) return { root, file: join(root, hit) }
  }
  return null
}
