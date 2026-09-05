import * as THREE from 'three'
import { CIRCUIT } from '~/data/suzuka'
import { TEAMS, TEAM_ORDER } from '~/data/drivers'
import type { Track } from '~/sim/track'
import type { Ground } from './ground'
import type { BoxPlacer } from './boxes'
import { boardTexture, garageTexture } from './textures'
import { EMISSIVE, emissiveScale } from './emissive'

/**
 * Legacy pit complex: the main pit building (open garages facing the lane, the glass hospitality
 * floor, race control tower), the paddock trucks and buildings behind it, and the Dunlop bridge.
 * Everything goes through the shared `boxes` placer, so the single-material parts are merged
 * together with the trackside props when the caller flushes it. Slated to be replaced by the
 * footprint-based generator (and the bridge by nothing).
 * Returns the building roof material: the marshal huts reuse it, which keeps their roofs in the
 * same merged mesh.
 */
export function buildLegacyPitComplex(track: Track, ground: Ground, boxes: BoxPlacer): { buildingRoofMat: THREE.MeshStandardMaterial } {
  // --- pit building, race control, paddock ------------------------------------------------
  const pit = CIRCUIT.pit
  const garageMat = new THREE.MeshStandardMaterial({ map: garageTexture(), roughness: 0.7 })
  const buildingMat = new THREE.MeshStandardMaterial({ color: 0xd2d4d6, roughness: 0.7 })
  const buildingRoofMat = new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.8 })
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x3f6f9c, roughness: 0.12, metalness: 0.85 })
  const pitCentre = track.wrap(pit.boxStartS + 5 * pit.boxSpacing)
  // main pit building behind the pit lane: open garages facing the lane (and the track), the
  // glass hospitality floor above them, the paddock at the back.
  // Local frame of boxes.place: +X = left of the track (towards the circuit), so the pit-lane
  // face of the building is its +X face at lateral `pit.garageFront`.
  {
    const depth = 13, height = 10, length = 320
    const front = pit.garageFront // -21
    const centre = front - depth / 2 // -27.5
    const back = front - depth // -34
    // upper floor (hospitality) over the garages: solid block from 4.6 m up, glass towards the track
    boxes.place(pitCentre, centre, length, depth, height - 4.6, [glassMat, buildingMat, buildingRoofMat, buildingMat, buildingMat, buildingMat], 4.6, true)
    // garage floor slab (level with the pit apron) and the paddock-side back wall up to the ceiling
    boxes.place(pitCentre, centre, length, depth, 0.3, buildingMat, -0.3, true)
    boxes.place(pitCentre, back + 0.6, length, 1.2, 4.6, buildingMat, 0, true)
    // team-coloured interior back walls + the fascia above each bay opening
    const teams = TEAM_ORDER.map((id) => TEAMS[id])
    const walls: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const boards: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: EMISSIVE.garageStrip.color, emissiveIntensity: EMISSIVE.garageStrip.intensity * emissiveScale() })
    const cartMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7 })
    const tyreStackMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.9 })
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t]!
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing)
      walls.push({ m: boxes.matrix(s, back + 1.5, 4.4, 0, true, new THREE.Matrix4()), color: new THREE.Color(team.body) })
      // the fascia shows this team's slice of the one façade texture: baked into the box uv
      // (every face — only the lane face is visible) instead of a cloned, offset texture per team
      boxes.place(s, front - 0.2, pit.boxSpacing - 1.5, 0.25, 1.1, garageMat, 3.4, true, false, (uv) => {
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (t + uv.getX(i)) / teams.length, 0.55 + uv.getY(i) * 0.15)
      })
      // lit ceiling strips in the bay (bloom on the high tier)
      boxes.place(s, centre, pit.boxSpacing - 6, 6, 0.1, lampMat, 4.3, true, false)
      // a couple of props: tool carts / tyre stacks (interior: never cast)
      boxes.place(s - 6, centre - 2, 1.2, 1.0, 1.1, cartMat, 0, true, false)
      boxes.place(s + 7, centre - 3, 0.7, 0.7, 1.3, tyreStackMat, 0, true, false)
    }
    boxes.instanced(pit.boxSpacing - 1.5, 0.3, 4.4, walls, 0.6, false, 'garageWalls')
    // columns between the bays along the pit-lane face
    for (let t = 0; t <= teams.length; t++) {
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing - pit.boxSpacing / 2)
      boxes.place(s, front - 0.4, 0.8, 0.8, 4.6, buildingMat, 0, true)
    }
    boxes.place(pitCentre, centre, length + 4, depth + 2, 1.2, buildingMat, height, true) // roof slab
    boxes.place(pitCentre, front + 0.8, length - 4, 2.2, 5, glassMat, height + 0.6, true) // hospitality deck rail over the lane
    // pit gantries: a post at the garage line carrying an arm over the working lane with the number board
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.5, metalness: 0.6 })
    for (let t = 0; t < teams.length; t++) {
      const s = track.wrap(pit.boxStartS + t * pit.boxSpacing)
      boxes.place(s, front + 0.6, 0.3, 0.3, 4.2, gantryMat, 0, true)
      boxes.place(s, front + 4.3, 0.3, 7.6, 0.3, gantryMat, 4.2, true, false)
      boards.push({ m: boxes.matrix(s, pit.laneOffset - 2.5, 1.2, 3.0, true, new THREE.Matrix4()), color: new THREE.Color(teams[t]!.body) })
    }
    boxes.instanced(2.4, 0.15, 1.2, boards, 0.5, false, 'pitBoards')
    // race control tower rising out of the building at the line
    boxes.place(2, centre - 0.5, 16, depth + 1, 22, [glassMat, buildingMat, buildingRoofMat, buildingMat, buildingMat, buildingMat], 0, true)
  }
  // paddock: motorhomes / trucks (on the terrain behind the building)
  const truckMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 })
  for (let i = 0; i < 16; i++) {
    const s = track.wrap(5580 + i * 21)
    boxes.place(s, -48 - (i % 2) * 18, 14, 4.5, 4, truckMat, 0, false, false)
  }
  for (let i = 0; i < 7; i++) {
    const s = track.wrap(5600 + i * 44)
    boxes.place(s, -80, 24, 12, 8, [buildingMat, buildingMat, buildingRoofMat, buildingMat, glassMat, glassMat])
  }

  // --- Dunlop bridge: a sponsor bridge spanning the track at the top of Dunlop Curve -----------
  {
    const s = 1880
    const hw2 = track.halfWidthAt(s)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.5 })
    const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.5 })
    for (const side of [1, -1]) boxes.place(s, side * (hw2 + 4), 2.2, 2.2, 7.6, towerMat, -0.1, true)
    boxes.place(s, 0, 2 * hw2 + 10.4, 2.6, 2.4, [towerMat, towerMat, towerMat, towerMat, boardMat, boardMat], 7.5, true)
    boxes.place(s, 0, 2 * hw2 + 10.4, 3.0, 0.4, towerMat, 9.9, true)
  }

  return { buildingRoofMat }
}
