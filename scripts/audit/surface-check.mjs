#!/usr/bin/env node
/**
 * Offline guard set for the ground (v2 — the plan's §4, phase P0).
 *
 * The scene is built in plain Node (`app-runtime.mjs`) and MEASURED: which sheet is visible from
 * above, where two faces cover the same ground, how far every face sits from the frame it claims,
 * whether the height field is continuous. Nothing here restates a builder's arithmetic — that is
 * how the previous guard reported 0 % on a mottled island — and nothing here is a numeric
 * baseline (R13): every non-zero number the run tolerates is a typed ALLOWANCE below, with the
 * phase that removes it, and an allowance whose phase has come fails the run.
 *
 *   G0  ladder        LAYER stacks ascending, ≥ LAYER_MIN_STEP apart               (goes with LAYER in P3)
 *   G1  census        visible owner from above vs the owner the data declares       (plan.ownerAt in P2)
 *   G2  overlap       any two faces — the same one included — covering one XZ point
 *   G3  deviation     face centroid vs its declared frame (road plane / height field)
 *   G4  quality       zero-area triangles, zero normals on drawn vertices, steep faces
 *   G5  continuity    Terrain.heightAt jumps along s and across the verge
 *   G6  terrain       the drawn grid coming up through a registered sheet (per tier)
 *   G7  max edge      a face too coarse to resolve the grid it is draped on (per tier)
 *   G8  registration  horizontal geometry at ground level that is not a registered face; G8b lints
 *   G9  seams         STUB until P3 (shared-boundary vertices)
 *   G10 residue       declared RUNOFF_ZONES band no ribbon or patch draws (m² per zone|side)
 *   G11 drops         station-to-station cliffs along a swept ribbon's edge columns
 *   G12 plan          STUB until P2 (plan integrity)
 *
 *   node scripts/audit/surface-check.mjs [--strict] [--tier high|low] [--only G1,G5] [--json out.json] [--suggest]
 *
 * --suggest prints, for every failing key, the ALLOWANCES entry that would cover it (rounded up:
 * counts / m² +5 %, mm +2, edges to 0.1 m). It never writes anything — the author still has to
 * paste the entry with a `why` and an `until`.
 *
 * Imports (R13 — checked by G8b against this list; nothing else under app/ may be imported):
 *   app/data/suzuka.ts, app/data/suzuka-facilities-spec.ts, app/data/suzuka-barriers-spec.ts
 *   app/three/ground.ts            LAYER, SHEET_LAYER, RUNOFF_WIDTH, FLAT_STRIP, RUNOFF_LIFT, STRIP_DROP
 *   (the built scene's ground.field — the one continuous height source, ground-field.ts — is the
 *   frame every non-road face is measured against since P1)
 *   app/three/trackside.ts         patchOutline, laneWorldPath
 *   app/three/track-mesh.ts        runoffLayout, RUNOFF_MAX_LAT — TEMPORARY, replaced by plan rows in P2
 *   app/sim/track.ts               forwardDelta, signedDelta
 *   scripts/audit/app-runtime.mjs  buildScene, ROOT, THREE
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'

const ALLOWED_IMPORTS = [
  'app/data/suzuka.ts',
  'app/data/suzuka-facilities-spec.ts',
  'app/data/suzuka-barriers-spec.ts',
  'app/three/ground.ts',
  'app/three/trackside.ts',
  'app/three/track-mesh.ts',
  'app/sim/track.ts',
  './app-runtime.mjs',
  'scripts/audit/sections.json',
]

// ================================================================ phases and allowances
const PHASE = 'P1'
const PHASES = ['P0', 'P1', 'P2', 'P3a', 'P3b', 'P4', 'P5', 'P6']
const phaseIdx = (p) => PHASES.indexOf(p)

/**
 * Every non-zero the run tolerates, typed: { guard, key, bound, why, until }. `until` is the
 * phase that removes the cause; once PHASE reaches it the entry fails the run. Bounds cover both
 * tiers (they build on different terrain grids). Generated from the P0 measurement of the
 * builders as they stand (2026-09-08) and grouped by the reason they exist.
 */
const WHY = {
  ladder: 'the LAYER ladder separates stacked sheets by height; the ladder and its tight pairs go with LAYER in P3',
  stacked: 'stacked sheets (a ribbon drawn under another); removed by the partition in P3a',
  selfOverlap: 'one swept sheet covering the same XZ twice (hairpin, 200R↔west straight, Dunlop, 130R, chicane); removed by the bisector cap in P2/P3a',
  pitFrame: 'pit lane / apron / paddock in their own frames over the verge ribbon; removed by the pit owners of the partition in P3a',
  kerbs: 'the kerbs are an unregistered upper over the verge ribbon; they become a raster owner in P3a',
  lanes: 'lanePaving / laneKerbs swept over the verge and patches at a different lift; lanes become footprints (P3a) and the kerbs objects (P4)',
  patches: 'SURFACE_PATCHES drape blended between road / strip / verge frames on their own triangulation; rows of the plan in P2, polygons of the mesh in P3a',
  field: 'Terrain.heightAt is discrete (nearest-sample road plane, far-stretch lateral cap); made continuous in P1',
  meshFrame: 'paddock / helipad / secondary paving built on the DRAWN grid before settle() moved it; they move to the field in P1',
  strip: 'the 2 m flat strip switches frame mid-verge (STRIP_DROP vs terrain + lift); the strip becomes a height rule of the field in P1',
  residue: 'declared band cut by the swept frame (FOLD) or wider than RUNOFF_WIDTH; residue rows in P2, OSM_SAND rows in P6',
  unregistered: 'horizontal geometry at ground level outside the face registry (basin floor, pit wall foot, boards); registered or typed as furniture in P4',
  relief: 'stand relief cuts (vRange) and the hairpin cliff in heightAt; ramps / the continuous cap in P1',
  gridEdge: 'ribbon stations 4 m apart at RUNOFF_WIDTH exceed half the terrain grid on the low tier; rasters ≤ 4 m in P3a',
  roadTwist: 'the asphalt / pit lane / kerb ribbons are two-edge quads 1-3 m long, so where the camber changes the two triangles of a quad twist off the road plane (97 mm at T1); the shared-edge chain of ground:road in P3a gets lateral interpolation points',
  water: 'the basin floor and bank are unregistered horizontal geometry; a `water` row of GROUND_AREAS in P2, a face in P3a',
  straightFrame: 'the paddock, the helipad and the paving are swept in the main straight\'s (s, lateral) frame out to 125 m, past its bisector with NIPPO, where the field belongs to the other road; the partition rasters them from both roads up to the bisector in P3a',
  ribbonChord: 'a swept ribbon samples the field every 4 m along s and at 11 fixed offsets across, so it chords over the field\'s relief edges and fold-capped edges; the raster follows the field at ≤ 2 m / ≤ 4 m in P3a',
  reliefEdge: 'facilityRelief (stands.ts) has hard edges: the chord-zone vRange cut, the basin polygon edge, its own 2 m sample sawtooth; ramps are stands.ts work outside the ground modules (plan §6.6)',
}
const ALLOWANCES = [
  { guard: 'G0', key: "tightPairs", bound: 7, why: WHY.ladder, until: 'P3a' },
  { guard: 'G1', key: "gravel>runoffAsphaltR", bound: 2, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "gravel>runoffL", bound: 545, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "gravel>runoffR", bound: 2499, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "kerbs>runoffR", bound: 4, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G1', key: "lanePaving>gravel", bound: 212, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "lanePaving>runoffAsphaltR", bound: 197, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "lanePaving>runoffR", bound: 782, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "lanePaving>surface-asphalt", bound: 207, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "pitLane>lanePaving", bound: 216, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G1', key: "pitLane>runoffAsphaltR", bound: 941, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G1', key: "pitLane>runoffR", bound: 735, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G1', key: "runoffAsphaltL>runoffL", bound: 228, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "runoffAsphaltR>lanePaving", bound: 12, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "runoffAsphaltR>runoffR", bound: 2, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "runoffL>terrain", bound: 8, why: WHY.residue, until: 'P2' },
  { guard: 'G1', key: "runoffR>gravel", bound: 1125, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "runoffR>laneKerbs", bound: 72, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "runoffR>runoffAsphaltR", bound: 2, why: WHY.stacked, until: 'P3a' },
  { guard: 'G1', key: "runoffR>terrain", bound: 7, why: WHY.residue, until: 'P2' },
  { guard: 'G1', key: "surface-asphalt>gravel", bound: 6, why: WHY.patches, until: 'P3a' },
  { guard: 'G1', key: "surface-asphalt>laneKerbs", bound: 7, why: WHY.lanes, until: 'P3a' },
  { guard: 'G1', key: "surface-asphalt>runoffL", bound: 9, why: WHY.patches, until: 'P3a' },
  { guard: 'G1', key: "terrain>runoffR", bound: 3, why: WHY.residue, until: 'P2' },
  { guard: 'G10', key: "200R → Spoon|L", bound: 11, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "chicane approach|R", bound: 6, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "chicane T16–T17|R", bound: 202, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 1 → 2|L", bound: 1157, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 1 → 2|R", bound: 7, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Degner 1|R", bound: 213, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Dunlop entry trap|R", bound: 578, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Dunlop exit → Degner|R", bound: 88, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "hairpin|L", bound: 176, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "Spoon 1–2|R", bound: 1022, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "T2 exit → Esses|L", bound: 3, why: WHY.residue, until: 'P6' },
  { guard: 'G10', key: "T2|L", bound: 642, why: WHY.residue, until: 'P6' },
  { guard: 'G11', key: "runoffL", bound: 7, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G11', key: "runoffR", bound: 2, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G2', key: "asphalt|kerbs", bound: 206, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "asphalt|lanePaving", bound: 1509, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "asphalt|pitLane", bound: 10, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "asphalt|runoffAsphaltL", bound: 1661, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "asphalt|runoffAsphaltR", bound: 1206, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "asphalt|runoffL", bound: 2033, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "asphalt|runoffR", bound: 344, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "gravel|gravel", bound: 47, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "gravel|kerbs", bound: 151, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "gravel|lanePaving", bound: 623, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "gravel|paddockAsphalt", bound: 167, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "gravel|runoffAsphaltL", bound: 155, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "gravel|runoffAsphaltR", bound: 175, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "gravel|runoffL", bound: 37795, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "gravel|runoffR", bound: 63047, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "gravel|surface-asphalt", bound: 183, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "helipad|paddockAsphalt", bound: 1286, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "kerbs|asphalt", bound: 280, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "kerbs|lanePaving", bound: 229, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "kerbs|runoffAsphaltL", bound: 24267, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "kerbs|runoffAsphaltR", bound: 23987, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "kerbs|runoffL", bound: 13103, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "kerbs|runoffR", bound: 9169, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "laneKerbs|laneKerbs", bound: 46, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "laneKerbs|runoffL", bound: 120, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "laneKerbs|runoffR", bound: 218, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "laneKerbs|surface-asphalt", bound: 835, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|asphalt", bound: 36, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|gravel", bound: 56, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|lanePaving", bound: 263, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|pitLane", bound: 186, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|runoffAsphaltR", bound: 668, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|runoffR", bound: 4546, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "lanePaving|surface-asphalt", bound: 61, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "paddockAsphalt|helipad", bound: 282, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "paddockAsphalt|runoffR", bound: 4347, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitApron|runoffR", bound: 3031, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitLane|asphalt", bound: 638, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitLane|lanePaving", bound: 207, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitLane|pitApron", bound: 301, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitLane|runoffAsphaltR", bound: 4290, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "pitLane|runoffR", bound: 4910, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltL|asphalt", bound: 7, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltL|kerbs", bound: 909, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltL|runoffL", bound: 1186, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltR|asphalt", bound: 8, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltR|gravel", bound: 4, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltR|kerbs", bound: 702, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltR|lanePaving", bound: 447, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "runoffAsphaltR|pitLane", bound: 714, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "runoffL|asphalt", bound: 135, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "runoffL|gravel", bound: 852, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "runoffL|kerbs", bound: 549, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "runoffL|laneKerbs", bound: 186, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "runoffL|runoffAsphaltL", bound: 183, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "runoffL|runoffL", bound: 13616, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "runoffL|surface-asphalt", bound: 29, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "runoffR|asphalt", bound: 296, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "runoffR|gravel", bound: 2189, why: WHY.stacked, until: 'P3a' },
  { guard: 'G2', key: "runoffR|kerbs", bound: 576, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G2', key: "runoffR|laneKerbs", bound: 131, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "runoffR|lanePaving", bound: 1216, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "runoffR|paddockAsphalt", bound: 1650, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "runoffR|pitLane", bound: 430, why: WHY.pitFrame, until: 'P3a' },
  { guard: 'G2', key: "runoffR|runoffR", bound: 2041, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "secondaryPaving|secondaryPaving", bound: 5, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|gravel", bound: 83, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|laneKerbs", bound: 1193, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|lanePaving", bound: 397, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|runoffAsphaltL", bound: 1357, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|runoffAsphaltR", bound: 163, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|runoffL", bound: 9922, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|runoffR", bound: 1479, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|surface-asphalt", bound: 105, why: WHY.selfOverlap, until: 'P3a' },
  { guard: 'G2', key: "surface-asphalt|surface-turf", bound: 290, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-turf|laneKerbs", bound: 208, why: WHY.lanes, until: 'P3a' },
  { guard: 'G2', key: "surface-turf|runoffAsphaltL", bound: 50, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-turf|runoffL", bound: 1484, why: WHY.patches, until: 'P3a' },
  { guard: 'G2', key: "surface-turf|surface-asphalt", bound: 490, why: WHY.patches, until: 'P3a' },
  { guard: 'G3', key: "asphalt", bound: 8.45, why: WHY.roadTwist, until: 'P3a' },
  { guard: 'G3', key: "gravel", bound: 2.39, why: WHY.field, until: 'P3a' },
  { guard: 'G3', key: "helipad", bound: 4.88, why: WHY.straightFrame, until: 'P3a' },
  { guard: 'G3', key: "kerbs", bound: 4.11, why: WHY.roadTwist, until: 'P3a' },
  { guard: 'G3', key: "laneKerbs", bound: 71.21, why: WHY.lanes, until: 'P4' },
  { guard: 'G3', key: "lanePaving", bound: 38.6, why: WHY.lanes, until: 'P3a' },
  { guard: 'G3', key: "paddockAsphalt", bound: 8.53, why: WHY.straightFrame, until: 'P3a' },
  { guard: 'G3', key: "pitLane", bound: 12.56, why: WHY.roadTwist, until: 'P3a' },
  { guard: 'G3', key: "runoffAsphaltL", bound: 6.31, why: WHY.field, until: 'P3a' },
  { guard: 'G3', key: "runoffAsphaltR", bound: 3.74, why: WHY.field, until: 'P3a' },
  { guard: 'G3', key: "runoffL", bound: 16.58, why: WHY.field, until: 'P3a' },
  { guard: 'G3', key: "runoffR", bound: 6.99, why: WHY.field, until: 'P3a' },
  { guard: 'G3', key: "secondaryPaving", bound: 2.82, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G3', key: "surface-asphalt", bound: 11.6, why: WHY.patches, until: 'P3a' },
  { guard: 'G3', key: "surface-turf", bound: 9.8, why: WHY.patches, until: 'P3a' },
  { guard: 'G4', key: "gravel.steep", bound: 78, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "gravel.zeroArea", bound: 336, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "helipad.steep", bound: 14, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G4', key: "laneKerbs.steep", bound: 4, why: WHY.lanes, until: 'P3a' },
  { guard: 'G4', key: "lanePaving.steep", bound: 6, why: WHY.lanes, until: 'P3a' },
  { guard: 'G4', key: "paddockAsphalt.steep", bound: 284, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G4', key: "runoffAsphaltL.steep", bound: 93, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "runoffAsphaltL.zeroArea", bound: 25755, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "runoffAsphaltR.steep", bound: 126, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G4', key: "runoffAsphaltR.zeroArea", bound: 24276, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "runoffL.steep", bound: 587, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G4', key: "runoffL.zeroArea", bound: 2840, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "runoffR.steep", bound: 275, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "runoffR.zeroArea", bound: 4362, why: WHY.stacked, until: 'P3a' },
  { guard: 'G4', key: "secondaryPaving.steep", bound: 48, why: WHY.ribbonChord, until: 'P3a' },
  { guard: 'G4', key: "surface-asphalt.steep", bound: 208, why: WHY.patches, until: 'P3a' },
  { guard: 'G4', key: "surface-turf.steep", bound: 4, why: WHY.patches, until: 'P3a' },
  { guard: 'G5', key: "jumps", bound: 591, why: WHY.reliefEdge, until: 'P6' },
  { guard: 'G7', key: "asphalt", bound: 15.1, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G7', key: "gravel", bound: 10.3, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G7', key: "lanePaving", bound: 8.4, why: WHY.lanes, until: 'P3a' },
  { guard: 'G7', key: "pitLane", bound: 9.6, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G7', key: "runoffAsphaltL", bound: 9.4, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G7', key: "runoffL", bound: 16.2, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G7', key: "runoffR", bound: 14.8, why: WHY.gridEdge, until: 'P3a' },
  { guard: 'G8', key: "basinBank", bound: 69, why: WHY.water, until: 'P3a' },
  { guard: 'G8', key: "basinFloor", bound: 2565, why: WHY.water, until: 'P3a' },
  { guard: 'G8', key: "kerbs", bound: 2382, why: WHY.kerbs, until: 'P3a' },
  { guard: 'G8', key: "pitInterior", bound: 5664, why: WHY.unregistered, until: 'P4' },
]

// ================================================================ CLI
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const STRICT = args.includes('--strict')
const SUGGEST = args.includes('--suggest')
const TIER = flag('--tier', 'high')
const JSON_OUT = flag('--json', null)
const ONLY = flag('--only', null)?.split(',').map((s) => s.trim())
const runs = (g) => !ONLY || ONLY.includes(g)
const fmt = (n, d = 1) => Number(n).toFixed(d)
const pad = (s, n) => String(s).padStart(n)
const padE = (s, n) => String(s).padEnd(n)

// ================================================================ app modules (R13)
const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const barriersSpec = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
const { CIRCUIT } = await import(path.join(ROOT, 'app/data/suzuka.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))
const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
// TEMPORARY (P2 replaces it with the plan's rows): the gravel / asphalt bands the builders sweep
const tmMod = await import(path.join(ROOT, 'app/three/track-mesh.ts'))
const { forwardDelta, signedDelta } = await import(path.join(ROOT, 'app/sim/track.ts'))
const sections = JSON.parse(readFileSync(path.join(ROOT, 'scripts/audit/sections.json'), 'utf8'))
const { LAYER, SHEET_LAYER, RUNOFF_WIDTH, FLAT_STRIP, RUNOFF_LIFT } = groundMod

// ================================================================ build
const tBuild = Date.now()
const { track, terrain, ground, root } = await buildScene({ tier: TIER })
const built = Date.now() - tBuild
const L = track.length
const sOver = track.crossing.sOver
const sUnder = track.crossing.sUnder
const pit = CIRCUIT.pit

// ================================================================ failures and the check() helper
const errors = []
const notes = []
const fail = (m) => errors.push(m)
const out = { tier: TIER, phase: PHASE, built, measured: {}, ms: {}, guards: {} }
const usedAllowance = new Set()
const suggestions = []
const roundUp = (v, unit) => {
  if (unit === 'mm') return Math.ceil(v + 2)
  if (unit === 'pct') return Math.min(100, Math.ceil(v * 1.05 * 100) / 100)
  if (unit === 'm') return Math.ceil(v * 10) / 10
  return Math.ceil(v * 1.05)
}
/**
 * The one gate every guard goes through. `measured ≤ bound` passes; anything else needs an
 * ALLOWANCES entry for (guard, key) that is still in force and whose bound holds.
 */
function check(guard, key, measured, bound = 0, where = '', unit = 'n') {
  ;(out.measured[guard] ??= {})[key] = measured
  if (measured <= bound + 1e-9) return true
  const a = ALLOWANCES.find((e) => e.guard === guard && e.key === key)
  const at = where ? ` ${where}` : ''
  if (!a) fail(`${guard} ${key}: ${fmtUnit(measured, unit)} > ${fmtUnit(bound, unit)} with no allowance${at}`)
  else if (phaseIdx(a.until) <= phaseIdx(PHASE)) fail(`${guard} ${key}: allowance expired (until ${a.until}, phase ${PHASE}) — ${fmtUnit(measured, unit)}${at}`)
  else if (measured > a.bound + 1e-9) fail(`${guard} ${key}: ${fmtUnit(measured, unit)} above the allowance ${fmtUnit(a.bound, unit)} (${a.why})${at}`)
  else { usedAllowance.add(a); return true }
  suggestions.push({ guard, key, bound: roundUp(measured, unit), measured, unit })
  return false
}
const fmtUnit = (v, unit) => (unit === 'pct' ? `${fmt(v, 2)} %` : unit === 'mm' ? `${fmt(v, 0)} mm` : unit === 'm' ? `${fmt(v, 1)} m` : unit === 'm2' ? `${Math.round(v)} m²` : String(Math.round(v)))
const timers = {}
const guardStart = (g, title) => { timers[g] = Date.now(); console.log(`\n${g}  ${title}`) }
const guardEnd = (g) => { out.ms[g] = Date.now() - timers[g]; console.log(`    [${g} ${out.ms[g]} ms]`) }

// ================================================================ shared geometry: faces + XZ index
/**
 * A FACE is a registered ground sheet (the registry, not the scene: the pit apron is registered
 * on its own and then merged into `concrete`) plus the kerbs, which are an unregistered upper
 * today. Decals are never faces.
 */
const DECAL_NAMES = new Set(['paintedAprons', 'whiteLines', 'drsLines', 'brakingRubber', 'parkingLines'])
const meshByGeo = new Map()
root.traverse((o) => { if (o.isMesh && o.geometry) meshByGeo.set(o.geometry.uuid, o) })
const faces = []
{
  const seen = new Set()
  for (const reg of terrain.groundSheets) {
    if (reg.geo.userData.groundReg?.decal) continue
    const mesh = meshByGeo.get(reg.geo.uuid)
    const name = mesh?.name || reg.name
    if (seen.has(name)) { fail(`faces: two registered geometries resolve to the name "${name}"`); continue }
    seen.add(name)
    faces.push({ name, geo: reg.geo, reg, mesh, registered: true })
  }
  root.traverse((o) => { if (o.isMesh && o.name === 'kerbs') faces.push({ name: 'kerbs', geo: o.geometry, reg: null, mesh: o, registered: false }) })
}
const faceIdx = Object.fromEntries(faces.map((f, i) => [f.name, i]))
/** the rung a face is declared at; kerbs are the exempt upper, the pit apron rides on `pit.concrete` */
const EXTRA_RUNG = { pitApron: ['pit', 'concrete'] }
const rungOf = (name) => {
  const e = SHEET_LAYER[name] ?? EXTRA_RUNG[name]
  return e ? { stack: e[0], rung: e[1], y: LAYER[e[0]][e[1]] } : null
}

const triCountOf = (geo) => { const idx = geo.getIndex(); return idx ? Math.floor(idx.count / 3) : Math.floor(geo.attributes.position.count / 3) }
const vertexOf = (geo, t, k) => { const idx = geo.getIndex(); return idx ? idx.getX(t * 3 + k) : t * 3 + k }

// live triangles of every face as flat arrays, and one XZ hash over all of them
const CELL = 8
const cells = new Map()
const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768)
const LIVE_AREA = 1e-6
for (let f = 0; f < faces.length; f++) {
  const face = faces[f]
  const pos = face.geo.attributes.position
  const n = triCountOf(face.geo)
  const T = new Float64Array(n * 9)
  const area = new Float64Array(n)
  const live = new Uint8Array(n)
  const vidx = new Int32Array(n * 3)
  let liveCount = 0
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(face.geo, t, k)
      vidx[t * 3 + k] = v
      T[t * 9 + k * 3] = pos.getX(v)
      T[t * 9 + k * 3 + 1] = pos.getY(v)
      T[t * 9 + k * 3 + 2] = pos.getZ(v)
    }
    const o = t * 9
    const a = Math.abs((T[o + 3] - T[o]) * (T[o + 8] - T[o + 2]) - (T[o + 5] - T[o + 2]) * (T[o + 6] - T[o])) / 2
    area[t] = a
    if (a < LIVE_AREA) continue
    live[t] = 1
    liveCount++
    const i0 = Math.floor(Math.min(T[o], T[o + 3], T[o + 6]) / CELL), i1 = Math.floor(Math.max(T[o], T[o + 3], T[o + 6]) / CELL)
    const j0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / CELL), j1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / CELL)
    const id = f * 4194304 + t
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = cellKey(i, j)
      let arr = cells.get(k)
      if (!arr) { arr = []; cells.set(k, arr) }
      arr.push(id)
    }
  }
  Object.assign(face, { T, area, live, vidx, tris: n, liveCount })
}
/**
 * Every live triangle of every face containing (x, z), as {f, t, y}. `tol` is the barycentric
 * tolerance: -1e-6 admits a point on a triangle's boundary (the census: what is visible there),
 * +1e-6 demands the interior (the overlap count: a shared edge is not double cover).
 */
const hits = []
function hitsAt(x, z, tol, skipF = -1, skipT = -1) {
  hits.length = 0
  const arr = cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
  if (!arr) return hits
  for (const id of arr) {
    const f = Math.floor(id / 4194304), t = id - f * 4194304
    if (f === skipF && t === skipT) continue
    const T = faces[f].T
    const o = t * 9
    const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (Math.abs(d) < 1e-12) continue
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
    const w = 1 - u - v
    if (u < tol || v < tol || w < tol) continue
    hits.push({ f, t, y: ay * u + by * v + cy * w })
  }
  return hits
}
/** the topmost face at (x, z) among `set` (a Set of face indices, or null for all), or null */
function topAt(x, z, set = null, tol = -1e-6) {
  const h = hitsAt(x, z, tol)
  let best = null
  for (const r of h) {
    if (set && !set.has(r.f)) continue
    if (!best || r.y > best.y) best = r
  }
  return best
}
/** the highest y of face `f` at (x, z), or null when it has no triangle there */
function faceYAt(f, x, z) {
  const h = hitsAt(x, z, -1e-6)
  let y = null
  for (const r of h) if (r.f === f && (y === null || r.y > y)) y = r.y
  return y
}

// ---- lap coordinates -------------------------------------------------------------------------
/** nearest centreline sample (discrete s); null far from every stretch of road */
const sOf = (x, z) => {
  let d = terrain.distanceToTrack(x, z, 120)
  if (d.i < 0) d = terrain.distanceToTrack(x, z, 400)
  return d.i < 0 ? null : d
}
/** continuous (s, lateral) refined on the segments around the nearest sample */
const contOf = (x, z, d) => track.nearestOnRange(x, z, d.s - 6, d.s + 6, 0)
/**
 * (s, lateral) such that `track.pointAt(s, lateral)` lands ON (x, z): `nearestOnRange` projects
 * onto the chord with the interpolated normal, which is not pointAt's inverse — on a cambered
 * bend the residual is centimetres, and a road-frame height read there is off by slope × error.
 */
function roadProject(x, z, d) {
  const c = contOf(x, z, d)
  let s = c.s, lat = c.lateral
  for (let it = 0; it < 3; it++) {
    track.pointAt(s, lat, _v, 0)
    const rx = x - _v.x, rz = z - _v.z
    if (rx * rx + rz * rz < 1e-8) break
    const h = track.headingAt(s)
    s = track.wrap(s + rx * h.tx + rz * h.tz)
    lat += rx * h.tz - rz * h.tx // the track's left normal is (tz, −tx)
  }
  return { s, lateral: lat }
}
/** the double crossover window: excluded from every XZ guard unconditionally */
const inCross = (s) => Math.abs(signedDelta(sOver, s, L)) < 115 || Math.abs(signedDelta(sUnder, s, L)) < 115
const inFwd = (from, to, s) => forwardDelta(from, s, L) <= forwardDelta(from, to, L)
const sectionOf = (s) => sections.find((sec) => inFwd(sec.s[0], sec.s[1], s))?.id ?? '-'
const secShort = (s) => sectionOf(s).slice(0, 2)
const sideCh = (side) => (side > 0 ? 'L' : 'R')
const _v = new THREE.Vector3()
const inRing = (x, z, r) => {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j]
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c
  }
  return c
}
const bboxOf = (pts, grow = 0) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z }
  return [x0 - grow, x1 + grow, z0 - grow, z1 + grow]
}
const inBox = (x, z, b) => x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]

console.log(`surface-check v2 — phase ${PHASE}, tier ${TIER}, scene built in ${built} ms; ${faces.length} faces (${faces.map((f) => f.name).join(', ')})`)

// ================================================================ G0 — the layer ladder (A6; gone with LAYER in P3)
if (runs('G0')) {
  guardStart('G0', 'layer ladder — every LAYER stack ascending, ≥ LAYER_MIN_STEP apart')
  const { LAYER_MIN_STEP, LAYER_SOFT, LAYER_KNOWN_TIGHT } = groundMod
  const known = new Set(LAYER_KNOWN_TIGHT.map(([a, b]) => `${a}|${b}`))
  let tight = 0, unordered = 0
  for (const [stack, entries] of Object.entries(LAYER)) {
    const list = Object.entries(entries)
    console.log(`    ${stack}: ${list.map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  ')}`)
    for (let i = 0; i < list.length - 1; i++) {
      const [ka, va] = list[i], [kb, vb] = list[i + 1]
      const a = `${stack}.${ka}`, b = `${stack}.${kb}`
      if (vb <= va) { unordered++; notes.push(`G0: ${b} (${vb}) is not above ${a} (${va})`) }
      if (LAYER_SOFT.has(a) || LAYER_SOFT.has(b)) continue
      if (vb - va < LAYER_MIN_STEP - 1e-9) { tight++; if (!known.has(`${a}|${b}`)) notes.push(`G0: ${a} → ${b} is ${((vb - va) * 1000).toFixed(0)} mm apart and not in LAYER_KNOWN_TIGHT`) }
    }
  }
  console.log(`    ${tight} pair(s) under ${LAYER_MIN_STEP * 1000} mm (${LAYER_KNOWN_TIGHT.length} declared in LAYER_KNOWN_TIGHT), ${unordered} out of order`)
  check('G0', 'unordered', unordered)
  check('G0', 'tightPairs', tight)
  guardEnd('G0')
}

// ================================================================ G1 — census: visible owner vs declared owner
if (runs('G1')) {
  guardStart('G1', 'census — the sheet visible from above vs the owner the data declares')
  /**
   * TEMPORARY expected-owner function — replaced by `plan.ownerAt` in P2. It reads the DATA
   * (KERBS, CIRCUIT.pit, OFFSET_LANES, SURFACE_PATCHES, RUNOFF_ZONES via runoffLayout) in the
   * precedence the plan fixes, and nothing of how the builders sweep it.
   */
  const KERB_SPANS = []
  const subtractInterval = (from, to, cutFrom, cutTo) => {
    const len = forwardDelta(from, to, L), cutLen = forwardDelta(cutFrom, cutTo, L)
    let c0 = forwardDelta(from, cutFrom, L)
    if (c0 > L / 2) c0 -= L
    const c1 = c0 + cutLen
    if (c1 <= 0 || c0 >= len) return [[from, to]]
    const r = []
    if (c0 > 0) r.push([from, from + c0])
    if (c1 < len) r.push([from + c1, to])
    return r
  }
  for (const k of barriersSpec.KERBS) {
    if (k.kind !== 'flat') continue
    const spans = k.side < 0 ? subtractInterval(k.sRange[0], k.sRange[1], pit.entryS - 4, pit.exitS + 4) : [[k.sRange[0], k.sRange[1]]]
    for (const [a, b] of spans) KERB_SPANS.push({ from: a, to: b, side: k.side, width: k.width ?? 1.3 })
  }
  const LANES = barriersSpec.OFFSET_LANES.filter((d) => !d.paved).map((d) => {
    const pts = trackside.laneWorldPath(track, d, 2)
    return { name: d.name, pts, half: d.width / 2, box: bboxOf(pts, d.width / 2 + 0.1) }
  }).filter((l) => l.pts.length >= 2)
  const distToLane = (x, z, l) => {
    let best = Infinity
    for (let i = 0; i < l.pts.length - 1; i++) {
      const a = l.pts[i], b = l.pts[i + 1]
      const dx = b.x - a.x, dz = b.z - a.z
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)))
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t)
      if (d < best) best = d
    }
    return best
  }
  const RINGS = spec.SURFACE_PATCHES.map((p) => { const ring = trackside.patchOutline(track, p, 2); return { name: p.name, kind: p.kind, layer: p.layer, sRange: p.sRange, ring, box: bboxOf(ring) } }).filter((r) => r.ring.length >= 3)
  const layout = tmMod.runoffLayout(track)
  const halfLane = pit.laneWidth / 2
  const expectedAt = (s, side, off, x, z) => {
    if (off <= 0) return 'asphalt'
    const hw = track.halfWidthAt(s)
    const lat = side * (hw + off), al = hw + off
    for (const k of KERB_SPANS) if (k.side === side && off <= k.width && inFwd(k.from, k.to, s)) return 'kerbs'
    if (side < 0) {
      const pl = track.pitLateralAt(s)
      if (pl !== null && Math.abs(lat - pl) <= halfLane) return 'pitLane'
      if (inFwd(pit.limitStartS - 40, pit.limitEndS, s) && lat <= pit.laneOffset - halfLane && lat >= pit.garageFront + 0.4) return 'pitApron'
    }
    if (off > 1.5) for (const l of LANES) if (inBox(x, z, l.box) && distToLane(x, z, l) <= l.half) return 'lanePaving'
    let best = null
    for (const r of RINGS) if ((!best || r.layer > best.layer) && inBox(x, z, r.box) && inRing(x, z, r.ring)) best = r
    if (best) return `surface-${best.kind}`
    const g = layout.gravel(s, side)
    if (g && al >= g[0] && al <= g[1]) return 'gravel'
    const W = ground.runoffWidth(s, side)
    if (al < Math.min(layout.asphaltOuter(s, side), hw + W)) return side > 0 ? 'runoffAsphaltL' : 'runoffAsphaltR'
    if (off <= W) return side > 0 ? 'runoffL' : 'runoffR'
    return 'terrain'
  }
  const FACILITY = new Set(['paddockAsphalt', 'helipad', 'secondaryPaving'])
  const censusSet = new Set(faces.map((f, i) => (SHEET_LAYER[f.name] || f.name === 'kerbs' || f.name === 'pitApron' ? i : -1)).filter((i) => i >= 0))
  const gotAt = (x, z) => {
    const top = topAt(x, z, censusSet)
    const tY = terrain.meshHeightAt(x, z)
    if (!top || top.y < tY) return { name: 'terrain', y: tY }
    return { name: faces[top.f].name, y: top.y }
  }
  const stats = { total: 0, lattice: 0, ring: 0, seam: 0, match: 0, facility: 0, mismatch: 0, cross: 0, far: 0 }
  const matrix = new Map()
  const records = []
  /**
   * One XZ point. Its owner is read at the NEAREST stretch of road (what `plan.ownerAt` will do
   * through `field.project`): a 34 m verge swept from the 200R runs under the west straight, and
   * the ground there belongs to the straight, not to the station it was swept from.
   */
  const sample = (x, z, fromRing) => {
    const d = sOf(x, z)
    if (!d) { stats.far++; return }
    const c = contOf(x, z, d)
    const s = c.s, side = c.lateral >= 0 ? 1 : -1
    const off = Math.abs(c.lateral) - track.halfWidthAt(s)
    if (fromRing && off > 0 && off <= Math.min(RUNOFF_WIDTH, ground.runoffWidth(s, side))) return // the lattice has it
    if (inCross(s)) { stats.cross++; return }
    stats.total++
    if (fromRing) stats.ring++; else stats.lattice++
    const exp = expectedAt(s, side, off, x, z)
    // seam band: the owner changes within 0.5 m along s or across, so the boundary itself is not judged
    let seam = false
    for (const ds of [-0.5, 0.5]) {
      const s2 = track.wrap(s + ds)
      track.pointAt(s2, side * (track.halfWidthAt(s2) + off), _v, 0)
      if (expectedAt(s2, side, off, _v.x, _v.z) !== exp) { seam = true; break }
    }
    if (!seam) for (const doff of [-0.5, 0.5]) {
      const off2 = off + doff
      track.pointAt(s, side * (track.halfWidthAt(s) + off2), _v, 0)
      if (expectedAt(s, side, off2, _v.x, _v.z) !== exp) { seam = true; break }
    }
    if (seam) { stats.seam++; return }
    const got = gotAt(x, z)
    if (got.name === exp) { stats.match++; return }
    if (FACILITY.has(got.name)) { stats.facility++; return }
    stats.mismatch++
    const mk = `${exp}>${got.name}`
    matrix.set(mk, (matrix.get(mk) ?? 0) + 1)
    let dd = null, absent = false
    if (exp === 'terrain') dd = got.y - terrain.meshHeightAt(x, z)
    else if (exp === 'asphalt' || faceIdx[exp] !== undefined) {
      const y = faceYAt(faceIdx[exp], x, z)
      if (y === null) absent = true
      else dd = got.y - y
    } else absent = true
    records.push({ s, side, off, exp, got: got.name, d: dd, absent })
  }
  // the verge lattice: every metre of s, both sides, 0.5 m across, never exactly on the road edge
  for (let s = 0; s < L; s += 1) {
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const W = Math.min(RUNOFF_WIDTH, ground.runoffWidth(s, side))
      for (let off = 0.05; off <= W; off += 0.5) {
        track.pointAt(s, side * (hw + off), _v, 0)
        sample(_v.x, _v.z, false)
      }
    }
  }
  // the interior of every patch ring on a 1 m grid (a ring reaches beyond the lattice at the chicane)
  for (const r of RINGS) {
    for (let x = Math.ceil(r.box[0]); x <= r.box[1]; x += 1) for (let z = Math.ceil(r.box[2]); z <= r.box[3]; z += 1) {
      if (inRing(x, z, r.ring)) sample(x, z, true)
    }
  }
  const judged = stats.total - stats.seam
  console.log(`    ${stats.total} samples (${stats.lattice} lattice + ${stats.ring} ring interior; ${stats.cross} more in the crossover window, ${stats.far} far from the lap), ${stats.seam} in a seam band`)
  console.log(`    judged ${judged}: match ${stats.match} (${fmt((100 * stats.match) / Math.max(1, judged), 2)} %), facility ${stats.facility}, mismatch ${stats.mismatch}`)
  // the mismatch matrix
  const rows = [...matrix.entries()].sort((a, b) => b[1] - a[1])
  console.log('    expected > got                              samples')
  for (const [k, n] of rows) console.log(`    ${padE(k, 42)} ${pad(n, 7)}`)
  // clusters: same side / expected / got, merged along s over gaps ≤ 3 m
  records.sort((a, b) => a.side - b.side || a.exp.localeCompare(b.exp) || a.got.localeCompare(b.got) || a.s - b.s)
  const clusters = []
  for (const r of records) {
    const c = clusters[clusters.length - 1]
    if (c && c.side === r.side && c.exp === r.exp && c.got === r.got && r.s - c.to <= 3) {
      c.to = r.s; c.n++; c.off0 = Math.min(c.off0, r.off); c.off1 = Math.max(c.off1, r.off)
      if (r.absent) c.absent++; else if (Math.abs(r.d) > Math.abs(c.dmax)) c.dmax = r.d
    } else clusters.push({ from: r.s, to: r.s, side: r.side, exp: r.exp, got: r.got, n: 1, off0: r.off, off1: r.off, dmax: r.absent ? 0 : r.d, absent: r.absent ? 1 : 0 })
  }
  clusters.sort((a, b) => b.n - a.n)
  console.log('    top clusters:  s-range      side  off-range   samples   maxD mm  absent  sec  expected > got')
  for (const c of clusters.slice(0, 30)) {
    console.log(`      ${pad(Math.round(c.from), 5)}-${padE(Math.round(c.to), 5)}   ${sideCh(c.side)}   ${pad(fmt(c.off0, 1), 5)}-${padE(fmt(c.off1, 1), 5)} ${pad(c.n, 7)}   ${pad(fmt(c.dmax * 1000, 0), 6)}  ${pad(c.absent, 6)}  ${secShort(c.from)}   ${c.exp} > ${c.got}`)
  }
  console.log(`    ${clusters.length} clusters in all`)
  out.guards.G1 = { ...stats, matrix: Object.fromEntries(rows), clusters: clusters.slice(0, 30) }
  for (const [k, n] of rows) check('G1', k, n)
  guardEnd('G1')
}

// ================================================================ G2 — overlap: any two faces over one point (the same face included)
if (runs('G2')) {
  guardStart('G2', 'overlap — faces covering the same XZ point, the same face included; upper = the one on top at the sample')
  const pairs = new Map()
  let samplesTotal = 0, overlapSamples = 0, crossSkipped = 0, far = 0
  const BIN = 20
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]
    const T = face.T
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      const o = t * 9
      const P = [
        [(T[o] + T[o + 3] + T[o + 6]) / 3, (T[o + 2] + T[o + 5] + T[o + 8]) / 3, (T[o + 1] + T[o + 4] + T[o + 7]) / 3],
        [(T[o] + T[o + 3]) / 2, (T[o + 2] + T[o + 5]) / 2, (T[o + 1] + T[o + 4]) / 2],
        [(T[o + 3] + T[o + 6]) / 2, (T[o + 5] + T[o + 8]) / 2, (T[o + 4] + T[o + 7]) / 2],
        [(T[o + 6] + T[o]) / 2, (T[o + 8] + T[o + 2]) / 2, (T[o + 7] + T[o + 1]) / 2],
      ]
      const a4 = face.area[t] / 4
      for (const [x, z, y] of P) {
        samplesTotal++
        const h = hitsAt(x, z, 1e-6, f, t)
        if (!h.length) continue
        const d = sOf(x, z)
        if (!d) { far++; continue }
        if (inCross(d.s)) { crossSkipped++; continue }
        overlapSamples++
        for (const r of h) {
          const other = faces[r.f].name
          const dy = r.y - y
          const top = dy > 0 ? other : face.name
          const bottom = dy > 0 ? face.name : other
          const key = `${top}|${bottom}`
          let p = pairs.get(key)
          if (!p) {
            const rt = rungOf(top), rb = rungOf(bottom)
            let declared = 'cross-frame'
            if (top === bottom) declared = 'self'
            else if (bottom === 'kerbs') declared = 'inverted'
            else if (top === 'kerbs') declared = 'ok'
            else if (rt && rb && rt.stack === rb.stack) declared = rt.y > rb.y ? 'ok' : 'inverted'
            p = { top, bottom, declared, n: 0, area: 0, bad: 0, worst: 0, gap: 0, bins: new Map() }
            pairs.set(key, p)
          }
          p.n++
          p.area += a4
          const g = Math.abs(dy)
          if (g > p.gap) p.gap = g
          if (p.declared === 'inverted' && g > 0.002) { p.bad++; if (g > p.worst) p.worst = g }
          const b = Math.floor(d.s / BIN)
          p.bins.set(b, (p.bins.get(b) ?? 0) + 1)
        }
      }
    }
  }
  const rows = [...pairs.values()].sort((a, b) => b.n - a.n)
  console.log(`    ${samplesTotal} samples on ${faces.reduce((a, f) => a + f.liveCount, 0)} live triangles; ${overlapSamples} covered by another triangle (${crossSkipped} skipped in the crossover window, ${far} far from the lap)`)
  console.log('    upper            lower             declared     samples      m²  violations  worst mm  gap mm  runs (s-range·section)')
  for (const p of rows) {
    const bins = [...p.bins.keys()].sort((a, b) => a - b)
    const runsOf = []
    for (const b of bins) {
      const r = runsOf[runsOf.length - 1]
      if (r && b - r.b1 <= 1) { r.b1 = b; r.n += p.bins.get(b) } else runsOf.push({ b0: b, b1: b, n: p.bins.get(b) })
    }
    runsOf.sort((a, b) => b.n - a.n)
    const runTxt = runsOf.slice(0, 3).map((r) => `${r.b0 * BIN}-${(r.b1 + 1) * BIN}·${secShort(r.b0 * BIN)}`).join(' ') + (runsOf.length > 3 ? ` +${runsOf.length - 3}` : '')
    console.log(`    ${padE(p.top, 16)} ${padE(p.bottom, 17)} ${padE(p.declared, 11)} ${pad(p.n, 8)} ${pad(Math.round(p.area / 2), 7)}  ${pad(p.bad, 10)}  ${pad(fmt(p.worst * 1000, 0), 8)}  ${pad(fmt(p.gap * 1000, 0), 6)}  ${runTxt}`)
  }
  console.log(`    ${rows.length} ordered pairs`)
  out.guards.G2 = rows.map((p) => ({ pair: `${p.top}|${p.bottom}`, declared: p.declared, samples: p.n, m2: Math.round(p.area / 2), violations: p.bad, worstMm: Math.round(p.worst * 1000), gapMm: Math.round(p.gap * 1000) }))
  for (const p of rows) check('G2', `${p.top}|${p.bottom}`, p.n, 0, `(${Math.round(p.area / 2)} m², ${p.declared})`)
  guardEnd('G2')
}

// ================================================================ G3 — deviation from the declared frame
if (runs('G3')) {
  guardStart('G3', 'deviation — face centroid vs its declared frame (road plane ≤ 2 mm, height field ≤ 40 mm)')
  const ROAD = { asphalt: () => 0, pitLane: () => LAYER.pit.lane, pitApron: () => LAYER.pit.concrete }
  /** the kerb cross-section as LAYER declares it (track-mesh.ts kerbProfile); w = the KERBS width there */
  const kerbY = (off, w) => {
    const prof = [[0, 0], [0.3, 0.05], [w * 0.55, 0.065], [w - 0.15, 0.05], [w, LAYER.strip.kerbOuter]]
    if (off <= 0) return 0
    for (let i = 0; i < prof.length - 1; i++) {
      const [o0, y0] = prof[i], [o1, y1] = prof[i + 1]
      if (off <= o1) return y0 + ((y1 - y0) * (off - o0)) / Math.max(1e-6, o1 - o0)
    }
    return LAYER.strip.kerbOuter
  }
  /** width of the built (flat) kerb on `side` at s — the 'green' rows are decals and the sausages objects */
  const flatKerbWidth = (s, side) => {
    let w = 0
    for (const k of barriersSpec.KERBS) if (k.kind === 'flat' && k.side === side && inFwd(k.sRange[0], k.sRange[1], s)) w = Math.max(w, k.width ?? 1.3)
    return w || 1.3
  }
  /** the gravel bed's 2 cm in the strip is not on the ladder (track-mesh.ts gravel edges) — declared here until P1 removes the strip */
  const UNDECLARED_STRIP_RUNG = { gravel: 0.02 }
  const rows = []
  console.log('    face              frame   n       p50 mm  p99 mm   max mm   beyond    skipped  worst (one per 20 m)')
  for (const face of faces) {
    const T = face.T
    const rung = rungOf(face.name)
    // since P1 the 'mesh' stack rides the field too (ground.field, ground-field.ts): its rungs are
    // metres above the field, the verge stack's are metres above the analytic terrain, i.e. above
    // the field minus RUNOFF_LIFT
    const frame = ROAD[face.name] || face.name === 'kerbs' ? 'road' : rung?.stack === 'verge' || rung?.stack === 'mesh' ? 'field' : null
    if (!frame) { console.log(`    ${padE(face.name, 17)} (no declared frame — skipped)`); continue }
    const rungOverField = rung ? rung.y - (rung.stack === 'verge' ? RUNOFF_LIFT : 0) : 0
    // patches and the paving are built in world XZ (projected inside their own window); the ribbons
    // and the lanes on (s, lateral) stations
    const worldBuilt = face.name.startsWith('surface-') || face.name === 'secondaryPaving' || face.name === 'helipad' || face.name === 'paddockAsphalt'
    const limit = frame === 'road' ? 0.002 : 0.04
    const devs = []
    const worst = []
    let skipped = 0
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      const o = t * 9
      const x = (T[o] + T[o + 3] + T[o + 6]) / 3, z = (T[o + 2] + T[o + 5] + T[o + 8]) / 3, y = (T[o + 1] + T[o + 4] + T[o + 7]) / 3
      const d = sOf(x, z)
      if (!d) { skipped++; continue }
      if (inCross(d.s)) { skipped++; continue }
      let expected
      if (frame === 'road') {
        const c = roadProject(x, z, d)
        track.pointAt(c.s, c.lateral, _v, 0)
        if (face.name === 'kerbs') {
          const side = c.lateral >= 0 ? 1 : -1
          expected = _v.y + kerbY(Math.abs(c.lateral) - track.halfWidthAt(c.s), flatKerbWidth(c.s, side))
        } else expected = _v.y + ROAD[face.name]()
      } else {
        const c = contOf(x, z, d)
        const off = Math.abs(c.lateral) - track.halfWidthAt(c.s)
        const sr = UNDECLARED_STRIP_RUNG[face.name]
        if (off <= FLAT_STRIP && sr !== undefined) {
          // the gravel bed's 2 cm in the strip is not on the ladder (track-mesh.ts gravel edges)
          track.pointAt(c.s, c.lateral, _v, 0)
          expected = _v.y + sr
        } else expected = (worldBuilt ? ground.field.y(x, z) : ground.field.yAt(c.s, c.lateral)) + rungOverField
      }
      const dev = Math.abs(y - expected)
      devs.push(dev)
      if (dev > limit) {
        // keep the three worst, at most one per 20 m of s
        const bin = Math.floor(d.s / 20)
        const same = worst.find((w) => w.bin === bin)
        if (same) { if (dev > same.dev) Object.assign(same, { dev, s: d.s, lat: d.lateral }) }
        else { worst.push({ bin, dev, s: d.s, lat: d.lateral }); worst.sort((a, b) => b.dev - a.dev); if (worst.length > 3) worst.pop() }
      }
    }
    devs.sort((a, b) => a - b)
    const n = devs.length
    const q = (p) => (n ? devs[Math.min(n - 1, Math.floor(p * n))] : 0)
    const beyond = devs.filter((v) => v > limit).length
    const pct = n ? (100 * beyond) / n : 0
    rows.push({ name: face.name, frame, n, p50: q(0.5), p99: q(0.99), max: n ? devs[n - 1] : 0, pct, beyond, skipped, worst })
    console.log(`    ${padE(face.name, 17)} ${padE(frame, 6)} ${pad(n, 7)}  ${pad(fmt(q(0.5) * 1000, 1), 7)} ${pad(fmt(q(0.99) * 1000, 1), 7)}  ${pad(fmt((n ? devs[n - 1] : 0) * 1000, 0), 7)}  ${pad(fmt(pct, 2), 6)} %  ${pad(skipped, 7)}  ${worst.map((w) => `s${Math.round(w.s)} lat${Math.round(w.lat)} ${Math.round(w.dev * 1000)}mm·${secShort(w.s)}`).join(' ')}`)
  }
  out.guards.G3 = rows.map((r) => ({ ...r, p50: Math.round(r.p50 * 1000), p99: Math.round(r.p99 * 1000), max: Math.round(r.max * 1000) }))
  for (const r of rows) check('G3', r.name, Number(fmt(r.pct, 2)), 0, `(${r.frame} frame, p99 ${fmt(r.p99 * 1000, 0)} mm, max ${fmt(r.max * 1000, 0)} mm)`, 'pct')
  guardEnd('G3')
}

// ================================================================ G4 — mesh quality
if (runs('G4')) {
  guardStart('G4', 'quality — zero-area triangles, zero normals on drawn vertices, field-frame faces tilted > 10° away from the field')
  console.log('    face                 tris   zero-area   zero-normal   off-field>10°  worst   slivers<0.01m²')
  const rows = []
  /** unit normal of the field at (x, z): central differences 0.5 m apart, memoised per metre cell */
  const normalMemo = new Map()
  const fieldNormal = (x, z) => {
    const key = ((Math.round(x) & 0xffff) << 16) ^ (Math.round(z) & 0xffff)
    let n = normalMemo.get(key)
    if (n) return n
    const cx = Math.round(x), cz = Math.round(z)
    const dx = ground.field.y(cx + 0.5, cz) - ground.field.y(cx - 0.5, cz)
    const dz = ground.field.y(cx, cz + 0.5) - ground.field.y(cx, cz - 0.5)
    const l = Math.hypot(dx, 1, dz)
    n = [-dx / l, 1 / l, -dz / l]
    normalMemo.set(key, n)
    return n
  }
  const ROAD_FACES = new Set(['asphalt', 'pitLane', 'pitApron', 'kerbs'])
  for (const face of faces) {
    const T = face.T
    const nrm = face.geo.attributes.normal
    let deg = 0, steep = 0, worst = 0, slivers = 0
    const live = new Set()
    const roadFace = ROAD_FACES.has(face.name)
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) { deg++; continue }
      const o = t * 9
      const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      const len = Math.hypot(nx, ny, nz) || 1
      live.add(face.vidx[t * 3]); live.add(face.vidx[t * 3 + 1]); live.add(face.vidx[t * 3 + 2])
      // a sliver under 0.01 m² of XZ area covers no pixel and its normal weighs nothing in the vertex normals
      if (Math.abs(ny) / 2 < 0.01) { slivers++; continue }
      // a road-frame face is on the cambered road plane by construction and G3 measures its
      // height; only field-frame faces are judged against the field's tilt
      if (roadFace) continue
      const fn = fieldNormal((ax + bx + cx) / 3, (az + bz + cz) / 3)
      const dot = Math.abs((nx * fn[0] + ny * fn[1] + nz * fn[2]) / len)
      const tilt = (Math.acos(Math.min(1, dot)) * 180) / Math.PI
      if (tilt > worst) worst = tilt
      if (tilt > 10) steep++
    }
    let zero = 0
    if (nrm) for (const i of live) if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 1e-6) zero++
    console.log(`    ${padE(face.name, 18)} ${pad(face.tris, 7)}   ${pad(deg, 9)}   ${pad(zero, 11)}   ${pad(steep, 12)}   ${pad(fmt(worst, 1), 6)}°   ${pad(slivers, 8)}`)
    rows.push({ name: face.name, tris: face.tris, zeroArea: deg, zeroNormal: zero, steep, worst: Number(fmt(worst, 1)), slivers })
  }
  out.guards.G4 = rows
  for (const r of rows) {
    check('G4', `${r.name}.zeroNormal`, r.zeroNormal)
    check('G4', `${r.name}.zeroArea`, r.zeroArea)
    // the kerbs are a profile (a 30° back edge by design), not a sheet: their tilt is judged against the declared profile from P4
    if (r.name !== 'kerbs') check('G4', `${r.name}.steep`, r.steep, 0, `(worst ${r.worst}°)`)
  }
  guardEnd('G4')
}

// ================================================================ G5 — field continuity
if (runs('G5')) {
  guardStart('G5', 'field continuity — Terrain.heightAt jumps (> 8 mm and > 3× the neighbouring steps), crossover excluded')
  const jumps = []
  let series = 0, points = 0
  const scan = (pts, label) => {
    // pts: [{s, side, off, h}] contiguous in one series
    series++
    points += pts.length
    const steps = []
    for (let i = 0; i < pts.length - 1; i++) steps.push(Math.abs(pts[i + 1].h - pts[i].h))
    for (let i = 1; i < pts.length - 2; i++) {
      const d = pts[i + 1].h - pts[i].h
      const a = Math.abs(d)
      if (a <= 0.008) continue
      const nb = Math.max(steps[i - 1], steps[i + 1])
      if (a <= 3 * nb) continue
      // a slope starting (the embankment toe, a smoothstep end) is a step that grows over the next
      // samples, not a jump: compare with the median step over the surrounding 16 samples
      const win = steps.slice(Math.max(0, i - 8), Math.min(steps.length, i + 9)).sort((p, q) => p - q)
      const med = win[Math.floor(win.length / 2)]
      if (a <= Math.max(3 * med, 0.008) || (a < 0.05 && a < 4 * med)) continue
      jumps.push({ s: pts[i].s, side: pts[i].side, off: pts[i].off, mm: d * 1000, dir: label })
    }
  }
  // along s at 0.125 m: off 3, 12 and W−1 on both sides
  for (const side of [1, -1]) {
    for (const offSpec of [3, 12, 'W-1']) {
      let cur = []
      for (let s = 0; s < L; s += 0.125) {
        const W = ground.runoffWidth(s, side)
        const off = offSpec === 'W-1' ? W - 1 : offSpec
        if (off > W || off < 0.5 || inCross(s)) { if (cur.length) scan(cur, `s@${offSpec}`); cur = []; continue }
        track.pointAt(s, side * (track.halfWidthAt(s) + off), _v, 0)
        cur.push({ s, side, off, h: terrain.heightAt(_v.x, _v.z) })
      }
      if (cur.length) scan(cur, `s@${offSpec}`)
    }
  }
  const alongN = points
  // across the verge at 0.25 m, every 4 m of s (1 m is the plan's figure; 4 m keeps the run inside its budget today)
  for (let s = 0; s < L; s += 4) {
    if (inCross(s)) continue
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const W = ground.runoffWidth(s, side)
      const cur = []
      for (let off = 0.05; off <= W; off += 0.25) {
        track.pointAt(s, side * (hw + off), _v, 0)
        cur.push({ s, side, off, h: terrain.heightAt(_v.x, _v.z) })
      }
      if (cur.length) scan(cur, 'lat')
    }
  }
  jumps.sort((a, b) => Math.abs(b.mm) - Math.abs(a.mm))
  const cliffs = jumps.filter((j) => Math.abs(j.mm) > 500).length
  console.log(`    ${points} field samples in ${series} series (${alongN} along s, ${points - alongN} across); ${jumps.length} jumps, ${cliffs} of them over 0.5 m`)
  console.log('    worst:   s       side  off     mm   series   section')
  for (const j of jumps.slice(0, 10)) console.log(`      ${pad(fmt(j.s, 1), 7)}   ${sideCh(j.side)}   ${pad(fmt(j.off, 1), 5)} ${pad(fmt(j.mm, 0), 6)}   ${padE(j.dir, 7)}  ${sectionOf(j.s)}`)
  out.guards.G5 = { points, jumps: jumps.length, cliffs, worst: jumps.slice(0, 10) }
  check('G5', 'jumps', jumps.length)
  guardEnd('G5')
}

// ================================================================ G6 / G7 — the terrain through a sheet, and max edge (per tier)
if (runs('G6') || runs('G7')) {
  guardStart('G6', `terrain through a registered sheet (G6) and longest XZ edge (G7) — tier ${TIER}`)
  const maxEdgeLimit = (TIER === 'low' ? 18.056 : 13.542) / 2
  const N = 4
  const rows = []
  for (const face of faces) {
    if (!face.registered) continue
    const T = face.T
    let samples = 0, under = 0, worst = 0, maxEdge = 0
    for (let t = 0; t < face.tris; t++) {
      const o = t * 9
      const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8]
      const longest = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz))
      if (longest > maxEdge) maxEdge = longest
      if (!face.live[t]) continue
      for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
        const u = i / N, v = j / N, w = 1 - u - v
        const clearance = ay * w + by * u + cy * v - terrain.meshHeightAt(ax * w + bx * u + cx * v, az * w + bz * u + cz * v)
        samples++
        if (clearance < 0) { under++; if (-clearance > worst) worst = -clearance }
      }
    }
    rows.push({ name: face.name, tris: face.tris, pct: samples ? (100 * under) / samples : 0, worst, maxEdge, flat: face.reg.flat })
  }
  rows.sort((a, b) => b.pct - a.pct || b.maxEdge - a.maxEdge)
  console.log('    sheet                tris   terrain above   worst      longest XZ edge')
  for (const r of rows) console.log(`    ${padE(r.name, 18)} ${pad(r.tris, 7)}   ${pad(fmt(r.pct, 2), 8)} %   ${pad(fmt(r.worst, 3), 6)} m   ${pad(fmt(r.maxEdge, 1), 6)} m${r.maxEdge > maxEdgeLimit && !r.flat ? ' <<' : ''}${r.flat ? ' (flat)' : ''}`)
  console.log(`    ${terrain.groundSheets.length} sheets registered, ${terrain.clamped.size} clamped; settle() took ${fmt(terrain.settleMs)} ms; edge limit ${fmt(maxEdgeLimit, 2)} m`)
  const capped = {}
  for (const c of terrain.clampCapped) {
    const d = terrain.distanceToTrack(c.x, c.z, 400)
    const cur = capped[c.name]
    if (!cur || c.needed > cur.needed) capped[c.name] = { needed: c.needed, s: d.s, lat: d.lateral, n: (cur?.n ?? 0) + 1 }
    else cur.n++
  }
  for (const [name, c] of Object.entries(capped).sort((a, b) => b[1].needed - a[1].needed)) console.log(`      maxDrop refused a ${fmt(c.needed, 2)} m cut under ${name} at s≈${fmt(c.s, 0)} lat ${fmt(c.lat, 0)} (${c.n} nodes) — G6 says whether it shows`)
  out.guards.G6 = rows.map((r) => ({ name: r.name, pct: Number(fmt(r.pct, 2)), worst: Number(fmt(r.worst, 3)), maxEdge: Number(fmt(r.maxEdge, 1)) }))
  if (runs('G6')) {
    for (const r of rows) check('G6', r.name, Number(fmt(r.pct, 2)), 0, `(worst ${fmt(r.worst, 3)} m)`, 'pct')
    check('G6', 'unclamped', terrain.groundSheets.length - terrain.clamped.size)
  }
  if (runs('G7')) for (const r of rows) if (!r.flat) check('G7', r.name, Number(fmt(r.maxEdge, 1)), Number(fmt(maxEdgeLimit, 2)), `(half the ${fmt(maxEdgeLimit * 2, 1)} m grid)`, 'm')
  guardEnd('G6')
  if (runs('G7')) out.ms.G7 = 0 // shares G6's pass; recorded so its allowances are audited as "ran"
}

// ================================================================ G8 — registration, from the geometry
if (runs('G8')) {
  guardStart('G8', 'registration — horizontal geometry at ground level that is not a registered face')
  const FURNITURE = ['stand', 'terrace', 'furniture', 'props', 'concrete', 'pitRails', 'terrain']
  const allowListed = (o) => { for (let p = o; p; p = p.parent) if (p.name && FURNITURE.some((pre) => p.name.startsWith(pre))) return true; return false }
  root.updateMatrixWorld(true)
  const rows = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes?.position) return
    if (o.geometry.userData.groundReg || o.userData.decal || DECAL_NAMES.has(o.name)) return
    if (o.material?.transparent && o.material?.depthWrite === false) return
    if (allowListed(o)) return
    const pos = o.geometry.attributes.position
    const n = triCountOf(o.geometry)
    let flat = 0, near = 0
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(pos, vertexOf(o.geometry, t, 0)).applyMatrix4(o.matrixWorld)
      b.fromBufferAttribute(pos, vertexOf(o.geometry, t, 1)).applyMatrix4(o.matrixWorld)
      c.fromBufferAttribute(pos, vertexOf(o.geometry, t, 2)).applyMatrix4(o.matrixWorld)
      const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
      const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)
      const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const len = Math.hypot(nx, ny, nz)
      // upward-facing only (a box's bottom face is not a surface anyone sees), within 60 m of the road
      if (len < 1e-9 || ny / len < 0.9) continue
      const area = len / 2
      flat += area
      const x = (a.x + b.x + c.x) / 3, z = (a.z + b.z + c.z) / 3, y = (a.y + b.y + c.y) / 3
      if (terrain.distanceToTrack(x, z, 75).i < 0) continue
      const top = topAt(x, z)
      const g = Math.max(top ? top.y : -Infinity, terrain.meshHeightAt(x, z))
      if (Math.abs(y - g) <= 0.3) near += area
    }
    if (near > 0.5) rows.push({ name: o.name || `(unnamed ${n} tris in ${o.parent?.name || 'root'})`, tris: n, flat, near })
  })
  rows.sort((a, b) => b.near - a.near)
  console.log('    mesh                                    tris   horizontal m²   at ground m²')
  for (const r of rows) console.log(`    ${padE(r.name, 38)} ${pad(r.tris, 7)}   ${pad(Math.round(r.flat), 13)}   ${pad(fmt(r.near, 1), 12)}${r.near >= 5 ? ' <<' : ''}`)
  out.guards.G8 = rows.map((r) => ({ name: r.name, near: Number(fmt(r.near, 1)) }))
  for (const r of rows) if (r.near >= 5) check('G8', r.name, Number(fmt(r.near, 1)), 0, '', 'm2')

  // G8b — source lints: ground-looking mesh names that never reach the registry, and R13 imports
  const files = ['track-mesh', 'surfaces', 'lanes', 'props', 'pit-complex', 'stands', 'environment']
  const groundLike = /^(asphalt|runoff[A-Za-z]*|gravel|surface-[a-z]+|surfacePatches|pitLane|pitApron|lanePaving|laneKerbs|secondaryPaving|paddockAsphalt|helipad)$/
  const declared = new Set(faces.map((f) => f.name))
  const found = new Set()
  for (const f of files) for (const m of readFileSync(path.join(ROOT, `app/three/${f}.ts`), 'utf8').matchAll(/'([A-Za-z][A-Za-z0-9-]*)'/g)) if (groundLike.test(m[1])) found.add(m[1])
  const unregistered = [...found].filter((n) => !declared.has(n) && n !== 'surfacePatches')
  // the patch meshes are named `surface-${kind}` at runtime and registered as 'surfacePatches'
  const gone = [...declared].filter((n) => n !== 'kerbs' && !found.has(n) && !(n.startsWith('surface-') && found.has('surfacePatches')))
  console.log(`    G8b name lint: ${found.size} ground-looking names in the builders, ${declared.size} faces; unregistered [${unregistered.join(', ')}], blind [${gone.join(', ')}]`)
  check('G8', 'nameLint.unregistered', unregistered.length, 0, `[${unregistered.join(', ')}]`)
  check('G8', 'nameLint.blind', gone.length, 0, `[${gone.join(', ')}]`)
  // R13: this file's own imports against ALLOWED_IMPORTS (the patterns are built from strings so they do not match themselves)
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const imported = new Set()
  for (const m of self.matchAll(new RegExp(String.raw`import\(path\.join\(ROOT, '([^']+)'\)\)`, 'g'))) imported.add(m[1])
  for (const m of self.matchAll(new RegExp(String.raw`^import .* from '([^']+)'`, 'gm'))) if (!m[1].startsWith('node:')) imported.add(m[1])
  for (const m of self.matchAll(new RegExp(String.raw`readFileSync\(path\.join\(ROOT, '([^']+)'\)`, 'g'))) if (m[1].endsWith('.json')) imported.add(m[1])
  const foreign = [...imported].filter((i) => !ALLOWED_IMPORTS.includes(i))
  console.log(`    G8b imports: ${imported.size} modules, foreign [${foreign.join(', ')}]`)
  check('G8', 'imports.foreign', foreign.length, 0, `[${foreign.join(', ')}] — R13: the guard reads data, ground.ts, trackside.ts, track-mesh.ts (temporary) and the built scene only`)
  guardEnd('G8')
}

// ================================================================ G9 — seams (STUB until P3)
if (runs('G9')) {
  guardStart('G9', 'seams — shared boundary vertices bit-identical across faces')
  console.log('    no shared-boundary faces until P3 (the raster of ground-mesh.ts); nothing to measure')
  out.guards.G9 = { stub: true }
  guardEnd('G9')
}

// ================================================================ G10 — residue (A1 coverage)
if (runs('G10')) {
  guardStart('G10', 'residue — declared RUNOFF_ZONES band that no ribbon or patch draws (m² per zone|side)')
  const rings = spec.SURFACE_PATCHES.map((p) => trackside.patchOutline(track, p, 2))
  const zoneAt = (s) => spec.RUNOFF_ZONES.find((z) => inFwd(z.sRange[0], z.sRange[1], s))
  const DS = 0.5, DL = 0.5
  const cellsOut = []
  for (let s = 0; s < L; s += DS) {
    if (inCross(s)) continue
    const z = zoneAt(s)
    if (!z) continue
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1]) {
      const b = side > 0 ? z.left : z.right
      const want = Math.max(b.asphalt?.[1] ?? 0, b.grass?.[1] ?? 0, b.gravel?.[1] ?? 0)
      const rw = ground.runoffWidth(s, side)
      let have = hw + rw
      if (b.gravel) have = Math.max(have, Math.min(b.gravel[1], hw + (rw * tmMod.RUNOFF_MAX_LAT) / RUNOFF_WIDTH))
      if (want <= have + 0.5) continue
      const cap = rw >= RUNOFF_WIDTH - 0.01 ? 'WIDTH' : 'FOLD'
      for (let off = have + 0.5; off < want; off += DL) {
        track.pointAt(s, side * off, _v, 0)
        if (!rings.some((r) => inRing(_v.x, _v.z, r))) cellsOut.push({ s, side, cap, zone: z.name, want, have })
      }
    }
  }
  const runsOut = []
  for (const c of cellsOut) {
    const last = runsOut[runsOut.length - 1]
    if (last && last.side === c.side && last.zone === c.zone && forwardDelta(last.to, c.s, L) <= 2) {
      last.to = c.s; last.m2 += DS * DL; last.want = Math.max(last.want, c.want); last.have = Math.min(last.have, c.have)
      if (c.cap === 'FOLD') last.cap = 'FOLD'
    } else runsOut.push({ from: c.s, to: c.s, side: c.side, cap: c.cap, zone: c.zone, want: c.want, have: c.have, m2: DS * DL })
  }
  const perKey = new Map()
  for (const r of runsOut) {
    const k = `${r.zone}|${sideCh(r.side)}`
    const e = perKey.get(k) ?? { m2: 0, runs: 0, cap: r.cap, from: r.from, to: r.to }
    e.m2 += r.m2; e.runs++; e.to = r.to
    if (r.cap === 'FOLD') e.cap = 'FOLD'
    perKey.set(k, e)
  }
  const area = runsOut.reduce((a, r) => a + r.m2, 0)
  console.log('    zone|side                       cap      m²   runs   s-range')
  for (const [k, e] of [...perKey.entries()].sort((a, b) => b[1].m2 - a[1].m2)) console.log(`    ${padE(k, 30)} ${padE(e.cap, 5)} ${pad(Math.round(e.m2), 6)}   ${pad(e.runs, 4)}   ${Math.round(e.from)}-${Math.round(e.to)}`)
  console.log(`    total ${Math.round(area)} m² in ${runsOut.length} runs`)
  out.guards.G10 = Object.fromEntries([...perKey.entries()].map(([k, e]) => [k, { m2: Math.round(e.m2), cap: e.cap }]))
  for (const [k, e] of perKey) check('G10', k, Math.round(e.m2), 0, `(${e.cap})`, 'm2')
  guardEnd('G10')
}

// ================================================================ G11 — drops along a swept ribbon's edge columns
if (runs('G11')) {
  guardStart('G11', 'drops — station-to-station Δy > 0.5 m along one edge column of a swept ribbon')
  /**
   * A drop the field itself has at the same column is ground — a stand platform (stands.ts
   * facilityRelief), a basin bank — and is counted apart; what is left is the sheet chording
   * across something the field does not do.
   */
  const rows = []
  for (const name of ['runoffL', 'runoffR', 'runoffAsphaltL', 'runoffAsphaltR', 'gravel']) {
    const face = faces[faceIdx[name]]
    if (!face) continue
    const idx = face.geo.getIndex()
    const pos = face.geo.attributes.position
    // profileRibbonGeometry: vertex = station·E + edge, first triangle (0, E, 1)
    const E = idx.getX(1)
    const seen = new Set()
    let drops = 0, relief = 0
    const worst = []
    for (let t = 0; t < face.tris; t++) {
      if (!face.live[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = face.vidx[t * 3 + k], b = face.vidx[t * 3 + ((k + 1) % 3)]
        if (Math.abs(a - b) !== E) continue
        const lo = Math.min(a, b)
        if (seen.has(lo)) continue
        seen.add(lo)
        const dy = Math.abs(pos.getY(a) - pos.getY(b))
        if (dy <= 0.5) continue
        // the field has the same drop there → it is ground (a stand platform, a basin bank), not the sheet
        const pa = sOf(pos.getX(a), pos.getZ(a)), pb = sOf(pos.getX(b), pos.getZ(b))
        if (pa && pb) {
          const fa = ground.field.yAt(pa.s, pa.lateral), fb = ground.field.yAt(pb.s, pb.lateral)
          if (Math.abs(fa - fb) > 0.4) { relief++; continue }
        }
        drops++
        const d = sOf(pos.getX(a), pos.getZ(a))
        worst.push({ s: d?.s ?? -1, lat: d?.lateral ?? 0, mm: dy * 1000, col: lo % E })
      }
    }
    worst.sort((a, b) => b.mm - a.mm)
    rows.push({ name, E, drops, relief, worst: worst.slice(0, 5) })
    console.log(`    ${padE(name, 16)} E=${E}  drops ${pad(drops, 5)}  (field drops ${pad(relief, 4)})  ${worst.slice(0, 5).map((w) => `s${Math.round(w.s)} lat${Math.round(w.lat)} ${Math.round(w.mm)}mm·${secShort(w.s)}`).join('  ')}`)
  }
  out.guards.G11 = rows
  for (const r of rows) check('G11', r.name, r.drops)
  guardEnd('G11')
}

// ================================================================ G12 — plan integrity (STUB until P2)
if (runs('G12')) {
  guardStart('G12', 'plan integrity — intervals tile [0, W], tag chains agree, ring crossings even')
  console.log('    no ground-plan until P2; nothing to measure')
  out.guards.G12 = { stub: true }
  guardEnd('G12')
}

// ================================================================ allowance hygiene and the report
{
  const seenKeys = new Set()
  for (const a of ALLOWANCES) {
    const k = `${a.guard}|${a.key}`
    if (seenKeys.has(k)) fail(`ALLOWANCES: duplicate entry ${k}`)
    seenKeys.add(k)
    if (!PHASES.includes(a.until)) fail(`ALLOWANCES: ${k} has an unknown phase "${a.until}"`)
    else if (phaseIdx(a.until) <= phaseIdx(PHASE)) fail(`ALLOWANCES: ${k} expired (until ${a.until}, phase ${PHASE}) — remove the cause or the entry`)
    if (typeof a.bound !== 'number' || !a.why) fail(`ALLOWANCES: ${k} needs a numeric bound and a why`)
  }
  const ranGuards = new Set(Object.keys(out.ms))
  const unused = ALLOWANCES.filter((a) => ranGuards.has(a.guard) && !usedAllowance.has(a))
  if (unused.length) console.log(`\n${unused.length} allowance(s) not needed on this tier (may be removable once both tiers agree): ${unused.map((a) => `${a.guard} ${a.key}`).join(', ')}`)
  const perGuard = {}
  for (const a of ALLOWANCES) perGuard[a.guard] = (perGuard[a.guard] ?? 0) + 1
  console.log(`\nallowances: ${ALLOWANCES.length} (${Object.entries(perGuard).map(([g, n]) => `${g} ${n}`).join(', ')}), ${usedAllowance.size} used`)
  console.log(`guard ms: ${Object.entries(out.ms).map(([g, ms]) => `${g} ${ms}`).join('  ')}  (build ${built}, total ${Date.now() - tBuild})`)
  if (SUGGEST && suggestions.length) {
    console.log('\n--suggest: entries that would cover the failing keys (add a why and an until):')
    for (const s of suggestions) console.log(`  { guard: '${s.guard}', key: ${JSON.stringify(s.key)}, bound: ${s.bound}, why: WHY.?, until: '?' }, // measured ${s.measured}`)
  }
  out.suggestions = suggestions
  out.allowances = { total: ALLOWANCES.length, perGuard, used: usedAllowance.size, unused: unused.map((a) => `${a.guard} ${a.key}`) }
  if (JSON_OUT) { writeFileSync(JSON_OUT, `${JSON.stringify(out, null, 2)}\n`); console.log(`measured numbers written to ${JSON_OUT}`) }
  if (notes.length) console.log(`\n${notes.length} note(s):\n  - ${notes.join('\n  - ')}`)
  if (errors.length) {
    console.log(`\n${errors.length} error(s):\n  - ${errors.join('\n  - ')}`)
    if (STRICT) process.exit(1)
  }
  console.log(`\nsurface-check: ${errors.length ? 'FAILED' : 'OK'}${STRICT ? ' (strict)' : ''}`)
}
