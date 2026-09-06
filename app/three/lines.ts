import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CIRCUIT } from '~/data/suzuka'
import { EDGE_LINE_GAPS, LINES, type LineDef } from '~/data/suzuka-barriers-spec'
import { alongAt, garageS, type Side } from '~/data/suzuka-facilities-spec'
import { forwardDelta, type Track } from '~/sim/track'
import type { Ground } from './ground'
import { FLAT_STRIP, STRIP_DROP } from './ground'

type Fn = (s: number) => number

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

/** Painted lines sit this far above the surface they are on (plus polygon offset). */
const LIFT = 0.012
/** Half-width a line keeps on screen however far away it is (pixels at the render resolution). */
const MIN_HALF_PX = 0.6

/**
 * All painted markings of the circuit in one mesh: the continuous edge lines of the whole lap, the
 * pit lane's limit / divider / box lines, the pit entry and exit lines with their merge tapers, the
 * grid slots and the start line.
 *
 * They are GEOMETRY, not texture. The edge lines used to be baked into the asphalt tile
 * (asphaltMaps): 15 cm of a 13 m tile is 24 of 2048 texels, so anisotropic minification erased them
 * a few car lengths away and the overview and heli cameras showed a circuit with no markings at all.
 *
 * A 15 cm ribbon is also thinner than a pixel from those cameras, so the vertex shader widens each
 * line until its half-width covers MIN_HALF_PX pixels: `aAcross` is the unit vector across the line
 * and `aHalf` the signed half-width in metres, and the offset is applied in view depth, so the
 * paint keeps its real size in close-ups and stays visible from the air.
 */
export function buildLines(track: Track, ground: Ground): THREE.Mesh {
  const L = track.length
  const pit = CIRCUIT.pit
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const geos: THREE.BufferGeometry[] = []

  /** height of the surface the paint lies on: the flat strip under the kerbs, else the road plane */
  const surfaceY = (s: number, lat: number): number => {
    const off = Math.abs(lat) - hwAt(s)
    if (off <= 0) return LIFT
    return (off <= FLAT_STRIP ? STRIP_DROP : ground.yAt(s, lat)) + LIFT
  }

  /**
   * One painted stripe of width `w` centred on `lat(s)` from s0 to s1, with the across-vector and
   * half-width attributes the widening shader needs.
   */
  const stripe = (s0: number, s1: number, lat: Fn, w: number, step = 2) => {
    const len = forwardDelta(s0, s1, L) || L
    const segs = Math.max(1, Math.ceil(len / step))
    const pos = new Float32Array((segs + 1) * 6)
    const across = new Float32Array((segs + 1) * 4)
    const half = new Float32Array((segs + 1) * 2)
    const uv = new Float32Array((segs + 1) * 4)
    const idx: number[] = []
    for (let i = 0; i <= segs; i++) {
      const d = (i / segs) * len
      const s = s0 + d
      const c = lat(s)
      const y = surfaceY(s, c)
      track.pointAt(s, c + w / 2, _a, y)
      track.pointAt(s, c - w / 2, _b, y)
      const k = i * 2
      pos.set([_a.x, _a.y, _a.z, _b.x, _b.y, _b.z], k * 3)
      // unit vector from the right edge to the left edge, in world xz
      const dx = _a.x - _b.x, dz = _a.z - _b.z
      const inv = 1 / (Math.hypot(dx, dz) || 1)
      across.set([dx * inv, dz * inv, dx * inv, dz * inv], k * 2)
      half.set([w / 2, -w / 2], k)
      uv.set([0, d, 1, d], k * 2)
      if (i < segs) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aAcross', new THREE.BufferAttribute(across, 2))
    g.setAttribute('aHalf', new THREE.BufferAttribute(half, 1))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    geos.push(g)
  }
  /** a stripe broken into `on`/`off` metre dashes */
  const dashed = (s0: number, s1: number, lat: Fn, w: number, on: number, off: number) => {
    const len = forwardDelta(s0, s1, L) || L
    for (let d = 0; d + on <= len; d += on + off) stripe(s0 + d, s0 + d + on, lat, w, on)
  }
  /** a line across the road (start line, pit exit line) */
  const across = (s: number, latA: number, latB: number, w: number) => {
    const lat = (latA + latB) / 2
    const half = Math.abs(latA - latB) / 2
    stripe(s - w / 2, s + w / 2, () => lat, half * 2, w)
  }

  // --- the lap's edge lines, interrupted where a lane leaves or joins ------------------------
  for (const side of [1, -1] as Side[]) {
    const gaps = EDGE_LINE_GAPS.filter((g) => g.side === side)
    const inGap = (s: number) => gaps.some((g) => forwardDelta(g.sRange[0], s, L) <= forwardDelta(g.sRange[0], g.sRange[1], L))
    const lat: Fn = (s) => side * (hwAt(s) - 0.1)
    let from: number | null = null
    for (let s = 0; s <= L; s += 2) {
      const gap = s < L && inGap(track.wrap(s))
      if (!gap && from === null) from = s
      if ((gap || s >= L) && from !== null) {
        if (s - from > 3) stripe(from, s - 2, lat, 0.15, 4)
        from = null
      }
    }
  }

  // --- the table's own lines (pit entry / exit, the lane markings) ---------------------------
  for (const ln of LINES) {
    if (ln.lateral === 'left-edge' || ln.lateral === 'right-edge') continue
    const w = ln.width ?? 0.15
    if (ln.lateralTo !== undefined) {
      across(ln.sRange[0], ln.lateral as number, ln.lateralTo, w)
      continue
    }
    const lat: Fn = (s) => alongAt(ln.lateral as Exclude<LineDef['lateral'], 'left-edge' | 'right-edge'>, s, ln.sRange)
    if (ln.dash) dashed(ln.sRange[0], ln.sRange[1], lat, w, ln.dash[0], ln.dash[1])
    else stripe(ln.sRange[0], ln.sRange[1], lat, w, 3)
  }

  // --- pit lane: the two speed-limit lines and the box outlines ------------------------------
  const pitLat = (s: number) => track.pitLateralAt(s) ?? pit.laneOffset
  const halfLane = pit.laneWidth / 2
  for (const s of [pit.limitStartS, pit.limitEndS]) across(s, pitLat(s) + halfLane, pitLat(s) - halfLane, 0.6)
  for (let t = 0; t < 11; t++) {
    const s = garageS(t)
    const lat = pit.laneOffset - 2.5
    stripe(s - 3.5, s + 3.5, () => lat + 2.05, 0.3, 3.5)
    stripe(s - 3.5, s + 3.5, () => lat - 2.05, 0.3, 3.5)
    across(s - 3.35, lat + 2.2, lat - 2.2, 0.3)
  }

  // --- grid slots and the start line ----------------------------------------------------------
  for (let k = 0; k < 22; k++) {
    const s = track.wrap(-(14 + 8 * k))
    const lat = k % 2 === 0 ? 2.6 : -2.6
    stripe(s - 2.6, s + 2.6, () => lat + 1.475, 0.25, 2.6)
    stripe(s - 2.6, s + 2.6, () => lat - 1.475, 0.25, 2.6)
    across(s + 2.5, lat + 1.6, lat - 1.6, 0.2)
  }
  stripe(L - 0.5, 0.5, () => 0, 2 * hwAt(0), 0.5)

  const mat = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  addScreenWidth(mat)
  const merged = mergeGeometries(geos, false)!
  for (const g of geos) g.dispose()
  const mesh = new THREE.Mesh(merged, mat)
  mesh.name = 'whiteLines'
  mesh.receiveShadow = true
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  return mesh
}

/** Uniform shared by every widening material, updated once per frame from the renderer size. */
const viewportH = { value: 1080 }

export function setLineViewportHeight(px: number) {
  viewportH.value = Math.max(1, px)
}

/**
 * Vertex patch that stops a thin painted line from disappearing under a pixel: the metres one pixel
 * covers at this vertex's view depth is `2·(-viewZ) / (P[1][1]·viewportHeight)`, and where the line's
 * real half-width is smaller than MIN_HALF_PX of those, the vertex is pushed out along `aAcross`.
 * Installed before setupMaterials so it chains under the CSM hook (see scene.ts).
 */
function addScreenWidth(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uViewportH = viewportH
    shader.uniforms.uMinHalfPx = { value: MIN_HALF_PX }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aAcross;
        attribute float aHalf;
        uniform float uViewportH;
        uniform float uMinHalfPx;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 lineMv = modelViewMatrix * vec4(transformed, 1.0);
          float mPerPx = 2.0 * max(-lineMv.z, 0.001) / (projectionMatrix[1][1] * uViewportH);
          float want = uMinHalfPx * mPerPx;
          float have = abs(aHalf);
          if (want > have) transformed.xz += aAcross * (sign(aHalf) * (want - have));
        }`)
  }
  mat.customProgramCacheKey = () => 'line'
}
