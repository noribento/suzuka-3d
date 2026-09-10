/**
 * Layouts of the baked impostor atlases the runtime shader in app/three/impostor.ts reads: the
 * spectators (mirrored from ~/data/crowd-atlas.ts, baked), and the trees and parked cars
 * (placeholders until scripts/assets/bake-crowd-atlas.mjs `--set trees|cars` bakes them in C2).
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
 * Trees (`tex/tree_atlas`, baked in C2 from the trees_*.glb prototypes): 8 yaws × 2 elevations,
 * the two bands stacked as consecutive rows (row 2·k = low camera, 2·k + 1 = high camera of
 * species k). The mask R channel marks the foliage so the season tint (aTint0 rgb) leaves the
 * trunk alone. Cell 24 m: the widest canopy in the pack is ≈ 20 m. Placeholder numbers — the
 * bake writes the final ones.
 */
export const TREE_LAYOUT: ImpostorLayout = {
  width: 2048,
  height: 4096,
  cell: 256,
  cols: 8,
  rows: 16,
  yaws: 8,
  elevations: [8, 40],
  bandAxis: 'rows',
  cellM: 24,
  padM: 0.5,
  quadW: 1.0,
  modelScale: 1,
  rowsMeta: { subjects: 8, variants: 1, note: 'baked in C2: species k at rows 2k (low camera) and 2k + 1 (high camera)' },
}

/**
 * Parked cars and coaches (`tex/car_atlas`, baked in C2 from ~/three/car-bodies.ts): 8 yaws × 1
 * elevation, one row per body. The mask R channel marks the paintwork, tinted from aTint0 rgb
 * like an instanceColor; glass, tyres and lights stay as baked. Cell 16 m: a 12 m coach fits
 * with the quad at 80 % of the cell. Placeholder numbers — the bake writes the final ones.
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
  rowsMeta: { subjects: 6, variants: 1, note: 'baked in C2: minivan, kei wagon, SUV, hatchback, saloon, coach; rows 6–7 spare' },
}
