#!/usr/bin/env node
/**
 * Invariants of the bounded-sun model (app/three/sun-model.ts), checked from Node:
 *
 *   node --import ./scripts/ts-hooks.mjs scripts/sun-model-check.mjs
 *
 * The contract kneed sky < BLOOM_THRESHOLD < emitters < SUN_PROBE_MIN < disc, the knee's
 * shape and robustness (identity, monotonic, bounded for Inf/NaN, hue-preserving), the
 * exposure adaptation staying finite and in range for any input, the frame weighting's edge
 * cases, the Sky.js anchor strings the shader patch relies on, and the GLSL constants being
 * the TS numbers. Exits non-zero on the first failure.
 */
import './ts-hooks.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const sun = await import('../app/three/sun-model.ts')
const em = await import('../app/three/emissive.ts')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKY_JS = path.join(ROOT, 'node_modules/three/examples/jsm/objects/Sky.js')

let checks = 0
const ok = (cond, msg) => {
  checks++
  assert.ok(cond, msg)
}
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`)

// --- ordering contract ------------------------------------------------------------------------
ok(sun.SKY_MAX < em.BLOOM_THRESHOLD, `SKY_MAX ${sun.SKY_MAX} must stay below BLOOM_THRESHOLD ${em.BLOOM_THRESHOLD}`)
ok(sun.SKY_KNEE < sun.SKY_MAX, 'SKY_KNEE < SKY_MAX')

const E = em.EMISSIVE
const disc = []
const discIntensity = em.brakeDiscEmissive(1250, disc)
const emitters = {
  startLamp: em.luminance(E.startLamp.color, E.startLamp.on),
  brakeDisc1250C: em.luminanceLinear(disc[0], disc[1], disc[2], discIntensity),
  sparkHeatMax: em.luminanceLinear(...E.spark.rgb, E.spark.heatMax),
  garageStrip: em.luminance(E.garageStrip.color, E.garageStrip.intensity),
  rainLightFlashHi: em.luminance(E.rainLight.color, E.rainLight.flashHi),
}
const maxEmitter = Math.max(...Object.values(emitters))
const minEmitter = Math.min(...Object.values(emitters))
const discLow = sun.luminance709(...sun.discColour(0)) * sun.SUN_DISC_RADIANCE
const discHigh = sun.luminance709(...sun.discColour(1)) * sun.SUN_DISC_RADIANCE
ok(maxEmitter < sun.SUN_PROBE_MIN, `every emitter (max ${maxEmitter.toFixed(2)}) must stay below SUN_PROBE_MIN ${sun.SUN_PROBE_MIN}`)
ok(sun.SUN_PROBE_MIN < discLow, `SUN_PROBE_MIN ${sun.SUN_PROBE_MIN} must stay below the sunset disc ${discLow.toFixed(2)}`)
ok(em.BLOOM_THRESHOLD < maxEmitter, 'the brightest emitter still blooms')

// --- bloom knee -------------------------------------------------------------------------------
// The high pass ramps over [BLOOM_THRESHOLD, BLOOM_THRESHOLD + BLOOM_KNEE]. The knee must not be
// so wide that an emitter documented as glowing ends up with a token halo: every one of them has
// to clear at least half weight. (Full weight would need 7.0 and the start lamps sit at 6.34.)
const bloomWeight = (L) => {
  const t = Math.min(1, Math.max(0, (L - em.BLOOM_THRESHOLD) / em.BLOOM_KNEE))
  return t * t * (3 - 2 * t)
}
ok(em.BLOOM_KNEE > 0, 'BLOOM_KNEE is a real ramp, not three\'s 0.01 step')
ok(sun.SKY_MAX < em.BLOOM_THRESHOLD, 'the knee widens upward only: the sky still never blooms')
for (const [k, v] of Object.entries(emitters)) {
  ok(bloomWeight(v) >= 0.5, `emitter ${k} (luminance ${v.toFixed(2)}) must keep at least half its halo under the knee: weight ${bloomWeight(v).toFixed(3)}`)
}
ok(minEmitter > em.BLOOM_THRESHOLD, `the dimmest emitter (${minEmitter.toFixed(2)}) still clears the threshold`)

// --- firefly clamp ----------------------------------------------------------------------------
// HDR_MAX clamps the sanitized scene copy PER CHANNEL, so the bound to clear is the brightest
// channel the model can write: the disc (added after the knee) on top of a kneed sky whose
// luminance is capped at SKY_MAX, i.e. at most SKY_MAX / 0.0722 in a pure-blue channel.
const discMaxChannel = sun.SUN_DISC_RADIANCE * Math.max(...sun.discColour(0), ...sun.discColour(1))
const skyMaxChannel = sun.SKY_MAX / 0.0722
ok(discMaxChannel + skyMaxChannel < sun.HDR_MAX, `the brightest channel the model writes (${(discMaxChannel + skyMaxChannel).toFixed(1)}) must survive the HDR_MAX ${sun.HDR_MAX} clamp`)
ok(maxEmitter < sun.HDR_MAX, 'no emitter is clipped by the firefly clamp')

// --- knee -------------------------------------------------------------------------------------
for (const L of [0, 0.1, 0.5, 1, 1.25, sun.SKY_KNEE]) near(sun.kneeLuminance(L), L, 1e-12, `identity below the knee at ${L}`)
let prev = -1
for (let i = 0; i <= 600; i++) {
  // 0 … 3 in steps of 0.01, then 3 · 10^0.1 … 3 · 10^30 (a monotone sweep)
  const L = i <= 300 ? i / 100 : 3 * 10 ** ((i - 300) / 10)
  const k = sun.kneeLuminance(L)
  ok(Number.isFinite(k) && k <= sun.SKY_MAX + 1e-9, `knee bounded at ${L}: ${k}`)
  ok(k >= prev - 1e-12, `knee monotonic at ${L}: ${k} < ${prev}`)
  prev = k
}
// C1 at the knee: unit slope on both sides
near((sun.kneeLuminance(sun.SKY_KNEE + 1e-6) - sun.kneeLuminance(sun.SKY_KNEE)) / 1e-6, 1, 1e-3, 'unit slope just above the knee')
for (const L of [1e30, 1e300, Infinity, NaN, -Infinity]) {
  const k = sun.kneeLuminance(L)
  ok(Number.isFinite(k) && k <= sun.SKY_MAX, `knee finite and bounded for ${L}: ${k}`)
}
for (const c of [[10, 4, 1], [1e6, 2e6, 5e5], [Infinity, 1, 1], [NaN, 0.5, 0.5], [3, 3, 3], [0.2, 0.3, 0.8]]) {
  const k = sun.skyKnee(c)
  ok(k.every(Number.isFinite), `skyKnee finite for ${c}`)
  ok(sun.luminance709(...k) <= sun.SKY_MAX + 1e-9, `skyKnee luminance bounded for ${c}`)
  if (c.every(Number.isFinite) && sun.luminance709(...c) > sun.SKY_KNEE) {
    near(k[0] / k[1], c[0] / c[1], 1e-9, `hue preserved r/g for ${c}`)
    near(k[2] / k[1], c[2] / c[1], 1e-9, `hue preserved b/g for ${c}`)
  }
}
near(sun.luminance709(...sun.skyKnee([1e9, 1e9, 1e9])), sun.SKY_MAX, 1e-6, 'a huge input reaches the asymptote')

// --- exposure -----------------------------------------------------------------------------------
const wild = [NaN, Infinity, -Infinity, -1, 0, 1e9, 0.3]
for (const ev of wild) for (const target of wild) for (const dt of wild) {
  const out = sun.adaptEv(ev, target, dt)
  ok(Number.isFinite(out) && out >= sun.EV_MIN && out <= sun.EV_MAX, `adaptEv(${ev}, ${target}, ${dt}) = ${out}`)
  const v = sun.smoothVis(ev, target, dt)
  ok(Number.isFinite(v) && v >= 0 && v <= 1, `smoothVis(${ev}, ${target}, ${dt}) = ${v}`)
}
// step responses: 1 - e^-1 after one time constant, darkening faster than brightening
near(sun.adaptEv(0, -1, sun.TAU_DARKEN), -(1 - Math.exp(-1)), 1e-9, 'darkening step after one tau')
near(sun.adaptEv(-1, 0, sun.TAU_BRIGHTEN), -Math.exp(-1), 1e-9, 'brightening step after one tau')
ok(Math.abs(sun.adaptEv(0, -1, 0.1)) > Math.abs(sun.adaptEv(-1, 0, 0.1) + 1), 'darkening is faster than brightening')
// (dt is clamped to 1 s inside adaptEv, so the 1.5 s tv iris is probed at half a tau)
const tv = sun.adaptTau('tv')
near(sun.adaptEv(0, -1, tv.darken / 2, tv.darken, tv.brighten), -(1 - Math.exp(-0.5)), 1e-9, 'tv iris after half a (slower) tau')
ok(tv.darken > sun.TAU_DARKEN && sun.adaptTau('onboard').darken === sun.TAU_DARKEN && sun.adaptTau(null).brighten === sun.TAU_BRIGHTEN, 'tau table')
// dt is clamped to 1 s, so a huge dt is one 1 s step: 1 - e^-4 of the way (a tab switch does not snap)
near(sun.adaptEv(0.15, -1, 1e9), 0.15 + (-1 - 0.15) * (1 - Math.exp(-1 / sun.TAU_DARKEN)), 1e-9, 'a huge dt is one clamped step')
near(sun.adaptEv(0, -5, 1e9), sun.EV_MIN + (0 - sun.EV_MIN) * Math.exp(-1 / sun.TAU_DARKEN), 1e-9, 'an out-of-range target is clamped first')
ok(sun.adaptEv(0, 0, 0.016) === 0, 'no drift at the target')
for (const w of [0, 0.5, 1, NaN]) for (const v of [0, 0.5, 1, NaN]) for (const warm of [0, 1, NaN]) {
  const t = sun.glareTargetEv(w, v, warm)
  ok(Number.isFinite(t) && t <= 0 && t >= sun.EV_MIN, `glareTargetEv(${w}, ${v}, ${warm}) = ${t}`)
}
near(sun.glareTargetEv(1, 1, 1), -sun.GLARE_EV, 1e-12, 'midday, centred, visible')
near(sun.glareTargetEv(1, 1, 0), -(sun.GLARE_EV + sun.GLARE_EV_LOW_SUN), 1e-12, 'sunset, centred, visible')
ok(sun.glareTargetEv(1, 0, 0) === 0, 'an occluded sun does not stop the camera down')
near(sun.baseExposure(1), 0.92, 1e-12, 'base exposure at midday')
near(sun.baseExposure(0), 0.92 * 0.82, 1e-12, 'base exposure at sunset')
for (const ev of wild) ok(Number.isFinite(sun.flareScale(ev)) && sun.flareScale(ev) >= sun.FLARE_SCALE_MIN && sun.flareScale(ev) <= 1.05, `flareScale(${ev})`)

// --- frame weighting --------------------------------------------------------------------------
ok(sun.sunFrameWeight(0, 0, 1) === 1, 'sun centred, camera facing it')
ok(sun.sunFrameWeight(0, 0, 0) === 0 && sun.sunFrameWeight(0, 0, -1) === 0, 'sun behind the camera')
ok(sun.sunFrameWeight(1.3, 0, 1) === 0 && sun.sunFrameWeight(0, -1.5, 1) === 0, 'sun outside the frame box')
ok(sun.sunFrameWeight(NaN, 0, 1) === 0 && sun.sunFrameWeight(0, 0, NaN) === 0, 'NaN projection counts as out of frame')
near(sun.sunFrameWeight(0.5, 0, sun.SUN_CENTRE_COS / 2), 0.5, 1e-12, 'centre weighting at half the cos range')
const wIn = sun.sunFrameWeight(0.9, 0, 1), wEdge = sun.sunFrameWeight(1.1, 0, 1)
ok(wIn === 1 && wEdge > 0 && wEdge < 1, `fade between 0.9 and 1.3: ${wIn}, ${wEdge}`)
ok(sun.sunFade(0.5) === 1 && sun.sunFade(sun.FLARE_BOX) === 0 && sun.sunNear(sun.FLARE_BOX) === 1 && sun.sunNear(sun.VEIL_FAR) === 0 && sun.sunNear(NaN) === 0, 'flare box / veil persistence')
ok(sun.elevationWeight(0.03) > 0 && sun.elevationWeight(0.03) < 1 && sun.elevationWeight(0.5) === 1 && sun.elevationWeight(0.01) === 0, 'elevation term')
for (const mode of ['overview', 'heli', 'chase', 'onboard', 'tv', 'director']) {
  const g = sun.FLARE_GAIN[mode]
  ok(g && [g.streak, g.ghost, g.veil].every((x) => x >= 0 && x <= 1), `FLARE_GAIN has ${mode}`)
}
ok(sun.FLARE_GAIN.overview.veil === 0 && sun.FLARE_GAIN.onboard.streak === 1, 'flare gain extremes')
const dl = sun.discColour(0), dh = sun.discColour(1), dn = sun.discColour(NaN)
ok(dl[1] < dh[1] && dn[1] === dh[1] && sun.aureolePeak(0) > sun.aureolePeak(1), 'disc colour / aureole warm up towards the horizon')

// --- Sky.js anchors ------------------------------------------------------------------------------
const skySrc = readFileSync(SKY_JS, 'utf8')
ok(skySrc.includes(sun.SKY_FRAG_ANCHOR), `Sky.js no longer contains '${sun.SKY_FRAG_ANCHOR}'`)
ok(skySrc.includes(sun.SKY_MAIN_ANCHOR), `Sky.js no longer contains '${sun.SKY_MAIN_ANCHOR}'`)
ok(skySrc.includes('gl_Position.z = gl_Position.w;'), 'Sky.js vertex anchor for the reversed-depth patch')
ok(skySrc.includes('vec3 direction = normalize( vWorldPosition - cameraPosition );') && skySrc.includes('varying vec3 vSunDirection;'), 'Sky.js still exposes direction / vSunDirection')
// the fragment shader is the last template literal (the constructor also says `fragmentShader:`):
// exactly one main() and one write in it
const fragStart = skySrc.lastIndexOf('fragmentShader:')
ok(fragStart > 0, 'Sky.js fragmentShader found')
const frag = skySrc.slice(fragStart)
ok(frag.split(sun.SKY_MAIN_ANCHOR).length === 2, 'one main() in the fragment shader')
ok(frag.split(sun.SKY_FRAG_ANCHOR).length === 2, 'one gl_FragColor write in the fragment shader')
ok(frag.indexOf('* 0.04') < frag.indexOf(sun.SKY_FRAG_ANCHOR), 'the disc is added after the * 0.04 scaling (same units)')

// --- GLSL constants = TS exports ---------------------------------------------------------------
let glslConsts = 0
for (const src of [sun.SUN_GLSL_PARS, sun.SUN_GLSL_FLARE_PARS]) {
  for (const m of src.matchAll(/const float (\w+) = ([^;]+);/g)) {
    const [, name, value] = m
    ok(typeof sun[name] === 'number', `GLSL constant ${name} has no TS export`)
    ok(Number(value) === sun[name], `GLSL ${name} = ${value} differs from TS ${sun[name]}`)
    ok(/[.e]/.test(value), `GLSL ${name} literal '${value}' must be a float literal`)
    glslConsts++
  }
}
ok(glslConsts >= 10, `expected the GLSL constants to be generated (${glslConsts})`)
for (const g of sun.GHOSTS) ok(sun.SUN_GLSL_FLARE.includes(sun.glslFloat(g.t)) && sun.SUN_GLSL_FLARE.includes(sun.glslFloat(g.size)), `ghost t ${g.t} in the GLSL`)
const skyCode = (sun.SUN_GLSL_PARS + sun.SUN_GLSL_SUN).replace(/\/\/.*$/gm, '') // comments may mention isnan; code may not (SwiftShader)
ok(sun.SUN_GLSL_SUN.includes(sun.SKY_FRAG_ANCHOR) && skyCode.includes('skyKnee( texColor )') && !skyCode.includes('isnan'), 'Sky patch shape (knee, write, no isnan)')
ok(sun.glslFloat(3) === '3.0' && sun.glslFloat(1.5) === '1.5' && sun.glslFloat(1e-7) === '1e-7', 'glslFloat')

console.log(`sun-model: ${checks} checks passed`)
console.log(`  kneed sky ≤ ${sun.SKY_MAX} < bloom ${em.BLOOM_THRESHOLD} < emitters ≤ ${maxEmitter.toFixed(2)} < probe ${sun.SUN_PROBE_MIN} < disc ${discLow.toFixed(1)} (sunset) … ${discHigh.toFixed(1)} (midday)`)
console.log(`  bloom ramps over ${em.BLOOM_THRESHOLD} … ${em.BLOOM_THRESHOLD + em.BLOOM_KNEE}, firefly clamp HDR_MAX ${sun.HDR_MAX} (model writes at most ${(discMaxChannel + skyMaxChannel).toFixed(1)} in a channel)`)
for (const [k, v] of Object.entries(emitters)) console.log(`  ${k.padEnd(18)} ${v.toFixed(2)}  halo ${(bloomWeight(v) * 100).toFixed(0)}%`)
