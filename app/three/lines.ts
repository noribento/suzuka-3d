import * as THREE from 'three'
import { CIRCUIT } from '~/data/suzuka'
import { EDGE_LINE_GAPS, LINES, OFFSET_LANES, type LineDef } from '~/data/suzuka-barriers-spec'
import { alongAt, garageS, type Side } from '~/data/suzuka-facilities-spec'
import { forwardDelta, type Track } from '~/sim/track'
import { laneWorldPath, type LanePoint } from './trackside'
import { LAYER, markDecal, type Ground } from './ground'
import type { DecalQuad } from './ground-mesh'
import type { OwnerKind } from './ground-plan'

type Fn = (s: number) => number

const _a = new THREE.Vector3()

/** per-vertex attributes of a line: the across vector and signed half-width the widening shader needs, then uv */
const LINE_LAYOUT = [{ name: 'aAcross', size: 2 }, { name: 'aHalf', size: 1 }, { name: 'uv', size: 2 }] as const

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
 * and `aHalf` the signed offset from its centre in metres, and the offset is applied in view depth,
 * so the paint keeps its real size in close-ups and stays visible from the air.
 *
 * Every line is a DECAL on the drawn ground (ground.decal): the ground faces' own triangles under
 * the line's outline, clipped to it and lifted a rung of LAYER by the face's kind — so the paint
 * is coplanar with the face whatever its facets. A ribbon of its own chorded under the road's
 * folds (9 mm at the chicane, 21 mm across the pit lane) and the strip's ramp, and the old
 * (s, lateral) arithmetic that decided "on the pit lane" put every pit marking 68 mm under it.
 */
export function buildLines(track: Track, ground: Ground): THREE.Mesh {
  const L = track.length
  const pit = CIRCUIT.pit
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const quads: DecalQuad[] = []
  /** the rung over the face a line lies on: the racing surface, the pit lane and apron, or the verge */
  const rungOf = (kind: OwnerKind): number => (kind === 'road' ? LAYER.road.line : kind === 'pitLane' || kind === 'pitApron' ? LAYER.pit.line : LAYER.verge.line)

  const pitLat = (s: number) => track.pitLateralAt(s) ?? pit.laneOffset
  const halfLane = pit.laneWidth / 2

  /**
   * One painted stripe of width `w` centred on `lat(s)` from s0 to s1: one quad per row of the
   * plan's lattice (≤ `step` apart), so the outline follows the curve and each quad meets few
   * facets. The attributes come from the vertex's own (s, lateral) on this stretch of road.
   */
  const stripe = (s0: number, s1: number, lat: Fn, w: number, step = 2) => {
    const len = forwardDelta(s0, s1, L) || L
    const rows = ground.plan.lattice(s0, s1, step)
    for (let i = 0; i < rows.length - 1; i++) {
      const sa = rows[i]!, sb = rows[i + 1]!
      const ca = lat(sa), cb = lat(sb)
      const xz: number[] = []
      for (const [s, l] of [[sa, ca - w / 2], [sa, ca + w / 2], [sb, cb + w / 2], [sb, cb - w / 2]] as const) {
        track.pointAt(s, l, _a, 0)
        xz.push(_a.x, _a.z)
      }
      // the road plane: the face this line lies on is within DECAL_LAYER of it (under the bridge
      // the deck is not)
      track.pointAt((sa + sb) / 2, (ca + cb) / 2, _a, 0)
      quads.push({
        xz,
        yHint: _a.y,
        attrs: (x, z) => {
          const p = track.nearestOnRange(x, z, sa, sb, 2)
          const h = track.headingAt(p.s)
          const half = p.lateral - lat(p.s)
          let d = forwardDelta(s0, p.s, L)
          if (d > len + 10) d -= L
          // across = the frame's left normal (from the right edge to the left edge); u 0 at the left edge
          return [h.tz, -h.tx, half, 0.5 - half / w, d]
        },
      })
    }
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
  for (const s of [pit.limitStartS, pit.limitEndS]) across(s, pitLat(s) + halfLane, pitLat(s) - halfLane, 0.6)
  for (let t = 0; t < 11; t++) {
    const s = garageS(t)
    const lat = pit.laneOffset - 2.5
    stripe(s - 3.5, s + 3.5, () => lat + 2.05, 0.3, 3.5)
    stripe(s - 3.5, s + 3.5, () => lat - 2.05, 0.3, 3.5)
    across(s - 3.35, lat + 2.2, lat - 2.2, 0.3)
  }

  // --- edge lines of the two-wheel chicanes and the slip roads --------------------------------
  for (const def of OFFSET_LANES) {
    if (!def.lines) continue
    const pts = laneWorldPath(track, def)
    if (pts.length < 3) continue
    // 0.2 m inside the lane's edge: the drawn lane (its ring, sampled at 2 m) sits a few
    // centimetres inside the declared width on the inside of its bends
    for (const side of [1, -1] as const) laneStripe(track, ground, pts, def.width / 2 - 0.2, side, 0.15, quads)
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

  // double-sided: the lane edge lines are swept along their own path, so one side of each pair
  // winds the other way round
  const mat = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  addScreenWidth(mat)
  const built = ground.decal(quads, rungOf, LINE_LAYOUT)
  const mesh = new THREE.Mesh(built.geo ?? new THREE.BufferGeometry(), mat)
  mesh.name = 'whiteLines'
  mesh.receiveShadow = true
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  markDecal(mesh, LAYER.road.line, built.stats)
  return mesh
}

/**
 * Edge line of an offset lane: a stripe `dist` metres to `side` of its sampled centreline, one
 * quad per path segment. Skips the stretch where the lane is still on the racing surface (the
 * split and merge mouths, where the lap's own edge line already has its gap).
 */
function laneStripe(track: Track, ground: Ground, pts: LanePoint[], dist: number, side: 1 | -1, w: number, quads: DecalQuad[]): void {
  const keep = pts.filter((p) => Math.abs(p.lat) > track.halfWidthAt(p.s) + 1.5)
  if (keep.length < 3) return
  const n = keep.length
  // the stripe's centre and the path normal (pointing to `side`) at every kept point
  const cx = new Float64Array(n), cz = new Float64Array(n), nX = new Float64Array(n), nZ = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = keep[i]!
    const prev = keep[Math.max(0, i - 1)]!, next = keep[Math.min(n - 1, i + 1)]!
    const dx = next.x - prev.x, dz = next.z - prev.z
    const inv = 1 / (Math.hypot(dx, dz) || 1)
    nX[i] = dz * inv * side
    nZ[i] = -dx * inv * side
    cx[i] = p.x + nX[i]! * dist
    cz[i] = p.z + nZ[i]! * dist
  }
  for (let i = 0; i < n - 1; i++) {
    const x0 = cx[i]!, z0 = cz[i]!, x1 = cx[i + 1]!, z1 = cz[i + 1]!
    const xz = [x0 + nX[i]! * w / 2, z0 + nZ[i]! * w / 2, x0 - nX[i]! * w / 2, z0 - nZ[i]! * w / 2, x1 - nX[i + 1]! * w / 2, z1 - nZ[i + 1]! * w / 2, x1 + nX[i + 1]! * w / 2, z1 + nZ[i + 1]! * w / 2]
    // the segment's own frame for the attributes: along (ux, uz), across = its normal to `side`
    const ex = x1 - x0, ez = z1 - z0, el = Math.hypot(ex, ez) || 1
    const ux = ex / el, uz = ez / el
    const ax = uz * side, az = -ux * side
    const d0 = keep[i]!.d, d1 = keep[i + 1]!.d
    quads.push({
      xz,
      yHint: ground.standY(x0, z0),
      attrs: (x, z) => {
        const half = (x - x0) * ax + (z - z0) * az
        const t = Math.min(1, Math.max(0, ((x - x0) * ux + (z - z0) * uz) / el))
        return [ax, az, half, 0.5 - half / w, d0 + t * (d1 - d0)]
      },
    })
  }
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
