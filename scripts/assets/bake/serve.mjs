/**
 * The bake harness the atlas scripts share (bake-tree-atlas.mjs; bake-car-atlas.mjs moves onto
 * it in Phase 5): a static server over the repo root that transpiles app/**\/*.ts on the fly —
 * the TypeScript compiler, the way scripts/audit/app-runtime.mjs feeds Node — so a bake page
 * imports the SAME data tables and helpers the runtime uses (`/app/data/tree-species.ts`,
 * `/app/three/model-proto.ts`), plus headless Chromium through Playwright (SwiftShader flags as
 * playwright.config.ts: no GPU is needed for a few hundred 256 px cells) that opens the page and
 * hands it to the caller.
 *
 *   import { serveAndBake } from './bake/serve.mjs'
 *   await serveAndBake({
 *     page: 'scripts/assets/bake/tree-impostor.html', query: { cell: 256 }, out: 'misc/dl/tex/tree_atlas',
 *     run: async (page) => { const r = await page.evaluate(() => window.bake('colour')); ... },
 *   })
 *
 * What the server serves: everything under the repo root by path (`/node_modules/three/...`,
 * `/public/assets/models/*.glb`, `/public/basis/*` for the KTX2 transcoder,
 * `/public/assets-manifest.json`), `.ts` transpiled to ES modules, and an extension-less
 * specifier resolved to its `.ts` (the app's relative imports carry no extension). Import maps
 * in the page resolve 'three', 'three/addons/' and '~/'.
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

export const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const require = createRequire(join(ROOT, 'package.json'))
const ts = require('typescript')

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2',
}

/** the Chromium flags of playwright.config.ts: software GL, so the bake runs on any machine */
export const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

/** Resolve a request path to a file under ROOT: the file itself, or `<path>.ts` for an extension-less app import. */
function resolveFile (pathname) {
  const p = normalize(decodeURIComponent(pathname))
  const f = join(ROOT, p)
  if (!f.startsWith(ROOT)) return null
  if (existsSync(f) && !statSync(f).isDirectory()) return f
  if (!extname(f) && existsSync(f + '.ts')) return f + '.ts'
  return null
}

/** Start the static + TypeScript server on `port` (127.0.0.1); returns the http.Server. */
export async function startServer (port) {
  const server = createServer((req, res) => {
    const f = resolveFile(new URL(req.url, 'http://x').pathname)
    if (!f) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' })
    if (extname(f) === '.ts') {
      // the browser needs JavaScript; strip the types and keep the ES modules as they are (the
      // page's import map resolves 'three', 'three/addons/' and '~/')
      const out = ts.transpileModule(readFileSync(f, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: false },
      })
      res.end(out.outputText)
      return
    }
    createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return server
}

/**
 * Serve the repo, open `page` (repo-relative) with `query` in headless Chromium, wait for
 * `window.bakeReady === true`, run the caller's driver with the Playwright page, then close
 * everything. `out` (a directory) is created first. Page errors and console warnings are
 * echoed; `viewport` defaults to 1024², and `timeout` (ms) bounds the ready wait.
 */
export async function serveAndBake ({ page: pagePath, query = {}, out, run, port = 3113, viewport = { width: 1024, height: 1024 }, timeout = 120000 }) {
  if (out) mkdirSync(out, { recursive: true })
  const server = await startServer(port)
  const browser = await chromium.launch({ args: CHROMIUM_ARGS })
  try {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', (e) => { console.error('[page]', e.message) })
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()) })
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    await page.goto(`http://127.0.0.1:${port}/${pagePath.replace(/^\//, '')}${qs ? `?${qs}` : ''}`)
    await page.waitForFunction(() => window.bakeReady === true, null, { timeout })
    return await run(page)
  } finally {
    await browser.close()
    server.close()
  }
}
