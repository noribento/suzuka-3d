import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { COLOURS, GARAGE_CENTRES, GARAGE_ORDER, LEADER_TOWER, PIT_BLOCK, PIT_BOX_STRIP, PIT_WALL, PRAT_PERCH, garageS } from '~/data/suzuka-facilities-spec'
import { SIGNS } from '~/data/suzuka-barriers-spec'
import { forwardDelta } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal } from './ground'
import type { DecalQuad, DecalStats } from './ground-mesh'
import { bucketedInstancedMeshes } from './instancing'
import { latticeGeometry } from './lattice'
import { cutoutFromAssets, cutoutParams, pbrFromAssets } from './materials'
import { addMerged, canvas, chequer, type Fn, frameAt, K, label, PIT_TEXTS, pitMaterials, sectionPlate, sweep, tex, texturedWall, tube, type Pt } from './pit-geometry'
import { FACING_FACE, signAtlas, signCellOf, signUv } from './structures'
import { profileRibbonGeometry } from './track-mesh'
import { armcoMaps } from './textures'

/**
 * The pit lane (plan I1-c): the pit wall's v2 section (PIT_WALL, plan §横断 2 — pp4s2-4,
 * padroad.jpg, west.jpg) and the Leader Tower at the pit exit. Everything is swept on the road
 * plane like the pit building (the wall and the lane follow the 2.8 % fall of the straight):
 *
 *  - the 0.7 m concrete wall to 1.8 m (`pitWall`, concrete046, its first 10 m painted white —
 *    the block the SIGNS rows 'pit-entry-60' / 'fire-station' (mount pitWallTop) stand on,
 *    `pitWallSigns`), the advertising band on both faces (`pitWallBoards` towards the grid,
 *    `pitWallBoardsLane` with the 80 km/h ring = SIGNS 'pit-lane-80'), the debris mesh over the
 *    track face (`pitDebrisFence`: 1.0 m along the box strip, 1.8 m at the entry / exit, posts
 *    every 4 m `pitFencePosts-<bay>`);
 *  - on the lane side the walkway (`concretePitWalkway`, +0.5), the white kerb
 *    (`concretePitKerb`, +0.45) with the inverted-U pipe hoops every 1.3 m (`pitHoops-<bay>`,
 *    one 76-triangle prototype instanced per 60 m bay), the fixed platform 31–69 (+1.3 with its
 *    parapet and pipe rail, `concretePitPlatform`), the starter's rostrum beside the gantry leg
 *    (`pitRostrum`), the equipment cabinets at the block boundaries (`pitCabinets`) and the v1
 *    team perches on the walkway (the ops layer, I3-c, replaces them);
 *  - the W-beam guardrail with round posts and a white pipe rail before and after the concrete
 *    (`pitWBeam`, `pitWBeamPosts-<bay>`);
 *  - the blue band of the auxiliary lane and its white edge line as a decal on the drawn lane
 *    (`pitBlueBand`, LAYER.pit.band).
 *
 * The sim's envelope (PIT_ENVELOPE / track.pitLateralAt) is respected by construction: nothing
 * here stands inside lateral [−19.1, −11.5] — the walkway, kerb, hoops, platform, rostrum and
 * cabinets all lie at lateral ≥ −11.5 — and the blue band is paint. pit-smoke.mjs `checkLane`
 * asserts it from the built bounding boxes.
 */

const _p = new THREE.Vector3()

// ---------------------------------------------------------------- canvas textures

/** Leader Tower LED board: white top panel, clock and lap, then ten rows of position + car number. */
function towerTexture(k: number, first: number): THREE.Texture {
  const w = 256, h = 1024
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#0b0b0d'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#f5f5f2'
  ctx.fillRect(10, 10, w - 20, 150)
  label(ctx, 'SUZUKA', w / 2, 70, 44, COLOURS.circuitRed.lit, 900, 'center', w - 40)
  label(ctx, 'CIRCUIT', w / 2, 118, 30, '#2a2f34', 700, 'center', w - 40)
  label(ctx, '14:00', w / 2, 200, 44, '#ffffff', 700)
  label(ctx, 'LAP  1', w / 2, 248, 30, '#ffffff', 700)
  for (let i = 0; i < 10; i++) {
    const pos = first + i
    const d = DRIVERS[pos - 1]
    const y = 320 + i * 66
    label(ctx, String(pos), 78, y, 46, '#ffffff', 700, 'right')
    label(ctx, d ? String(d.number) : '', 190, y, 46, '#ffd400', 700, 'right')
  }
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** The pit-lane speed-limit ring (SIGNS kind 'speed80'): red ring, black figures, on white. */
function speedRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = COLOURS.circuitRed.lit
  ctx.lineWidth = r * 0.22
  ctx.beginPath()
  ctx.arc(x, y, r * 0.86, 0, Math.PI * 2)
  ctx.stroke()
  label(ctx, '80', x, y, r * 1.05, '#141414', 900, 'center', r * 1.3)
}

/**
 * Pit-wall advertising band: 8 panels of 8 m in Suzuka's white / black / red rhythm, chequered
 * circuit-name panel included, fictional words only (PIT_TEXTS). The pit-lane face (`laneFace`)
 * carries the 80 km/h limit ring on the sixth panel — the SIGNS row 'pit-lane-80' (mount
 * 'pitWallBoard'): the ring stands ON the wall, it is not a free-standing sign — so it recurs
 * every 64 m along the lane like the real ones.
 */
function wallPanelTexture(k: number, laneFace = false): THREE.Texture {
  // 64:1 for the 64 m × 0.9 m band it covers (eight 8 m slots); a 16:1 canvas stretched the
  // lettering 4.4× along the wall (I1 review V9)
  const w = 4096, h = 64
  const { c, ctx } = canvas(w, h, k)
  const slot = w / 8
  const styles: [string, string][] = [['#fbfbf9', '#141414'], ['#141414', '#ffffff'], ['#fbfbf9', COLOURS.circuitRed.lit], [COLOURS.circuitRed.lit, '#ffffff']]
  for (let i = 0; i < 8; i++) {
    const [bg, fg] = styles[i % 4]!
    const x = i * slot
    ctx.fillStyle = bg
    ctx.fillRect(x, 0, slot, h)
    if (i === 0) {
      chequer(ctx, x + 10, 8, 48, h - 16, 8)
      chequer(ctx, x + slot - 58, 8, 48, h - 16, 8)
    }
    if (laneFace && i === 5) {
      ctx.fillStyle = '#fbfbf9'
      ctx.fillRect(x, 0, slot, h)
      speedRing(ctx, x + slot / 2, h / 2, h * 0.44)
    } else label(ctx, PIT_TEXTS[i]!, x + slot / 2, h / 2, 40, fg, 900, 'center', i === 0 ? slot - 150 : slot - 60)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(x, 0, 3, h)
  }
  return tex(c)
}

/** The Leader Tower's track-face board: 'SUZUKA CIRCUIT' in a plain face, reading top to bottom (Frontstretch photo). */
function verticalTextTexture(k: number): THREE.Texture {
  const w = 128, h = 1024
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#141518'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.rotate(Math.PI / 2)
  label(ctx, 'SUZUKA CIRCUIT', 0, 0, 78, '#f4f4f1', 700, 'center', h - 120)
  ctx.restore()
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** The starter's rostrum name panel: 'SUZUKA CIRCUIT' in the circuit red on white (west.jpg). */
function rostrumPanelTexture(k: number): THREE.Texture {
  const w = 1024, h = 192
  const { c, ctx } = canvas(w, h, k)
  ctx.fillStyle = '#f6f6f3'
  ctx.fillRect(0, 0, w, h)
  chequer(ctx, 24, 36, 90, h - 72, 15)
  label(ctx, 'SUZUKA CIRCUIT', w / 2 + 40, h / 2, 110, COLOURS.circuitRed.lit, 900, 'center', w - 220)
  return tex(c, THREE.ClampToEdgeWrapping)
}

/** Debris-fence mesh (no pack): dark wire grid on a transparent ground, one tile = 0.5 m (the alpha test thins it with distance like real mesh). */
function meshTexture(k: number): THREE.Texture {
  const w = 64
  const { c, ctx } = canvas(w, w, k)
  ctx.clearRect(0, 0, w, w)
  ctx.fillStyle = '#2a2d31'
  for (let i = 0; i < w; i += 8) {
    ctx.fillRect(i, 0, 2, w)
    ctx.fillRect(0, i, w, 2)
  }
  const t = tex(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}
/** metres one tile of the procedural mesh covers */
const MESH_TILE_M = 0.5

// ---------------------------------------------------------------- small geometry

/**
 * The hoop prototype: an inverted U of φ50 pipe in the s–y plane (a half torus over two legs),
 * `w` wide along s and `h` tall, its feet at the origin's height. ≈ 76 triangles.
 */
function hoopGeometry(w: number, h: number, r: number): THREE.BufferGeometry {
  const R = w / 2
  const legH = Math.max(0.05, h - R)
  // TorusGeometry lies in XY with the arc from +X over +Y to −X; turn it into the Z–Y plane
  const arc = new THREE.TorusGeometry(R, r, 3, 10, Math.PI).rotateY(Math.PI / 2).translate(0, legH, 0)
  const legs = [-R, R].map((z) => new THREE.CylinderGeometry(r, r, legH, 4, 1, true).translate(0, legH / 2, z))
  const merged = mergeGeometries([arc, ...legs], false)!
  arc.dispose()
  for (const g of legs) g.dispose()
  return merged
}

/** a vertical cylinder of diameter `d` and height `h` standing on the origin */
function postGeometry(d: number, h: number, segments = 6): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(d / 2, d / 2, h, segments, 1, true).translate(0, h / 2, 0)
}

// ---------------------------------------------------------------- the builder

export function buildPitLane(ctx: EnvBuildContext): void {
  const { track, ground, group, boxes, quality, assets } = ctx
  const L = track.length
  const k = quality.textureScale
  const { concreteTile, concreteMat, darkMat, railMat, whiteMat, boardMat } = pitMaterials(ctx)
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)
  const W = PIT_WALL
  const lat = W.lateral
  const half = W.wallWidth / 2
  const wallTop = W.wallTop
  // the box strip (12 blocks + 6 cores, 270 m): the mesh is lower there, the perches span it
  const S0 = track.wrap(PIT_BOX_STRIP[0]) // 5625, final-corner end
  const S1 = track.wrap(PIT_BOX_STRIP[1]) // 88, T1 end
  const [c0, c1] = W.concrete
  const concreteLen = forwardDelta(c0, c1, L)
  const teams = GARAGE_ORDER.map((id) => TEAMS[id])
  const [p0, p1] = W.platform.sRange
  const onPlatform = (s: number) => forwardDelta(p0, s, L) <= forwardDelta(p0, p1, L)
  /** the walkway top at s: the platform deck between p0 and p1, the walkway elsewhere */
  const walkTop = (s: number) => (onPlatform(s) ? W.platform.y : W.walkway.y)
  const walkCentre = (W.walkway.from + W.walkway.to) / 2
  const bay = (s: number) => Math.floor(track.wrap(s) / 60)

  const rails: THREE.BufferGeometry[] = []
  /** galvanised small steel: the fence's top tube, the sign posts, the rostrum's stair stringers */
  const steel: THREE.BufferGeometry[] = []
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.6 })
  const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.6, metalness: 0.3 })
  // the kerb: plaster_grey_04's relief under a flat white (the same program as the garage piers)
  const kerbMat = assets
    ? pbrFromAssets(assets, 'plaster_grey_04', { fallback: () => new THREE.MeshStandardMaterial({ color: 0xeceeea, roughness: 0.7 }), handBuiltUv: true, normalScale: 0.5, noMap: true, extra: { color: 0xeceeea } })
    : new THREE.MeshStandardMaterial({ color: 0xeceeea, roughness: 0.7 })
  // the debris mesh: the fence003 photo (diff / normal / opacity) with the pack, the procedural
  // wire grid without — both in METRE uv (the strips below scale v to their height)
  const meshMat = cutoutFromAssets(assets, 'fence003', {
    quality,
    tile: 2.0,
    handBuiltUv: true,
    normalScale: 0.6,
    fallback: () => {
      const map = meshTexture(k)
      map.repeat.set(1 / MESH_TILE_M, 1 / MESH_TILE_M)
      return new THREE.MeshStandardMaterial({ map, color: 0x9a9da1, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide, ...cutoutParams(quality) })
    },
  })

  // --- Leader Tower at the pit exit ---------------------------------------------------------------
  // The black lattice tower of the Frontstretch photo: two square lattice columns side by side
  // over the 3.6 × 1.9 m OSM footprint, a vertical 'SUZUKA CIRCUIT' board on the track face,
  // the LED timing board on top. (There is no second S/F tower: this is it.)
  {
    const t = LEADER_TOWER
    const [along, across] = t.footprint
    const gy = ground.standAt(t.s, t.lateral)
    const boardBottom = t.height - t.boardHeight
    const halfAcross = across / 2 - 0.07
    // the X braces cost 8 bars per 1.5 m panel; the low tier leaves them out with the fences
    const column = latticeGeometry({ height: boardBottom - gy, baseHalf: halfAcross, topHalf: halfAcross, panel: 1.5, leg: 0.14, ring: 0.07, brace: 0.06, braces: quality.fence })
    const columns: THREE.BufferGeometry[] = []
    for (const ds of [-(along / 2 - halfAcross), along / 2 - halfAcross]) columns.push(column.clone().applyMatrix4(frameAt(track, t.s + ds, t.lateral, gy, new THREE.Matrix4())))
    column.dispose()
    add(columns, darkMat, 'leaderTowerLattice', true)
    boxes.place(t.s, t.lateral, t.boardWidth + 0.4, 1.3, t.boardHeight, darkMat, boardBottom, true)
    boxes.place(t.s, t.lateral, t.boardWidth + 0.6, 1.5, 0.3, darkMat, t.height, true, false)
    // the vertical name board on the track face, from 1.5 m up to just under the LED board
    const nameH = boardBottom - gy - 3.0
    const name = new THREE.Mesh(new THREE.PlaneGeometry(1.0, nameH).rotateY(Math.PI / 2), boardMat(verticalTextTexture(k)))
    name.applyMatrix4(frameAt(track, t.s, t.lateral + halfAcross + 0.05, gy + 1.5 + nameH / 2, new THREE.Matrix4()))
    name.name = 'leaderTowerName'
    group.add(name)
    // positions 1–10 towards the grandstand, 11–20 towards the pit lane
    const front = new THREE.Mesh(new THREE.PlaneGeometry(t.boardWidth, t.boardHeight - 0.4).rotateY(Math.PI / 2), boardMat(towerTexture(k, 1), 1.1))
    front.applyMatrix4(frameAt(track, t.s, t.lateral + 0.66, boardBottom + t.boardHeight / 2, new THREE.Matrix4()))
    const rear = new THREE.Mesh(new THREE.PlaneGeometry(t.boardWidth, t.boardHeight - 0.4).rotateY(-Math.PI / 2), boardMat(towerTexture(k, 11), 1.1))
    rear.applyMatrix4(frameAt(track, t.s, t.lateral - 0.66, boardBottom + t.boardHeight / 2, new THREE.Matrix4()))
    front.name = 'leaderTowerBoard'
    group.add(front, rear)
  }

  // --- the concrete wall, its bands, the white block and the wall-top signs ---------------------
  {
    // lane face (from the walkway top up), top, track face — FrontSide, so every face the eye
    // can reach is explicit; the buried lane face below the walkway is left out. The track face
    // runs FOOT_SINK under the road plane like the barriers' feet: the drawn asphalt band under
    // it lies 2–3 cm below the plane and a face ending at 0 left a hairline gap (I1 review F8)
    const y0 = W.walkway.y
    const FOOT_SINK = 0.1
    const edges: [Fn, Fn][] = [[K(lat - half), K(y0)], [K(lat - half), K(wallTop)], [K(lat - half), K(wallTop)], [K(lat + half), K(wallTop)], [K(lat + half), K(wallTop)], [K(lat + half), K(-FOOT_SINK)]]
    const uAt = [0, (wallTop - y0) / concreteTile, (wallTop - y0) / concreteTile, (wallTop - y0 + 2 * half) / concreteTile, (wallTop - y0 + 2 * half) / concreteTile, (2 * wallTop - y0 + 2 * half + FOOT_SINK) / concreteTile]
    const wallEnd: Pt[] = [[lat - half, 0], [lat + half, -FOOT_SINK], [lat + half, wallTop], [lat - half, wallTop]]
    add([profileRibbonGeometry(track, c0, c1, edges, 4, concreteTile, uAt), sectionPlate(track, c1, wallEnd, true)], concreteMat, 'pitWall', true)
    // the white block at the entry end: a box a centimetre proud of the concrete on every face
    const blockEnd: Pt[] = [[lat - half - 0.01, 0], [lat + half + 0.01, -FOOT_SINK], [lat + half + 0.01, wallTop + 0.01], [lat - half - 0.01, wallTop + 0.01]]
    add([sweep(track, [[lat - half - 0.01, y0], [lat - half - 0.01, wallTop + 0.01], [lat + half + 0.01, wallTop + 0.01], [lat + half + 0.01, -FOOT_SINK]], c0, c0 + W.whiteBlock, 2, 2), sectionPlate(track, c0 + W.whiteBlock, blockEnd, true), sectionPlate(track, c0, blockEnd, false)], whiteMat, 'pitWallBlock', true)
    // the advertising band on both faces (y 0.9 → 1.8), one repeat per 64 m; the white block's
    // 10 m stay bare (the signs stand there)
    const [a0, a1] = W.adPanel
    const bandFrom = c0 + W.whiteBlock
    add([texturedWall(track, bandFrom, c1, lat + half + 0.02, a0, a1, 64, 1)], new THREE.MeshStandardMaterial({ map: wallPanelTexture(k), roughness: 0.5 }), 'pitWallBoards', false)
    add([texturedWall(track, bandFrom, c1, lat - half - 0.02, a0, a1, 64, -1)], new THREE.MeshStandardMaterial({ map: wallPanelTexture(k, true), roughness: 0.5 }), 'pitWallBoardsLane', false)
    // the SIGNS rows mounted on the wall top (the 60 ring and FIRE STATION on the white block):
    // 0.06 boards on two posts, the graphic on the face towards the approaching cars
    const signMat = new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.5 })
    const signs: THREE.BufferGeometry[] = []
    for (const sign of SIGNS) {
      if (sign.mount !== 'pitWallTop' || sign.lateral === 'cameraSide') continue
      const across = sign.facing === '+s' || sign.facing === '-s'
      const bottom = wallTop + W.signPost
      const board = new THREE.BoxGeometry(across ? sign.width : 0.06, sign.boardHeight, across ? 0.06 : sign.width)
      signUv(FACING_FACE[sign.facing], signCellOf(sign), sign.width / sign.boardHeight)(board.attributes.uv as THREE.BufferAttribute)
      board.applyMatrix4(frameAt(track, sign.s, sign.lateral, bottom + sign.boardHeight / 2, new THREE.Matrix4()))
      signs.push(board)
      // the posts stand on the wall top: an across sign's posts are clamped inside the wall's
      // footprint (±(half − 0.05)), not spread to ±0.4 × width over the lane and the walkway
      const po = Math.min(sign.width * 0.4, across ? half - 0.05 : sign.width * 0.4)
      for (const o of [-po, po]) {
        const post = postGeometry(0.05, W.signPost + sign.boardHeight * 0.3)
        post.applyMatrix4(frameAt(track, sign.s + (across ? 0 : o), sign.lateral + (across ? o : 0), wallTop, new THREE.Matrix4()))
        steel.push(post)
      }
    }
    add(signs, signMat, 'pitWallSigns', false)
  }

  // --- the debris mesh over the track face ----------------------------------------------------
  {
    const runs: [number, number, number][] = [[c0, S0, W.mesh.hEnds], [S0, S1, W.mesh.hBox], [S1, c1, W.mesh.hEnds]]
    const meshLat = lat + half - 0.06
    const fence: THREE.BufferGeometry[] = []
    for (const [s0, s1, h] of runs) {
      const g = texturedWall(track, s0, s1, meshLat, wallTop, wallTop + h, 1, 1)
      const uv = g.attributes.uv as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * h)
      fence.push(g)
      steel.push(tube(track, s0, s1, meshLat, wallTop + h, 0.02))
    }
    const merged = mergeGeometries(fence, false)!
    for (const g of fence) g.dispose()
    const mesh = new THREE.Mesh(merged, meshMat)
    mesh.name = 'pitDebrisFence'
    mesh.receiveShadow = true
    group.add(mesh)
    // the posts: one prototype per height, every 4 m on the wall top
    const protos = new Map<number, THREE.BufferGeometry>()
    const matrices: THREE.Matrix4[] = []
    const postS: number[] = []
    const heights: number[] = []
    for (let d = 0; d <= concreteLen + 1e-6; d += W.mesh.postPitch) {
      const s = c0 + Math.min(d, concreteLen)
      const inBox = forwardDelta(S0, s, L) <= forwardDelta(S0, S1, L)
      const h = inBox ? W.mesh.hBox : W.mesh.hEnds
      if (!protos.has(h)) protos.set(h, postGeometry(W.mesh.postD, h))
      matrices.push(frameAt(track, s, meshLat, wallTop, new THREE.Matrix4()))
      postS.push(s)
      heights.push(h)
    }
    for (const [h, geo] of protos) {
      const idx = heights.map((v, i) => (v === h ? i : -1)).filter((i) => i >= 0)
      for (const inst of bucketedInstancedMeshes(geo, steelMat, idx.map((i) => matrices[i]!), null, (j) => bay(postS[idx[j]!]!), { name: `pitFencePosts${h === W.mesh.hBox ? '' : 'Tall'}`, receiveShadow: true })) group.add(inst)
    }
  }

  // --- the walkway, the kerb, the hoops and the fixed platform --------------------------------
  {
    const wk = W.walkway, kb = W.kerb
    // the walkway top between the kerb and the wall, in the two stretches either side of the platform
    const walkProfile: Pt[] = [[wk.to, kb.h], [wk.to, wk.y], [wk.from, wk.y]]
    const walkEnd: Pt[] = [[wk.to, 0], [wk.from, 0], [wk.from, wk.y], [wk.to, wk.y]]
    add([sweep(track, walkProfile, c0, p0, concreteTile, 4), sweep(track, walkProfile, p1, c1, concreteTile, 4), sectionPlate(track, c0, walkEnd, false), sectionPlate(track, c1, walkEnd, true)], concreteMat, 'concretePitWalkway', false)
    // the platform: deck at +1.3, the parapet on its lane edge, closed at both ends
    const pf = W.platform
    const parapetTop = pf.y + pf.parapet
    const parapetIn = wk.to + 0.2
    const platProfile: Pt[] = [[wk.to, kb.h], [wk.to, parapetTop], [parapetIn, parapetTop], [parapetIn, pf.y], [wk.from, pf.y]]
    const endPlate: Pt[] = [[wk.to, kb.h], [wk.to, parapetTop], [parapetIn, parapetTop], [parapetIn, pf.y], [wk.from, pf.y], [wk.from, wk.y], [wk.to, wk.y]]
    add([sweep(track, platProfile, p0, p1, concreteTile, 4), sectionPlate(track, p0, endPlate, false), sectionPlate(track, p1, endPlate, true)], concreteMat, 'concretePitPlatform', true)
    // the white pipe rail on the parapet
    const railLat = wk.to + 0.1
    rails.push(tube(track, p0, p1, railLat, pf.y + pf.rail, 0.025))
    for (let s = p0; s <= p1 + 1e-6; s += 2) rails.push(postGeometry(0.04, pf.rail - pf.parapet).applyMatrix4(frameAt(track, s, railLat, parapetTop, new THREE.Matrix4())))
    // the kerb: white, the hoops' footing
    const kerbEnd: Pt[] = [[kb.to, 0], [kb.from, 0], [kb.from, kb.h], [kb.to, kb.h]]
    add([sweep(track, [[kb.to, 0], [kb.to, kb.h], [kb.from, kb.h]], c0, c1, 1, 4), sectionPlate(track, c0, kerbEnd, false), sectionPlate(track, c1, kerbEnd, true)], kerbMat, 'concretePitKerb', false)
    // the hoops: one prototype, every 1.3 m along the kerb, 60 m bays
    const hp = W.hoops
    const hoop = hoopGeometry(hp.w, hp.h, hp.r)
    const hoopLat = (kb.from + kb.to) / 2
    const n = Math.floor(concreteLen / hp.pitch)
    const matrices: THREE.Matrix4[] = []
    const hoopS: number[] = []
    for (let i = 0; i < n; i++) {
      const s = c0 + (i + 0.5) * hp.pitch
      matrices.push(frameAt(track, s, hoopLat, kb.h, new THREE.Matrix4()))
      hoopS.push(s)
    }
    for (const inst of bucketedInstancedMeshes(hoop, steelMat, matrices, null, (i) => bay(hoopS[i]!), { name: 'pitHoops', receiveShadow: true })) group.add(inst)
    group.userData.pitHoops = n
  }

  // --- the equipment cabinets at the block boundaries ----------------------------------------
  {
    const [cl, cw, ch] = W.cabinet.size
    const cabinets: THREE.BufferGeometry[] = []
    const ends = [...GARAGE_CENTRES.map((s) => s + PIT_BLOCK / 2), GARAGE_CENTRES[GARAGE_CENTRES.length - 1]! - PIT_BLOCK / 2]
    for (const s of ends) {
      const geo = new THREE.BoxGeometry(cw, ch, cl)
      geo.applyMatrix4(frameAt(track, s, walkCentre, walkTop(s) + ch / 2, new THREE.Matrix4()))
      cabinets.push(geo)
    }
    add(cabinets, cabinetMat, 'pitCabinets', false)
  }

  // --- the starter's rostrum ------------------------------------------------------------------
  // A dark steel cabin over the walkway beside the gantry's leg, floor +3.0, on four legs; a
  // mesh window towards the grid, the circuit-name panel on the track face, the stair down to
  // the walkway on the T1 side.
  {
    const r = W.rostrum
    const [rl, rw, rh] = r.size
    const body: THREE.BufferGeometry[] = []
    const cabin = new THREE.BoxGeometry(rw, rh, rl)
    cabin.applyMatrix4(frameAt(track, r.s, r.lateral, r.floor + rh / 2, new THREE.Matrix4()))
    body.push(cabin)
    const legTop = r.floor - 0.06
    const base = walkTop(r.s)
    for (const ds of [-rl / 2 + 0.2, rl / 2 - 0.2]) {
      for (const dl of [W.walkway.from - 0.15, W.walkway.to + 0.2]) {
        body.push(postGeometry(r.legD, legTop - base, 8).applyMatrix4(frameAt(track, r.s + ds, dl, base, new THREE.Matrix4())))
      }
    }
    // the stair: treads down to the walkway on the +s side, two stringers
    const rise = (r.floor - base) / r.steps
    const run = 0.28
    for (let i = 0; i < r.steps - 1; i++) {
      const tread = new THREE.BoxGeometry(0.8, 0.05, run)
      tread.applyMatrix4(frameAt(track, r.s + rl / 2 + (i + 0.5) * run, r.lateral, r.floor - (i + 1) * rise - 0.025, new THREE.Matrix4()))
      body.push(tread)
    }
    const stairLen = Math.hypot(r.steps * run, r.floor - base)
    const angle = Math.atan2(r.floor - base, r.steps * run)
    for (const dl of [-0.42, 0.42]) {
      const stringer = new THREE.BoxGeometry(0.04, 0.16, stairLen).rotateX(angle)
      stringer.applyMatrix4(frameAt(track, r.s + rl / 2 + (r.steps * run) / 2, r.lateral + dl, (r.floor + base) / 2 - 0.05, new THREE.Matrix4()))
      steel.push(stringer)
    }
    add(body, darkMat, 'pitRostrum', true)
    // the mesh window: the grid face (−s) and the track face, 0.9 m tall under the roof
    const win: THREE.BufferGeometry[] = []
    const wy = r.floor + rh - 0.35 - 0.45
    const gridFace = new THREE.PlaneGeometry(rw - 0.3, 0.9)
    const uvG = gridFace.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uvG.count; i++) uvG.setXY(i, uvG.getX(i) * (rw - 0.3), uvG.getY(i) * 0.9)
    win.push(gridFace.clone().rotateY(Math.PI).applyMatrix4(frameAt(track, r.s - rl / 2 - 0.01, r.lateral, wy, new THREE.Matrix4())))
    const trackFace = new THREE.PlaneGeometry(rl - 0.3, 0.9)
    const uvT = trackFace.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uvT.count; i++) uvT.setXY(i, uvT.getX(i) * (rl - 0.3), uvT.getY(i) * 0.9)
    win.push(trackFace.rotateY(Math.PI / 2).applyMatrix4(frameAt(track, r.s, r.lateral + rw / 2 + 0.01, wy, new THREE.Matrix4())))
    gridFace.dispose()
    const windows = new THREE.Mesh(mergeGeometries(win, false)!, meshMat)
    for (const g of win) g.dispose()
    windows.name = 'pitRostrumWindow'
    windows.receiveShadow = true
    group.add(windows)
    // the white name panel on the track face under the window
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(rl - 0.4, 0.5).rotateY(Math.PI / 2), boardMat(rostrumPanelTexture(k)))
    panel.applyMatrix4(frameAt(track, r.s, r.lateral + rw / 2 + 0.02, r.floor + 0.55, new THREE.Matrix4()))
    panel.name = 'pitRostrumPanel'
    panel.receiveShadow = true
    group.add(panel)
  }

  // --- the W-beam guardrail before and after the concrete ---------------------------------------
  {
    const armco = armcoMaps()
    const guardMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xdfe2e4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })
    const wb = W.wBeamRail
    const beams: THREE.BufferGeometry[] = []
    const post = postGeometry(wb.postD, wb.pipe, 8)
    const matrices: THREE.Matrix4[] = []
    const postS: number[] = []
    for (const [s0, s1] of W.wBeam) {
      beams.push(texturedWall(track, s0, s1, lat, wb.bottom, wb.top, 4, 1))
      rails.push(tube(track, s0, s1, lat, wb.pipe, 0.025))
      const len = forwardDelta(s0, s1, L)
      for (let d = 0; d <= len + 1e-6; d += wb.postPitch) {
        const s = s0 + Math.min(d, len)
        matrices.push(frameAt(track, s, lat, 0, new THREE.Matrix4()))
        postS.push(s)
      }
    }
    add(beams, guardMat, 'pitWBeam', true)
    for (const inst of bucketedInstancedMeshes(post, steelMat, matrices, null, (i) => bay(postS[i]!), { name: 'pitWBeamPosts', receiveShadow: true })) group.add(inst)
  }

  // --- the blue band and the white edge line of the auxiliary lane (paint = decal) -------------
  {
    const rows = ground.plan.lattice(c0, c1, 1)
    const stripe = (from: number, to: number): DecalQuad[] => {
      const quads: DecalQuad[] = []
      for (let i = 0; i < rows.length - 1; i++) {
        const sa = rows[i]!, sb = rows[i + 1]!
        const xz: number[] = []
        for (const [s, l] of [[sa, from], [sa, to], [sb, to], [sb, from]] as const) {
          track.pointAt(s, l, _p, 0)
          xz.push(_p.x, _p.z)
        }
        track.pointAt((sa + sb) / 2, (from + to) / 2, _p, 0)
        quads.push({
          xz,
          yHint: _p.y,
          attrs: (x, z) => {
            const p = track.nearestOnRange(x, z, sa, sb, 2)
            return [(p.lateral - from) / (to - from), forwardDelta(c0, p.s, L)]
          },
        })
      }
      return quads
    }
    const layout = [{ name: 'uv', size: 2 }] as const
    const blue = ground.decal(stripe(W.blueBand.lat[0], W.blueBand.lat[1]), LAYER.pit.band, layout)
    const edge = ground.decal(stripe(W.blueBand.edgeLine[0], W.blueBand.edgeLine[1]), LAYER.pit.band, layout)
    const blueMat = new THREE.MeshStandardMaterial({ color: 0x1e6fd6, roughness: 0.6 })
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55 })
    const parts = [blue.geo, edge.geo].filter((g): g is THREE.BufferGeometry => !!g)
    if (parts.length) {
      // one mesh, two material groups (blue, white) — a flat-colour material either way
      const both = parts.length === 2
      const geo = both ? mergeGeometries(parts, true)! : parts[0]!
      const mesh = new THREE.Mesh(geo, both ? [blueMat, edgeMat] : blue.geo ? blueMat : edgeMat)
      mesh.name = 'pitBlueBand'
      mesh.receiveShadow = true
      mesh.renderOrder = 1
      const stats: DecalStats = { quads: blue.stats.quads + edge.stats.quads, triangles: blue.stats.triangles + edge.stats.triangles, area: blue.stats.area + edge.stats.area, uncovered: blue.stats.uncovered + edge.stats.uncovered, bareAt: [...blue.stats.bareAt, ...edge.stats.bareAt] }
      markDecal(mesh, LAYER.pit.band, stats)
      group.add(mesh)
    }
  }

  // --- the v1 team perches, moved onto the walkway (the ops layer's v2 perches replace them, I3-c)
  {
    const perch = PRAT_PERCH
    // as wide as the walkway (the v1 1.8 would hang over the kerb into the hoops)
    const pw = Math.min(perch.width, W.walkway.from - W.walkway.to)
    const r = W.rostrum
    const rostrumSpan: [number, number] = [r.s - r.size[0] / 2 - 0.5, r.s + r.size[0] / 2 + r.steps * 0.28 + 0.5]
    const canopies: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const backs: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      // the block whose perch would stand in the rostrum's footprint goes without (the ops layer places it)
      if (s + perch.length / 2 > rostrumSpan[0] && s - perch.length / 2 < rostrumSpan[1]) return
      const colour = new THREE.Color(team.body)
      const base = walkTop(s)
      const pl = walkCentre
      boxes.place(s, pl, perch.length, pw, 0.9, darkMat, base, true, false)
      for (const ds of [-perch.length / 2 + 0.05, perch.length / 2 - 0.05]) boxes.place(s + ds, pl, 0.1, pw, perch.height - 0.9, darkMat, base + 0.9, true, false)
      for (let i = 0; i < 4; i++) boxes.place(s - 1.8 + i * 1.2, pl - 0.3, 0.5, 0.5, 0.5, darkMat, base + 0.9, true, false)
      canopies.push({ m: boxes.matrix(s, pl, 0.2, base + perch.height - 0.2, true, new THREE.Matrix4()), color: colour })
      backs.push({ m: boxes.matrix(s, pl - pw / 2 + 0.05, perch.height - 0.9, base + 0.9, true, new THREE.Matrix4()), color: colour })
    })
    boxes.instanced(perch.length, pw, 0.2, canopies, 0.5, false, 'perchCanopies')
    boxes.instanced(perch.length, 0.1, perch.height - 0.9, backs, 0.5, false, 'perchBacks')
  }

  // the pipe rails share the building's white rail material; the small steel is galvanised grey
  add(rails, railMat, 'pitRails', false)
  add(steel, steelMat, 'pitSteel', false)
}
