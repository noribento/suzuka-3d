/**
 * Layout of the baked spectator impostor atlas (`tex/crowd_atlas/diff` + `/mask` in the asset
 * pack), mirrored from scripts/assets/bake-crowd-atlas.mjs so the runtime shader needs no JSON
 * fetch. Regenerate the atlas and update this file together.
 *
 * Atlas: 2048 × 4096, 128 px cells, one ROW per figure (row 0 at the top), 16 columns:
 * columns 0–7 = low camera (8° pitch), 8–15 = high camera (32°), yaw 0 faces the camera and
 * increases clockwise seen from above (45° steps). Rows 0–13 bare heads, rows 14–27 the same
 * figures wearing a cap. A cell covers CELL_M × CELL_M metres with the figure's feet PAD_M above
 * the bottom edge, so one fixed-size quad shows every figure at true scale.
 * `diff` = lit RGBA, clothing baked white / light grey; `mask` = R shirt + cap, G pants, B skin
 * (the channels the runtime tints per spectator).
 */
export const CROWD_ATLAS = {
  width: 2048,
  height: 4096,
  cell: 128,
  cols: 16,
  rows: 32,
  yaws: 8,
  elevs: 2,
  /** camera pitch of the two elevation bands (deg, looking down) */
  elevDeg: [8, 32] as const,
  /** metres covered by one cell edge */
  cellM: 2.0,
  /** feet above the bottom edge of the cell (m) */
  padM: 0.08,
  /** rows per variant block: rows [0, figures) bare, [figures, 2·figures) with a cap */
  figures: 14,
  /** the GLBs are authored at ≈ 2 units / m (male_standing is 3.832 tall): the bake's uniform scale to metres */
  modelScale: 1.78 / 3.832,
} as const

export interface CrowdFigure {
  id: string
  pose: 'sit' | 'stand'
  /** bounding height / width of the figure (m), for picking rows and for near-field LOD scale */
  height: number
  width: number
}

/** Row order of the bare-head block; the cap block repeats it at row + CROWD_ATLAS.figures. */
export const CROWD_FIGURES: CrowdFigure[] = [
  { id: 'male_sitting', pose: 'sit', height: 1.44, width: 0.66 },
  { id: 'male_sitting_cheering', pose: 'sit', height: 1.68, width: 0.74 },
  { id: 'female_sitting', pose: 'sit', height: 1.38, width: 0.66 },
  { id: 'female_sitting_cheering', pose: 'sit', height: 1.52, width: 0.68 },
  { id: 'male_standing', pose: 'stand', height: 1.78, width: 0.58 },
  { id: 'male_standing_waving', pose: 'stand', height: 2.08, width: 0.73 },
  { id: 'female_standing', pose: 'stand', height: 1.72, width: 0.47 },
  { id: 'woman_standing_waving', pose: 'stand', height: 1.95, width: 0.49 },
  { id: 'male_standing_hips', pose: 'stand', height: 1.78, width: 0.92 },
  { id: 'male_lookingup', pose: 'stand', height: 1.71, width: 0.92 },
  { id: 'female_standing_hips', pose: 'stand', height: 1.73, width: 0.67 },
  { id: 'female_lookingup', pose: 'stand', height: 1.67, width: 0.63 },
  { id: 'male_standing_coveringeyes', pose: 'stand', height: 1.79, width: 0.67 },
  { id: 'female_standing_coveringeyes', pose: 'stand', height: 1.75, width: 0.47 },
]

/** Flipbook pairs (rest row, cheer row) among the bare-head rows: a spectator alternates between them. */
export const CROWD_CHEER_PAIRS: [number, number][] = [
  [0, 1], // male sitting ↔ cheering
  [2, 3], // female sitting ↔ cheering
  [4, 5], // male standing ↔ waving
  [6, 7], // female standing ↔ waving
]
