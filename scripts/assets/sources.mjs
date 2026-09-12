/**
 * Third-party asset sources for the high-quality tier (plan §1a / §1b).
 *
 * One entry per source asset. `fetch.mjs` downloads the `files` into misc/dl/<key>/ (or, for
 * `misc-local`, expects the user to have dropped the files under misc/), and `import-misc.mjs`
 * converts them into public/assets/ with content-hashed names and writes the manifest.
 *
 * Decisions carried over from the plan — do not re-add: leafy_grass (contradicts late March),
 * Road007 (white lines stay procedural), Plastic011, metal_plate_02, any HDRI (the analytic sky
 * dome IBL follows the sun and cannot coexist with a fixed HDRI), aerial_grass_rock,
 * concrete_panels, box_profile_metal_sheet, TextureCan ground_0040, Poly Haven's dense trees
 * (pine_tree_01.bin is 948 MB), the Suzuka wordmark (trademark), and — since R Phase 2 — the
 * Quaternius low-poly trees / bush and Poly Haven shrub_03 (stylised; replaced by the Sketchfab
 * packs below, with the procedural cones as the fallback when a pack is missing).
 *
 * Map roles: diff → sRGB colour, nor_gl → linear OpenGL-convention normal, arm → linear packed
 * R = ambient occlusion (1.0 when the source has none), G = roughness, B = metalness (0 when
 * absent), opacity → linear cut-out mask.
 *
 * Texture fields: `res` is the shipped size ('512' | '1k' | '2k' | '4k'), `fetchRes` the size in
 * the download URL when the site has no file at `res` (Poly Haven has no _512: fetch 1k, ship
 * 512); `pixels: true` ships WebP (lossless ≤ 512²) instead of KTX2 for textures the runtime
 * reads back with drawImage (building facade array layers).
 * Model fields (all optional; import-misc.mjs `packModel` runs them in this order):
 *   dropNodes / keepNodes  RegExp on the node's full name path (`Root/Pine_1/LOD2`, see
 *                          inspect-model.mjs) — drop LOD / billboard / season variants at import
 *   overrideImages         { '<image index | name regex>': 'file relative to the drop dir' |
 *                          'misc/<path>' | '@<name regex of another image of the model>' }
 *   maxTex                 cap for textures inside the GLB (default 1024)
 *   metalrough             true → gltf-transform metalrough before the resize: a drop authored
 *                          with KHR_materials_pbrSpecularGlossiness (three's GLTFLoader no longer
 *                          reads it) becomes metallic-roughness + KHR_materials_specular
 *   retouch / dropParts    trademark surgery (retouch-glb.mjs: UV rectangles blurred / filled,
 *                          primitives dropped by material / mesh name regex)
 *   retouchReviewed        vehicles (`model/vehicles/*`) and the ops layer (`model/ops/*`) must
 *                          carry a non-empty `retouch` — or this string, saying why none is
 *                          needed after every texture was dumped and read (a fictional-brand
 *                          body). `import-misc.mjs --check` fails a source with neither.
 *   keepBox                { min?, max? } scene-space AABB (the model's own units, as
 *                          inspect-model.mjs prints them): triangles outside are dropped — for a
 *                          one-primitive drop that also holds a backdrop or a second prop
 *   texEncode              { default?, normal?, alpha?: 'etc1s' | 'uastc' | 'none', quality? } →
 *                          KTX2 inside the GLB (normal + alpha-tested default to uastc, rest
 *                          etc1s; `quality` is the etc1s qlevel); absent = textures stay PNG/JPEG
 *   simplify               0–1 → gltfpack -si -sa (the triangle ratio to keep, reached — plain
 *                          -si stops at a 1 % error bound and barely touches a scan-like mesh)
 * misc-local: `zip` / `entry` may be a glob-like string or RegExp (Sketchfab zip names vary);
 * the first match directly under the first existing `miscRoots` entry wins (convention:
 * ['<group>/<id>', '<group>', '.'], where <group> is the key's middle segment — `sketchfabModel`
 * derives it); `entry` defaults to scene.gltf or the single *.glb.
 *
 * Only '2k' for the hero grass; everything else ships at 1K or 512 (budget: ≤ 200 MB on disk,
 * ≤ 512 MB RGBA8-equivalent VRAM, enforced by import-misc.mjs --check).
 */

/** User-Agent for every request: poly.pizza needs the Mozilla prefix, Wikimedia wants a contact. */
export const UA = 'Mozilla/5.0 (compatible; suzuka3d/0.1; +mailto:bhyg756@gmail.com)'

export const RES_PX = { 512: 512, '1k': 1024, '2k': 2048, '4k': 4096 }

/** Licences that may ever reach public/assets (checked by `import-misc.mjs --check`). */
export const LICENCES = {
  'CC0-1.0': { name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-3.0': { name: 'Creative Commons Attribution 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  'CC-BY-4.0': { name: 'Creative Commons Attribution 4.0', url: 'http://creativecommons.org/licenses/by/4.0/' },
  'Apache-2.0': { name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
}

const PH_TEX = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg'

/**
 * The misc/<group>/ folders that receive Sketchfab CC-BY drops (the middle segment of a
 * `model/<group>/<id>` key): `sketchfabModel` refuses a key outside this list, and
 * `import-misc.mjs --check` accepts a shipped file only from a declared root. ops / trackside /
 * pit are the I phase's (柵の内側): the drops named in the plan go there before their entries exist.
 */
export const MISC_GROUPS = ['trees', 'road', 'buildings', 'vehicles', 'seats', 'ops', 'trackside', 'pit']

/**
 * The KTX2 recipe every model pack ships with unless a source says otherwise: normals and
 * alpha-tested colour UASTC, everything else ETC1S at qlevel 160 (the Sketchfab default below
 * and the Poly Haven props since the I phase — a JPEG inside a GLB is decoded to RGBA8, 4× the
 * VRAM of a transcoded KTX2).
 */
const KTX_PACK = { default: 'etc1s', normal: 'uastc', alpha: 'uastc', quality: 160 }

/**
 * Poly Haven texture: predictable URL template, three maps (diff / nor_gl / arm) unless `maps`
 * narrows the list (a texture only read for its colour ships diff alone: no download, no file,
 * no VRAM for maps nobody samples). Smallest published size is 1k, so a 512 entry sets
 * `fetchRes: '1k'` (the default when `res` is 512).
 */
function polyhavenTexture (id, { name, author, res = '1k', fetchRes = RES_PX[res] < 1024 ? '1k' : res, tile, use, pixels, maps = ['diff', 'nor_gl', 'arm'] }) {
  const f = (map) => `${id}_${map}_${fetchRes}.jpg`
  return {
    key: `tex/${id}`,
    kind: 'texture',
    site: 'Poly Haven',
    name,
    id,
    pageUrl: `https://polyhaven.com/a/${id}`,
    author,
    licence: 'CC0-1.0',
    resolver: 'direct',
    res,
    ...(fetchRes !== res ? { fetchRes } : {}),
    ...(pixels ? { pixels: true } : {}),
    tile,
    use,
    files: Object.fromEntries(maps.map(m => [f(m), `${PH_TEX}/${fetchRes}/${id}/${f(m)}`])),
    maps: Object.fromEntries(maps.map(m => [m, f(m)])),
  }
}

/**
 * ambientCG texture: one zip per resolution behind a 302. Map values are member-name suffixes;
 * a trailing '?' marks an optional member (packed with a neutral value when missing). Like Poly
 * Haven, 1K is the smallest zip, so `res: '512'` fetches 1K.
 */
function ambientcgTexture (id, { name, res = '1k', fetchRes = RES_PX[res] < 1024 ? '1k' : res, tile, use, maps, pixels }) {
  const zip = `${id}_${fetchRes.toUpperCase()}-JPG.zip`
  return {
    key: `tex/${id.toLowerCase()}`,
    kind: 'texture',
    site: 'ambientCG',
    name,
    id,
    pageUrl: `https://ambientcg.com/view?id=${id}`,
    author: 'Lennart Demes',
    licence: 'CC0-1.0',
    resolver: 'ambientcg-redirect',
    res,
    ...(fetchRes !== res ? { fetchRes } : {}),
    ...(pixels ? { pixels: true } : {}),
    tile,
    use,
    files: { [zip]: `https://ambientcg.com/get?file=${zip}` },
    zip,
    maps,
  }
}

/** poly.pizza GLB (Quaternius CC0 mirror). `publicId` is the page slug, `resourceId` the file; `pack` = model fields above. */
function polypizzaModel (key, { name, publicId, resourceId, author = 'Quaternius', use, maxTex, ...pack }) {
  const file = `${key.split('/').pop()}.glb`
  return {
    ...(maxTex ? { maxTex } : {}),
    ...pack,
    key,
    kind: 'model',
    site: 'poly.pizza',
    name,
    pageUrl: `https://poly.pizza/m/${publicId}`,
    author,
    authorUrl: 'https://poly.pizza/u/Quaternius',
    licence: 'CC0-1.0',
    resolver: 'polypizza',
    use,
    files: { [file]: `https://static.poly.pizza/${resourceId}.glb` },
    entry: file,
  }
}

/** Poly Haven model: the .bin folder is not derivable, so fetch.mjs resolves it via the API. `pack` = model fields above. */
function polyhavenModel (id, { name, author, res = '1k', use, maxTex, ...pack }) {
  return {
    ...(maxTex ? { maxTex } : {}),
    ...pack,
    key: `model/${use.startsWith('veg') ? 'veg' : 'props'}/${id}`,
    kind: 'model',
    site: 'Poly Haven',
    name,
    id,
    pageUrl: `https://polyhaven.com/a/${id}`,
    author,
    licence: 'CC0-1.0',
    resolver: 'polyhaven-api',
    res,
    use,
    apiUrl: `https://api.polyhaven.com/files/${id}`,
    // files are filled in from the API response at fetch time (gltf + include list)
  }
}

/**
 * Sketchfab drop (CC-BY 4.0): the model page's auto-converted glTF zip under misc/<group>/ (or
 * misc/), where <group> is the key's middle segment (`model/trees/…` → misc/trees/, `model/road/…`
 * → misc/road/), scene.gltf inside, license.txt as evidence — the importer takes the credit line
 * (title / author / URL) from that file, so `author` / `authorUrl` here only need to match it.
 * `authorUrl` defaults to the Sketchfab profile named like `author` (most usernames are the
 * display name; pass it when they differ). `pack` = the model fields above (dropNodes /
 * keepNodes / overrideImages / maxTex / simplify / texEncode); by default every pack ships KTX2
 * at ≤ 1K with the tree recipe (foliage alpha + normals UASTC, the rest ETC1S q160).
 */
function sketchfabModel (key, { name, zip, author, authorUrl = `https://sketchfab.com/${author}`, pageUrl, use, maxTex = 1024, texEncode = KTX_PACK, ...pack }) {
  if (!MISC_GROUPS.includes(key.split('/')[1])) throw new Error(`${key}: group ${key.split('/')[1]} is not in MISC_GROUPS`)
  return {
    ...pack,
    key,
    kind: 'model',
    site: 'Sketchfab',
    name,
    pageUrl,
    author,
    authorUrl,
    licence: 'CC-BY-4.0',
    resolver: 'misc-local',
    use,
    miscRoots: [key.split('/')[1], '.'],
    zip,
    entry: 'scene.gltf',
    licenceFile: 'license.txt',
    licenceMarker: 'CC-BY-4.0',
    maxTex,
    texEncode,
  }
}

export const SOURCES = [
  // ---- grass / ground -----------------------------------------------------------------------
  polyhavenTexture('withered_grass', {
    name: 'Withered Grass', author: 'Charlotte Baglioni', res: '2k', tile: 2.0,
    use: 'dormant Zoysia, late March — hero ground texture (2 m tile)',
  }),
  {
    // Grass blade cards for the near-field grass (later phase): the dry albedo + alpha of the
    // grass_medium_01 model. The mesh itself is not used (983 KB .bin under Models/gltf/8k).
    key: 'tex/grass_medium_01',
    kind: 'texture',
    site: 'Poly Haven',
    name: 'Grass Medium 01 (dry albedo + alpha)',
    id: 'grass_medium_01',
    pageUrl: 'https://polyhaven.com/a/grass_medium_01',
    author: 'Rob Tuytel, Rico Cilliers',
    licence: 'CC0-1.0',
    resolver: 'direct',
    res: '1k',
    use: 'blade card atlas source (near-field grass, later phase)',
    files: {
      'grass_medium_01_dry_diff_1k.png': 'https://dl.polyhaven.org/file/ph-assets/Models/png/1k/grass_medium_01/grass_medium_01_dry_diff_1k.png',
      'grass_medium_01_alpha_1k.png': 'https://dl.polyhaven.org/file/ph-assets/Models/png/1k/grass_medium_01/grass_medium_01_alpha_1k.png',
    },
    maps: { diff: 'grass_medium_01_dry_diff_1k.png', opacity: 'grass_medium_01_alpha_1k.png' },
  },
  polyhavenTexture('asphalt_pit_lane', {
    name: 'Asphalt Pit Lane', author: 'Dimitrios Savva', tile: 2.0, use: 'pit lane surface',
  }),
  // The public roads outside the fences (roads.ts, materials.ts roadRibbonMaterial): sampled in
  // world metres so overlapping ribbons at a junction show the same texels. Authors and tile
  // sizes as api.polyhaven.com/info/<id> lists them (`authors`, `dimensions`), verified 2026-09-11.
  polyhavenTexture('asphalt_04', {
    name: 'Asphalt 04', author: 'Jenelle van Heerden, Sergej Majboroda', tile: 4.04,
    use: 'public roads outside the fences (県道・市道): lighter, browner and coarser than the pit lane',
  }),
  polyhavenTexture('gravel_road', {
    name: 'Gravel Road', author: 'Amal Kumar', tile: 2.0,
    use: 'unsealed farm tracks (農道) and unpaved lanes',
  }),

  // ---- buildings ----------------------------------------------------------------------------
  polyhavenTexture('white_plaster_02', {
    name: 'White Plaster 02', author: 'Rob Tuytel', tile: 1.0, use: 'white cladding: pit building, VIP band',
  }),
  polyhavenTexture('plaster_grey_04', {
    name: 'Plaster Grey 04', author: 'Rob Tuytel', tile: 1.5, use: 'light grey render: stands RC, tower',
  }),
  ambientcgTexture('Concrete046', {
    name: 'Concrete 046', tile: 2.4, use: 'smooth white-grey concrete (painted precast)',
    // No AO map in this set → ARM R channel is filled with 1.0.
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  polyhavenTexture('preconcrete_wall_001_long', {
    name: 'Preconcrete Wall 001 Long', author: 'Dimitrios Savva, Rico Cilliers', tile: 4.0,
    use: 'weathered RC: underpass, retaining walls, stand bases only',
  }),
  ambientcgTexture('Facade001', {
    name: 'Facade 001', use: 'reflective glass curtain wall: pit building / VIP band',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('Plastic013A', {
    name: 'Plastic 013 A', use: 'seat plastic (white; V2 tinted dark grey via material.color)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('Fence003', {
    name: 'Fence 003', use: 'wire mesh: debris fence, perimeter fence (cut-out)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', opacity: '_Opacity' },
  }),
  ambientcgTexture('CorrugatedSteel003', {
    name: 'Corrugated Steel 003', use: 'corrugated sheet: temporary stand backs, sheds',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  // The photo layers of the building facade array (R Phase 4, buildings.ts facadeAtlas): the
  // runtime draws these into a DataArrayTexture at load, which only works from decodable
  // pixels, so they ship as 512² lossless WebP (`pixels`), not KTX2 — 512² is the layer size
  // (a house roof is 8–12 m across and seen from ≥ 76 m). Tile sizes as the sites list them
  // (api.polyhaven.com/info `dimensions` 3.0 m; ambientCG `dimensionX` 290 cm for the glazed
  // tiles, the corrugated sets carry none — 1.5 m is one sheet width of 3 × 0.5 m ribs).
  polyhavenTexture('grey_roof_tiles', {
    name: 'Grey Roof Tiles', author: 'Rob Tuytel', res: '512', pixels: true, tile: 3.0,
    use: 'kawara: the houses\' roof layer of the facade array (grey ceramic, mossy)',
  }),
  ambientcgTexture('RoofingTiles015A', {
    name: 'Roofing Tiles 015 A', res: '512', pixels: true, tile: 2.9,
    use: 'glazed kawara: the darker, glossier roof layer of the facade array (30 % of the houses)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('CorrugatedSteel009', {
    name: 'Corrugated Steel 009', res: '512', pixels: true, tile: 1.5,
    use: 'dark galvanised sheet: farm sheds, garages and huts (walls + roof)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('CorrugatedSteel007A', {
    name: 'Corrugated Steel 007 A', res: '512', pixels: true, tile: 1.5,
    use: 'painted light-blue sheet: works and warehouse walls (half of them)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  // Only the colour: the land-cover detail tile packs its luminance into one channel of the
  // grass shader's existing detail sampler (landcover.ts coverDetailTile), so nor_gl / arm
  // would never be read.
  polyhavenTexture('dry_mud_field_001', {
    name: 'Dry Mud Field 001', author: 'Rob Tuytel, Rico Cilliers', res: '512', pixels: true, tile: 3.0, maps: ['diff'],
    use: 'dry paddy mud: the farmland detail of the cover splat (late March, before flooding)',
  }),
  // The panel faces of the solar farms outside the fences (outskirts.ts, R Phase 5): a 1K KTX2
  // set like the other PBR textures — the racks are seen from 140 m to 2 km, the cell grid is
  // what reads. `tile` from ambientCG's dimensionX (260 cm: a row of 2–3 modules); the set has
  // no AO, so ARM R is 1.0, and it does carry metalness (the frames), which is packed into B.
  ambientcgTexture('SolarPanel003', {
    name: 'Solar Panel 003', tile: 2.6, use: 'solar farm panel faces (outskirts.ts, the static panel quads)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),

  // ---- surfaces inside the fences (I phase, 柵の内側) ---------------------------------------
  // 512 px KTX2 sets (fetched at 1k): the pit lane, garages, paddock, marshal cabins and the TV
  // platforms are seen from 8–70 m, and a 512 tile at 2–3 m is 2–4 texels per cm. Tile sizes as
  // api.polyhaven.com/info `dimensions` (mm) and ambientCG `dimensionX` (cm) list them, verified
  // 2026-09-12; PaintedMetal010 and MetalWalkway012 carry none on the site — tiles read off the
  // colour maps (rust patches of 10–20 cm; nine ≈ 10 cm expanded-mesh slots across), unverified.
  polyhavenTexture('asphalt_track', {
    name: 'Asphalt Track', author: 'Dimitrios Savva', res: '512', tile: 2.0,
    use: 'race-track tarmac: the west loop\'s newer surface tone and the Spoon service apron',
  }),
  polyhavenTexture('square_floor_patern_01', {
    name: 'Square Floor Patern 01', author: 'Rob Tuytel', res: '512', tile: 3.0,
    use: 'clean cool-grey slabs: the paddock walkways',
  }),
  polyhavenTexture('concrete_floor_03', {
    name: 'Concrete Floor 03', author: 'Rob Tuytel, Matterfield', res: '512', tile: 2.5,
    use: 'rough concrete floor: the garages and the pit building\'s work area',
  }),
  polyhavenTexture('blue_metal_plate', {
    name: 'Blue Metal Plate', author: 'Rob Tuytel', res: '512', tile: 2.5,
    use: 'painted steel: the marshal cabins\' walls',
  }),
  polyhavenTexture('container_side', {
    name: 'Container Side', author: 'Dimitrios Savva', res: '512', tile: 1.94,
    use: 'corrugated container side: the paddock containers and the broadcast compound',
  }),
  polyhavenTexture('painted_metal_shutter', {
    name: 'Painted Metal Shutter', author: 'Dario Barresi, Rico Cilliers, Charlotte Baglioni', res: '512', tile: 2.0,
    use: 'roller shutter slats: the garage front shutters',
  }),
  polyhavenTexture('rectangular_facade_tiles', {
    name: 'Rectangular Facade Tiles', author: 'Charlotte Baglioni', res: '512', tile: 2.0,
    use: 'dark concrete facade strips: the pit building\'s rear 2F / 3F',
  }),
  polyhavenTexture('tarred_gravel', {
    name: 'Tarred Gravel', author: 'Dimitrios Savva', res: '512', tile: 2.2,
    use: 'tar-bound gravel: the cutting floors and the gravel pads of the infield',
  }),
  ambientcgTexture('PavingStones099', {
    name: 'Paving Stones 099', res: '512', tile: 2.0, use: 'grey interlocking pavers (ILB): around the centre house',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('PaintedMetal010', {
    name: 'Painted Metal 010', res: '512', tile: 1.0, use: 'white painted panel, heavily rust-blistered: pit-wall stands, cabins, sign backs (the runtime should sample it sparingly or lighten it — the rust is ~20 % of the sheet)',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('Asphalt033', {
    name: 'Asphalt 033', res: '512', tile: 2.5, use: 'charcoal granular tarmac: the south course and the service roads inside the fences',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' } },
  }),
  ambientcgTexture('MetalWalkway012', {
    name: 'Metal Walkway 012', res: '512', tile: 1.0, use: 'expanded-mesh grating (cut-out, with metalness): the TV platforms and the marshal-post decks',
    maps: { diff: '_Color', nor_gl: '_NormalGL', arm: { ao: '_AmbientOcclusion?', rough: '_Roughness', metal: '_Metalness?' }, opacity: '_Opacity' },
  }),

  // ---- trees (R Phase 2: Sketchfab CC-BY 4.0 drops in misc/trees/) --------------------------
  // The user downloads each model page's auto-converted glTF zip into misc/trees/ (the zip keeps
  // Sketchfab's title-derived name, matched by glob); license.txt inside supplies the credit
  // line. Every pack is addressed by node path at runtime (app/data/tree-species.ts, gltfpack
  // -kn) and classified bark / foliage by material name (-km), so nothing is merged here. The
  // packs' own billboards, reference planes and checker floors are dropped — the impostor atlas
  // is baked in-repo — and every texture goes to KTX2 (foliage alpha and normals UASTC, the
  // rest ETC1S) at ≤ 1K: 4K cluster atlases would be 64 MB of VRAM per pack.
  sketchfabModel('model/trees/pine_pack', {
    name: 'Pine trees pack (lowpoly, game ready, LODs)', zip: 'pine_trees_pack*.zip', author: 'lolipop_1707',
    pageUrl: 'https://sketchfab.com/3d-models/pine-trees-pack-lowpoly-game-ready-lods-e1e9c07b8e2e445c943fec660beefba2',
    use: 'matsu (red / black pine): Pine_large / big for the hill woods, medium / small for the scatter; LOD0–2 per tree',
    dropNodes: /Billboard|(^|\/)Back(\/|$)|Ref_plane|Checker|Pine_sapling/i,
  }),
  sketchfabModel('model/trees/fir_pack', {
    name: 'Realistic Fir Trees Pack (LODS, gameready)', zip: 'realistic_fir_trees*.zip', author: 'lolipop_1707',
    pageUrl: 'https://sketchfab.com/3d-models/realistic-fir-trees-pack-lods-gameready-f58e8b6d733e4b0586e5b7db847b89e7',
    use: 'sugi / hinoki plantation rows: the spire silhouette, needles tinted per species at runtime; LOD0–2',
    dropNodes: /LOD3|Billboard/i,
  }),
  // The oak pack is imported three times: the pack as shipped (summer clusters → kusunoki), and
  // twice re-skinned with the season atlases the pack carries on its "Seasons Example" trees
  // (winter → bare keyaki, spring → budding). The `@` overrides copy those Sketchfab-converted
  // images: the author's raw season download (misc/trees/oak_seasons/*_MRAO.png) packs
  // metallic / roughness / AO in the opposite channel order to glTF, so it is not used.
  sketchfabModel('model/trees/oak_pack', {
    name: 'Oak trees pack (17var, LODs, seasons, gameready)', zip: 'oak_trees_pack*.zip', author: 'lolipop_1707',
    pageUrl: 'https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393',
    use: 'kusunoki (evergreen broadleaf): the four Large oaks with the summer clusters, darkened at runtime; LOD0–2',
    keepNodes: /(^|\/)Large_oak_tree_00[1-4]\//,
    dropNodes: /Billboard|Ground|Man ref|Seasons|Checker/i,
  }),
  sketchfabModel('model/trees/oak_winter', {
    name: 'Oak trees pack (17var, LODs, seasons, gameready)', zip: 'oak_trees_pack*.zip', author: 'lolipop_1707',
    pageUrl: 'https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393',
    use: 'keyaki, bare (late March): the Big / Medium oaks wearing the pack\'s winter cluster atlas; LOD0–2',
    keepNodes: /(^|\/)(Big|Medium)_oak_tree__00[1-4]\//,
    dropNodes: /Billboard|Ground|Man ref|Seasons|Checker/i,
    overrideImages: {
      '^Cluster_Mat_baseColor$': '@^Cluster_Mat_Winter_EX_baseColor$',
      '^Cluster_Mat_metallicRoughness$': '@^Cluster_Mat_Winter_EX_metallicRoughness$',
      '^Cluster_Mat_normal$': '@^Cluster_Mat_Winter_EX_normal$',
    },
  }),
  sketchfabModel('model/trees/oak_spring', {
    name: 'Oak trees pack (17var, LODs, seasons, gameready)', zip: 'oak_trees_pack*.zip', author: 'lolipop_1707',
    pageUrl: 'https://sketchfab.com/3d-models/oak-trees-pack-17var-lods-seasons-gameready-a5e4e64f9f1d4089bdcc6170a9333393',
    use: 'budding broadleaves: the Medium / Small oaks wearing the pack\'s spring cluster atlas; LOD0–2',
    keepNodes: /(^|\/)(Medium|Small)_oak_tree__00[1-3]\//,
    dropNodes: /Billboard|Ground|Man ref|Seasons|Checker/i,
    overrideImages: {
      '^Cluster_Mat_baseColor$': '@^Cluster_Mat_Spring_EX_baseColor$',
      '^Cluster_Mat_metallicRoughness$': '@^Cluster_Mat_Spring_EX_metallicRoughness$',
      '^Cluster_Mat_normal$': '@^Cluster_Mat_Spring_EX_normal$',
    },
  }),
  sketchfabModel('model/trees/bush_pack', {
    name: 'Bush models pack (gameready, LODs)', zip: 'bush_models_pack*.zip', author: 'lolipop_1707', maxTex: 512,
    pageUrl: 'https://sketchfab.com/3d-models/bush-models-pack-gameready-lods-f2d9ffd3e6a94cf0b9464ccd66a4c2f8',
    use: 'hedges outside the fences and the forest-edge shrubs: 15 bushes in three sizes, LOD0–2',
    dropNodes: /Billboard|Ground|Man ref/i,
  }),
  sketchfabModel('model/trees/cherry_medium', {
    name: 'Japanese Cherry Tree (medium-Poly)', zip: 'japanese_cherry_tree_medium*.zip', author: 'Sereib',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-cherry-tree-medium-poly-e0306a4402b44fa08f55aa58518dcb9c',
    use: 'sakura in full bloom, LOD0 (11.7 k tris): the gate and roadside cherries',
  }),
  sketchfabModel('model/trees/cherry_low', {
    name: 'Japanese Cherry Tree (low-Poly)', zip: 'japanese_cherry_tree_low*.zip', author: 'Sereib', maxTex: 512,
    pageUrl: 'https://sketchfab.com/3d-models/japanese-cherry-tree-low-poly-7c9e7c4e971f4953b06faf300cbb1209',
    use: 'sakura in full bloom, LOD1 (5 k tris) and the smaller roadside rows',
  }),
  sketchfabModel('model/trees/bamboo', {
    name: 'bamboo', zip: 'bamboo.zip', author: 'evolveduk', maxTex: 512,
    pageUrl: 'https://sketchfab.com/3d-models/bamboo-a02bf0e3ffe44617ad49daf3cd94fe59',
    use: 'bamboo: one culm with leaves (2.2 k tris), three per clump at the village edges',
  }),

  // ---- props (small objects seen from > 20 m: 512 px textures) -------------------------------
  // Authors as api.polyhaven.com/info/<id> lists them (`authors`), verified 2026-09-11 / 09-12.
  // The three R-phase props below are photogrammetry-dense (61 k / 20 k / 13.6 k tris) and shipped
  // JPEG inside the GLB; since the I phase (柵の内側) they are decimated to what a prop that is
  // instanced by the hundred (jersey blocks) or seen from ≥ 20 m needs, and GPU-compressed.
  polyhavenModel('concrete_road_barrier', { maxTex: 512, name: 'Concrete Road Barrier', author: 'Amal Kumar', use: 'props: pit entry / paddock separation blocks', simplify: 0.08, texEncode: KTX_PACK }),
  polyhavenModel('security_camera_01', { maxTex: 512, name: 'Security Camera 01', author: 'Alexander Otterbeck, Yann Kervran', use: 'props: trackside TV camera stand-in', simplify: 0.3, texEncode: KTX_PACK }),
  polyhavenModel('street_lamp_02', { maxTex: 512, name: 'Street Lamp 02', author: 'Josh Dean', use: 'props: paddock / car-park lighting', simplify: 0.2, texEncode: KTX_PACK }),
  polyhavenModel('utility_box_02', { maxTex: 512, name: 'Utility Box 02', author: 'James Ray Cock', use: 'props: signal controller / distribution cabinet at the signal poles' }),

  // ---- props of the pit lane, paddock, marshal posts and infield (I phase, 柵の内側) ----------
  // Poly Haven CC0 scans, 1k download capped at 256 px (a sub-metre object seen from ≥ 8 m; the
  // roller door and the fire escape, several metres across, keep 512), every texture KTX2, and
  // `simplify` where the scan is far denser than the silhouette (ratios from the I0-e plan: a
  // prop lands at ≈ 1–4 k tris). Trademark policy: the extinguisher's label and the generator's
  // decals were dumped (`retouch-glb.mjs --dump`) and read before the entry was written — see
  // each `retouch`. Authors as api.polyhaven.com/info/<id> lists them, verified 2026-09-12.
  polyhavenModel('old_tyre', { maxTex: 256, name: 'Old Tyre', author: 'MP', use: 'props: tyre-barrier columns and the stacked spares behind the garages (painted per instance)', texEncode: KTX_PACK }),
  polyhavenModel('korean_fire_extinguisher_01', {
    maxTex: 256, name: 'Korean Fire Extinguisher 01', author: 'UM JOORIN', use: 'props: extinguishers at the pit wall, the garages and every marshal post',
    simplify: 0.3, texEncode: KTX_PACK,
    // The body sheet carries the maker's white instruction label and the stencilled 소화기 on the
    // cylinder (filled with the body red — a blur would leave a pale smudge) and a small maker
    // mark on the hose (blurred); the hanging inspection card (`paper`, handwritten names and
    // dates) is dropped whole.
    retouch: [
      { image: /body_diff/, op: 'fill', colour: '#9c2a1c', rects: [[0.17, 0.58, 0.43, 0.68], [0.02, 0.02, 0.33, 0.12]] },
      { image: /body_diff/, op: 'blur', rects: [[0.93, 0.07, 0.99, 0.17]] },
    ],
    dropParts: /paper/,
  }),
  polyhavenModel('plastic_monobloc_chair_01', { maxTex: 256, name: 'Plastic Monobloc Chair 01', author: 'Kuutti Siitonen', use: 'props: marshal-post and catering chairs', texEncode: KTX_PACK }),
  polyhavenModel('security_light', { maxTex: 256, name: 'Security Light', author: 'Maximilian Schuster', use: 'props: wall flood lamp on the garages, cabins and gate huts', texEncode: KTX_PACK }),
  polyhavenModel('rollershutter_door', { maxTex: 512, name: 'Rollershutter Door', author: 'MP', use: 'props: the garages\' rear doors and the marshal huts\' shutters', texEncode: KTX_PACK }),
  polyhavenModel('tool_cart', { maxTex: 256, name: 'Tool Cart', author: 'Savva Zakharov', use: 'props: garage trolleys', simplify: 0.15, texEncode: KTX_PACK }),
  polyhavenModel('metal_tool_chest', { maxTex: 256, name: 'Metal Tool Chest', author: 'Yann Kervran, John Hutcheson', use: 'props: roller chests along the garage back walls', simplify: 0.25, texEncode: KTX_PACK }),
  polyhavenModel('Barrel_02', { maxTex: 256, name: 'Barrel 02', author: 'Jorge Camacho', use: 'props: blue plastic drums in the yards and the broadcast compound', texEncode: KTX_PACK }),
  polyhavenModel('plastic_crate_02', { maxTex: 256, name: 'Plastic Crate 02', author: 'Fabi_G', use: 'props: stackable crates in the garages and behind the paddock offices', simplify: 0.5, texEncode: KTX_PACK }),
  polyhavenModel('portable_generator', {
    maxTex: 256, name: 'Portable Generator', author: 'James Ray Cock', use: 'props: petrol genset at the marquees and marshal posts',
    simplify: 0.15, texEncode: KTX_PACK,
    // The atlas carries the model script (EN2500, twice), the control-panel lettering, a dial
    // brand and five warning / rating labels — every legible patch is blurred (sigma 6: the
    // panel keeps its shading, the letters go).
    retouch: [{
      image: /portable_generator_diff/, op: 'blur', sigma: 6,
      rects: [
        [0.38, 0.965, 0.535, 0.995], [0.30, 0.86, 0.345, 0.875], [0.555, 0.86, 0.595, 0.875], [0.33, 0.9, 0.6, 0.955], [0.635, 0.948, 0.71, 0.983],
        [0.695, 0.54, 0.755, 0.595], [0.68, 0.715, 0.815, 0.755], [0.64, 0.41, 0.71, 0.45], [0.14, 0.695, 0.21, 0.72], [0.855, 0.72, 0.91, 0.765], [0.94, 0.26, 0.98, 0.3],
      ],
    }],
  }),
  polyhavenModel('exterior_aircon_unit', {
    maxTex: 256, name: 'Exterior Aircon Unit', author: 'Monsta3D', use: 'props: condenser units on the team offices and the centre house',
    // The scan ships a clean and a rusted unit side by side (two nodes, 12 textures): only the
    // clean one, so half the textures never leave the download.
    keepNodes: /^exterior_aircon_unit$/,
    simplify: 0.3, texEncode: KTX_PACK,
  }),
  polyhavenModel('metal_jerrycan', { maxTex: 256, name: 'Metal Jerrycan', author: 'Sean Buckley', use: 'props: fuel cans at the marshal posts and the recovery vehicles', simplify: 0.15, texEncode: KTX_PACK }),
  polyhavenModel('modular_fire_escape', { maxTex: 512, name: 'Modular Fire Escape', author: 'Juniix', use: 'props: external stair of the TV platforms and the pit building\'s rear', texEncode: KTX_PACK }),
  polyhavenModel('security_camera_02', { maxTex: 256, name: 'Security Camera 02', author: 'Garrison Gager, Yann Kervran', use: 'props: the second CCTV shape on the pit building and the paddock gates', simplify: 0.3, texEncode: KTX_PACK }),
  polyhavenModel('steel_frame_shelves_01', { maxTex: 256, name: 'Steel Frame Shelves 01', author: 'James Ray Cock', use: 'props: garage shelving', texEncode: KTX_PACK }),
  polyhavenModel('covered_car', { maxTex: 256, name: 'Covered Car', author: 'MP', use: 'props: a car under a cover in the paddock car parks (no badge, no plate)', simplify: 0.4, texEncode: KTX_PACK }),

  // ---- roadside furniture (R Phase 3: Sketchfab CC-BY 4.0 drops in misc/road/) ---------------
  // Addressed by node path at runtime (road-furniture.ts / outskirts.ts through modelPrototype,
  // gltfpack -kn) and by material name (-km): the sign faces are `triangle` (止まれ, material
  // Stop), `triangle1` (徐行, Slow), `circle_new2` (SpeedLimit — the pack's only value is 60;
  // the other limits are painted at runtime), `circle_new4` (NoEntry), the signal head
  // `traffic_things/traffic_lights1`, the poles `main_tube*` / `short_tube` /
  // `pasted__trafficpole*mesh`, the pin insulators `electric_mega_isolator*`, the wiring
  // brackets `pasted__electric_pole_iso_holder1..6`. 82 textures at 1K / 512 would be 60 MB
  // of RGBA8-equivalent VRAM, so the pack is capped at 256 px (≈ 6 MB): every prop is a few
  // metres tall and seen from ≥ 20 m. The `citylight` advertising column (its poster is a
  // billboard we would never show) is dropped whole.
  sketchfabModel('model/road/jp_traffic_assets', {
    name: 'Japanese Traffic Assets', zip: 'japanese_traffic_assets*.zip', author: 'Erik Kinč', authorUrl: 'https://sketchfab.com/erikkinc',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-traffic-assets-1a4833770ace4df6aecfdabb76e36d60',
    use: 'JP signs (止まれ, speed, no entry …), signal heads, sign poles, insulators, vending machine, bins',
    maxTex: 256,
    dropNodes: /citylight|Citylight/i,
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  // The hero level of the utility poles within 200 m (outskirts.ts). The author's scene is one
  // primitive: the pole (10.6 k tris — two crossarms with pin insulators, a lamp arm, step-bolt
  // holes; scene units ≈ 2.2 × metres, 23.4 tall), a red round post box beside it (7.8 k) and a
  // 34 × 14 backdrop wall (14) — `keepBox` keeps the pole's own column (x −4.4…2.9, z 3.6…11.4)
  // and the rest goes. Decimated to a quarter (≈ 2.5 k tris: crossarms still straight, lamp
  // shade round), the 2K set capped at 512. The material carries KHR_materials_specular (a
  // uniform white texture, a no-op that makes three build a MeshPhysicalMaterial),
  // KHR_materials_emissive_strength 4.5 on the lamp and a normal map with scale 0; the runtime
  // builds its own material from the base colour, so they only have to survive the loader.
  sketchfabModel('model/road/jp_denchu', {
    name: 'Japanese Pole (Denchu)', zip: 'japanese_pole_denchu*.zip', author: 'Fumiya Funatsu', authorUrl: 'https://sketchfab.com/funatsu.fumiya',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-pole-denchu-e46e33e8908f40dc99eb3e0849a15048',
    use: 'concrete utility pole with crossarms, pin insulators and a lamp arm: the hero level of the roadside poles',
    maxTex: 512,
    keepBox: { min: [-5, null, 3], max: [4, null, 12] },
    simplify: 0.25,
    texEncode: { default: 'etc1s', normal: 'uastc' },
  }),

  // ---- houses (R Phase 4: Sketchfab CC-BY 4.0 drops in misc/buildings/) ---------------------
  // Hero replacements for the OSM house footprints an OBB fit accepts (hero-buildings.ts,
  // through modelPrototype): the massing is skipped there and one InstancedMesh per model
  // carries every fitted footprint. The three reckzilla homes are one primitive each
  // (`JapaneseResidentialHome_0N/JapaneseResidentialHome_0N_blinn1_0`, material `blinn1`)
  // sharing one 2K trim sheet (baseColor / metallicRoughness identical across the three, the
  // normal differs for 03) — capped at 512: a 10 m house at ≥ 76 m is ~100 px wide. Authors
  // as license.txt spells them (the importer takes the credit line from that file).
  sketchfabModel('model/buildings/jp_house_01', {
    name: 'Japanese Residential Home 01', zip: 'japanese_residential_home_01*.zip', author: 'Morrissey Alexander', authorUrl: 'https://sketchfab.com/reckzilla',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-residential-home-01-d690f83d8e8d48e6a532bebe84901595',
    use: 'hero house on a fitting footprint: two-storey, hipped kawara roof, 1.7 k tris',
    maxTex: 512,
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  sketchfabModel('model/buildings/jp_house_02', {
    name: 'Japanese Residential Home 02', zip: 'japanese_residential_home_02*.zip', author: 'Morrissey Alexander', authorUrl: 'https://sketchfab.com/reckzilla',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-residential-home-02-c31697f09152453cb3ed215482e7a810',
    use: 'hero house on a fitting footprint: two-storey with a carport, 2.0 k tris',
    maxTex: 512,
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  sketchfabModel('model/buildings/jp_house_03', {
    name: 'Japanese Residential Home 03', zip: 'japanese_residential_home_03*.zip', author: 'Morrissey Alexander', authorUrl: 'https://sketchfab.com/reckzilla',
    pageUrl: 'https://sketchfab.com/3d-models/japanese-residential-home-03-1c53f4f37fc44c32a8874464025aea48',
    use: 'hero house on a fitting footprint: L-shaped two-storey, 2.4 k tris',
    maxTex: 512,
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  // A Revit-style export: 256 nodes / 145 tiny primitives over 10 materials (`Building_…/Ground
  // Floor_…/Wall_…`), 8 textures of ≤ 512 × 256 — merged per material by modelPrototype at
  // runtime, so the node soup costs nothing; 256 px is already above the source's detail.
  sketchfabModel('model/buildings/jp_apartment_grey', {
    name: 'Grey Japanease Apartment', zip: 'grey_japanease_apartment*.zip', author: 'Kasuga𓅂', authorUrl: 'https://sketchfab.com/kasuga',
    pageUrl: 'https://sketchfab.com/3d-models/grey-japanease-apartment-8589efeb25284d709934497e02a25421',
    use: 'hero two-storey apartment block (アパート) on a fitting `building=apartments` footprint, 1.3 k tris',
    maxTex: 256,
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),

  // ---- vehicles (R Phase 5: Sketchfab CC-BY 4.0 drops in misc/vehicles/) --------------------
  // The hero level of the parked cars within 260 m and the campsite vans (car-glb.ts through
  // modelPrototype, one InstancedMesh per body): four Japanese bodies, one photo-textured
  // primitive each (the Hiace splits into Body / 4 wheels / 2 plates, same material), 1.8–3.4 k
  // tris, capped at 512 px — a 3.4 m kei car at ≥ 140 m is ~50 px long. Every texture was
  // dumped (`retouch-glb.mjs --dump`) and read: the `retouch` rectangles (glTF UV, origin
  // top-left) cover each maker emblem, model-name script, number plate, fleet number, operator
  // name, destination display and sticker so that nothing legible ships (CLAUDE.md policy);
  // the shipped GLBs were dumped again to confirm. Titles / authors as license.txt spells them
  // (the importer takes the credit line from that file).
  sketchfabModel('model/vehicles/kei_truck', {
    name: 'Suzuki Carry kei truck low poly', zip: 'suzuki_carry*.zip', author: 'bean(alwayshasbean)', authorUrl: 'https://sketchfab.com/alwayshasbean',
    pageUrl: 'https://sketchfab.com/3d-models/suzuki-carry-kei-truck-low-poly-6bc99e709e9748da98cc9ac676684510',
    use: 'kei truck (軽トラ) body: the hero level of the `keitruck` parked cars, 2.2 k tris',
    maxTex: 512,
    // Authored as KHR_materials_pbrSpecularGlossiness (diffuse 1024 × 512 + specGloss 512 × 256);
    // three's GLTFLoader dropped that extension, so it is converted at import.
    metalrough: true,
    // Rear number plate (top centre of the sheet), the front-grille emblem, the tailgate script
    // at the sheet's right edge.
    retouch: [{ image: /_diffuse$/, op: 'blur', sigma: 8, rects: [[0.32, 0.0, 0.465, 0.2], [0.86, 0.455, 0.905, 0.535], [0.96, 0.88, 1.0, 0.95]] }],
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  sketchfabModel('model/vehicles/kei_wagon', {
    name: 'Daihatsu Move Conte (Low Poly)', zip: 'daihatsu_move_conte*.zip', author: 'NNXST',
    pageUrl: 'https://sketchfab.com/3d-models/daihatsu-move-conte-low-poly-eff914331c194de0abe20a33d2c3a2c3',
    use: 'kei wagon (軽ワゴン) body: the hero level of the `kei` parked cars, 1.8 k tris',
    maxTex: 512,
    // The sheet is a decal atlas on a white body: the model-name script is filled with the body
    // white (a blur would leave a grey smudge), the two maker emblems, the sister-model badge
    // and the grille emblem are blurred into chrome blobs (default sigma = a quarter of the
    // patch), the plate and the small rear badge with a fixed sigma.
    retouch: [
      { image: /baseColor$/, op: 'fill', colour: '#ffffff', rects: [[0.0, 0.27, 0.26, 0.365]] },
      { image: /baseColor$/, op: 'blur', rects: [[0.0, 0.36, 0.25, 0.505], [0.255, 0.355, 0.49, 0.505], [0.27, 0.245, 0.485, 0.33], [0.335, 0.155, 0.405, 0.215]] },
      { image: /baseColor$/, op: 'blur', sigma: 8, rects: [[0.81, 0.505, 1.0, 0.605], [0.01, 0.135, 0.05, 0.165]] },
    ],
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  sketchfabModel('model/vehicles/van_h100', {
    name: '1990 Toyota Hiace (H100)', zip: '1990_toyota_hiace*.zip', author: 'ImperialBlue', authorUrl: 'https://sketchfab.com/ImperialBlue3D',
    pageUrl: 'https://sketchfab.com/3d-models/1990-toyota-hiace-h100-1764351001194f66b85c495dd8ce2d71',
    use: 'one-box van (ハイエース) body: the hero level of the `minivan` parked cars and the campsite vans, 2.2 k tris',
    maxTex: 512,
    // Rear sticker and rear model script (top-left of the sheet), the front badge above the
    // grille and the maker script across the bumper (bottom-left); the plates are blank already.
    retouch: [{ image: /baseColor$/, op: 'blur', sigma: 6, rects: [[0.035, 0.1, 0.085, 0.14], [0.05, 0.21, 0.1, 0.24], [0.27, 0.71, 0.35, 0.75], [0.275, 0.8, 0.445, 0.845]] }],
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),
  sketchfabModel('model/vehicles/bus_mid', {
    name: 'Isuzu Erga Mio bus', zip: 'isuzu_erga_mio*.zip', author: 'own.guest',
    pageUrl: 'https://sketchfab.com/3d-models/isuzu-erga-mio-bus-050e8acd0bbc4da0902a8a874ef10fca',
    use: 'mid-size route bus body: the hero level of the `coach` parked cars, 3.4 k tris',
    maxTex: 1024,
    // A 2048 × 1024 four-view sheet (rear, side, front, side) in an operator's green livery,
    // which stays as a generic livery; every piece of text goes: the retailer watermark in the
    // sheet corner, both plates, the fleet number (×6), the operator script (×2) and skirt
    // lettering (×2), the side-window stop list (×2), the door / exit / number stickers, the
    // destination displays and the LED stop sign.
    retouch: [{
      image: /baseColor$/, op: 'blur', sigma: 8,
      rects: [
        [0.855, 0.0, 1.0, 0.058],
        [0.07, 0.09, 0.115, 0.14], [0.148, 0.09, 0.175, 0.115], [0.055, 0.24, 0.128, 0.28], [0.14, 0.29, 0.172, 0.335], [0.045, 0.345, 0.14, 0.395],
        [0.234, 0.165, 0.272, 0.202], [0.572, 0.163, 0.716, 0.198], [0.884, 0.165, 0.975, 0.2], [0.33, 0.288, 0.36, 0.333], [0.51, 0.372, 0.735, 0.413],
        [0.06, 0.595, 0.12, 0.642], [0.058, 0.648, 0.13, 0.685], [0.155, 0.698, 0.18, 0.722], [0.012, 0.892, 0.185, 0.96],
        [0.444, 0.658, 0.484, 0.694], [0.334, 0.683, 0.382, 0.742], [0.394, 0.695, 0.518, 0.745], [0.566, 0.73, 0.62, 0.765], [0.716, 0.705, 0.755, 0.742],
        [0.46, 0.82, 0.525, 0.895], [0.285, 0.887, 0.32, 0.907], [0.488, 0.922, 0.712, 0.96], [0.955, 0.712, 0.99, 0.746],
      ],
    }],
    texEncode: { default: 'etc1s', normal: 'uastc', quality: 160 },
  }),

  // ---- ops layer (I phase, 柵の内側: Sketchfab CC-BY 4.0 drops in misc/ops/) -----------------
  // Course cars, medical / recovery vehicles, marquees, portable toilets, gensets and a forklift
  // for the infield builders (I1–I5, through modelPrototype; every builder keeps a procedural
  // fallback). The seven vehicles are Daniel Zhabotinsky's fictional-brand "Low poly model"
  // series: one body material per car (no baseColor texture — a baseColorFactor the runtime
  // tints), shared `UCB_*` sets (lights / glass, underbody, interiors), one `RB1c_Tire_1k` wheel
  // set ("KAMASTONE SPECIAL" sidewall — fictional), a `Numberplates_Misk_U` letter atlas (mock
  // plates: generic letters, US state names, no real registration) and a `Carbadges_misc_U`
  // atlas of ~80 invented marques. Every image of all seven was dumped (`retouch-glb.mjs --dump`)
  // and read: the shared sets are byte-identical across the cars. Two atlas cells carry real
  // marque / model names among the invented ones ("ROVER LIMITED", "OUTBACK"), so the two
  // badge nodes (`*_Body_Badges` / `*_Badges_Front` / `*_Badges_Body`: 4–14 tris of decal quads that the
  // decimation also mangled to single triangles) are dropped and the atlas is pruned with them —
  // nothing legible is left on a car body. Decimated to 0.4 (the plan's ratio: 16–26 k → 7–10 k
  // tris; the 80-tri plates survive), capped at 512 px.
  // Node naming: `<Model>_<Part>/Object_N/<Model>_<Part>_<Material>_0`, parts Body / Hood /
  // Bumper_Front / Bumper_Rear / Glass_* / Headlights / Brakelights / Blinkers / Interior /
  // Steering_Wheel / Bottom / Suspension / WheelStock_{FL,FR,RL,RR} / Numberplates_{Front,Rear}
  // / Body_Badges / Bumper_Front_Badges. Scene units are metres, +X forward, Y up.
  ...['jdm_sport_99', 'sigil_07', 'ace_11', 'urban_10', 'lightbody_flatbed', 'lightbody_tow'].map((id) => {
    const meta = {
      jdm_sport_99: ['JDM Sport \'99 - Low Poly model', 'jdm_sport_99*.zip', 'jdm-sport-99-low-poly-model-6dd4ae19c454414d9eed2bc524515d78', 'FIA-style safety car: 90s Japanese GT coupé (`carGlb|tint` red), 4.7 × 2.0 m, 23.2 k → 9.3 k tris'],
      sigil_07: ['Sigil \'07 - Low poly model', 'sigil_07*.zip', 'sigil-07-low-poly-model-22abe5284d4c4b55920b8462eb24a8c1', 'medical car: shooting-brake estate (silver tint, red stripe procedural), 4.3 × 1.8 m, 16.9 k → 6.8 k tris'],
      ace_11: ['Ace \'11 - Low Poly model', 'ace_11*.zip', 'ace-11-low-poly-model-055ff8a21b8d4d279debca089e2fafcd', 'Suzuka course car: city hatch (yellow tint, black roof + LED bar procedural), 3.8 × 1.8 m, 18.4 k → 7.4 k tris'],
      urban_10: ['Urban \'10 - Low poly model', 'urban_10*.zip', 'urban-10-low-poly-model-2866efdfa943484391ef8313768e074d', 'course SUV ×2 (black tint), 4.3 × 1.9 m, 16.5 k → 6.6 k tris'],
      lightbody_flatbed: ['Lightbody \'90 MD Flatbed - Low poly model', 'lightbody_90_md_flatbed*.zip', 'lightbody-90-md-flatbed-low-poly-model-39195e554c7a41a2884186c10d5079c0', 'recovery crane chassis: medium-duty flatbed (yellow tint, boom procedural), 5.3 × 2.0 m, 24.1 k → 9.6 k tris'],
      lightbody_tow: ['Lightbody \'90 MD Tow Truck - Low poly model', 'lightbody_90_md_tow_truck*.zip', 'lightbody-90-md-tow-truck-low-poly-model-5cba208001c64e8ea164f89e4dde91e7', 'recovery tow truck (yellow tint), 5.7 × 2.0 m, 26.1 k → 10.5 k tris'],
    }[id]
    return sketchfabModel(`model/ops/${id}`, {
      name: meta[0], zip: meta[1], author: 'Daniel Zhabotinsky', authorUrl: 'https://sketchfab.com/DanielZhabotinsky',
      pageUrl: `https://sketchfab.com/3d-models/${meta[2]}`,
      use: meta[3],
      maxTex: 512,
      simplify: 0.4,
      dropNodes: /Badges/,
      retouchReviewed: 'fictional brand (Zhabotinsky series), every image dumped and read; the badge nodes and their atlas are dropped, the plate atlas is mock letters',
    })
  }),
  // The ambulance is the same series with a 4K body sheet: a US ambulance livery (red bands on
  // white). "AMBULANCE", "FIRST RESPONDER" and "KEEP YOUR DISTANCE" stay (generic); filled with
  // the sheet's own white / red: the three Star of Life marks (a registered certification mark),
  // both US flags, "911" and the "EMERGENCY DIAL 911" block, the unit number "269 64 PCT" (×2),
  // "MADE IN USA" and the "HANDLE WITH CARE" sticker (the retouched sheet was dumped again and
  // read). The builder tints the white to Japanese ambulance white and keeps the red bands.
  // Badge nodes dropped as on the other six.
  sketchfabModel('model/ops/shvan_92_ambulance', {
    name: 'Shvan \'92 Ambulance - Low Poly model', zip: 'shvan_92_ambulance*.zip', author: 'Daniel Zhabotinsky', authorUrl: 'https://sketchfab.com/DanielZhabotinsky',
    pageUrl: 'https://sketchfab.com/3d-models/shvan-92-ambulance-low-poly-model-2856dd3c61f940909dced9a5c0379484',
    use: 'ambulance ×2 (white body, red bands from the sheet), 5.0 × 2.3 m, 25.9 k → 10.4 k tris',
    maxTex: 512,
    simplify: 0.4,
    dropNodes: /Badges/,
    retouch: [
      { image: /Shvan92_bodymat_baseColor$/, op: 'fill', colour: '#d3d3d3', rects: [[0.643, 0.472, 0.687, 0.525], [0.895, 0.535, 0.95, 0.59], [0.935, 0.685, 0.97, 0.748], [0.643, 0.772, 0.687, 0.824], [0.165, 0.888, 0.203, 0.92], [0.662, 0.884, 0.722, 0.913], [0.657, 0.922, 0.695, 0.946]] },
      { image: /Shvan92_bodymat_baseColor$/, op: 'fill', colour: '#ca0000', rects: [[0.858, 0.538, 0.888, 0.588], [0.183, 0.86, 0.214, 0.879], [0.675, 0.853, 0.722, 0.877]] },
    ],
  }),
  // One primitive `root/GLTF_SceneRootNode/TentCanopy_0/Object_4` (material TentCanopyMat, 1K
  // set): a plain white-grey canvas with blue / teal panels, no printed valance (the sheet was
  // dumped and read). Scene units are not metres (41 × 18 × 48) — the builder uses scaleTo.
  sketchfabModel('model/ops/tent_canopy', {
    name: 'Tent Canopy - rectangular', zip: 'tent_canopy*.zip', author: 'MozillaHubs', authorUrl: 'https://sketchfab.com/mozillareality',
    pageUrl: 'https://sketchfab.com/3d-models/tent-canopy-rectangular-256b7c9e92d54a49af295be120b5ec59',
    use: 'marquee tent (hospitality / marshal compound), 2.0 k tris',
    maxTex: 512,
    retouchReviewed: 'plain canvas, no printed valance — every image dumped and read',
  }),
  // 26 primitives (`Collada visual scene group/<Part>_LP/defaultMaterial`, one `lambert1` 4K
  // set): a blue-and-white cabin with no operator name or sticker. 1.0 × 2.0 × 1.0 m, Y from
  // −0.86 (its origin is mid-height).
  sketchfabModel('model/ops/porta_potty', {
    name: 'Porta Potty', zip: 'porta_potty*.zip', author: 'Sean Thomas', authorUrl: 'https://sketchfab.com/foon.',
    pageUrl: 'https://sketchfab.com/3d-models/porta-potty-b970702ea74a456e89673e73cfb6d873',
    use: 'portable toilet rows (south course, hairpin infield, marshal posts), 2.1 k tris',
    maxTex: 256,
    retouchReviewed: 'no operator name or sticker on the cabin — every image dumped and read',
  }),
  // 12 primitives under `<hash>.fbx/RootNode/<part>_low/…` (one `Material_39` 2K set): a yellow
  // canopy genset 0.6 × 0.8 × 1.1 m with a generic caution label, an hour meter and an outlet
  // panel ("AC 220V", "VOLT METER") — no maker.
  sketchfabModel('model/ops/diesel_generator', {
    name: 'Diesel Generator (low-poly game asset)', zip: 'diesel_generator*.zip', author: 'Eugene Flerko', authorUrl: 'https://sketchfab.com/eugene.flerko',
    pageUrl: 'https://sketchfab.com/3d-models/diesel-generator-low-poly-game-asset-03db834f3fd94212a6a07d3127630b3b',
    use: 'gensets at the broadcast compound and marquees, 1.0 k tris',
    maxTex: 256,
    retouchReviewed: 'generic caution label, hour meter and outlet panel only, no maker — every image dumped and read',
  }),
  // One primitive `Loader_car.fbx/RootNode/Loader_car/Loader_car_Loader_car_Material_0` (1K
  // set), scene units cm (1.2 × 2.1 × 3.7): a yellow counterbalance forklift, no badge.
  sketchfabModel('model/ops/forklift', {
    name: 'Forklift low poly', zip: 'forklift_low_poly*.zip', author: 'Ricardo Sanchez', authorUrl: 'https://sketchfab.com/380660711785',
    pageUrl: 'https://sketchfab.com/3d-models/forklift-low-poly-8ab650b3982243f8b661142de50f79c9',
    use: 'forklift at the Spoon yard and the paddock, 4.4 k tris',
    maxTex: 256,
    retouchReviewed: 'no badge or lettering on the body — every image dumped and read',
  }),

  // ---- trackside (I phase, 柵の内側: Sketchfab CC-BY 4.0 drops in misc/trackside/) ----------
  // Marshal cabins, tyre stacks, flood-light heads, cones and crowd barriers along the fences.
  // The booth zip holds two nodes: `BoothMain/BoothMain_ParkingBoothMain_0` (the cabin, 2.9 ×
  // 2.5 × 3.3 m, material ParkingBoothMain — BLEND with KHR_materials_transmission for the
  // glazing) and `Cube/Cube_BarrierMaterial_0` (a 3.9 m boom barrier) — the boom is dropped by
  // node. No signage on the cabin (the 4K sheet was dumped and read).
  sketchfabModel('model/trackside/guard_booth', {
    name: 'Small Guard Booth', zip: 'small_guard_booth*.zip', author: 'Arsen Ismailov', authorUrl: 'https://sketchfab.com/fdgasd7',
    pageUrl: 'https://sketchfab.com/3d-models/small-guard-booth-422ec83e0bd64687a0026c67abb6bc07',
    use: 'marshal-post cabin body (scaleTo long 2.5), 0.7 k tris',
    maxTex: 512,
    dropNodes: /\/RootNode\/Cube(\/|$)/,
  }),
  // One primitive `root/GLTF_SceneRootNode/NFT_0/Object_4` (material `material`, 2K baseColor +
  // specular): a 0.72 × 0.94 m column of plain black tyres, no sidewall moulding.
  sketchfabModel('model/trackside/tire_stack', {
    name: 'Racetrack tire stack standard (v2)', zip: 'racetrack_tire_stack*.zip', author: 'mira9',
    pageUrl: 'https://sketchfab.com/3d-models/racetrack-tire-stack-standard-v2-65cc7bcf581646a3bc42cf31d0580bcb',
    use: 'tyre stacks at the barrier ends and marshal posts (tiles as a fence), 1.0 k tris',
    maxTex: 256,
  }),
  // One primitive `Flood_light.fbx/RootNode/Cube/Cube_Material_0` (4K set → 256): a yellow
  // industrial flood head 0.4 × 1.2 × 0.4 m, no label.
  sketchfabModel('model/trackside/flood_light', {
    name: 'Flood light 02', zip: 'flood_light_02*.zip', author: 'CHAMOD', authorUrl: 'https://sketchfab.com/Chamodp',
    pageUrl: 'https://sketchfab.com/3d-models/flood-light-02-95ad365a60434015a8700efbdaa90893',
    use: 'flood-light heads on the lighting masts, 2.8 k tris',
    maxTex: 256,
  }),
  // A 12-model OBJ pack, one node each under `barrier_pack.obj.cleaner.gles/Object_2/Object_N`
  // with 43 2K images over 17 materials (all custom-painted, no lettering — dumped and read).
  // Kept: the two 0.46 m cones (Object_3 / Object_5, materials None.001 / None.004), the two
  // 0.68 m striped drum cones (Object_13 / Object_14, None / None.003), the 0.6 m delineator
  // post (Object_10, stick) and the three 1.66 × 0.67 m short barriers (Object_15 plain /
  // Object_16 painted / Object_17 signed). Dropped: the concrete barriers, wall pieces, the
  // fenced barrier + its fence plane, the A-frame signs and the concrete block (Object_4).
  sketchfabModel('model/trackside/cone_pack', {
    name: 'Barrier & Traffic Cone Pack', zip: 'barrier__traffic_cone_pack*.zip', author: 'Sabri Ayeş', authorUrl: 'https://sketchfab.com/sabriayes',
    pageUrl: 'https://sketchfab.com/3d-models/barrier-traffic-cone-pack-23c4dfca76a24bf0b21894847867af2a',
    use: 'traffic cones, drum cones, delineator posts and short barriers around the ops areas, 4.3 k tris kept',
    maxTex: 256,
    keepNodes: /\/Object_(3|5|10|13|14|15|16|17)$/,
  }),
  // One primitive `Police Crowd Barrier.fbx/RootNode/Cube/Cube_Material.001_0` (4K set → 256).
  // The two blue rails read "POLICE LINE - DO NOT CROSS" / "POLICE DEPT" between the hatch
  // stripes — filled with the rail blue so the barrier is a plain blue-and-white one. Scene
  // units are not metres (9.4 × 5.0 × 8.2) — scaleTo.
  sketchfabModel('model/trackside/crowd_barrier', {
    name: 'Police Crowd Barrier', zip: 'police_crowd_barrier*.zip', author: 'exiS7-Gs',
    pageUrl: 'https://sketchfab.com/3d-models/police-crowd-barrier-27146861408c43dfa6abeacf11f23988',
    use: 'crowd-control barriers at the gates and the paddock, 0.2 k tris',
    maxTex: 256,
    retouch: [{ image: /baseColor$/, op: 'fill', colour: '#1575c5', rects: [[0.06, 0.298, 0.265, 0.708]] }],
  }),

  // ---- pit lane (I phase, 柵の内側: Sketchfab CC-BY 4.0 drops in misc/pit/) -----------------
  // A pit board with 11 letter / digit panels, each its own node `Pit Board.fbx/RootNode/
  // Pit_Board/<panel>/<panel>_<mat>_0` (IN, FUEL, 4, 2, L, 3, _ (−), 2_2, __2 (+), 1, P) over
  // one baseColor image per panel (yellow glyph on black), plus the frame (Pit_Board_Metal_Sheet
  // / Pit_Board_Inside_Bars / Pit_Board_Metal_Bar_, untextured `Paint_Metal`). Scene units cm
  // (0.69 × 1.0 m). The panel images are filled white so the runtime writes its own message on
  // blank cards (the plan's decision) — the glyphs themselves carry nothing to blur.
  sketchfabModel('model/pit/pit_board', {
    name: 'Pit Board', zip: 'pit_board*.zip', author: 'Alex Werner', authorUrl: 'https://sketchfab.com/alexwerndesign',
    pageUrl: 'https://sketchfab.com/3d-models/pit-board-42e680a0171246f8854918ac03e4c33c',
    use: 'pit boards held over the pit wall, 2.8 k tris',
    maxTex: 256,
    retouch: [{ image: /baseColor$/, op: 'fill', colour: '#ffffff', rects: [[0, 0, 1, 1]] }],
  }),
  // One primitive `1.obj.cleaner.materialmerger.gles/Object_2` (material UVChannel_1, 2K set):
  // a dark-green air impact wrench; the only print is a laser-safety caution + CE mark on two
  // socket faces (generic, ≈ 30 px at 2K and nothing at 256) — no tool brand.
  sketchfabModel('model/pit/impact_wrench', {
    name: 'Impact wrench', zip: 'impact_wrench*.zip', author: 'chupin',
    pageUrl: 'https://sketchfab.com/3d-models/impact-wrench-538a84dc51ba4b43b98dad3697147ffc',
    use: 'wheel-gun stand-in on the garage floor and at the pit-stop crews, 1.6 k tris',
    maxTex: 256,
  }),
  // Four nodes `root/GLTF_SceneRootNode/Jack-Body_3/{Object_4, Jack-arm_1/Object_6,
  // Jack-arm_1/Jack-vup_0/Object_8, Jack-lever_2/Object_10}` (one `TrollyJack` 4K set → 256):
  // a worn blue garage trolley jack 0.8 m + 1.5 m handle, no maker. Decimated to 0.4 (8.9 k →
  // 3.6 k).
  sketchfabModel('model/pit/trolley_jack', {
    name: 'Trolley Jack Lo Poly', zip: 'trolley_jack*.zip', author: 'almartin',
    pageUrl: 'https://sketchfab.com/3d-models/trolley-jack-lo-poly-c4ea505c9a6942bd9bd192602d18ce81',
    use: 'jacks on the garage floor (the quick-lift jacks stay procedural), 8.9 k → 3.6 k tris',
    maxTex: 256,
    simplify: 0.4,
  }),
  // Four nodes `root/GLTF_SceneRootNode/{SM_widescreen_monitor_1, SM_widescreen_stand_2,
  // SM_standard_monitor_stand_4, SM_standard_monitor_5}/Object_N` over two 4K sets (→ 256):
  // black screens (the wide one has an emissive slot), no brand on the bezels.
  sketchfabModel('model/pit/pc_monitors', {
    name: 'Basic PC Monitors', zip: 'basic_pc_monitors*.zip', author: 'Sousinho', authorUrl: 'https://sketchfab.com/sousinho',
    pageUrl: 'https://sketchfab.com/3d-models/basic-pc-monitors-58a2dba70e4f4752962ee98a9d6827be',
    use: 'pit-wall gantry and garage monitors (widescreen + standard, each with a stand), 4.6 k tris',
    maxTex: 256,
  }),

  // ---- reference-only downloads (kept in misc/dl, never imported) ----------------------------
  {
    key: 'ref/kenney_racing_kit',
    kind: 'reference',
    site: 'Kenney',
    name: 'Racing Kit',
    pageUrl: 'https://kenney.nl/assets/racing-kit',
    author: 'Kenney',
    licence: 'CC0-1.0',
    resolver: 'kenney-scrape',
    slug: 'racing-kit',
    use: 'shape/proportion reference for temporary stands and pit structures',
    files: { 'kenney_racing-kit.zip': 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip' },
  },
  {
    key: 'ref/crowd_plates',
    kind: 'reference',
    site: 'Wikimedia Commons',
    name: 'Crowd plates (CC0 photographs)',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:Bangabandhu_National_Stadium_crowd,_Home_match_day_FIFA_WC_qualifier_2019.jpg',
    author: 'FaysaLBinDaruL; Melanie van Leeuwen (Unsplash)',
    licence: 'CC0-1.0',
    resolver: 'direct',
    use: 'source material for the far-field spectator impostor atlas (later phase); only ≤128 px cells are shipped',
    files: {
      'bangabandhu_crowd_2019.jpg': 'https://upload.wikimedia.org/wikipedia/commons/6/6f/Bangabandhu_National_Stadium_crowd%2C_Home_match_day_FIFA_WC_qualifier_2019.jpg',
      'front_row_audience_unsplash.jpg': 'https://upload.wikimedia.org/wikipedia/commons/0/01/Front_row_audience_%28Unsplash%29.jpg',
    },
  },

  // ---- user drops in misc/ (plan §1b) --------------------------------------------------------
  {
    key: 'model/crowd/eclair',
    kind: 'model',
    site: 'Eclair Assets (itch.io)',
    name: 'Background Posed Humans GLB Pack',
    pageUrl: 'https://eclair-assets.itch.io/background-posed-humans-glb-pack-28-free-cc0-3d-models',
    author: 'Quaternius',
    authorUrl: 'https://quaternius.com/packs/backgroundposedhumans.html',
    credit: 'Background characters by Quaternius (GLB conversion by Eclair Assets)',
    licence: 'CC0-1.0',
    resolver: 'misc-local',
    use: 'near-field 3D spectators + impostor bake source (20 poses, 8 hairstyles)',
    // Any of these roots may hold the pack (the plan said misc/crowd/eclair; the user dropped
    // the unzipped folder at misc root). The GLBs live in <root>/models_glb/.
    miscRoots: ['crowd/eclair/quaternius_background_posed_humans_glb_cc0_v1', 'crowd/eclair', 'quaternius_background_posed_humans_glb_cc0_v1'],
    glob: 'models_glb/*.glb',
    licenceFile: 'source_reference/License.txt',
    licenceMarker: 'CC0 1.0 Universal',
    // 'Female_Female Poses_OBJ_Female_Sitting.glb' → 'female_sitting'
    subKey: (file) => file.replace(/^.*_OBJ_/, '').replace(/\.glb$/i, '').toLowerCase(),
  },
  {
    key: 'model/seats/arena_seat',
    kind: 'model',
    site: 'Sketchfab',
    name: 'Low poly stadium/sports arena seats',
    pageUrl: 'https://sketchfab.com/3d-models/low-poly-stadiumsports-arena-seats-6bbe4c85d2a4489dbe5918831be5d886',
    author: 'anDDDres',
    authorUrl: 'https://sketchfab.com/anDDDres',
    licence: 'CC-BY-4.0',
    resolver: 'misc-local',
    use: 'individual seat shape for stands',
    miscRoots: ['seats', '.'],
    zip: 'low_poly_stadiumsports_arena_seats.zip',
    entry: 'scene.gltf',
    licenceFile: 'license.txt',
    licenceMarker: 'CC-BY-4.0',
  },
  // Baked in-repo from the CC0 Quaternius / Eclair figures above (scripts/assets/bake-crowd-atlas.mjs):
  // the far-field spectator impostor atlas. 128 px cells, one row per figure (14 poses, then the
  // same 14 wearing a cap, then 4 standing poses wearing a white helmet — the ops layer's
  // marshals and crews), columns = 8 yaws × 2 camera elevations. diff = lit RGBA with the
  // clothing baked white / light grey; mask = R shirt+cap, G pants, B skin (what the runtime
  // tints), black for the helmet (never tinted).
  {
    key: 'tex/crowd_atlas',
    kind: 'texture',
    site: 'Quaternius (baked by suzuka-3d)',
    name: 'Spectator impostor atlas — Background Posed Humans Pack',
    pageUrl: 'https://quaternius.com/packs/backgroundposedhumans.html',
    author: 'Quaternius',
    authorUrl: 'https://quaternius.com/packs/backgroundposedhumans.html',
    credit: 'Background characters by Quaternius (GLB conversion by Eclair Assets); impostor atlas baked by scripts/assets/bake-crowd-atlas.mjs',
    licence: 'CC0-1.0',
    resolver: 'bake',
    bakeScript: 'node scripts/assets/bake-crowd-atlas.mjs',
    res: '4k', // keeps the 2048 × 4096 canvas as baked (loadRaw only shrinks above RES_PX)
    use: 'far-field spectator impostors and the ops layer\'s figures (8 yaws × 2 elevations × 32 rows: 14 bare, 14 capped, 4 helmeted)',
    files: { 'crowd_atlas_diff.png': 'bake://crowd-atlas/diff', 'crowd_atlas_mask.png': 'bake://crowd-atlas/mask' },
    maps: { diff: 'crowd_atlas_diff.png', mask: 'crowd_atlas_mask.png' },
  },
  // Baked in-repo from app/three/car-bodies.ts and, with --glb, the vehicle GLBs above through
  // app/three/car-glb.ts (scripts/assets/bake-car-atlas.mjs): the far-field parked-car impostor
  // atlas. 128 px cells, one row per body (minivan, kei wagon, SUV, hatchback, saloon, coach, kei
  // truck), columns = 8 yaws at one camera elevation. diff = lit RGBA with the procedural
  // paintwork baked white (the GLB rows keep their photo); mask = R the paintwork (what the
  // runtime tints — the luma rule for the GLB rows), black glass / tyres / lamps.
  {
    key: 'tex/car_atlas',
    kind: 'texture',
    site: 'suzuka-3d (own bake) + Sketchfab',
    name: 'Parked-car impostor atlas — procedural low-poly bodies and the four CC-BY vehicle GLBs',
    pageUrl: 'https://github.com/noribento/suzuka-3d',
    author: 'suzuka-3d, bean(alwayshasbean), NNXST, ImperialBlue, own.guest',
    // the four GLB rows (kei wagon, kei truck, minivan, coach) are renders of the CC-BY bodies
    // above, so the atlas carries their credit: "Suzuki Carry kei truck low poly" by
    // bean(alwayshasbean), "Daihatsu Move Conte (Low Poly)" by NNXST, "1990 Toyota Hiace (H100)"
    // by ImperialBlue, "Isuzu Erga Mio bus" by own.guest (titles as their license.txt); the other
    // three rows are the project's own procedural shells
    credit: 'impostor atlas baked by scripts/assets/bake-car-atlas.mjs --glb from app/three/car-bodies.ts and the CC-BY 4.0 models "Suzuki Carry kei truck low poly" (bean(alwayshasbean)), "Daihatsu Move Conte (Low Poly)" (NNXST), "1990 Toyota Hiace (H100)" (ImperialBlue) and "Isuzu Erga Mio bus" (own.guest)',
    licence: 'CC-BY-4.0',
    resolver: 'bake',
    bakeScript: 'node scripts/assets/bake-car-atlas.mjs --glb',
    res: '1k', // keeps the 1024 × 1024 canvas as baked (loadRaw only shrinks above RES_PX)
    use: 'far-field parked-car impostors (8 yaws × 7 body rows: 4 from the vehicle GLBs, 3 procedural)',
    files: { 'car_atlas_diff.png': 'bake://car-atlas/diff', 'car_atlas_mask.png': 'bake://car-atlas/mask' },
    maps: { diff: 'car_atlas_diff.png', mask: 'car_atlas_mask.png' },
  },
  // Kept for provenance / later phases, never imported: the Quaternius originals (FBX/OBJ/Blend)
  // behind the Eclair GLBs, and the Universal Base Characters + Animation Library (VAT crowd).
  {
    key: 'ref/quaternius_posed_originals',
    kind: 'reference',
    site: 'Quaternius',
    name: 'Posed Background Characters (FBX/OBJ/Blend originals)',
    pageUrl: 'https://quaternius.com/packs/backgroundposedhumans.html',
    author: 'Quaternius',
    licence: 'CC0-1.0',
    resolver: 'misc-local',
    miscRoots: ['crowd/quaternius', 'Posed Background Characters by @Quaternius'],
    licenceFile: 'License.txt',
    licenceMarker: 'CC0 1.0 Universal',
  },
  {
    key: 'ref/quaternius_ubc',
    kind: 'reference',
    site: 'Quaternius',
    name: 'Universal Base Characters [Standard] + Universal Animation Library [Standard]',
    pageUrl: 'https://quaternius.com/packs/universalbasecharacters.html',
    author: 'Quaternius',
    licence: 'CC0-1.0',
    resolver: 'misc-local',
    miscRoots: ['crowd/quaternius-ubc', 'Universal Base Characters[Standard]'],
    licenceFile: 'License_Standard.txt',
    licenceMarker: 'CC0 1.0 Universal',
  },
  // --- tree impostor atlas (Phase 2, scripts/assets/bake-tree-atlas.mjs) ---------------------
  // Baked in-repo from the imported tree packs above (`model/trees/*`, CC-BY 4.0): one 4096²
  // atlas, 256 px cells, one row per species of app/data/tree-species.ts, columns = 8 yaws × 2
  // camera elevations (10°, 45°). diff = the lit trees, RGBA; mask = R the foliage (what the
  // runtime tints per tree), black the bark. The layout is mirrored as TREE_LAYOUT in
  // app/data/impostor-atlas.ts.
  {
    key: 'tex/tree_atlas',
    kind: 'texture',
    site: 'Sketchfab (baked by suzuka-3d)',
    name: 'Tree impostor atlas — pine / fir / oak / bush / cherry / bamboo packs',
    pageUrl: 'https://github.com/noribento/suzuka-3d',
    author: 'lolipop_1707, Sereib, evolveduk',
    credit: 'impostor atlas baked from the CC-BY tree packs by scripts/assets/bake-tree-atlas.mjs',
    licence: 'CC-BY-4.0',
    resolver: 'bake',
    bakeScript: 'node scripts/assets/bake-tree-atlas.mjs',
    res: '4k', // keeps the 4096 × 4096 canvas as baked (loadRaw only shrinks above RES_PX)
    use: 'far-field tree impostors (8 yaws × 2 elevations × 11 species rows)',
    files: { 'tree_atlas_diff.png': 'bake://tree-atlas/diff', 'tree_atlas_mask.png': 'bake://tree-atlas/mask' },
    maps: { diff: 'tree_atlas_diff.png', mask: 'tree_atlas_mask.png' },
  },
]

/**
 * sha256 pins of every downloaded file, keyed by '<key>/<relpath>'. Filled by
 * `node scripts/assets/fetch.mjs --print-pins` after a clean fetch; fetch.mjs fails loudly when a
 * re-download no longer matches (upstream re-encode, CDN tampering, or a moved Kenney build hash).
 */
export const PINS = {
  'model/props/Barrel_02/Barrel_02.bin': 'a9a848743a7616710e2b3aee0b61c6fb69abc3910a150856ad21776a6089f29a',
  'model/props/Barrel_02/Barrel_02_1k.gltf': '82204368af4d7211c440e7ebcd30979f48ba349d4439f3bf0212f86d4ba5d9d8',
  'model/props/Barrel_02/textures/Barrel_02_arm_1k.jpg': 'bd69aa2c5c069482cb48a14aed1f3a1d079bd868d865247206427df5a53202e3',
  'model/props/Barrel_02/textures/Barrel_02_diff_1k.jpg': '2dd828ce25b5b6b0ffc9b7901d1778767f1897be1c8004f4ec047fc91742cf12',
  'model/props/Barrel_02/textures/Barrel_02_nor_gl_1k.jpg': 'f7029669d04979d20bbe1a80d34e689aff4b1ebe1bcc37a3ee62c8e384229a77',
  'model/props/concrete_road_barrier/concrete_road_barrier.bin': '64a4f9bc6e4af64d714a252c3c13428c430a60569deba3d52ca6b7dd3aa70d8c',
  'model/props/concrete_road_barrier/concrete_road_barrier_1k.gltf': 'c371e87d303fff3f0c9fbe88520f7837514364e5c66aac3244e115ffa673d061',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_arm_1k.jpg': 'b940847648012f2db8c24b16e07ad1e39b3bd33ea493203364deca209606e4b4',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_diff_1k.jpg': '88b2d79829ffec7b11ac4d9c8554328f30b665d2c17f634197fde4f1ca8696fe',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_nor_gl_1k.jpg': 'c1072f51ff5c3d7158f0fbb0aa26e82b816b745b9f03639c4816832af2b37c52',
  'model/props/covered_car/covered_car.bin': 'dcbd7bf82d415e30d02c3e7056013b44729de7b712868b5ab9bf29f2b3b8bc57',
  'model/props/covered_car/covered_car_1k.gltf': '80b210b08673833a8085812b9ee71286213b2af92654886e5a1a368977265aa7',
  'model/props/covered_car/textures/covered_car_arm_1k.jpg': 'e77f73234311701dd8088ec572e61d4ec7838bd28e9ea13ffe5e28f79da8e085',
  'model/props/covered_car/textures/covered_car_diff_1k.jpg': 'c4616a5c7c1327e4bc127b600e59d9dcb2123f8926f1570a1ca4a068d97f4d34',
  'model/props/covered_car/textures/covered_car_nor_gl_1k.jpg': '6769694abe28c53e5c35ad1cefdd462b56416e7d89a6bcf5a9d9f6c922b46d05',
  'model/props/exterior_aircon_unit/exterior_aircon_unit.bin': 'b4b9ad082bdaa8f8b437bc14d9981caeaf318334499d4bf65d616fb2ec0c5ca8',
  'model/props/exterior_aircon_unit/exterior_aircon_unit_1k.gltf': 'f19d85c76948903047c2846068aeaa376d5e956a410675268cb6cb6aac5d97c2',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_01_arm_1k.jpg': '14671920f716691dc3b8940432f7aba5c469e3b466441ff8ad500de92d3178fb',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_01_diff_1k.jpg': '2ae5005b4836d2c91d1e712d9acf425c7dcc4973b7c0fc6f23da9afaa6381da6',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_01_nor_gl_1k.jpg': 'e5a6f3c135b942d6efe62a24496c575d03f6a4316188efe65079035d7faf1c38',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_01_opacity_1k.jpg': 'c19feb434c2b01923fbb3e16ace3aa6d9cb16b05c2a5c479ad237759b2d331d6',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_02_arm_1k.jpg': '1cdfa2d1c938c3af61a5f06510b0d94aeddddd4bdc1832008b3826240dd1535d',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_02_nor_gl_1k.jpg': '864c0fb1e55aff910d826a8c1f6a2ad459f7db0124b5846445d466cabf0cadf5',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_01_arm_1k.jpg': '51c103926b118bf00b902826001db802b15755c6eefa12b00afa24c60d7b341b',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_01_diff_1k.jpg': 'a8771db98ed7f3d46ce48fd70867f58a74a2530666c339f8dcc14f3e5de86d0b',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_01_nor_gl_1k.jpg': '14f105cda9172290be2e8b23b8e895099b65e222619850af3b13105901d922e2',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_02_arm_1k.jpg': '6ac4cfca6a8d8bec6ef1ff756652eb1f36b780d1ff7d70d9cb3e0f7fe1faf271',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_02_nor_gl_1k.jpg': '3af4716b42812b742577594c7a0a342accd79925f02037c152b1da1c5831bb78',
  'model/props/exterior_aircon_unit/textures/exterior_aircon_unit_rusted_02_opacity_1k.jpg': 'a86bcaf9c4858cf250fd67c9a0ee362504454b9972ff6e1ac44e38bac3213421',
  'model/props/korean_fire_extinguisher_01/korean_fire_extinguisher_01.bin': 'a460dd65b63477bb641196d77393258af0c8a6e2a64728156cb45d92658c86bd',
  'model/props/korean_fire_extinguisher_01/korean_fire_extinguisher_01_1k.gltf': '565f9e41909165c2bead24b722746e29ba55e8eb5e541f61fe0d1ef7e66d2ecf',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_body_arm_1k.jpg': '2c8fa0a85d5acc5f4e784ecefd8bfd16e1aafd112e553bfcece0c81c9b129eea',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_body_diff_1k.jpg': '2d874513cfb6d7485b67e936ee32e7af14992da6a5eedf980dbdfc32a2119987',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_body_nor_gl_1k.jpg': 'b6ba7a7cafa04557c93dc63b44260b635863f0a95f8ba1445b75758dac3443d3',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_glass_arm_1k.jpg': '412712fddc3654d801949889f78c9ee92d8855624a1fe1057be29a38e766bda0',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_glass_diff_1k.jpg': 'ca7e49959126aa51e2d4ab440aeb9f7ff17a8a6d025b116f6327f2343ee041af',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_glass_nor_gl_1k.jpg': '3b299c54cb9b6f72d4f79e6ecd2f8cfcc618292c87881de1d17892b5ca668896',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_paper_arm_1k.jpg': '542b45184bb0ea66cdd2f180792148c45d45862a12f1ac341f798e53029015b9',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_paper_diff_1k.jpg': '2d56948aa72a9bad6133db3e6b17fa0df1a56cdf25db4b7e21e6ceb21999a038',
  'model/props/korean_fire_extinguisher_01/textures/korean_fire_extinguisher_01_paper_nor_gl_1k.jpg': 'caaa26dd438e827e994c69605091d58ecc6a152813ece776cc561e0b24a8433a',
  'model/props/metal_jerrycan/metal_jerrycan.bin': 'd84ce2528b28a477c5309fc289a50a3deb61287265a787bd728e639c5230408c',
  'model/props/metal_jerrycan/metal_jerrycan_1k.gltf': '7ae6f2aa0b7f35e38baa89c1c243312848391a9d1c0e67acf02aa7dac32599ff',
  'model/props/metal_jerrycan/textures/metal_jerrycan_arm_1k.jpg': 'fda20dd47d809fd5bd4cd29cd11e77fc2de97bd35569a7efb51fbf78705e659c',
  'model/props/metal_jerrycan/textures/metal_jerrycan_diff_1k.jpg': '64781939c4b3f739c52c335d26473def75d736173f3cc11a50ac2876d511d123',
  'model/props/metal_jerrycan/textures/metal_jerrycan_nor_gl_1k.jpg': '88dd8f6566cc5faa8fee658777115b518642508f23ffa1917128dba9539ae14d',
  'model/props/metal_tool_chest/metal_tool_chest.bin': 'c2bde4e96af4aad171e57e00ff78f0aa9e3b603286a2c74cd6d7c2a20c487342',
  'model/props/metal_tool_chest/metal_tool_chest_1k.gltf': '2f66fbb723cd52382f73daec184b68d9b36842a488ecaf120e5c3a6354e9dea4',
  'model/props/metal_tool_chest/textures/metal_tool_chest_arm_1k.jpg': 'd5552ee63ac9bc53527ee1bf19bcbd31d8424bcc15fe9861f79bba917e857828',
  'model/props/metal_tool_chest/textures/metal_tool_chest_diff_1k.jpg': 'da37ba2a8d064637c7206cb091597275986e788ce379bee58a96c949cce06511',
  'model/props/metal_tool_chest/textures/metal_tool_chest_nor_gl_1k.jpg': 'bc5a4009a544a9504849b951afd984d6ac7c5adb0d43c5a08c0a834f8e811a01',
  'model/props/modular_fire_escape/modular_fire_escape.bin': '5173033f47b33cbfe47fb38fb18ad99e6d78070ab7e1faf6fcc5a002afe98728',
  'model/props/modular_fire_escape/modular_fire_escape_1k.gltf': '3a28e24cf2b6fc32c86f4fd378a372f9c3babfb9c2206036c6276d5bb47df2fd',
  'model/props/modular_fire_escape/textures/modular_fire_escape_01_arm_1k.jpg': 'ca4ada942209b9b880b180f0646e1bf7c86f46b7599b12ff56b4ef6ad533c44d',
  'model/props/modular_fire_escape/textures/modular_fire_escape_01_diff_1k.jpg': '50b15363269bee95c4c4aeb54a4a4df31a3e52680877fe286259c92885c17b74',
  'model/props/modular_fire_escape/textures/modular_fire_escape_01_nor_gl_1k.jpg': '2db2bfc1d9d487cec32f68a846883ded440a1d10a328d81d8dcc522be45e7734',
  'model/props/modular_fire_escape/textures/modular_fire_escape_02_arm_1k.jpg': 'b4b65ebcd05e6c4502240a46eebd6535e9f83c0c65e0baaebaf25dae207c7c95',
  'model/props/modular_fire_escape/textures/modular_fire_escape_02_diff_1k.jpg': '9e969f5912b61aee6a6aa6dac3d98a4be3a4c92bf3b8f71e80fedc068493aa18',
  'model/props/modular_fire_escape/textures/modular_fire_escape_02_nor_gl_1k.jpg': 'd9024407844f8baf514d005354ea4a729aff3659753e36cbab92fb09d0df3565',
  'model/props/old_tyre/old_tyre.bin': '659e7982c2de92ca1d13194c97bf112b6dec22d91daecc88e3912d37ce1b7252',
  'model/props/old_tyre/old_tyre_1k.gltf': 'ba7b417eb3dc747c356ac3cd1f125754755684eb664737a9f1fc9e490c0b766e',
  'model/props/old_tyre/textures/old_tyre_arm_1k.jpg': '3bcf192f5b99a7a574f9e21e75927043e6726c601a5da15e3210a31db05e12d4',
  'model/props/old_tyre/textures/old_tyre_diff_1k.jpg': '0e34ce658c0844c0c94022233226d495930d514c917a5fa15ffee4760567439e',
  'model/props/old_tyre/textures/old_tyre_nor_gl_1k.jpg': '34b716e140408985ddbab7d4bf1d8d430edf834cd2fd4639d82b14cb393fa73e',
  'model/props/plastic_crate_02/plastic_crate_02.bin': 'f51696aa04643b5c1948da88be8ce1d4e92596ae4908b0132cd690f8fb8e0b63',
  'model/props/plastic_crate_02/plastic_crate_02_1k.gltf': '531f7ba7d4b501759b04fb704db1948bcaab34d8342e71e3f5877d9f0340dba7',
  'model/props/plastic_crate_02/textures/plastic_crate_02_arm_1k.jpg': 'f0c667358c7afd46be37b40c30435b63ae3dba8432b45c507f3298fc6f163418',
  'model/props/plastic_crate_02/textures/plastic_crate_02_diff_1k.jpg': 'f153478d5f44f39ab27a967850caac27b35ee8f04185d0d4eaf7ad501742fb15',
  'model/props/plastic_crate_02/textures/plastic_crate_02_nor_gl_1k.jpg': '492b4cb03b043fb30a21b5de1cdf91dfbcd9bb7d080957af69a333d622050f30',
  'model/props/plastic_monobloc_chair_01/plastic_monobloc_chair_01.bin': 'db5c778488d01d7e7d3409e2cda53ee8f6dd523a327c080000d549dd0f83b375',
  'model/props/plastic_monobloc_chair_01/plastic_monobloc_chair_01_1k.gltf': '899bf148139ab8d1718c25ec06112a652631f9476b5aaeeacb9eb1da9b7f1d3a',
  'model/props/plastic_monobloc_chair_01/textures/plastic_monobloc_chair_01_arm_1k.jpg': '78a67659a19a9df9efc0ef71789de0c949a727db62ade4c4c8887cd2c803c1a2',
  'model/props/plastic_monobloc_chair_01/textures/plastic_monobloc_chair_01_diff_1k.jpg': 'fdd1255a02bf684cfcff2eae75c0e3eea0db1fb5ecbfbd8c4f9beab8fd83ff6c',
  'model/props/plastic_monobloc_chair_01/textures/plastic_monobloc_chair_01_nor_gl_1k.jpg': '9ffa876b37d72ae1c0aed84d4dc1f62c956c844b3efec1f786f9080c10f63c9e',
  'model/props/portable_generator/portable_generator.bin': 'fb7dcfedec1331ad541569e4ca8d4157284b2164084b7fe5a97928d4abc0ea2d',
  'model/props/portable_generator/portable_generator_1k.gltf': 'd5afe27834f824dfe753391713c45be03479e8100831f320796030531f61b848',
  'model/props/portable_generator/textures/portable_generator_arm_1k.jpg': '10236e967baddd90ec7d4ab68969b06fb419f98782a2796db94edc0249b0dad2',
  'model/props/portable_generator/textures/portable_generator_diff_1k.jpg': '32acc300105a2df2290d872889b24e1b29ff1ca2c56c0a0cf8fbba0c5966a063',
  'model/props/portable_generator/textures/portable_generator_nor_gl_1k.jpg': '8a868edab1a2f5ffa50b2b1680c2c342491b3eeeac443734178c445c7286c25d',
  'model/props/portable_generator/textures/portable_generator_spec_1k.jpg': 'acf30e81c367898eb846f353d77e404f6831ac23bf071e0e718fddb8881b86cb',
  'model/props/rollershutter_door/rollershutter_door.bin': '155cd44e199d4edd19769503c7ed22b0b4007869166d0193a7e2d5e3134dc38d',
  'model/props/rollershutter_door/rollershutter_door_1k.gltf': '913b2689f88f99cb75f8a6575e315ee90437e59976a2a3ce0b260d5636a14d30',
  'model/props/rollershutter_door/textures/rollershutter_door_arm_1k.jpg': '0a45cf8585a339ae542ef891f3aa697258079b98f1755b2d6716ea542d3de14a',
  'model/props/rollershutter_door/textures/rollershutter_door_diff_1k.jpg': 'b8cd7ad14fe5c691484fe240213c379bf18f21336afe6622bfa20c731eca010d',
  'model/props/rollershutter_door/textures/rollershutter_door_graffiti_diff_1k.jpg': '7438bee86fc32e3b6ca23ec694f179576749554dff7c3b281f30acd917c250af',
  'model/props/rollershutter_door/textures/rollershutter_door_nor_gl_1k.jpg': '3eaad465ac23e4b3d5fbf2e315b738f8d3039cd244a69ab8adcc7a0e786cdffb',
  'model/props/security_camera_01/security_camera_01.bin': 'c43dd3576213c169d1b3a9968788c0da2d14073e59c7d2503bc230c05042bb21',
  'model/props/security_camera_01/security_camera_01_1k.gltf': 'd2468fe353cd9f992a5549709cf9efcfae67e9fd17f80bf7ff3866e2881dd2ae',
  'model/props/security_camera_01/textures/security_camera_01_arm_1k.jpg': '68bb728aff5af6bd4141201cd221c7e17ef537f49978c321b0e183677f8877ba',
  'model/props/security_camera_01/textures/security_camera_01_diff_1k.jpg': '572968d8c693682aa5c87d59428e1db234b0d81ec620af8a019c72e3f011d53f',
  'model/props/security_camera_01/textures/security_camera_01_nor_gl_1k.jpg': '80e791da5d975177d16d5f30202deac0b262ffe6b13311605c09c630b93d0de5',
  'model/props/security_camera_02/security_camera_02.bin': '15512a4c0add24cd6ec38386e7707b02587f6bb873d9a0620ca6bbc548f1dc7b',
  'model/props/security_camera_02/security_camera_02_1k.gltf': '912c8e01a7a3f3edc52ac39cc6f357bef9a967e5a1ded270c634c621f74d0b51',
  'model/props/security_camera_02/textures/security_camera_02_arm_1k.jpg': 'dd55c2295a8c2265c97e7730d3dad436032413f2ca0b1a976f2e4314ac1efcbf',
  'model/props/security_camera_02/textures/security_camera_02_diff_1k.jpg': '619756fa57b0972248d0f0100e99ca62d7cd95daa80c7439bb49ff8254eb7d12',
  'model/props/security_camera_02/textures/security_camera_02_nor_gl_1k.jpg': '87e70382709059a3c0b85ff803c3e68aec622f13062debe103c2069a78b71fef',
  'model/props/security_light/security_light.bin': '3d45d473d7ad4ace4ce93790db96dd7d6decbd0180b59a7a2774c690594e70e2',
  'model/props/security_light/security_light_1k.gltf': 'd82d2191df1e30a75c2f2ce07a8abefcd52b0e8eabc819e2ac854da0f16fba18',
  'model/props/security_light/textures/security_light_arm_1k.jpg': '4f8fe251eb31144de0eff820a7aef205d306b3b5dd4a19aff0ad4e87ca50a767',
  'model/props/security_light/textures/security_light_diff_1k.jpg': '2e7064d89f03ef51bffda6f78c86baac1edba3346f82f243aa0c33b20fa8b0e5',
  'model/props/security_light/textures/security_light_nor_gl_1k.jpg': '7d14ecdf5f6c70152ca6fdfc290c72a28553248f0e5a79e7b77c8f601b00ddc2',
  'model/props/steel_frame_shelves_01/steel_frame_shelves_01.bin': '306d7e72d12a5d3047b8a189f8d0add51075eaf7f51f935286fda4e1c16dd066',
  'model/props/steel_frame_shelves_01/steel_frame_shelves_01_1k.gltf': '4eff8994825d654e337f8dc425e959ed6add7f4773188c87ba64402d9edd9842',
  'model/props/steel_frame_shelves_01/textures/steel_frame_shelves_01_arm_1k.jpg': '858629eeaa8f68ddb4fc1a813afe6ed988ded3d6d49184ec45a14611760f0bb3',
  'model/props/steel_frame_shelves_01/textures/steel_frame_shelves_01_diff_1k.jpg': '85e205b334e15e05bec9b02be1258da6ab949ae908aa57e0bee6b94ba45b4415',
  'model/props/steel_frame_shelves_01/textures/steel_frame_shelves_01_nor_gl_1k.jpg': '2a67ed7dd4f53c3e225396e6381992b768fe58b5261be703d540678e366e46ed',
  'model/props/street_lamp_02/street_lamp_02.bin': 'e544c04855dcf728ff2724f691f6784690b8ba3ac323a9a332e56b271ffe1d7c',
  'model/props/street_lamp_02/street_lamp_02_1k.gltf': '3a8a42486c5dc4538a8b44aeeef502c64a1c9d0d42fa5610e37886c355337ff8',
  'model/props/street_lamp_02/textures/street_lamp_02_arm_1k.jpg': 'a1e2d654e7d5d48a1fdfbf720840192d171df54e5ea5f055145d0472d617eede',
  'model/props/street_lamp_02/textures/street_lamp_02_diff_1k.jpg': '19882567313dd43fef60f9fa41a4c55f81a957f9fee539e931fc36a32e386b6c',
  'model/props/street_lamp_02/textures/street_lamp_02_nor_gl_1k.jpg': 'fdd9fb26ca853020ed156fdd84e90ce3f9a68bf94edf71c0ffe72add67e316c6',
  'model/props/tool_cart/textures/tool_cart_arm_1k.jpg': '2b928779ab242468c90e6074ab72567bc58ecf3e0240fd709e4507b59764aef7',
  'model/props/tool_cart/textures/tool_cart_diff_1k.jpg': '3a3e18efa54d18f2d01ad51cb40f8edd9af76e054a6a9c21324bc14fe49be965',
  'model/props/tool_cart/textures/tool_cart_nor_gl_1k.jpg': 'fa995e77eacad81c78f650e28a6d4c1c7b9d6c74a3f314d5f5ebdddf6de510fc',
  'model/props/tool_cart/tool_cart.bin': '3962637a4faec733b10d9970bfeea6696a48b6fd361fda085cc3d122138f6aaa',
  'model/props/tool_cart/tool_cart_1k.gltf': 'ba4290f62b37dc08d4f99da2b3c78d8cb584bd229e8805ce586ed3f3b5303759',
  'model/props/utility_box_02/textures/utility_box_02_arm_1k.jpg': 'f85575f891c97354d2fff11d5d0e2bc5f7d3aeab853ff3d75100c30c177a9cc5',
  'model/props/utility_box_02/textures/utility_box_02_diff_1k.jpg': '78a0c93b1d8d394beee5989c0d3470a9c8c4e902f708acf3c11cd4edafbe08b1',
  'model/props/utility_box_02/textures/utility_box_02_nor_gl_1k.jpg': 'e7c85b37fa5420591b6fa5dcef7875c927c8dc51f38c39c5844d53284ef37c74',
  'model/props/utility_box_02/utility_box_02.bin': '0f0a3f8ecc0358e36e97120aa752c2456a78bf922671e6f77e402b0aa58ecfce',
  'model/props/utility_box_02/utility_box_02_1k.gltf': 'd3f87ce0852709498602f6a096be99a9e13f0ac2619f99edcebad9e89f9faf00',
  'ref/crowd_plates/bangabandhu_crowd_2019.jpg': '6557474c28a545cecfcf6e6859f3c368945f94ad4e95dbbfa3d9a56e0d9985a5',
  'ref/crowd_plates/front_row_audience_unsplash.jpg': '7585fefb4bcb4b14af078fb1d4eb71663f3ef740ebf060f09ff3c5d2fce0c392',
  'ref/kenney_racing_kit/kenney_racing-kit.zip': '8a71ea16219315a01d00d5a90c4f6b5c090faddbc56d80ecf727e2b3b853c6c0',
  'tex/asphalt033/Asphalt033_1K-JPG.zip': 'c71801b342dbea594dbdd0bd2ddc0a6d13f813c923fca408b9f5b9ee5e58aba2',
  'tex/asphalt_04/asphalt_04_arm_1k.jpg': '35f582fb66d223d242d294616aec5749affdc6ca0a97067311cd6f247f7ef081',
  'tex/asphalt_04/asphalt_04_diff_1k.jpg': '837a78bb1e94864c221f847c85480484e953a9ee958772481dd2c501e18def2e',
  'tex/asphalt_04/asphalt_04_nor_gl_1k.jpg': '18b91c2a6d83a8fbaa8d7fe84e80a66bd6451e4ec2774a09bf4429498c8f3912',
  'tex/asphalt_pit_lane/asphalt_pit_lane_arm_1k.jpg': '3e4315b489f07ff88315017932bdf40d3b9670e3d04c07d4077aa86a16e98d37',
  'tex/asphalt_pit_lane/asphalt_pit_lane_diff_1k.jpg': '8aad5097f6de913aebc33f2b9b9271834b55c6942359955722db3196a9ce9bca',
  'tex/asphalt_pit_lane/asphalt_pit_lane_nor_gl_1k.jpg': 'a215356a1180664fbbf94076f3720a4620a1121e137780ce98059621bf8b444e',
  'tex/asphalt_track/asphalt_track_arm_1k.jpg': '1ad38c055c97547802912facec609ee6deda2dc9bc2f048f36ea484e5f5ccb6e',
  'tex/asphalt_track/asphalt_track_diff_1k.jpg': '05c4e79cd99160075969d37bfc6ef72be262153a410bb45510b2c23f7303894c',
  'tex/asphalt_track/asphalt_track_nor_gl_1k.jpg': '18caf02427a7cd9cd577ceae5aa9daa7bb3ffba60598e2df8aaf75d1925a8a94',
  'tex/blue_metal_plate/blue_metal_plate_arm_1k.jpg': '9321b539fe9cf0136ea04c3405b95ae82383f31c258b9c0e37ff8a1e577b637f',
  'tex/blue_metal_plate/blue_metal_plate_diff_1k.jpg': 'a0162bffce47d4a35613a12af22571b28c18412dc5805cbb69eac343554ef750',
  'tex/blue_metal_plate/blue_metal_plate_nor_gl_1k.jpg': '970f0273c9e2e3b4fc8338bfd58a28c413b70ac4d1734d9dc8a136724bde56e6',
  'tex/concrete046/Concrete046_1K-JPG.zip': '72bf4321acbb39ddbc3b786f5996813b2a3cede12efefb47955e97ea9668985b',
  'tex/concrete_floor_03/concrete_floor_03_arm_1k.jpg': 'baaea8404331ead21e12306ab5a890eb74b80cb8a2e508aa209cc9dfa4423fa1',
  'tex/concrete_floor_03/concrete_floor_03_diff_1k.jpg': '6403524d194100d80e3040435b953ddf44e90069bd404cfb116204dec3c35df7',
  'tex/concrete_floor_03/concrete_floor_03_nor_gl_1k.jpg': 'f9f18d02c1e4e655aa321ddeaf2c696a87a9c4782fea7119c65310c510367f5a',
  'tex/container_side/container_side_arm_1k.jpg': 'c5238fd9c6d234b1c6c9a62e2b1b97343636a4e42abd429e03faf58a613318b7',
  'tex/container_side/container_side_diff_1k.jpg': '9d6a8a9a243b6111f9d13af12d90325f0f1d52e45c2e1731f2d496702f024452',
  'tex/container_side/container_side_nor_gl_1k.jpg': '1e9e54d5816c97e5abeb448c3468b1eafb4add9acb41fcdc26817563c8f21f22',
  'tex/corrugatedsteel003/CorrugatedSteel003_1K-JPG.zip': '0bad36b34cf9d0e445c06b125fcbb7ea78074505d85051087fabb37acfa18ca1',
  'tex/corrugatedsteel007a/CorrugatedSteel007A_1K-JPG.zip': 'c70ff5a3a182ab14a010105bcfbdf26617877ca6985f95ef5c6677d0c3175899',
  'tex/corrugatedsteel009/CorrugatedSteel009_1K-JPG.zip': 'fa917cba8bbf4ceb645cf27e4c1a4a17621d3b1ad44a4125997cdd05662711fb',
  'tex/dry_mud_field_001/dry_mud_field_001_diff_1k.jpg': 'fa527aa4eb6151c7dab4f0a7b31722d0aa180f728af694594439d106e76f6c6d',
  'tex/facade001/Facade001_1K-JPG.zip': 'e804ad49d692ca60b260394db2ec05d8a274ad319759f536a042471b58d38ea9',
  'tex/fence003/Fence003_1K-JPG.zip': '235f74060d50f379ab0154d7130178fff65ceaf6a6f8e5615260d57ec0f3e1f2',
  'tex/grass_medium_01/grass_medium_01_alpha_1k.png': '711a8e49af758d6a6ce1f610db858899a27be19da6d1866bd35c13bc7b8ffeff',
  'tex/grass_medium_01/grass_medium_01_dry_diff_1k.png': 'da85639d6eb8f029b50e7920aaf7e649940541bb24fe6ad239dbae7400af2eb2',
  'tex/gravel_road/gravel_road_arm_1k.jpg': '1fa3f6f701df897975fcb2d8682acd8da949793d686b2be86320d7d3acd1858d',
  'tex/gravel_road/gravel_road_diff_1k.jpg': 'bccbb077a825bdd0eb6f607939578a6ee549822824278fb3a828f6eed3d05d45',
  'tex/gravel_road/gravel_road_nor_gl_1k.jpg': '0920996cab9f2d62a2eb73a3589804527aa0273c4ca61b9f526ce4cba37edebc',
  'tex/grey_roof_tiles/grey_roof_tiles_arm_1k.jpg': 'cd00bc65d20defa8560adbe908bf9027e0e39b8ccf954eeab9fca7a3c5674281',
  'tex/grey_roof_tiles/grey_roof_tiles_diff_1k.jpg': 'f61107b70cf56074c9db09384a332620c94c678ed2baabfae78029a8242e49a3',
  'tex/grey_roof_tiles/grey_roof_tiles_nor_gl_1k.jpg': '99546fdc2978d0950a2c61fe94dbd4230bb7825944bb4e4e7ad586839fdc721d',
  'tex/metalwalkway012/MetalWalkway012_1K-JPG.zip': 'ab3240a3b1fdab71ddf0eebd9f62a473e200f358c327402ec5e9355324b35709',
  'tex/painted_metal_shutter/painted_metal_shutter_arm_1k.jpg': '26a49a8b60dd2e1fdb325c1488d55d2e6e7362f4505e400ac2243bf0ec67ca56',
  'tex/painted_metal_shutter/painted_metal_shutter_diff_1k.jpg': '278394aabcb5a5bd560d9904358682acc5af23666b22bd1f12558789da4aa4d2',
  'tex/painted_metal_shutter/painted_metal_shutter_nor_gl_1k.jpg': '7545d778669c55e3e9bdc89355ce7190077c3ffdfb324e988ff9803a5bae5a46',
  'tex/paintedmetal010/PaintedMetal010_1K-JPG.zip': '1d57d7d4fcbab46ec9637b6d6b5d3ff9e405f8a1e52cb8a550f58e7f1365e1aa',
  'tex/pavingstones099/PavingStones099_1K-JPG.zip': 'dbd1a0de24e4a64480c0d80a3a3669eccafb26bb3b19aecf378af718f5b0ef8d',
  'tex/plaster_grey_04/plaster_grey_04_arm_1k.jpg': '9c4a6d0dc9d019ebc4c2cefea095ae413ebce078189bd641fab2bdac49bfc52c',
  'tex/plaster_grey_04/plaster_grey_04_diff_1k.jpg': 'e78df7d6e762fe767634278e14316564e0d4510031986239458994ec9fc5410d',
  'tex/plaster_grey_04/plaster_grey_04_nor_gl_1k.jpg': '9d0eb5299f797c07eb841737eb7164755a2c8a2363540e175a76188a2aa5a2dc',
  'tex/plastic013a/Plastic013A_1K-JPG.zip': '2bf612fa6fe5556930196865beb55cefb833b83bd0bc3db1db7188074fb41260',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_arm_1k.jpg': '3c514c4f7983ab81ba4f715863c8f95945ecbf60f3a982780897835302b744cb',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_diff_1k.jpg': 'da12ad78e4de12c0b38ca5c9fe2783a6b49c4362310844ded51b1acd8821fbe0',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_nor_gl_1k.jpg': 'd6edfa39844a4ef480ae2bfcf1c3cce549d8ce6080edd58c4493845aca9ce92d',
  'tex/rectangular_facade_tiles/rectangular_facade_tiles_arm_1k.jpg': '6be9a4e34057fc90ab450624cf83d2f5bc67bf59d5c137617ea62d8206540011',
  'tex/rectangular_facade_tiles/rectangular_facade_tiles_diff_1k.jpg': '583eafdfc03da4a74509ba545c5ea808c8bdc6e883763a804fcbe859c120afb9',
  'tex/rectangular_facade_tiles/rectangular_facade_tiles_nor_gl_1k.jpg': '8a7d8db468fe5bd37a2fc14ff6012855b14bec03dd413e034a376902a723b44c',
  'tex/roofingtiles015a/RoofingTiles015A_1K-JPG.zip': '5bb040c4c08592b607bba47cbf7384c2769bea1b49d088c463fa296708c0f743',
  'tex/solarpanel003/SolarPanel003_1K-JPG.zip': '9691dbe84d7c44ef9a2c84a8a55bdeb87e6a59fa649ccc4f3d47121f00028b5c',
  'tex/square_floor_patern_01/square_floor_patern_01_arm_1k.jpg': '106bd467e70a1738e719dd25d7998b4d5c2313a2cf1635f525e03f3c0b0dfd54',
  'tex/square_floor_patern_01/square_floor_patern_01_diff_1k.jpg': '9d169406abb8a9961673cf8acae5ab29fb6c71dd89aa2fe10dc9e68eeef40b9f',
  'tex/square_floor_patern_01/square_floor_patern_01_nor_gl_1k.jpg': '5f7579bc7a080c575d91efa526072e8edd7f1f2e11fa9477493104f548faf27d',
  'tex/tarred_gravel/tarred_gravel_arm_1k.jpg': 'f9ac62177978eb1e57fa9e1f8967e62aa1a3a4b1ce11b0f7b48108e6481d0866',
  'tex/tarred_gravel/tarred_gravel_diff_1k.jpg': '7b866b32d73f74f2e493f98828391587aed5b2cd24c47619ce7188b40079e627',
  'tex/tarred_gravel/tarred_gravel_nor_gl_1k.jpg': '7b88d5d9e36f9f5978ec94b7b0a5b9d419eb43093bb94b001ced8605914931e8',
  'tex/white_plaster_02/white_plaster_02_arm_1k.jpg': '2bb1115821715dfd8bbd1c5a294a5bb43b97d5c46b1aa8aa8f744bcaf5eeeb10',
  'tex/white_plaster_02/white_plaster_02_diff_1k.jpg': 'a1ebbe091bd1ae93d2abd5de8d69f9003a8d0ee6532bcf9a87c2492c97051f23',
  'tex/white_plaster_02/white_plaster_02_nor_gl_1k.jpg': 'eb572ca3630d5bfde72e2601b1f02412da23ca005cd19384dced8690be4cb783',
  'tex/withered_grass/withered_grass_arm_2k.jpg': '0b4bfb6549a56c48f7239be7f520124b38e7842188b8d1d53b0a376686c40371',
  'tex/withered_grass/withered_grass_diff_2k.jpg': '0cf0fca68cbf4277199a2b9b7b3a8013357e4087247b1367f86d4a53b4fafa7e',
  'tex/withered_grass/withered_grass_nor_gl_2k.jpg': '5fd42baf06224086cb9afcb2f7a3b9f26feddd719bf1f9aed65ec49c586e7ff9',
}
