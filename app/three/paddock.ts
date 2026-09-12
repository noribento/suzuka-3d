import * as THREE from 'three'
import { TEAMS } from '~/data/drivers'
import { BUILDINGS, COLOURS, GARAGE_ORDER, PIT_BOX_STRIP, PIT_BUILDING, garageS } from '~/data/suzuka-facilities-spec'
import { OSM_BUILDINGS, osmFeature, type OsmFeature } from '~/data/suzuka-facilities'
import type { EnvBuildContext } from './environment'
import { LAYER, markDecal } from './ground'
import { addMerged, enMatrix, frameAt, pitMaterials, slice } from './pit-geometry'

/**
 * The paddock behind the pit building (plan I2): the team-office row, the centre house, the
 * fences and gates, the car parks. v1 as moved out of pit-complex.ts (I1-a): the BUILDINGS
 * footprints and every other OSM building inside the paddock box extruded on the drawn ground,
 * white prefab rows, team-coloured transporters, tents, flag poles (on the T1 cap roof and at
 * the gate) and the car park with its bay-line decals — I2 rewrites it from the drawings. The
 * umbrella (infield.ts) calls it after buildPitLane and laps its wall-clock as 'paddock';
 * `buildingRoofMat` is the pit complex's shared roof material (the same object as
 * `pitMaterials(ctx).buildingRoofMat`).
 */

const _p = new THREE.Vector3()

export function buildPaddock(ctx: EnvBuildContext, opts: { buildingRoofMat: THREE.Material }): void {
  const { track, ground, group, boxes } = ctx
  const { buildingRoofMat } = opts
  const { railMat, whiteMat } = pitMaterials(ctx)
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => addMerged(group, geos, mat, name, cast)
  // the T1 end of the box strip and the roof line: the flag poles stand on the T1 cap's roof
  const S1 = track.wrap(PIT_BOX_STRIP[1]) // 88
  const ROOF = PIT_BUILDING.roofTop
  const teams = GARAGE_ORDER.map((id) => TEAMS[id])

  // --- paddock: footprint buildings, prefabs, transporters, tents, flags, car park ------------------
  // (the asphalt aprons behind the building and around the medical centre are the `paddock` rows
  // of GROUND_AREAS, drawn by ground-mesh.ts on the field; the helipad is its `helipad` row)
  {
    // real footprints: the spec'd buildings plus every other OSM building inside the paddock box
    const capGeos: THREE.BufferGeometry[] = []
    const wallGeos: THREE.BufferGeometry[] = []
    const extrude = (f: OsmFeature, height: number, base: number) => {
      const shape = new THREE.Shape(f.en.map(([e, n]) => new THREE.Vector2(e, n)))
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
      geo.applyMatrix4(enMatrix(track, base))
      for (const g of geo.groups) (g.materialIndex === 0 ? capGeos : wallGeos).push(slice(geo, g.start, g.count))
      geo.dispose()
    }
    /** the drawn ground (world height) under track (s, lateral) */
    const standWorld = (s: number, lat: number): number => {
      track.pointAt(s, lat, _p, 0)
      return ground.standY(_p.x, _p.z)
    }
    const done = new Set<number>()
    for (const b of BUILDINGS) {
      if (b.osmWay === null) continue
      const f = osmFeature(b.osmWay)
      if (!f) continue
      done.add(f.id)
      let base: number
      if (b.anchor === 'terrain') {
        const [ce, cn] = f.en.reduce(([ae, an], [e, n]) => [ae + e / f.en.length, an + n / f.en.length], [0, 0])
        track.enToWorld(ce, cn, _p)
        base = ground.standY(_p.x, _p.z) - 0.5
      } else base = standWorld(b.anchor.s, b.anchor.lateral) - 0.5
      extrude(f, b.height + 0.5, base)
    }
    const inPaddock = (f: OsmFeature) => {
      const [s, lat] = f.centroid
      return lat < -57 && lat > -135 && (s > 5530 || s < 260) && !f.fold
    }
    for (const f of OSM_BUILDINGS) {
      if (done.has(f.id) || !inPaddock(f)) continue
      done.add(f.id)
      extrude(f, 4.5, standWorld(f.centroid[0], f.centroid[1]) - 0.4)
    }
    add(wallGeos, whiteMat, 'paddockBuildings', true)
    add(capGeos, buildingRoofMat, 'paddockRoofs', true)

    // transporters backed up to the rear wall behind each team's garage, two per team
    const trailers: { m: THREE.Matrix4; color: THREE.Color }[] = []
    teams.forEach((team, g) => {
      const s = garageS(g)
      for (const ds of [-5, 5]) {
        trailers.push({ m: boxes.matrix(s + ds, -64.5, 4.0, 0, false, new THREE.Matrix4()), color: new THREE.Color(team.body) })
        boxes.place(s + ds, -72.6, 2.5, 2.4, 3.2, whiteMat, 0, false, false) // cab
      }
    })
    boxes.instanced(2.55, 13.6, 4.0, trailers, 0.5, true, 'transporters')
    // white prefab hospitality units along the T1 end of the paddock road
    for (let i = 0; i < 6; i++) boxes.place(track.wrap(5790 + i * 13), -78, 12, 6, 3.4, whiteMat, 0, false, true)
    for (let i = 0; i < 6; i++) boxes.place(track.wrap(5790 + i * 13), -78, 12.4, 6.4, 0.2, buildingRoofMat, 3.4, false, false)
    // tents (white and red) on the final-corner side
    const tentMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.9, side: THREE.DoubleSide })
    const tentRedMat = new THREE.MeshStandardMaterial({ color: COLOURS.circuitRed.lit, roughness: 0.9, side: THREE.DoubleSide })
    const tentGeos: THREE.BufferGeometry[] = []
    const tentRedGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 6; i++) {
      const s = 5600 + i * 9
      const lat = -70
      const cone = new THREE.ConeGeometry(4.6, 2.2, 4, 1, true)
      cone.rotateY(Math.PI / 4)
      cone.applyMatrix4(frameAt(track, s, lat, ground.standAt(s, lat) + 2.7 + 1.1, new THREE.Matrix4()))
      ;(i % 3 === 1 ? tentRedGeos : tentGeos).push(cone)
      for (const [ds, dl] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) boxes.place(s + ds, lat + dl, 0.1, 0.1, 2.7, railMat, 0, false, false)
    }
    add(tentGeos, tentMat, 'tents', false)
    add(tentRedGeos, tentRedMat, 'tentsRed', false)
    // flag poles on the T1 cap roof (as in the photos) and at the paddock gate
    const flagGeos: THREE.BufferGeometry[] = []
    const flagColours = [0xffffff, COLOURS.circuitRed.lit, 0x1d5bb5, 0xffffff, COLOURS.signageGreen.mid]
    const flagMats = flagColours.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }))
    const flagsByMat: THREE.BufferGeometry[][] = flagColours.map(() => [])
    const pole = (s: number, lat: number, yBase: number, i: number) => {
      const p = new THREE.CylinderGeometry(0.04, 0.05, 9, 6)
      p.applyMatrix4(frameAt(track, s, lat, yBase + 4.5, new THREE.Matrix4()))
      flagGeos.push(p)
      const f = new THREE.PlaneGeometry(1.6, 1.0)
      f.translate(0, 0, -0.8)
      f.applyMatrix4(frameAt(track, s, lat + 0.02, yBase + 8.3, new THREE.Matrix4()))
      flagsByMat[i % flagColours.length]!.push(f)
    }
    for (let i = 0; i < 5; i++) pole(track.wrap(S1 + 1 + i * 1.5), -36 - i * 4, ROOF + 0.3, i)
    for (let i = 0; i < 6; i++) pole(5548, -62 - i * 5, ground.standAt(5548, -62 - i * 5), i)
    add(flagGeos, railMat, 'flagPoles', false)
    flagsByMat.forEach((geos, i) => add(geos, flagMats[i]!, `flags${i}`, false))
    // car park west of the team offices: bay lines and a few parked cars
    const lines: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const cars: { m: THREE.Matrix4; color: THREE.Color }[] = []
    const carColours = [0xf2f2f2, 0x1a1a1a, 0x8a8f95, 0xb01e28, 0x2b4a8c, 0xd8d8d8]
    let ci = 0
    for (const lat0 of [-104, -116]) {
      for (let s = 5600; s <= 5735; s += 2.6) {
        // only where the paddock is level under the whole 5 m bay: the car park steps down a bank
        // at its west end, and a slab (or a car) across the bank would hang in the air
        const level = [lat0 - 5, lat0 - 2.5, lat0].map((l) => { track.pointAt(s, l, _p, 0); return ground.standY(_p.x, _p.z) })
        if (Math.max(...level) - Math.min(...level) > 0.02) { ci++; continue }
        // bay lines: 1 cm slabs whose underside is LAYER.pit.line over the drawn paddock (a decal)
        lines.push({ m: boxes.matrix(s, lat0 - 2.5, 0.01, LAYER.pit.line, false, new THREE.Matrix4()), color: new THREE.Color(0xf4f4f0) })
        if (ci++ % 3 !== 1) cars.push({ m: boxes.matrix(s + 1.3, lat0 - 2.5, 1.45, 0, false, new THREE.Matrix4()), color: new THREE.Color(carColours[ci % carColours.length]!) })
      }
    }
    markDecal(boxes.instanced(0.12, 5, 0.01, lines, 0.8, false, 'parkingLines'), LAYER.pit.line)
    boxes.instanced(1.8, 4.4, 1.45, cars, 0.45, true, 'parkedCars')
  }
}
