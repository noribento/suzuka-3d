import * as THREE from 'three'
import { CIRCUIT } from '~/data/suzuka'
import { SEASON } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry } from './assets'
import { PLANAR_UV, type GroundMaterials } from './ground-mesh'
import type { CoverLayer } from './landcover'
import { addMacro, addRoadSurface, grassSurfaceMaterial, pbr, pbrFromAssets, repeatMetres, tileMetres } from './materials'
import { ASPHALT_LINE_FRAC, ASPHALT_TILE_M, ASPHALT_WIDTH_M, asphaltMaps, cached, concreteMaps, gravelMaps, groundAniso, helipadTexture, kerbMaps, makeTexture, type MaterialMaps, Noise2, normalMapFrom, paddockAsphaltTexture, paint, scaled, turfMaps } from './textures'

/**
 * One material per ground owner kind (ground-plan.ts PRECEDENCE), for `buildGroundMeshes`.
 *
 * The uv each material expects is fixed by ground-mesh.ts `uvOf`: the road-frame kinds are
 * road-relative (u across in ASPHALT_WIDTH_M units or 0..1, v = s / tile), the field kinds are
 * world-planar with the metres per uv unit in PLANAR_UV. A material's macro / detail periods are
 * therefore stated in the same units here, and a change to PLANAR_UV must be mirrored.
 *
 * `cover` (landcover.ts, the INNER layer — `landCover.layer('inner')`) goes to the grass
 * materials so the verge and the grass islands carry the same land-cover splat as the terrain:
 * the partition's edge is then invisible in the mask (R1 is unaffected — an owner is still
 * decided by the face, not by the pixels on it).
 */
export function groundMaterials(assets: AssetRegistry | null, cover: CoverLayer | null = null): GroundMaterials {
  // --- the racing surface: lined asphalt, one macro period across the road and every 300 m along
  const road = pbr(asphaltMaps(true), {}, 1)
  addRoadSurface(road, new THREE.Vector2(1, ASPHALT_TILE_M / 300))

  const kerb = pbr(kerbMaps(), { roughness: 0.75 }, 0.9)

  // the crossover deck's shoulder: poured concrete
  const concrete = pbr(concreteMaps(), { roughness: 0.95 }, 0.6)
  // the garage apron: the same concrete cast in 6 m bays with sawn joints (I1-c); uvOf gives it
  // u = 6 m across from the working-lane edge and v = 4 m along, so the square tile is repeated
  // 2/3 along to keep the bays square. Both tiers — the apron carries no pack material.
  const apronMaps = apronConcreteMaps()
  apronMaps.map.repeat.set(1, APRON_V_M / APRON_JOINT_M)
  apronMaps.normalMap!.repeat.set(1, APRON_V_M / APRON_JOINT_M)
  const pitApron = pbr(apronMaps, { roughness: 0.95 }, 0.7)

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

  // --- the offset lanes: world-planar, so the macro variation is isotropic
  const area = PLANAR_UV.asphaltArea!
  const lane = pbr(asphaltMaps(false), {}, 1)
  addRoadSurface(lane, new THREE.Vector2(area[0] / 120, area[1] / 120), area[0])
  // --- the paved areas (I5-a): the south course, the service roads and the aprons are a darker,
  // coarser tarmac than the racing surface — ambientCG Asphalt033 (2.5 m tile) sampled
  // world-planar with the paddock's macro period on the high tier (pbrFromAssets + addMacro, the
  // paddock's own program), the unlined tile darkened to 0x8c8c8a everywhere else
  const proceduralArea = () => {
    const m = pbr(asphaltMaps(false), { color: 0x8c8c8a }, 1)
    addRoadSurface(m, new THREE.Vector2(area[0] / 120, area[1] / 120), area[0])
    return m
  }
  let asphaltArea: THREE.MeshStandardMaterial
  if (assets && (['diff', 'nor_gl', 'arm'] as const).every((r) => assets.has(`tex/asphalt033/${r}`))) {
    asphaltArea = pbrFromAssets(assets, 'asphalt033', { fallback: proceduralArea, ground: true, handBuiltUv: true, normalScale: 0.8 })
    const tile = tileMetres(assets, 'tex/asphalt033/diff', 2.5)
    asphaltArea.map = repeatMetres(asphaltArea.map!.clone(), tile, area)
    asphaltArea.normalMap = repeatMetres(asphaltArea.normalMap!.clone(), tile, area)
    const arm = repeatMetres(asphaltArea.aoMap!.clone(), tile, area)
    asphaltArea.aoMap = asphaltArea.roughnessMap = asphaltArea.metalnessMap = arm
    const rep = asphaltArea.map.repeat
    addMacro(asphaltArea, new THREE.Vector2(area[0] / 250 / rep.x, area[1] / 250 / rep.y))
  } else asphaltArea = proceduralArea()

  const turf = pbr(turfMaps(), { roughness: 0.95 }, 0.9)
  const gravel = pbr(gravelMaps(), {}, 1.0)

  // the grass verge and the grass islands share the terrain's tile scale and macro period, so
  // the three phase-lock instead of showing a seam at the extent
  const g = PLANAR_UV.grass!
  const grass = grassSurfaceMaterial(assets, g, [250, 250], 0.8, cover)

  // --- the paddock aprons and car parks (I2-a): Poly Haven asphalt_04 (the public roads' tile,
  // 4.04 m, lighter and coarser than the pit lane) sampled world-planar (uv unit = 40 m) with the
  // same 250 m macro period; the pack-less tiers keep the grey noise, darkened to the photo's
  // mid grey. pbrFromAssets + addMacro is the pit lane's own combination (program key 'macro').
  const pad = PLANAR_UV.paddock!
  const proceduralPaddock = () => new THREE.MeshStandardMaterial({ map: paddockAsphaltTexture(), color: 0x9a9a9a, roughness: 0.95 })
  let paddock: THREE.MeshStandardMaterial
  if (assets && (['diff', 'nor_gl', 'arm'] as const).every((r) => assets.has(`tex/asphalt_04/${r}`))) {
    paddock = pbrFromAssets(assets, 'asphalt_04', { fallback: proceduralPaddock, ground: true, handBuiltUv: true, normalScale: 0.8 })
    const tile = tileMetres(assets, 'tex/asphalt_04/diff', 4.04)
    paddock.map = repeatMetres(paddock.map!.clone(), tile, pad)
    paddock.normalMap = repeatMetres(paddock.normalMap!.clone(), tile, pad)
    const arm = repeatMetres(paddock.aoMap!.clone(), tile, pad)
    paddock.aoMap = paddock.roughnessMap = paddock.metalnessMap = arm
    // vMapUv carries the map's repeat: the macro period is stated per uv unit and divided back out
    const rep = paddock.map.repeat
    addMacro(paddock, new THREE.Vector2(pad[0] / 250 / rep.x, pad[1] / 250 / rep.y))
  } else {
    paddock = proceduralPaddock()
    addMacro(paddock, new THREE.Vector2(pad[0] / 250, pad[1] / 250))
  }

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
    pitApron,
    lane,
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

/** metres of the pit apron one uv unit spans along s (ground-mesh.ts `uvOf`, case 'pitApron': v = s / 4) */
const APRON_V_M = 4
/** the apron's concrete bays: one 1024² tile = one 6 m bay across (the uv's u unit) */
const APRON_JOINT_M = 6

/**
 * The pit apron's concrete (I1-c): one 6 m bay per tile — the field of the crossover's
 * `concreteMaps` (the same fbm aggregate and staining, a fresh seed) with two 25 mm sawn joint
 * lines (one per axis: the tile's edges, so the repeat makes the 6 m grid) drawn dark and cut
 * into the height field, so the normal map carries the groove and the joint reads under a
 * raking sun as a step, not a stripe. Cached per textureScale like every procedural tile.
 */
export function apronConcreteMaps(): MaterialMaps {
  const [w, h] = scaled(1024, 1024)
  return cached(`pit-apron-${w}`, () => {
    const n = new Noise2(29)
    const height = new Float32Array(w * h)
    // 25 mm of a 6 m bay, at least one texel on the low tier
    const jw = Math.max(1, Math.round((0.025 / APRON_JOINT_M) * w))
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      const f = n.fbm(u * 32, v * 32, 32, 32, 4, 0.5)
      const stain = n.fbm(u * 3, v * 3, 3, 3, 3, 0.6)
      // the joint: a dark groove along both tile edges (wraps with the repeat)
      const joint = x < jw || y < jw
      // a faint band of lighter, smoother concrete beside the joint where the saw cleaned it
      const edge = Math.min(x, y, w - x, h - y) / w
      const lip = edge < 0.01 ? (1 - edge / 0.01) * 6 : 0
      const base = 150 + (f - 0.5) * 40 + (stain - 0.5) * 30 + lip
      const dark = joint ? 0.55 : 1
      out[0] = (base + 2) * dark
      out[1] = base * dark
      out[2] = (base - 6) * dark
      height[y * w + x] = joint ? f - 0.9 : f
    })
    return { map: makeTexture(c, { aniso: groundAniso() }), normalMap: normalMapFrom(height, w, h, 0.8, 0.8, groundAniso()) }
  })
}
