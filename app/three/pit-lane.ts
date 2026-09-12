import * as THREE from 'three'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { COLOURS, GARAGE_ORDER, LEADER_TOWER, PIT_BOX_STRIP, PIT_WALL, PRAT_PERCH, garageS } from '~/data/suzuka-facilities-spec'
import { forwardDelta } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import { latticeGeometry } from './lattice'
import { cutoutParams } from './materials'
import { addMerged, canvas, chequer, frameAt, K, label, PIT_TEXTS, pitMaterials, tex, texturedWall, tube } from './pit-geometry'
import { profileRibbonGeometry, ribbonGeometry } from './track-mesh'

/**
 * The pit lane (plan I1-c): the pit wall with its boards and the debris fence, the team prat
 * perches and the Leader Tower at the pit exit — v1 as moved out of pit-complex.ts (I1-a);
 * I1-c rebuilds the wall from PIT_WALL v2 (walkway, kerb, hoops, mesh, platform, rostrum, the
 * blue band, the W-beams, the SIGNS on the wall top). The umbrella (infield.ts) calls it right
 * after buildPitBuilding and laps its wall-clock as 'pitLane'.
 *
 * The 80 km/h ring (SIGNS 'pit-lane-80', mount 'pitWallBoard') is a cell of the wall's
 * pit-lane boards; the 60 sign and the FIRE STATION board (mount 'pitWallTop') are drawn here
 * in I1-c — TODO(I1-c).
 */

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
 * Pit-wall boards: 8 panels of 8 m in Suzuka's white / black / red rhythm, chequered circuit-name
 * panel included. The pit-lane face (`laneFace`) carries the 80 km/h limit ring on the sixth
 * panel — the SIGNS row 'pit-lane-80' (mount 'pitWallBoard'): the ring stands ON the wall, it is
 * not a free-standing sign — so it recurs every 64 m along the lane like the real ones.
 */
function wallPanelTexture(k: number, laneFace = false): THREE.Texture {
  const w = 2048, h = 128
  const { c, ctx } = canvas(w, h, k)
  const slot = w / 8
  const styles: [string, string][] = [['#fbfbf9', '#141414'], ['#141414', '#ffffff'], ['#fbfbf9', COLOURS.circuitRed.lit], [COLOURS.circuitRed.lit, '#ffffff']]
  for (let i = 0; i < 8; i++) {
    const [bg, fg] = styles[i % 4]!
    const x = i * slot
    ctx.fillStyle = bg
    ctx.fillRect(x, 0, slot, h)
    if (i === 0) {
      chequer(ctx, x + 10, 12, 60, h - 24, 15)
      chequer(ctx, x + slot - 70, 12, 60, h - 24, 15)
    }
    if (laneFace && i === 5) {
      ctx.fillStyle = '#fbfbf9'
      ctx.fillRect(x, 0, slot, h)
      speedRing(ctx, x + slot / 2, h / 2, h * 0.44)
    } else label(ctx, PIT_TEXTS[i]!, x + slot / 2, h / 2, 60, fg, 900, 'center', i === 0 ? slot - 170 : slot - 40)
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

/** Debris-fence mesh: dark wire grid on a transparent ground, one tile = 0.5 m (the alpha test thins it with distance like real mesh). */
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


// ---------------------------------------------------------------- the builder

export function buildPitLane(ctx: EnvBuildContext): void {
  const { track, ground, group, boxes, quality } = ctx
  const L = track.length
  const k = quality.textureScale
  const { concreteTile, concreteMat, darkMat, railMat, boardMat } = pitMaterials(ctx)
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)
  // the box strip (12 blocks + 6 cores, 270 m): the debris fence and the perches span it
  const S0 = track.wrap(PIT_BOX_STRIP[0]) // 5625, final-corner end
  const S1 = track.wrap(PIT_BOX_STRIP[1]) // 88, T1 end
  const stripLen = forwardDelta(S0, S1, L)
  const teams = GARAGE_ORDER.map((id) => TEAMS[id])
  const rails: THREE.BufferGeometry[] = []
  const concrete: THREE.BufferGeometry[] = []


  // --- Leader Tower at the pit exit ---------------------------------------------------------------
  // The black lattice tower of the Frontstretch photo: two square lattice columns side by side
  // over the 3.6 × 1.9 m OSM footprint, a vertical 'SUZUKA CIRCUIT' board on the track face,
  // the LED timing board on top. (There is no second S/F tower: this is it.)
  {
    const t = LEADER_TOWER
    const [along, across] = t.footprint
    const gy = ground.standAt(t.s, t.lateral)
    const boardBottom = t.height - t.boardHeight
    const half = across / 2 - 0.07
    // the X braces cost 8 bars per 1.5 m panel; the low tier leaves them out with the fences
    const column = latticeGeometry({ height: boardBottom - gy, baseHalf: half, topHalf: half, panel: 1.5, leg: 0.14, ring: 0.07, brace: 0.06, braces: quality.fence })
    const columns: THREE.BufferGeometry[] = []
    for (const ds of [-(along / 2 - half), along / 2 - half]) columns.push(column.clone().applyMatrix4(frameAt(track, t.s + ds, t.lateral, gy, new THREE.Matrix4())))
    column.dispose()
    add(columns, darkMat, 'leaderTowerLattice', true)
    boxes.place(t.s, t.lateral, t.boardWidth + 0.4, 1.3, t.boardHeight, darkMat, boardBottom, true)
    boxes.place(t.s, t.lateral, t.boardWidth + 0.6, 1.5, 0.3, darkMat, t.height, true, false)
    // the vertical name board on the track face, from 1.5 m up to just under the LED board
    const nameH = boardBottom - gy - 3.0
    const name = new THREE.Mesh(new THREE.PlaneGeometry(1.0, nameH).rotateY(Math.PI / 2), boardMat(verticalTextTexture(k)))
    name.applyMatrix4(frameAt(track, t.s, t.lateral + half + 0.05, gy + 1.5 + nameH / 2, new THREE.Matrix4()))
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

  // --- pit wall, its boards and the prat perches --------------------------------------------------------
  {
    const [w0, w1] = PIT_WALL.sRange
    const lat = PIT_WALL.lateral
    const half = 0.35
    const h = PIT_WALL.height
    // 1.05 m concrete (pit-lane face, top, grid face); the boards sit on top of it as a 0.5 m box
    concrete.push(profileRibbonGeometry(track, w0, w1, [[K(lat - half), K(0)], [K(lat - half), K(h)], [K(lat - half), K(h)], [K(lat + half), K(h)], [K(lat + half), K(h)], [K(lat + half), K(0)]], 4, concreteTile, [0, h / concreteTile, h / concreteTile, (h + 2 * half) / concreteTile, (h + 2 * half) / concreteTile, (2 * h + 2 * half) / concreteTile]))
    const panelMat = new THREE.MeshStandardMaterial({ map: wallPanelTexture(k), roughness: 0.5 })
    const bh = 0.5
    add([texturedWall(track, w0, w1, lat + half, h, h + bh, 64, 1)], panelMat, 'pitWallBoards', false)
    // the pit-lane face carries the 80 km/h ring (SIGNS 'pit-lane-80')
    add([texturedWall(track, w0, w1, lat - half, h, h + bh, 64, -1)], new THREE.MeshStandardMaterial({ map: wallPanelTexture(k, true), roughness: 0.5 }), 'pitWallBoardsLane', false)
    rails.push(ribbonGeometry(track, w0, w1, K(lat + half), K(lat - half), K(h + bh), K(h + bh), 4, 8))
    // debris fence on the grid side over the pit-stop zone: posts every 4 m and a wire mesh
    // (alpha-tested so it thins out with distance the way real mesh does)
    const fenceTop = h + bh + PIT_WALL.fenceHeight
    for (let d = 0; d <= stripLen; d += 4) boxes.place(S0 + d, lat + half - 0.04, 0.08, 0.08, fenceTop - h, darkMat, h, true, false)
    rails.push(tube(track, S0, S1, lat + half - 0.04, fenceTop, 0.02))
    const meshMat = new THREE.MeshStandardMaterial({ map: meshTexture(k), color: 0x9a9da1, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide, ...cutoutParams(quality) })
    const fence = new THREE.Mesh(texturedWall(track, S0, S1, lat + half - 0.04, h + bh, fenceTop, 0.5, 1), meshMat)
    const fuv = fence.geometry.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < fuv.count; i++) fuv.setY(i, fuv.getY(i) * (PIT_WALL.fenceHeight / 0.5))
    fence.name = 'pitDebrisFence'
    fence.receiveShadow = true
    group.add(fence)
    // team prat perches on the pit-lane side of the wall, opposite each garage
    const perch = PRAT_PERCH
    const pl = lat - half - 0.1 - perch.width / 2
    const canopies: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const backs: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      const colour = new THREE.Color(team.body)
      boxes.place(s, pl, perch.length, perch.width, 0.9, darkMat, 0, true, false)
      for (const ds of [-perch.length / 2 + 0.05, perch.length / 2 - 0.05]) boxes.place(s + ds, pl, 0.1, perch.width, perch.height - 0.9, darkMat, 0.9, true, false)
      for (let i = 0; i < 4; i++) boxes.place(s - 1.8 + i * 1.2, pl - 0.3, 0.5, 0.5, 0.5, darkMat, 0.9, true, false)
      canopies.push({ m: boxes.matrix(s, pl, 0.2, perch.height - 0.2, true, new THREE.Matrix4()), color: colour })
      backs.push({ m: boxes.matrix(s, pl - perch.width / 2 + 0.05, perch.height - 0.9, 0.9, true, new THREE.Matrix4()), color: colour })
    })
    boxes.instanced(perch.length, perch.width, 0.2, canopies, 0.5, false, 'perchCanopies')
    boxes.instanced(perch.length, 0.1, perch.height - 0.9, backs, 0.5, false, 'perchBacks')
  }


  // the wall's top ribbon and the fence's top rail share the building's white rail material
  add(rails, railMat, 'pitRails', false)
  add(concrete, concreteMat, 'pitWall', true)
}
