/**
 * Codec and shape of the committed DEM grids (app/data/suzuka-dem.ts): a hand-written decoder
 * for the base64 int16-delta arrays the generator scripts write, plus the grid helpers the
 * height field and the audit scripts share. Works in Node (Buffer) and the browser (atob).
 *
 * Encoding (shared with the OSM surroundings tables so the codecs can be unified): the values
 * are integers; `delta[i] = value[i] − value[i − 1]` with `value[−1] = 0`, each delta stored as
 * a little-endian int16, the whole array base64-encoded. The encoder throws when a delta does
 * not fit int16, so decoding never has to guess.
 */

/** One axis-aligned elevation grid in the local EN frame (the CENTERLINE_EN frame). */
export interface DemGrid {
  /** E (local EN metres) of column 0; column i lies at e0 + i·step */
  e0: number
  /** N (local EN metres) of row 0 = the NORTHERN edge; row j lies at n0 − j·step (world z ascending) */
  n0: number
  /** node spacing in EN metres */
  step: number
  cols: number
  rows: number
  /** metres per LSB of the decoded integers (0.1 = decimetres) */
  unit: number
  /** LSB value that means sea (far grid only); decodeDem() turns it into 0 m ASL */
  sea?: number
  /** base64 of little-endian int16 deltas, row-major (columns by E ascending, rows by N descending) */
  data: string
}

/** Decode a base64 int16-delta array into the cumulative integer values. */
export function decodeI16Delta(b64: string): Int32Array {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer
  const bytes: Uint8Array = B ? B.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const n = bytes.length >> 1
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Int32Array(n)
  let v = 0
  for (let i = 0; i < n; i++) {
    v += view.getInt16(2 * i, true)
    out[i] = v
  }
  return out
}

/**
 * Decode a grid to metres ASL, row-major (`values[j * cols + i]`); sea cells become 0 m.
 * Throws when the payload length does not match cols × rows.
 */
export function decodeDem(g: DemGrid): Float32Array {
  const raw = decodeI16Delta(g.data)
  if (raw.length !== g.cols * g.rows) throw new Error(`DemGrid: ${raw.length} values for ${g.cols} × ${g.rows}`)
  const out = new Float32Array(raw.length)
  for (let k = 0; k < raw.length; k++) {
    const v = raw[k]!
    out[k] = g.sea !== undefined && v === g.sea ? 0 : v * g.unit
  }
  return out
}

/**
 * Fractional grid position of local EN metres (e, n): column `u = (e − e0) / step`, row
 * `v = (n0 − n) / step`. Not clamped — callers decide what to do outside the grid. World xz
 * maps to EN through Track.enScale: `e = x / enScale`, `n = −z / enScale`.
 */
export function demIndex(g: DemGrid, e: number, n: number): { u: number; v: number } {
  return { u: (e - g.e0) / g.step, v: (g.n0 - n) / g.step }
}

/** Bilinear sample of a decoded grid at EN (e, n), clamped to the grid's outermost nodes. */
export function demSample(g: DemGrid, values: Float32Array, e: number, n: number): number {
  const { u, v } = demIndex(g, e, n)
  const uc = Math.min(g.cols - 1, Math.max(0, u)), vc = Math.min(g.rows - 1, Math.max(0, v))
  const i = Math.min(g.cols - 2, Math.floor(uc)), j = Math.min(g.rows - 2, Math.floor(vc))
  const fu = uc - i, fv = vc - j
  const k = j * g.cols + i
  const a = values[k]! * (1 - fu) + values[k + 1]! * fu
  const b = values[k + g.cols]! * (1 - fu) + values[k + g.cols + 1]! * fu
  return a * (1 - fv) + b * fv
}
