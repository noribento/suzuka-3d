/**
 * A stub asset registry for the Node smokes (I フェーズ I0-a, dev-only): the manifest's GLBs
 * behind the smallest registry the builders accept, so a pack path (road-furniture's plates,
 * the infield's props, the ops figures) can be exercised without a browser. Models load
 * through GLTFLoader + meshopt with every texture an empty stand-in — the geometry is what a
 * smoke measures — and every texture query answers null, so the other builders keep their
 * procedural maps. Cut out of furniture-smoke.mjs (R フェーズ Phase 3), which now imports it.
 *
 *   const reg = await stubRegistry(['model/road/jp_traffic_assets', 'model/props/utility_box_02'])
 *   const reg = await stubRegistry(/^model\/(crowd|pit)\//)
 *
 * `keys` is a list of manifest keys or a RegExp over them; a listed key that is not in the
 * manifest is noted and skipped. `buildSceneWith(tier, reg)` builds the environment with the
 * registry the way app-runtime's `buildScene` builds it without one.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, THREE } from './app-runtime.mjs'

/**
 * @param {string[] | RegExp} keys manifest keys to load, or a RegExp over every manifest key
 * @returns {Promise<object>} the registry (`has / entry / keys / texture / model / bytes / dispose / markAllDirty / progress`) plus `loaded`
 */
export async function stubRegistry(keys) {
  const { GLTFLoader } = await import(path.join(ROOT, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js'))
  const { MeshoptDecoder } = await import(path.join(ROOT, 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'))
  globalThis.self ??= globalThis
  globalThis.URL.createObjectURL ??= () => 'blob:stub'
  globalThis.URL.revokeObjectURL ??= () => {}
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/assets-manifest.json'), 'utf8'))
  const stubTex = { load: (url, onLoad) => { const t = new THREE.Texture(); onLoad(t); return t }, detectSupport() { return this }, setPath() { return this }, setCrossOrigin() { return this }, setRequestHeader() { return this }, setWithCredentials() { return this } }
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  loader.setKTX2Loader(stubTex)
  loader.manager.getHandler = () => stubTex
  loader.textureLoader = stubTex
  const wanted = keys instanceof RegExp ? Object.keys(manifest.assets).filter((k) => keys.test(k)) : keys
  const models = new Map()
  for (const key of wanted) {
    const a = manifest.assets[key]
    if (!a) { console.log(`  note: ${key} is not in the manifest`); continue }
    if (!/\.(glb|gltf)$/.test(a.path)) continue
    const buf = readFileSync(path.join(ROOT, 'public', a.path))
    const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej))
    const primitives = []
    gltf.scene.traverse((o) => { if (o.isMesh) primitives.push({ geometry: o.geometry, material: o.material }) })
    models.set(key, { scene: gltf.scene, primitives })
  }
  return {
    has: (k) => models.has(k), entry: () => null, keys: () => [...models.keys()], texture: () => null,
    model: (k) => models.get(k) ?? null, bytes: () => 0, dispose() {}, markAllDirty() {}, progress: { value: 1 },
    loaded: [...models.keys()],
  }
}

/** `buildScene` with a registry (app-runtime's builds with none): the environment, drained. */
export async function buildSceneWith(tier, reg) {
  const { Track } = await import(path.join(ROOT, 'app/sim/track.ts'))
  const suz = await import(path.join(ROOT, 'app/data/suzuka.ts'))
  const envMod = await import(path.join(ROOT, 'app/three/environment.ts'))
  const quality = await import(path.join(ROOT, 'app/three/quality.ts'))
  const track = new Track(suz.CIRCUIT)
  const q = quality.QUALITY[tier]
  const env = envMod.buildEnvironment(track, q, 7, reg)
  env.farField.drain()
  return { track, env, terrain: env.terrain, ground: env.ground, quality: q }
}
