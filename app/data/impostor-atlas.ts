/**
 * Layouts of the baked impostor atlases the runtime shader in app/three/impostor.ts reads: the
 * spectators (mirrored from ~/data/crowd-atlas.ts, baked by scripts/assets/bake-crowd-atlas.mjs),
 * the parked cars (baked by scripts/assets/bake-car-atlas.mjs) and the trees (baked by
 * scripts/assets/bake-tree-atlas.mjs).
 * Every layout describes the same thing: a grid of `cell` px cells, one ROW per subject (or
 * per subject × variant), `yaws` columns per elevation band (yaw 0 faces the camera, clockwise
 * seen from above), and where the second elevation band sits (`bandAxis`). A cell covers
 * `cellM` × `cellM` metres with the subject's base `padM` above the bottom edge, so one
 * fixed-size quad (`quadW` of the cell wide, see `impostorGeometry`) shows every subject at true
 * scale. Regenerate an atlas and update its layout together.
 */
import { CROWD_ATLAS } from './crowd-atlas'

export interface ImpostorLayout {
  /** atlas size (px) */
  width: number
  height: number
  /** cell edge (px) */
  cell: number
  cols: number
  rows: number
  /** yaw columns per elevation band (45° steps for 8) */
  yaws: number
  /** camera pitch of each elevation band (deg, looking down): 1 or 2 bands */
  elevations: readonly number[]
  /**
   * where the second elevation band lives: 'cols' = the next `yaws` columns of the same row
   * (crowd: 16 columns), 'rows' = the row after the band-0 row of the same subject
   */
  bandAxis: 'cols' | 'rows'
  /** metres covered by one cell edge */
  cellM: number
  /** the subject's base (feet / trunk / tyres) above the bottom edge of the cell (m) */
  padM: number
  /** fraction of the cell width the impostor quad covers (centred): trims transparent overdraw */
  quadW: number
  /** the bake's uniform scale from the source model's units to metres */
  modelScale: number
  /** what the rows hold */
  rowsMeta: {
    /** distinct subjects (figures / species / bodies) */
    subjects: number
    /** row blocks per subject (crowd: bare + cap); bands on the 'rows' axis multiply on top */
    variants: number
    note: string
  }
}

/**
 * Spectators: `tex/crowd_atlas/diff` + `/mask` (R shirt + cap, G pants, B skin), baked.
 * The widest figure (hands on hips, 0.92 m) fills less than half a 2 m cell: the quad covers the
 * middle 60 % of the cell's width, which cuts the transparent overdraw by 40 %.
 */
export const CROWD_LAYOUT: ImpostorLayout = {
  width: CROWD_ATLAS.width,
  height: CROWD_ATLAS.height,
  cell: CROWD_ATLAS.cell,
  cols: CROWD_ATLAS.cols,
  rows: CROWD_ATLAS.rows,
  yaws: CROWD_ATLAS.yaws,
  elevations: CROWD_ATLAS.elevDeg,
  bandAxis: 'cols',
  cellM: CROWD_ATLAS.cellM,
  padM: CROWD_ATLAS.padM,
  quadW: 0.6,
  modelScale: CROWD_ATLAS.modelScale,
  rowsMeta: { subjects: CROWD_ATLAS.figures, variants: 2, note: 'rows [0, figures) bare heads, [figures, 2·figures) the same figures with a cap' },
}

/**
 * Trees (`tex/tree_atlas`, baked by scripts/assets/bake-tree-atlas.mjs from the first variant's
 * LOD0 of every species in ~/data/tree-species.ts): 8 yaws × 2 elevations (10° and 45° cameras)
 * side by side in 16 columns like the crowd, one row per species (`TreeSpecies.row`), rows 11–15
 * spare. The mask's R channel marks the foliage, so the per-tree tint (aTint0, the species'
 * `tint` sample) leaves the trunk alone.
 *
 * Unlike the figures and the cars the rows are NOT at true scale: a species spans 4–20 m, so
 * every tree is baked to fill its 24 m cell (`TREE_CARD_ROW_HEIGHT_M` tall, the trunk base
 * `padM` above the bottom edge) and app/three/trees.ts scales the card instance by the
 * placement's height / the row's baked height — the base stays at the instance origin because
 * `impostorGeometry` puts it there.
 */
export const TREE_LAYOUT: ImpostorLayout = {
  width: 4096,
  height: 4096,
  cell: 256,
  cols: 16,
  rows: 16,
  yaws: 8,
  elevations: [10, 45],
  bandAxis: 'cols',
  cellM: 24,
  padM: 0.5,
  quadW: 1.0,
  modelScale: 1,
  rowsMeta: { subjects: 11, variants: 1, note: 'one row per TreeRole (tree-species.ts row), columns 0–7 the 10° band, 8–15 the 45° band; rows 11–15 spare' },
}

/**
 * Height (m) of each row's tree inside its atlas cell: the bake fits a tree to
 * `TREE_CARD_BAKE_M` tall unless it would be wider than the cell minus the padding, in which
 * case the width rules and the row is shorter. Mirrored from misc/dl/tex/tree_atlas/layout.json
 * `rows[].heightM` after every bake (the bake prints the array when a row deviates); the
 * placeholder is the bake height for every row.
 */
export const TREE_CARD_BAKE_M = 20
export const TREE_CARD_ROW_HEIGHT_M: readonly number[] = [20, 20, 20, 20, 20, 20, 20, 19.17, 19.09, 20, 20]

/**
 * Parked cars and coaches (`tex/car_atlas`, baked by scripts/assets/bake-car-atlas.mjs from
 * ~/three/car-bodies.ts, and with `--glb` from the pack's GLB bodies of ~/three/car-glb.ts for
 * the rows that have one): 8 yaws × 1 elevation (14°, the angle a 500–2200 m camera looks down
 * a car park at), one row per body in `CAR_BODIES` order, row 7 spare. The mask's R channel
 * marks the paintwork, tinted from aTint0 rgb the way instanceColor tints the 3D body inside
 * 500 m; glass, tyres and lamps stay as baked. `rowsMeta.note` mirrors `layout.json`'s `source`
 * per row (which rows the last bake took from a GLB and which from the procedural shells).
 *
 * ONE cellM for every row, not one per row: the shader and `impostorGeometry` read a single
 * `cellM`, and a per-row cell would need a per-instance quad scale (and a per-row padM) in
 * impostor.ts for the sake of one body. 16 m is the smallest cell that holds the 12 m coach at
 * every yaw (its half diagonal is 6.13 m, so it spans 12.3 m at 45°, inside the 12.8 m the quad
 * covers at quadW 0.8). A 4.7 m car is then only ≈ 38 px of a 128 px cell — still three times the
 * 11 px it covers on a 1080p screen at the 500 m where the cards take over from the bodies.
 */
export const CAR_LAYOUT: ImpostorLayout = {
  width: 1024,
  height: 1024,
  cell: 128,
  cols: 8,
  rows: 8,
  yaws: 8,
  elevations: [14],
  bandAxis: 'rows',
  cellM: 16,
  padM: 0.15,
  quadW: 0.8,
  modelScale: 1,
  rowsMeta: { subjects: 7, variants: 1, note: 'one row per body in CAR_BODIES order: minivan (glb), kei wagon (glb), SUV, hatchback, saloon, coach (glb), kei truck (glb); row 7 spare — source per row as in misc/dl/tex/car_atlas/layout.json of the last --glb bake' },
}
