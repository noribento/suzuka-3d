# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Suzuka Circuit in the browser: a Nuxt 4 SPA (`ssr: false`) + Vue 3.5 + three.js r185, TypeScript strict. A 22-car race simulation (`app/sim/`) drives a 3D scene (`app/three/`) and an F1 world-feed-style HUD (`app/components/hud/`). Runtime dependencies are only nuxt / vue / vue-router / three. Node ≥ 22.18 (native TS type stripping is relied on by every script) and pnpm 12.

**README.md (Japanese) is the design document** — every builder, the ground contract R1–R14, the far field, the perf budgets and the GPU checklist. Read the relevant section before touching a subsystem, and keep its `## Structure` tree and notes current when you add or rename a builder. Code comments are English; README and commit messages are Japanese — follow that.

## Commands

```bash
pnpm dev                      # :3000 — usually the user's own server; use --port 3100 for probes/e2e
NUXT_IGNORE_LOCK=1 pnpm dev --port 3100   # a nuxt dev started from a Claude shell needs the lock override
pnpm typecheck                # nuxi typecheck (vue-tsc)
pnpm check                    # the offline guard chain, ≈ 4–8 min (see below); .githooks/pre-commit runs it (opt-in)
pnpm sim -- --laps 53 --seeds 5   # Node race harness (--json, --brakes, --verbose)
pnpm test:e2e                 # Playwright, headless SwiftShader; starts / reuses a dev server on :3100
pnpm exec playwright test tests/e2e/race.spec.ts -g "WASD"   # one test
pnpm perf                     # perf-probe → perf-gate against a :3100 server; > 30 min on SwiftShader, run in background
```

`pnpm check` = typecheck → `scripts/textures-lint.mjs` → `scripts/assets/import-misc.mjs --check` → `scripts/facilities-check.mjs --strict` → `scripts/facilities/dem-profile.mjs --verify` → `scripts/audit/scene-cost.mjs --strict` (high, low; ≈ 12 s each) → `scripts/audit/surface-check.mjs --strict` (high, low; ≈ 95–210 s each). Run the individual script for the subsystem you changed rather than the whole chain while iterating; `surface-check` takes `--only G1,G5`, `--json`, `--suggest`.

Environment facts: there is no GPU reachable from headless Chromium here (always SwiftShader → the **low** tier, 2–12 fps). High-tier visuals can only be checked by the user on a real GPU (README「GPU で確認すること」); say so instead of claiming to have verified them. `?fx=0|1` forces a tier, `?assets=0|1` forces the asset pack, `?res=0` pins render resolution.

## Architecture

### Runtime flow
- `app/components/RaceViewport.client.vue` is the single orchestrator: `createScene` → `loadAssets` → `buildEnvironment` → `buildTrackMeshes` / `buildBarriers` / `buildLines` → `freezeStatic` → cars → `env.farField.start()` (deferred far-field jobs after the loading screen). Its `loop()` steps `RaceSim`, places cars, effects, cameras, audio, then renders and syncs the HUD store.
- `app/sim/` is pure TypeScript with no three.js scene dependency: `track.ts` (spline, racing line, crossover, pit lane), `race.ts` (`RaceSim`), `brake-thermal.ts`. The same code runs in Node via `scripts/sim-harness.mjs`.
- HUD components read `useRaceStore` only; `useBroadcastGraphics` is the graphics director for the TV / AUTO camera package. Driver tags are projected with the camera matrix (no CSS2DRenderer).
- `app/three/quality.ts`: every tier-dependent number lives in `QUALITY`; builders take a `Quality` and never branch on `tier === 'high'`. The low tier (= SwiftShader = e2e) has no post chain, uses logarithmic depth, and loads no external files.

### Coordinates
- Track frame `(s, lateral)`: `s` in metres along the lap (0–5807, wraps), `lateral` positive = **left**. `Track.pointAt / poseAt` go to world. Heights above the road plane are "relative to the road" in that frame.
- World = `(E, y, −N) × Track.enScale` (≈ 1.0012). Anything digitised in EN metres (OSM footprints, DEM samples) must go through `track.enToWorld`.
- The lap is a figure-8 with a crossover: world → `s` must always be windowed — `Track.nearestOnRange(x, z, s0, s1)` or `ground.plan.project(x, z, window)` — or points jump to the other road.

### The ground contract (README「地面の契約」R1–R14, enforced by `surface-check`)
The ground is an XZ **partition**: one opaque owner per point decided by `PRECEDENCE` from the data tables (`ground-plan.ts`), one continuous height field (`ground-field.ts`), meshes on shared vertices with one height per vertex (`ground-mesh.ts`), built in three phases inside `buildEnvironment`: draw faces → `terrain.settle()` → place everything else. Consequences you must respect:
- Outside `ground.ts / ground-plan.ts / ground-field.ts / ground-mesh.ts / environment.ts`, never call `terrain.heightAt / meshHeightAt / distanceToTrack` (G8 source lint fails `pnpm check`). Use `ground.standY / standAt` for objects, `ground.decalY` / `ground.decal` for paint, `ground.plan.project` for world → track.
- Do not add opaque horizontal geometry near the ground: paint is a `Ground.decal` (the face's own triangles, lifted one `LAYER` rung) tagged with `markDecal`; things standing on the ground are a `GROUND_OBJECTS` row tagged with `markObject`.
- `polygonOffset` is a no-op on the low tier (log depth writes `gl_FragDepth`): separate surfaces geometrically by ≥ `LAYER_MIN_STEP` (8 mm) using the `LAYER` rungs.
- Ground shapes are authored only as table rows (`RUNOFF_ZONES` / `KERBS` / `OFFSET_LANES` / `GROUND_AREAS` in `app/data/suzuka-barriers-spec.ts` and `suzuka-facilities-spec.ts`); rows carry no height, lift, order or mesh names. `(s, lateral)` can only describe the inside of a bend up to its radius — beyond that use a wall polyline in XZ (`{ way, verts }`).
- There are no numeric baselines: every non-zero tolerance is an `ALLOWANCES` entry in `scripts/audit/surface-check.mjs` with a `why` and an `until` phase, and it fails once `PHASE` reaches it. `--suggest` prints the entry for a failing key; you still write the reason. Do not loosen a guard to make a build pass.

### Far field (`app/three/farfield.ts`, everything outside the fences)
Builders register entries (250 m cells, LOD levels, `static` levels merged per block) through `ctx.farField` during `buildEnvironment`; the queue is drained in wall-clock ticks after `store.ready`. Deferred jobs run after `boxes.flush()` and the main `freezeStatic`, so they must not use `ctx.boxes`, must not touch the terrain grid or the ground faces, and read `ground.standY`. Tier budgets come from `Quality.farField`. Stages run `paving → buildings → forest → dressing` (keep-out producers before the forest). Overlays that lie on the ground out there (road ribbons, forest floor, later paddy bunds / rail beds / water strips) are terrain-cut with `far-geometry.ts` (`cellClippedPolygon` / `cellClippedStrip`) and lifted by ≥ `LAYER_MIN_STEP`; they stay ≥ `ROADS.minD` (76 m, outside G8's 75 m band) from the centreline and are never `GroundFace`s. The road network is one shared object: `road-section.ts roadNetwork(ctx)` (memoised; `offsetAt(+lateral)` = the driver's LEFT) — roads, furniture, poles, tree rows, building fronts and terrain-side crossings all read it, and `buildRoads` pushes the ribbons' keep-outs before the 'buildings' stage.

### Builders share one context
`EnvBuildContext` (`environment.ts`) carries track, terrain, ground, group, quality, assets, the shared `BoxPlacer`, rng, stand zones, keep-outs, farField and landCover. Add a dependency there rather than growing parameter lists. Every builder reports wall-clock into `buildMs`, which the e2e suite and `perf-probe` read.

### Data files
Hand-written specs: `suzuka.ts`, `suzuka-facilities-spec.ts`, `suzuka-barriers-spec.ts`, `surroundings-spec.ts`, `drivers.ts`. **Generated — never hand-edit** (the header says so): `suzuka-facilities.ts`, `suzuka-surroundings.ts`, `suzuka-power.ts` (OSM, ODbL; `scripts/facilities/build-*.mjs`), `suzuka-dem.ts` (GSI DEM; `dem-profile.mjs --grid --far --write`), `credits.ts` and `CREDITS.md` (`scripts/assets/import-misc.mjs`). Raw downloads and user reference material live in `misc/` (gitignored); `public/assets/` is the converted, committed output.

### Node tooling
`scripts/ts-hooks.mjs` maps `~/` and extension-less `.ts` imports so data/sim modules run in plain Node. `scripts/audit/app-runtime.mjs` adds a TypeScript transpile hook (parameter properties) and DOM stubs so `buildScene({ tier })` builds the full scene graph in Node — that is how `surface-check` and `scene-cost` measure the real geometry instead of restating builder arithmetic. Keep guards importing only data / plan / the built scene (R13 import list in `surface-check.mjs`).

### Budgets
`scripts/perf-budgets.json` holds the static budgets (`scene-cost`, strict in `pnpm check`) and the browser ceilings (`perf-gate`, formulas in its `comment`). Re-base only from a measured `.perf/*.json` run, and say which run.

## E2E and probes
- Dev-only `window.__suzuka` exposes `ctx, env, track, plan, groundMeshes, groundCensus(), perf, buildMs, setupMs, race, audio…`. Wait for `.loading` hidden **and** `__suzuka.env.farField.pending === 0` before measuring.
- SwiftShader runs a few fps, so wall-clock waits can span zero frames: count `ctx.renderer.info.render.frame` (see the WASD test in `tests/e2e/race.spec.ts`).
- `tests/e2e/global-setup.ts` absorbs Vite's first-load 504; ad-hoc Playwright scripts should retry once.
- Screenshots: `node scripts/shots.mjs --preset … --custom "name:s,lat,h:s,lat,h"` against :3100; aerial comparisons: `scripts/audit/{aerial,overlay,shoot}.mjs`.

## Policies
- Assets: CC0 and CC-BY (with credit) only, ≤ 200 MB committed in `public/assets/` (≤ 512 MB estimated VRAM); no real logos, sponsor names or trademarks in generated textures (`textures-lint.mjs` with `scripts/trademark-*.json`) — vehicle GLBs get their badge / plate rectangles blurred at import (`retouch` in `sources.mjs`). Sketchfab CC-BY drops live under `misc/<group>/` (trees / road / buildings / vehicles) and are optional: every builder keeps a procedural fallback.
- The reproduced date is the 2026 Japanese GP (29 March): dormant tan grass, cherry blossom, sun model — `SEASON` in `suzuka-facilities-spec.ts`.
