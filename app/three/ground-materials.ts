import * as THREE from 'three'
import { CIRCUIT } from '~/data/suzuka'
import { SEASON } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry } from './assets'
import { PLANAR_UV, type GroundMaterials } from './ground-mesh'
import { addMacro, addRoadSurface, grassSurfaceMaterial, pbr, pbrFromAssets, repeatMetres, tileMetres } from './materials'
import { ASPHALT_LINE_FRAC, ASPHALT_TILE_M, ASPHALT_WIDTH_M, asphaltMaps, concreteMaps, gravelMaps, helipadTexture, kerbMaps, paddockAsphaltTexture, turfMaps } from './textures'

/**
 * One material per ground owner kind (ground-plan.ts PRECEDENCE), for `buildGroundMeshes`.
 *
 * The uv each material expects is fixed by ground-mesh.ts `uvOf`: the road-frame kinds are
 * road-relative (u across in ASPHALT_WIDTH_M units or 0..1, v = s / tile), the field kinds are
 * world-planar with the metres per uv unit in PLANAR_UV. A material's macro / detail periods are
 * therefore stated in the same units here, and a change to PLANAR_UV must be mirrored.
 */
export function groundMaterials(assets: AssetRegistry | null): GroundMaterials {
  // --- the racing surface: lined asphalt, one macro period across the road and every 300 m along
  const road = pbr(asphaltMaps(true), {}, 1)
  addRoadSurface(road, new THREE.Vector2(1, ASPHALT_TILE_M / 300))

  const kerb = pbr(kerbMaps(), { roughness: 0.75 }, 0.9)

  // the crossover deck's shoulder and the garage apron: poured concrete
  const concrete = pbr(concreteMaps(), { roughness: 0.95 }, 0.6)

  // --- pit lane: the asphalt_pit_lane photo tile when the pack has it, else the lined tile inset
  // past its painted edge lines (cloned textures share the upload; only the transform differs)
  const proceduralPit = () => {
    const lined = asphaltMaps(true)
    const inset = (t: THREE.Texture) => {
      const c = t.clone()
      c.repeat.set(1 - 2 * ASPHALT_LINE_FRAC, 1)
      c.offset.set(ASPHALT_LINE_FRAC, 0)
      return c
    }
    const m = pbr({ map: inset(lined.map), normalMap: lined.normalMap && inset(lined.normalMap), roughnessMap: lined.roughnessMap && inset(lined.roughnessMap) }, {}, 1)
    addRoadSurface(m, new THREE.Vector2(1, ASPHALT_TILE_M / 300), CIRCUIT.pit.laneWidth)
    return m
  }
  let pitLane: THREE.MeshStandardMaterial
  if (assets && (['diff', 'nor_gl', 'arm'] as const).every((r) => assets.has(`tex/asphalt_pit_lane/${r}`))) {
    pitLane = pbrFromAssets(assets, 'asphalt_pit_lane', { fallback: proceduralPit, ground: true, handBuiltUv: true })
    const tile = tileMetres(assets, 'tex/asphalt_pit_lane/diff', 2)
    const uvM: [number, number] = [ASPHALT_WIDTH_M, ASPHALT_TILE_M]
    pitLane.map = repeatMetres(pitLane.map!.clone(), tile, uvM)
    pitLane.normalMap = repeatMetres(pitLane.normalMap!.clone(), tile, uvM)
    const arm = repeatMetres(pitLane.aoMap!.clone(), tile, uvM)
    pitLane.aoMap = pitLane.roughnessMap = pitLane.metalnessMap = arm
    const rep = pitLane.map.repeat
    addMacro(pitLane, new THREE.Vector2(1 / rep.x, ASPHALT_TILE_M / 300 / rep.y))
  } else pitLane = proceduralPit()

  // --- the asphalt run-off band: the unlined tile, u = metres from the road edge / 13, v = s / 20
  const asphaltBand = pbr(asphaltMaps(false), {}, 1)
  addRoadSurface(asphaltBand, new THREE.Vector2(1, ASPHALT_TILE_M / 300))

  // --- paved areas and the offset lanes: world-planar, so the macro variation is isotropic
  const area = PLANAR_UV.asphaltArea!
  const asphaltArea = pbr(asphaltMaps(false), {}, 1)
  addRoadSurface(asphaltArea, new THREE.Vector2(area[0] / 120, area[1] / 120), area[0])

  const turf = pbr(turfMaps(), { roughness: 0.95 }, 0.9)
  const gravel = pbr(gravelMaps(), {}, 1.0)

  // the grass verge and the grass islands share the terrain's tile scale and macro period, so
  // the three phase-lock instead of showing a seam at the extent
  const g = PLANAR_UV.grass!
  const grass = grassSurfaceMaterial(assets, g, [250, 250], 0.8)

  // the paddock aprons: flat grey asphalt with a macro period of 250 m (uv unit = 40 m)
  const pad = PLANAR_UV.paddock!
  const paddock = new THREE.MeshStandardMaterial({ map: paddockAsphaltTexture(), color: 0xb8b8b8, roughness: 0.95 })
  addMacro(paddock, new THREE.Vector2(pad[0] / 250, pad[1] / 250))

  const helipad = new THREE.MeshStandardMaterial({ map: helipadTexture(), roughness: 0.45 })

  // the retention basins: dry mud in late March (BASINS.dry), water in the October palette
  const water = SEASON === 'spring'
    ? new THREE.MeshStandardMaterial({ color: 0x8a7d66, roughness: 0.95 })
    : new THREE.MeshStandardMaterial({ color: 0x2f4d58, roughness: 0.08, metalness: 0.55 })

  return {
    road,
    kerb,
    deckShoulder: concrete,
    pitLane,
    pitApron: concrete,
    lane: asphaltArea,
    asphaltArea,
    turf,
    gravelArea: gravel,
    grassArea: grass,
    paddock,
    helipad,
    water,
    gravelBand: gravel,
    asphaltBand,
    grass,
  }
}
