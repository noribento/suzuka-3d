/**
 * Run the app's scene builders in plain Node, so the surface audit can measure the geometry that
 * is actually built instead of guessing from the tables.
 *
 * Two things stop `scripts/ts-hooks.mjs` alone from getting there:
 *  - Node's type-stripping refuses TypeScript *parameter properties*, and `environment.ts` (the
 *    Terrain) and `boxes.ts` both use them. So `.ts` is transpiled with the TypeScript compiler
 *    instead of stripped. This is a `load` hook on top of ts-hooks' `resolve` hook, and it is
 *    opt-in: scripts that only read the data tables keep the cheaper native path.
 *  - the texture generators reach for a 2D canvas at module scope. A minimal stub is enough —
 *    the audit measures positions, never pixels.
 *
 *   import { buildScene } from './app-runtime.mjs'
 *   const { track, terrain, ground, scene } = await buildScene()
 */
import { registerHooks, createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import '../ts-hooks.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'package.json'))
const ts = require('typescript')

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.ts') && url.startsWith('file:')) {
      const src = readFileSync(fileURLToPath(url), 'utf8')
      const out = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: false },
      })
      return { format: 'module', shortCircuit: true, source: out.outputText }
    }
    return next(url, context)
  },
})

// --- the smallest DOM the texture generators need ---------------------------------------------
const ctx2d = (canvas) => new Proxy({
  canvas, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
  globalCompositeOperation: 'source-over', textAlign: '', textBaseline: '', lineCap: '', lineJoin: '', filter: '',
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData: () => {},
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null,
}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true },
})

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => {
      const cv = { width: 1, height: 1, tagName: tag, style: {}, getContext: () => ctx2d(cv), toDataURL: () => 'data:,' }
      return cv
    },
  }
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
}
if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })

export const THREE = await import(path.join(ROOT, 'node_modules/three/build/three.module.js'))

/**
 * Build the same scene graph the app builds, in the same order as
 * `app/components/RaceViewport.client.vue`, and settle the terrain.
 *
 * @param {{ tier?: 'high' | 'low', settle?: boolean }} opts — `settle: false` leaves the terrain
 *   unclamped so a probe can compare clamp settings
 */
export async function buildScene({ tier = 'high', settle = true } = {}) {
  const { Track } = await import(path.join(ROOT, 'app/sim/track.ts'))
  const suz = await import(path.join(ROOT, 'app/data/suzuka.ts'))
  const envMod = await import(path.join(ROOT, 'app/three/environment.ts'))
  const tmMod = await import(path.join(ROOT, 'app/three/track-mesh.ts'))
  const quality = await import(path.join(ROOT, 'app/three/quality.ts'))
  const track = new Track(suz.CIRCUIT)
  const q = quality.QUALITY[tier]
  const env = envMod.buildEnvironment(track, q, 7, null)
  const trackMeshes = tmMod.buildTrackMeshes(track, env.terrain, env.ground)
  // the same order as RaceViewport: everything that samples the ground is built first, then the
  // clamp runs. The painted markings matter to the audit — they are the layer most likely to end
  // up buried under the sheet they belong to.
  const linesMod = await import(path.join(ROOT, 'app/three/lines.ts'))
  const whiteLines = linesMod.buildLines(track, env.ground, trackMeshes.surfaceLiftAt)
  if (settle) env.terrain.settle()
  const root = new THREE.Group()
  root.add(env.group, trackMeshes.group, whiteLines)
  return { track, env, terrain: env.terrain, ground: env.ground, trackMeshes, whiteLines, root, quality: q }
}
