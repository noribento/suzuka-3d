import { CIRCUIT } from '~/data/suzuka'

const az = (CIRCUIT.overviewAzimuthDeg * Math.PI) / 180
const sinA = Math.sin(az)
const cosA = Math.cos(az)

/**
 * Project a world point (x = east, z = south) into the 2D "broadcast map" frame
 * that matches the default overview camera orientation (main straight along the
 * bottom of the screen, cars travelling right → left).
 */
export function toMap(x: number, z: number): { mx: number; my: number } {
  const e = x
  const n = -z
  return {
    mx: -e * sinA + n * cosA,
    my: e * cosA + n * sinA,
  }
}

/** Unit vector (x, z) pointing from the track centre towards the overview camera. */
export function overviewDirection(): { x: number; z: number } {
  return { x: cosA, z: -sinA }
}
