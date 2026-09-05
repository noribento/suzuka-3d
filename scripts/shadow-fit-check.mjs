#!/usr/bin/env node
/**
 * Invariants of the cascade fit (app/three/shadow-fit.ts), checked from Node:
 *
 *   node --import ./scripts/ts-hooks.mjs scripts/shadow-fit-check.mjs
 *
 * This drives the REAL three CSM with the same options scene.ts passes it, over the camera
 * mode / subject distance matrix the game actually produces, and asserts that the cascade the
 * subject lands in resolves a car's shadow. It exists because the trap here is invisible from
 * the split fractions alone: CSM._updateShadowBounds sizes each cascade as a square whose side
 * is the frustum's longest DIAGONAL, so for a long lens a cascade is only as sharp as it is
 * thin, and a subject at the far end of cascade 0 (which always starts at camera.near) is
 * rendered at the resolution of the whole near field.
 *
 * Also checks the FOV quantiser (monotone, never under-covers, bounded step) and the
 * elevation-dependent penumbra. Exits non-zero on the first failure.
 */
import './ts-hooks.mjs'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CSM } from 'three/addons/csm/CSM.js'

const fit = await import('../app/three/shadow-fit.ts')
const { QUALITY } = await import('../app/three/quality.ts')

let checks = 0
const ok = (cond, msg) => {
  checks++
  assert.ok(cond, msg)
}

/** Per-mode lens and near plane, from app/three/cameras.ts. */
const MODES = [
  { name: 'onboard', fov: 75, near: 0.2, d: 1.4 },
  { name: 'chase', fov: 55, near: 0.5, d: 11.5 },
  { name: 'heli', fov: 38, near: 2, d: 95 },
  { name: 'tv 40°', fov: 40, near: 0.5, d: 16 },
  { name: 'tv 8°', fov: 8, near: 0.5, d: 150 },
  { name: 'tv 2°', fov: 2, near: 0.5, d: 400 },
  { name: 'tv 2° far', fov: 2, near: 0.5, d: 630 },
]
const ASPECT = 16 / 9

/** The split this replaced: the subject sat at the far end of cascade 0, which starts at near. */
function legacySplits(d, maxFar) {
  return { s0: Math.min(0.5, (d + 25) / maxFar), s1: Math.min(0.85, (d + 150) / maxFar) }
}

/** Cascade extents three would produce, in metres per shadow texel. */
function texels(tier, fov, near, d, splitFn = fit.followSplits) {
  const q = QUALITY[tier]
  const maxFar = q.followMaxFar
  const { s0, s1 } = splitFn(d, maxFar, q.cascades)
  const camera = new THREE.PerspectiveCamera(fit.quantFov(fov), ASPECT, near, 20000)
  const csm = new CSM({
    camera,
    parent: new THREE.Object3D(),
    cascades: q.cascades,
    maxFar,
    mode: 'custom',
    customSplitsCallback: (cascades, _near, _far, breaks) => {
      breaks.length = 0
      if (cascades >= 3) breaks.push(s0, s1, 1)
      else if (cascades === 2) breaks.push(s1, 1)
      else breaks.push(1)
    },
    shadowMapSize: q.shadowMapSize,
    lightDirection: new THREE.Vector3(0, -1, 0),
    lightMargin: 500,
  })
  csm.fade = true
  csm.updateFrustums()
  const out = csm.lights.map((l) => (l.shadow.camera.right - l.shadow.camera.left) / q.shadowMapSize)
  csm.dispose()
  // which cascade holds the subject: the first whose far break is past it
  const breaks = q.cascades >= 3 ? [s0, s1, 1] : [s1, 1]
  const idx = breaks.findIndex((b) => d <= b * maxFar)
  return { texel: out, subject: idx < 0 ? out.length - 1 : idx, s0, s1 }
}

// --- the subject's cascade must resolve a car -------------------------------------------------
// A 2026 car is 1.9 m wide, so the bar is how many shadow texels lie across it. An absolute
// metres-per-texel bound would be the wrong test: the heli's 38° lens is width-dominated, not
// depth-dominated, so its cascade is genuinely wide — but the car is also small on screen there.
const CAR_WIDTH_M = 1.9
const MIN_TEXELS_ACROSS_CAR = 25
const rows = []
for (const m of MODES) {
  const { texel, subject, s0, s1 } = texels('high', m.fov, m.near, m.d)
  const legacy = texels('high', m.fov, m.near, m.d, (d, maxFar) => legacySplits(d, maxFar))
  const across = CAR_WIDTH_M / texel[subject]
  rows.push({ mode: m.name, d: m.d, c: subject, texel: texel[subject], all: texel, s0, s1, was: legacy.texel[legacy.subject] })
  ok(across >= MIN_TEXELS_ACROSS_CAR, `high ${m.name} at ${m.d} m: only ${across.toFixed(0)} shadow texels across the car (cascade ${subject}, ${(texel[subject] * 100).toFixed(1)} cm/texel)`)
  ok(subject <= 1, `high ${m.name}: the subject must be bracketed by cascade 0 or 1, not left in the background cascade ${subject}`)
  // the whole point of the bracket: never worse than the split it replaced
  ok(texel[subject] <= legacy.texel[legacy.subject] + 1e-9, `high ${m.name}: the bracket must not be coarser than the old fit (${(texel[subject] * 100).toFixed(1)} vs ${(legacy.texel[legacy.subject] * 100).toFixed(1)} cm)`)
}
// the long lens is the shot the bracket exists for
const tv2 = texels('high', 2, 0.5, 400)
const tv2Legacy = texels('high', 2, 0.5, 400, (d, maxFar) => legacySplits(d, maxFar))
ok(tv2Legacy.texel[tv2Legacy.subject] / tv2.texel[tv2.subject] > 4, 'the 2° tv shot must gain at least 4× shadow resolution')
// the low tier keeps the wide split on purpose (two cascades cannot spare one for a slice)
for (const m of MODES) {
  const { texel, subject } = texels('low', m.fov, m.near, m.d)
  ok(Number.isFinite(texel[subject]) && texel[subject] > 0, `low ${m.name}: finite cascade extent`)
}

// --- splits are well formed --------------------------------------------------------------------
for (const cascades of [2, 3]) {
  for (let d = 1; d <= 900; d += 3) {
    const { s0, s1, bracketW } = fit.followSplits(d, 900, cascades)
    ok(s0 > 0 && s0 < s1 && s1 <= 0.9 + 1e-9, `splits ordered at d=${d}, cascades=${cascades}: ${s0} ${s1}`)
    // Past 0.9 * maxFar the slice cannot extend any further without collapsing the background
    // cascade, so the subject falls into it — which costs nothing, because that is already well
    // past casterGateLod1 (400 m): cars out there cast a contact blob, not a shadow map.
    if (d > 0.9 * 900) continue
    if (cascades >= 3) {
      ok(bracketW >= 10, `bracket never degenerates at d=${d}`)
      // The subject must be covered by cascade 0 or 1 — never left to the background cascade.
      // Very close subjects fall in cascade 0 because s0 clamps at 0.004: that is correct, and
      // it is what the onboard shot (d ≈ 1.4 m) relies on.
      const hi = s1 * 900
      ok(d <= hi + 1e-6, `subject ${d} must be covered by cascade 0 or 1 (slice ends at ${hi.toFixed(1)})`)
      // Walk the subject away from the fit until needsRefit fires, and check it never left the
      // slice on the way: this is the property the whole bracket depends on, and it is exactly
      // where a fixed fraction of bracketWidth broke down near maxFar (s1 clamps at 0.9).
      const lo = s0 * 900
      for (const dir of [1, -1]) {
        let x = d
        for (let step = 0; step < 4000; step++) {
          x += dir * 0.25
          if (fit.needsRefit(x, lo, hi)) break
          ok(x >= lo - 1e-6 && x <= hi + 1e-6, `subject drifted to ${x.toFixed(1)} outside its slice [${lo.toFixed(1)}, ${hi.toFixed(1)}] before a refit fired`)
        }
      }
    }
  }
}

ok(fit.needsRefit(100, NaN, NaN), 'an unfitted slice always refits')
ok(fit.needsRefit(100, 0, 0), 'a degenerate slice always refits')
ok(!fit.needsRefit(100, 90, 110), 'a subject in the middle of its slice does not refit every frame')

// --- the FOV quantiser ---------------------------------------------------------------------------
let prev = 0
for (let f = 1.5; f <= 80; f *= 1.003) {
  const qf = fit.quantFov(f)
  ok(qf >= f - 1e-9, `quantFov must round UP so the cascade covers the live frustum: ${f} → ${qf}`)
  ok(qf / f < 2 ** 0.125 + 1e-9, `quantFov wastes at most an ⅛ octave: ${f} → ${qf}`)
  ok(qf >= prev, 'quantFov is monotone')
  prev = qf
}
const steps = new Set()
for (let f = 2; f <= 40; f += 0.01) steps.add(fit.quantFov(f).toFixed(6))
ok(steps.size <= 40, `a 2°→40° zoom must refit tens of times, not hundreds: ${steps.size}`)
ok(steps.size >= 20, `…but still track the zoom: ${steps.size}`)

// --- the penumbra --------------------------------------------------------------------------------
const P = QUALITY.high.penumbraM
ok(P.length === QUALITY.high.cascades, 'one penumbra target per cascade on the high tier')
// 0.533° of sun = 0.93 cm of penumbra per metre of gap along the light
for (const sunY of [1, 0.77, 0.635, 0.2, 0.03]) {
  for (let i = 0; i < P.length; i++) {
    const t = fit.penumbraTarget(P, i, sunY)
    ok(t >= P[i] - 1e-9, `a lower sun never sharpens cascade ${i}`)
    ok(t <= P[i] * 6 + 1e-9, `the low-sun softening is capped at 6× (cascade ${i})`)
  }
}
ok(fit.penumbraTarget(P, 0, 1) < fit.penumbraTarget(P, 0, 0.2), 'the penumbra widens as the sun drops')
ok(P[0] <= P[P.length - 1], 'the near cascades are not softer than the background one')
// index past the end clamps rather than returning undefined
ok(fit.penumbraTarget(P, 99, 1) === P[P.length - 1], 'the cascade index clamps to the last entry')

console.log(`shadow-fit: ${checks} checks passed`)
console.log('  high tier, subject cascade (metres per shadow texel):')
for (const r of rows) {
  console.log(
    `    ${r.mode.padEnd(9)} d=${String(r.d).padStart(4)} m → c${r.c}  ${(r.texel * 100).toFixed(2).padStart(6)} cm/texel (was ${(r.was * 100).toFixed(2).padStart(6)}, ${(r.was / r.texel).toFixed(1)}×)  ${(CAR_WIDTH_M / r.texel).toFixed(0).padStart(3)} texels across the car`,
  )
}
