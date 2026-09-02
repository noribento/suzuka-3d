/**
 * Module resolution hooks so the simulation sources under app/ can run in plain Node
 * (Node ≥ 22.18 strips TypeScript types natively; this only maps the Nuxt `~/` alias and
 * adds the `.ts` extension to extension-less relative imports).
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app') + path.sep

function withTs(base) {
  if (existsSync(base + '.ts')) return base + '.ts'
  if (existsSync(path.join(base, 'index.ts'))) return path.join(base, 'index.ts')
  return null
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('~/')) {
      const file = withTs(APP + specifier.slice(2)) ?? APP + specifier.slice(2)
      return { url: pathToFileURL(file).href, shortCircuit: true }
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/.test(specifier) && context.parentURL?.startsWith('file:')) {
      const file = withTs(fileURLToPath(new URL(specifier, context.parentURL)))
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
