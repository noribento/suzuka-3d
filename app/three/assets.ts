import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { useRuntimeConfig } from '#imports'
import { groundAniso } from './textures'
import { assetsOverride, type Quality } from './quality'

/**
 * Runtime loading of the external asset pack (photo PBR tiles, tree / seat / spectator models).
 *
 * Everything the scene builders need is behind one `AssetRegistry` that answers `null` for
 * anything that did not arrive, so every consumer keeps its procedural fallback and the scene
 * always builds: the low tier (SwiftShader, the e2e suite) never even fetches the manifest, and
 * on the high tier a missing file, a stale manifest or a failed transcoder is a `console.warn`,
 * never an error and never a thrown promise. That contract matters because the e2e suite fails
 * on any console.error and the loading screen must always come down.
 *
 * The manifest (`public/assets-manifest.json`, written by scripts/assets/import-misc.mjs) is the
 * only unhashed file: it is fetched with `cache: 'no-cache'` so a redeploy is picked up, while the
 * files it points at carry a content hash in their name and are served immutable (nuxt.config).
 */

export type AssetKind = 'texture' | 'model'
export type AssetFormat = 'ktx2' | 'webp' | 'glb'
export type AssetRole = 'diff' | 'nor_gl' | 'arm' | 'opacity' | 'mask' | 'model'

export interface ManifestAsset {
  kind: AssetKind
  /** site-relative path of the hashed file, e.g. `/assets/withered_grass_diff.1a2b3c.ktx2` */
  path: string
  format: AssetFormat
  bytes: number
  width?: number
  height?: number
  /** transfer function of the pixel data: colour maps are sRGB, normal / ARM / opacity are linear */
  colorSpace?: 'srgb' | 'linear'
  role?: AssetRole
  source?: unknown
  modified?: string
}

export interface AssetManifest {
  version: number
  generated?: string
  tools?: unknown
  assets: Record<string, ManifestAsset>
}

export interface TextureOpts {
  /**
   * The texture is used on a ground surface (road, verge, gravel, terrain): it gets the ground
   * anisotropy budget (`textures.ts` groundAniso) instead of the tier's general one. Sticky: once
   * any caller asked for the ground budget the shared texture keeps it.
   */
  ground?: boolean
}

export interface LoadedModel {
  /** the glTF scene as loaded — NOT cloned; callers that need several copies clone or instance it */
  scene: THREE.Group
  /** every mesh primitive, flattened, with its authored material (multi-material meshes yield one entry per material) */
  primitives: { geometry: THREE.BufferGeometry; material: THREE.Material }[]
}

export interface AssetRegistry {
  /** true when the key is in the manifest AND it loaded */
  has(key: string): boolean
  /** manifest entry for a key (null when the pack is off or the key is unknown) — for sizes / roles */
  entry(key: string): ManifestAsset | null
  /** loaded keys, in manifest order */
  keys(): string[]
  texture(key: string, opts?: TextureOpts): THREE.Texture | null
  model(key: string): LoadedModel | null
  /** download size (manifest `bytes`) of everything that loaded */
  bytes(): number
  /** release GPU / worker resources: every texture, geometry and material, and the KTX2 worker pool */
  dispose(): void
  /** WebGL context restore: flag every loaded texture for re-upload */
  markAllDirty(): void
  /** 0..1 while `loadAssets` runs; 1 once it resolved */
  progress: { value: number }
}

const MANIFEST_URL = '/assets-manifest.json'
const TRANSCODER_PATH = '/basis/'

/**
 * Site-relative → absolute under Nuxt's `app.baseURL` ('/' unless configured). Not Vite's
 * `import.meta.env.BASE_URL`: in Nuxt that is the build-assets dir (`/_nuxt/`), where `public/`
 * files are not served.
 */
function withBase(path: string): string {
  let base = '/'
  try {
    base = useRuntimeConfig().app.baseURL || '/'
  } catch {
    /* outside the Nuxt app context (unit scripts): assume the site root */
  }
  return base.replace(/\/$/, '') + path
}

/**
 * Load the asset pack for this tier. Resolves to an EMPTY registry immediately when the tier (or
 * `?assets=0`) turns the pack off, and to a registry holding whatever arrived otherwise — never
 * rejects. `keys` restricts the load to a subset (default: every manifest entry). `onProgress`
 * receives 0..1 while the downloads run (the loading bar); the same value is on `progress`.
 */
export async function loadAssets(
  renderer: THREE.WebGLRenderer,
  q: Quality,
  keys?: string[],
  onProgress?: (p: number) => void,
): Promise<AssetRegistry> {
  const enabled = assetsOverride() ?? q.assets
  const progress = { value: 0 }
  const report = (p: number) => {
    // monotonic: the LoadingManager's item total grows as nested loads register, so a raw ratio can go backwards
    const v = Math.min(1, Math.max(progress.value, p))
    if (v === progress.value) return
    progress.value = v
    onProgress?.(v)
  }
  if (!enabled) {
    report(1)
    return emptyRegistry(progress)
  }

  const manifest = await fetchManifest()
  if (!manifest) {
    report(1)
    return emptyRegistry(progress)
  }
  const wanted = (keys ?? Object.keys(manifest.assets)).filter((k) => {
    if (manifest.assets[k]) return true
    console.warn(`[assets] '${k}' is not in the manifest`)
    return false
  })

  // one manager, one KTX2 worker pool, one glTF loader: KTX2Loader warns about multiple instances
  const manager = new THREE.LoadingManager()
  // the manager smooths the bar between whole assets, capped at the next asset boundary: its item
  // total only grows as nested loads (transcoder, glTF buffers) register, so its raw ratio runs ahead
  manager.onProgress = (_url, loaded, total) => {
    if (total > 0 && wanted.length) report(Math.min(loaded / total, (settled + 1) / wanted.length) * 0.98)
  }
  // a loader failure is reported per asset below; the manager's default onError would console.error
  manager.onError = () => {}
  const ktx2 = new KTX2Loader(manager).setTranscoderPath(withBase(TRANSCODER_PATH)).detectSupport(renderer)
  const gltf = new GLTFLoader(manager).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder)
  const imageLoader = new THREE.TextureLoader(manager)

  const textures = new Map<string, THREE.Texture>()
  const models = new Map<string, LoadedModel>()
  /** everything a `dispose` / `markAllDirty` has to reach, including textures embedded in glTF materials */
  const allTextures = new Set<THREE.Texture>()
  const failures: string[] = []
  let settled = 0

  const loadOne = async (key: string) => {
    const a = manifest.assets[key]!
    const url = withBase(a.path)
    try {
      if (a.kind === 'texture') {
        const tex = a.format === 'ktx2' ? await ktx2.loadAsync(url) : await imageLoader.loadAsync(url)
        prepareTexture(tex, a, q)
        textures.set(key, tex)
        allTextures.add(tex)
      } else {
        const g: GLTF = await gltf.loadAsync(url)
        const primitives: LoadedModel['primitives'] = []
        g.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const material of mats) {
            primitives.push({ geometry: mesh.geometry, material })
            for (const t of materialTextures(material)) allTextures.add(t)
          }
        })
        models.set(key, { scene: g.scene, primitives })
      }
    } catch (err) {
      failures.push(`${key} (${a.path}): ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      settled++
      report(wanted.length ? (settled / wanted.length) * 0.98 : 1)
    }
  }
  await Promise.all(wanted.map(loadOne))
  if (failures.length) {
    // one warning, not one per file: a missing transcoder or a stale manifest fails everything at once
    console.warn(`[assets] ${failures.length} of ${wanted.length} asset(s) unavailable, procedural fallbacks in use:\n  ${failures.join('\n  ')}`)
  }
  report(1)

  let loadedBytes = 0
  for (const k of [...textures.keys(), ...models.keys()]) loadedBytes += manifest.assets[k]?.bytes ?? 0
  const order = Object.keys(manifest.assets).filter((k) => textures.has(k) || models.has(k))

  return {
    has: (key) => textures.has(key) || models.has(key),
    entry: (key) => manifest.assets[key] ?? null,
    keys: () => order.slice(),
    texture(key, opts) {
      const tex = textures.get(key)
      if (!tex) return null
      if (opts?.ground) {
        const want = groundAniso()
        if (tex.anisotropy < want) {
          tex.anisotropy = want
          // sampler parameters are only applied on upload; a texture already on the GPU needs a re-upload
          tex.needsUpdate = true
        }
      }
      return tex
    },
    model: (key) => models.get(key) ?? null,
    bytes: () => loadedBytes,
    dispose() {
      for (const t of allTextures) t.dispose()
      for (const m of models.values()) {
        for (const p of m.primitives) {
          p.geometry.dispose()
          p.material.dispose()
        }
      }
      allTextures.clear()
      textures.clear()
      models.clear()
      order.length = 0
      loadedBytes = 0
      ktx2.dispose()
    },
    markAllDirty() {
      for (const t of allTextures) t.needsUpdate = true
    },
    progress,
  }
}

/** Manifest fetch. Any failure (offline, 404, the SPA fallback page served as HTML, bad JSON) → null + one warning. */
async function fetchManifest(): Promise<AssetManifest | null> {
  const url = withBase(MANIFEST_URL)
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as Partial<AssetManifest>
    if (!json || typeof json !== 'object' || typeof json.assets !== 'object' || json.assets === null) throw new Error('no `assets` map')
    if (json.version !== 1) throw new Error(`unsupported manifest version ${String(json.version)}`)
    return json as AssetManifest
  } catch (err) {
    console.warn(`[assets] ${url} unavailable (${err instanceof Error ? err.message : String(err)}): procedural materials only`)
    return null
  }
}

/**
 * One sampling convention for every external texture.
 *
 * - `flipY = false` everywhere. A compressed (KTX2) upload cannot be flipped, so the WebP path
 *   follows suit; the consequence for the project's hand-built UVs (authored for flipped canvas
 *   textures) is handled where the material is built — see `materials.ts` `pbrFromAssets`.
 * - colour space from the manifest, not guessed from the role: KTX2 files already carry it in
 *   their DFD and three trusts that, so the manifest and the encoder flags have to agree anyway.
 * - RepeatWrapping: every tile repeats over metres of surface.
 * - anisotropy: the tier budget; ground surfaces raise it on request (`texture(key, { ground })`).
 * - KTX2 keeps the filter / mipmap state the loader set: `generateMipmaps` is meaningless for
 *   compressed data and the mip chain is whatever the encoder wrote (see the `--check` in the
 *   import script, which insists on a full chain).
 */
function prepareTexture(tex: THREE.Texture, a: ManifestAsset, q: Quality) {
  tex.colorSpace = a.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.flipY = false
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = Math.max(1, q.anisotropy)
  tex.name = a.path
  tex.needsUpdate = true
}

/** Every texture slot a loaded glTF material can carry (MeshStandard / MeshPhysical / basic). */
function materialTextures(m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = []
  for (const v of Object.values(m as unknown as Record<string, unknown>)) {
    if (v && typeof v === 'object' && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture)
  }
  return out
}

function emptyRegistry(progress: { value: number }): AssetRegistry {
  return {
    has: () => false,
    entry: () => null,
    keys: () => [],
    texture: () => null,
    model: () => null,
    bytes: () => 0,
    dispose() {},
    markAllDirty() {},
    progress,
  }
}
