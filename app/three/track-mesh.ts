import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { CIRCUIT } from '~/data/suzuka'
import { PAINTED_APRONS, type Side } from '~/data/suzuka-facilities-spec'
import { KERBS } from '~/data/suzuka-barriers-spec'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import { APRON_TILE_M, APRON_UV, apronPaintTexture, boardTexture, concreteMaps } from './textures'
import { GROUND_OBJECTS, LAYER, markDecal, markObject, STRIP_DROP, type Ground } from './ground'
import type { DecalQuad } from './ground-mesh'
import { kerbWidthTapered } from './ground-plan'
import { pbr } from './materials'

type Fn = (s: number) => number

const _p = new THREE.Vector3()

/**
 * Ribbon following the track between s0 and s1 (forward), with per-edge lateral
 * offsets and heights. UV: u across (0..1), v along (s / vScale). Not for paint on the ground —
 * a decal is the drawn ground itself, lifted (ground.decal).
 */
export function ribbonGeometry(
  track: Track,
  s0: number,
  s1: number,
  leftLat: Fn,
  rightLat: Fn,
  leftY: Fn,
  rightY: Fn,
  step = 2,
  vScale = 10,
  uAcross = 1,
): THREE.BufferGeometry {
  const len = s0 === s1 ? track.length : forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, leftLat(s), _p, leftY(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, rightLat(s), _p, rightY(s))
    pos.push(_p.x, _p.y, _p.z)
    const v = d / vScale
    uv.push(0, v, uAcross, v)
    if (i < segs) {
      const a = i * 2
      // counter-clockwise seen from above (+Y) so the surface is front-facing
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Ribbon with an arbitrary cross-section: `edges` lists (lateral, height) functions from
 * one side to the other; u runs 0..1 across the edges (or `uAt[e]` when given — a constant per
 * edge, or a function of the edge index and s for cross-sections whose edges move with s),
 * v = s / vScale. Edges must be ordered right-to-left (increasing lateral) for the surface to
 * face up. Edges may coincide (zero-width quads): the degenerate triangles cost nothing and
 * contribute no normal.
 */
export function profileRibbonGeometry(track: Track, s0: number, s1: number, edges: [Fn, Fn][], step = 1, vScale = 2, uAt?: number[] | ((e: number, s: number) => number)): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const E = edges.length
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    for (let e = 0; e < E; e++) {
      const [lat, y] = edges[e]!
      track.pointAt(s, lat(s), _p, y(s))
      pos.push(_p.x, _p.y, _p.z)
      uv.push(uAt ? (typeof uAt === 'function' ? uAt(e, s) : uAt[e]!) : e / (E - 1), d / vScale)
    }
    if (i < segs) {
      for (let e = 0; e < E - 1; e++) {
        const a = i * E + e
        // (forward, then across towards +lateral) is counter-clockwise seen from above
        idx.push(a, a + E, a + 1, a + 1, a + E, a + E + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Vertical strip along the track between two height functions. `vScale` is metres per texture
 * tile along the wall; `uScale` (optional) is metres per tile up the wall — without it one tile
 * spans the whole height.
 */
export function wallGeometry(track: Track, s0: number, s1: number, lat: Fn, yBottom: Fn, yTop: Fn, step = 4, vScale = 8, uScale?: number): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, lat(s), _p, yBottom(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, lat(s), _p, yTop(s))
    pos.push(_p.x, _p.y, _p.z)
    const vTop = uScale ? (yTop(s) - yBottom(s)) / uScale : 1
    uv.push(d / vScale, 0, d / vScale, vTop)
    if (i < segs) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------------------------------------

export interface TrackMeshes {
  group: THREE.Group
  startLampMaterials: THREE.MeshStandardMaterial[]
}

/**
 * What stands on or beside the racing surface that is NOT ground: the sausage kerbs (objects on
 * the drawn kerb, GROUND_OBJECTS.sausage), the painted aprons and green strips (decals on the
 * drawn ground), the crossover bridge's slab, walls, rails and piers, the pit wall with its
 * boards, the DRS markings (decals) and the start gantry.
 *
 * The ground itself — the road, the kerbs, the run-off bands, the gravel, the pit lane and its
 * apron, the paved areas — is the partition of ground-plan.ts drawn by ground-mesh.ts. Nothing
 * here draws an opaque horizontal surface at ground level; the audit (surface-check G8) fails
 * on one that is not a registered ground face, a marked object or a marked decal.
 */
export function buildTrackMeshes(track: Track, ground: Ground): TrackMeshes {
  const group = new THREE.Group()
  /** local half-width — the road narrows to ~10.5 m at the Degners and widens to 15 m on the pit straight */
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const hw = track.halfWidth
  const L = track.length
  const cross = track.crossing
  const pit = CIRCUIT.pit
  // --- sausage kerbs from the KERBS table: yellow blocks behind the exit kerb ---------------------
  // objects standing on the drawn kerb face: base `sink` into it, crown `crown` above (rule R8)
  const sausageSpots: { s: number; side: 1 | -1 }[] = []
  for (const k of KERBS) {
    if (k.kind !== 'sausage') continue
    const len = forwardDelta(k.sRange[0], k.sRange[1], L)
    for (let d = 0; d <= len; d += 1.7) sausageSpots.push({ s: k.sRange[0] + d, side: k.side })
  }
  if (sausageSpots.length) {
    const rule = GROUND_OBJECTS.sausage
    const sausageGeo = new RoundedBoxGeometry(rule.maxWidth, rule.crown + rule.sink, 1.3, 2, 0.05)
    const sausageMat = new THREE.MeshStandardMaterial({ color: 0xf2c400, roughness: 0.6 })
    const sausages = new THREE.InstancedMesh(sausageGeo, sausageMat, sausageSpots.length)
    sausages.name = 'sausages'
    sausages.castShadow = true
    markObject(sausages, 'sausage', sausageSpots.length * 1.3)
    const q = new THREE.Quaternion()
    const mat4 = new THREE.Matrix4()
    sausageSpots.forEach((sp, i) => {
      const h = track.headingAt(sp.s)
      track.pointAt(sp.s, sp.side * (hwAt(sp.s) + 1.25), _p, 0)
      _p.y = ground.standY(_p.x, _p.z) + (rule.crown - rule.sink) / 2
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
      mat4.compose(_p, q, new THREE.Vector3(1, 1, 1))
      sausages.setMatrixAt(i, mat4)
    })
    sausages.instanceMatrix.needsUpdate = true
    group.add(sausages)
  }

  // --- painted aprons and edge strips (PAINTED_APRONS + the 'green' KERBS rows) -----------------
  // Decals on the DRAWN ground: the ground faces' own triangles under each band, clipped to it and
  // lifted LAYER.verge.paint (ground.decal), so the paint is coplanar with whatever facets the
  // ground has there — a ribbon of its own, however finely sampled, chorded under the folds
  // (12 mm at the hairpin) and the strip's ramp (20 mm). The polygon offset is a bonus, not what
  // keeps them visible. One atlas → one material.
  {
    const paintMat = new THREE.MeshStandardMaterial({ map: apronPaintTexture(), roughness: 0.65, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const quads: DecalQuad[] = []
    /** width of the flat kerb on `side` at s (0 where there is none) — the painted strips start behind it */
    const kerbOuterAt = (s: number, side: Side): number => kerbWidthTapered(ground.plan.kerbs, track, s, side)
    /**
     * One painted band from `from` to `to` on `side`, `inner(s)` metres behind the road edge and
     * `width(s)` wide, u across the band in `uRange`: one quad per row of the plan's lattice
     * (≤ 1 m), so the band's outline follows the curve and each quad meets few facets.
     */
    const decal = (from: number, to: number, side: Side, inner: Fn, width: Fn, uRange: readonly [number, number]) => {
      const rows = ground.plan.lattice(from, to, 1)
      const latIn: Fn = (s) => side * (hwAt(s) + inner(s))
      const latOut: Fn = (s) => side * (hwAt(s) + inner(s) + width(s))
      for (let i = 0; i < rows.length - 1; i++) {
        const sa = rows[i]!, sb = rows[i + 1]!
        const xz: number[] = []
        for (const [s, lat] of [[sa, latIn(sa)], [sa, latOut(sa)], [sb, latOut(sb)], [sb, latIn(sb)]] as const) {
          track.pointAt(s, lat, _p, 0)
          xz.push(_p.x, _p.z)
        }
        // the road plane: the face this band lies on is within DECAL_LAYER of it — beside the
        // bridge approach the lower road's verge 6 m down is not, and the band stays undrawn there
        track.pointAt((sa + sb) / 2, (latIn(sa) + latOut(sa)) / 2, _p, 0)
        quads.push({
          xz,
          yHint: _p.y,
          attrs: (x, z) => {
            const p = track.nearestOnRange(x, z, sa, sb, 2)
            const w = width(p.s)
            const f = w > 1e-3 ? Math.min(1, Math.max(0, (Math.abs(p.lateral) - hwAt(p.s) - inner(p.s)) / w)) : 0
            return [uRange[0] + f * (uRange[1] - uRange[0]), signedDelta(from, p.s, L) / APRON_TILE_M]
          },
        })
      }
    }
    for (const a of PAINTED_APRONS) {
      const len = forwardDelta(a.sRange[0], a.sRange[1], L)
      // the aprons are polygons, not bands: taper both ends over 8 m
      const width: Fn = (s) => {
        const d = forwardDelta(a.sRange[0], s, L)
        return a.width * Math.min(1, d / 8, (len - d) / 8)
      }
      const uv = a.pattern === 'chevrons' ? APRON_UV.chevrons : APRON_UV.turquoise
      // solid paint: a constant u well inside its region (the taps never reach a neighbour)
      const uRange: readonly [number, number] = a.pattern === 'chevrons' ? uv : [(uv[0] + uv[1]) / 2, (uv[0] + uv[1]) / 2]
      decal(a.sRange[0], a.sRange[1], a.side, (s) => kerbOuterAt(s, a.side) + 0.05, width, uRange)
    }
    for (const g of KERBS) {
      if (g.kind !== 'green') continue
      const mid = (APRON_UV.green[0] + APRON_UV.green[1]) / 2
      // behind the kerb where there is one, hard against the edge line otherwise
      decal(g.sRange[0], g.sRange[1], g.side, (s) => (kerbOuterAt(s, g.side) > 0 ? kerbOuterAt(s, g.side) + 0.05 : 0.1), () => g.width ?? 1.2, [mid, mid])
    }
    const built = ground.decal(quads, LAYER.verge.paint, [{ name: 'uv', size: 2 }])
    if (built.geo) {
      const paint = new THREE.Mesh(built.geo, paintMat)
      paint.name = 'paintedAprons'
      paint.receiveShadow = true
      paint.renderOrder = 1
      markDecal(paint, LAYER.verge.paint, built.stats)
      group.add(paint)
    }
  }

  // --- crossover bridge -------------------------------------------------------
  // The deck's shoulder strips are ground (the `deckShoulder` owner of the plan); what is built
  // here is the slab under the road, the deck walls, the embankment walls down to the ground, the
  // guard rails and the piers beside the lower track.
  const concrete = pbr(concreteMaps(), { roughness: 0.95, side: THREE.DoubleSide }, 0.6)
  const rail = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide })
  const span = 19
  const approach = 160
  const concreteGeos: THREE.BufferGeometry[] = []
  concreteGeos.push(ribbonGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, (s) => -hwAt(s) - 1.2, () => -1.3, () => -1.3, 3, 10))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, () => -1.3, () => 0.0, 3))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => -hwAt(s) - 1.2, () => -1.3, () => 0.0, 3))
  // embankments (walls down to the ground) either side of the span
  for (const [a, b] of [[cross.sOver - approach, cross.sOver - span], [cross.sOver + span, cross.sOver + approach]] as const) {
    for (const side of [1, -1] as const) {
      const lat: Fn = (s) => side * (hwAt(s) + 1.2)
      const bottom: Fn = (s) => Math.min(-0.05, ground.standAt(s, lat(s)) - 0.4)
      concreteGeos.push(wallGeometry(track, a, b, lat, bottom, () => 0, 4))
    }
  }
  // guard rails along the whole elevated section
  const railGeos: THREE.BufferGeometry[] = []
  for (const side of [1, -1] as const) {
    railGeos.push(wallGeometry(track, cross.sOver - approach, cross.sOver + approach, (s) => side * (hwAt(s) + 1.1), () => 0, () => 1.0, 4))
  }
  group.add(new THREE.Mesh(mergeGeometries(railGeos, false)!, rail))
  // piers beside the lower track
  const pierGeo = new THREE.CylinderGeometry(1.4, 1.6, 1, 12)
  const hwUnder = hwAt(cross.sUnder)
  for (const lat of [hwUnder + 5, -hwUnder - 5]) {
    track.pointAt(cross.sUnder, lat, _p)
    const top = cross.yOver - 1.3
    const bottom = ground.standY(_p.x, _p.z) - 1
    const g = pierGeo.clone()
    g.scale(1, top - bottom, 1)
    g.translate(_p.x, (top + bottom) / 2, _p.z)
    concreteGeos.push(g)
  }

  // --- pit wall between track and pit lane, with advertising boards facing the track ------------
  // (the pit lane and the garage apron are ground: the `pitLane` / `pitApron` owners of the plan)
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })
  const boardGeos: THREE.BufferGeometry[] = []
  boardGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset, () => STRIP_DROP, () => 1.2, 4, 64))
  concreteGeos.push(ribbonGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset + 0.3, () => pit.wallOffset - 0.3, () => 1.2, () => 1.2, 4, 10))
  concreteGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset - 0.3, () => STRIP_DROP, () => 1.2, 4, 4))
  // outside barrier along the main straight and into T1 (stands on the verge)
  boardGeos.push(wallGeometry(track, 5480, 470, () => hw + 8, (s) => ground.standAt(s, hw + 8), (s) => ground.standAt(s, hw + 8) + 1.1, 4, 64))
  group.add(new THREE.Mesh(mergeGeometries(boardGeos, false)!, boardMat))
  const concreteMesh = new THREE.Mesh(mergeGeometries(concreteGeos, false)!, concrete)
  concreteMesh.name = 'concrete'
  concreteMesh.castShadow = true
  group.add(concreteMesh)

  // grid slots, the start line and every other painted marking are built by lines.ts
  // DRS detection / activation markings: decals on the drawn road, LAYER.road.drs up
  const gridMat = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.55, metalness: 0 })
  const drsQuads: DecalQuad[] = []
  for (const s of [CIRCUIT.drs.detection, CIRCUIT.drs.start]) {
    const xz: number[] = []
    for (const [ss, lat] of [[s, hwAt(s)], [s, -hwAt(s)], [s + 0.4, -hwAt(s + 0.4)], [s + 0.4, hwAt(s + 0.4)]] as const) {
      track.pointAt(ss, lat, _p, 0)
      xz.push(_p.x, _p.z)
    }
    track.pointAt(s + 0.2, 0, _p, 0)
    drsQuads.push({ xz, yHint: _p.y, attrs: (x, z) => { const p = track.nearestOnRange(x, z, s, s + 0.4, 2); return [(hwAt(p.s) - p.lateral) / (2 * hwAt(p.s)), signedDelta(s, p.s, L)] } })
  }
  const drs = ground.decal(drsQuads, LAYER.road.drs, [{ name: 'uv', size: 2 }])
  if (drs.geo) {
    const drsLines = new THREE.Mesh(drs.geo, gridMat)
    drsLines.name = 'drsLines'
    drsLines.receiveShadow = true
    markDecal(drsLines, LAYER.road.drs, drs.stats)
    group.add(drsLines)
  }

  // --- start gantry with the five light clusters ------------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x3c3f46, roughness: 0.45, metalness: 0.8 })
  const gantry = new THREE.Group()
  const postGeo = new THREE.BoxGeometry(0.5, 9, 0.5)
  const beamGeo = new THREE.BoxGeometry(2 * hw + 6, 0.6, 0.6)
  const gs = 3
  const pose = track.headingAt(gs)
  track.pointAt(gs, 0, _p)
  gantry.position.copy(_p)
  gantry.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(pose.tz, 0, -pose.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(pose.tx, 0, pose.tz)))
  for (const x of [hw + 2.5, -hw - 2.5]) {
    const post = new THREE.Mesh(postGeo, steel)
    post.position.set(x, 4.5, 0)
    post.castShadow = true
    gantry.add(post)
  }
  const beam = new THREE.Mesh(beamGeo, steel)
  beam.position.set(0, 8.7, 0)
  gantry.add(beam)
  const startLampMaterials: THREE.MeshStandardMaterial[] = []
  const lampGeo = new THREE.SphereGeometry(0.28, 10, 8)
  const housingGeo = new THREE.BoxGeometry(0.9, 1.7, 0.5)
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 1.6
    const housing = new THREE.Mesh(housingGeo, new THREE.MeshStandardMaterial({ color: 0x111111 }))
    housing.position.set(x, 7.5, 0)
    gantry.add(housing)
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0x000000, roughness: 0.3 })
    startLampMaterials.push(mat)
    for (const y of [7.9, 7.1]) {
      const lamp = new THREE.Mesh(lampGeo, mat)
      lamp.position.set(x, y, -0.3)
      gantry.add(lamp)
    }
  }
  group.add(gantry)

  return { group, startLampMaterials }
}
