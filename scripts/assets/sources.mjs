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
 *   retouch / dropParts    trademark surgery (retouch-glb.mjs: UV rectangles blurred / filled,
 *                          primitives dropped by material / mesh name regex)
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
 * Poly Haven texture: predictable URL template, three maps (diff / nor_gl / arm). Smallest
 * published size is 1k, so a 512 entry sets `fetchRes: '1k'` (the default when `res` is 512).
 */
function polyhavenTexture (id, { name, author, res = '1k', fetchRes = RES_PX[res] < 1024 ? '1k' : res, tile, use, pixels }) {
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
    files: Object.fromEntries(['diff', 'nor_gl', 'arm'].map(m => [f(m), `${PH_TEX}/${fetchRes}/${id}/${f(m)}`])),
    maps: { diff: f('diff'), nor_gl: f('nor_gl'), arm: f('arm') },
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
function sketchfabModel (key, { name, zip, author, authorUrl = `https://sketchfab.com/${author}`, pageUrl, use, maxTex = 1024, texEncode = { default: 'etc1s', normal: 'uastc', alpha: 'uastc', quality: 160 }, ...pack }) {
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
  polyhavenModel('concrete_road_barrier', { maxTex: 512, name: 'Concrete Road Barrier', author: 'Amal Kumar', use: 'props: pit entry / paddock separation blocks' }),
  polyhavenModel('security_camera_01', { maxTex: 512, name: 'Security Camera 01', author: 'Alexander Otterbeck, Yann Kervran', use: 'props: trackside TV camera stand-in' }),
  polyhavenModel('street_lamp_02', { maxTex: 512, name: 'Street Lamp 02', author: 'Josh Dean', use: 'props: paddock / car-park lighting' }),
  polyhavenModel('utility_box_02', { maxTex: 512, name: 'Utility Box 02', author: 'James Ray Cock', use: 'props: signal controller / distribution cabinet at the signal poles' }),

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
  {
    key: 'model/seats/bleacher',
    kind: 'model',
    site: 'Sketchfab',
    name: 'Bleacher',
    pageUrl: 'https://sketchfab.com/3d-models/bleacher-4960023d1ea340bfb07625aaa7f9713b',
    author: 'JanStano',
    authorUrl: 'https://sketchfab.com/JanStano',
    licence: 'CC-BY-4.0',
    resolver: 'misc-local',
    use: 'bench seating for temporary stands',
    miscRoots: ['seats', '.'],
    zip: 'bleacher.zip',
    entry: 'scene.gltf',
    licenceFile: 'license.txt',
    licenceMarker: 'CC-BY-4.0',
  },
  // Baked in-repo from the CC0 Quaternius / Eclair figures above (scripts/assets/bake-crowd-atlas.mjs):
  // the far-field spectator impostor atlas. 128 px cells, one row per figure (14 poses, then the
  // same 14 wearing a cap), columns = 8 yaws × 2 camera elevations. diff = lit RGBA with the
  // clothing baked white / light grey; mask = R shirt+cap, G pants, B skin (what the runtime tints).
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
    use: 'far-field spectator impostors (8 yaws × 2 elevations × 28 figure rows)',
    files: { 'crowd_atlas_diff.png': 'bake://crowd-atlas/diff', 'crowd_atlas_mask.png': 'bake://crowd-atlas/mask' },
    maps: { diff: 'crowd_atlas_diff.png', mask: 'crowd_atlas_mask.png' },
  },
  // Baked in-repo from app/three/car-bodies.ts (scripts/assets/bake-car-atlas.mjs): the far-field
  // parked-car impostor atlas. 128 px cells, one row per body (minivan, kei wagon, SUV, hatchback,
  // saloon, coach), columns = 8 yaws at one camera elevation. diff = lit RGBA with the paintwork
  // baked white; mask = R the paintwork (what the runtime tints), black glass / tyres / lamps.
  {
    key: 'tex/car_atlas',
    kind: 'texture',
    site: 'suzuka-3d (own bake)',
    name: 'Parked-car impostor atlas — procedural low-poly bodies',
    pageUrl: 'https://github.com/noribento/suzuka-3d',
    author: 'suzuka-3d',
    credit: 'project-own bake of procedural car bodies (scripts/assets/bake-car-atlas.mjs from app/three/car-bodies.ts)',
    licence: 'CC0-1.0',
    resolver: 'bake',
    bakeScript: 'node scripts/assets/bake-car-atlas.mjs',
    res: '1k', // keeps the 1024 × 1024 canvas as baked (loadRaw only shrinks above RES_PX)
    use: 'far-field parked-car impostors (8 yaws × 6 body rows)',
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
  'model/props/concrete_road_barrier/concrete_road_barrier.bin': '64a4f9bc6e4af64d714a252c3c13428c430a60569deba3d52ca6b7dd3aa70d8c',
  'model/props/concrete_road_barrier/concrete_road_barrier_1k.gltf': 'c371e87d303fff3f0c9fbe88520f7837514364e5c66aac3244e115ffa673d061',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_arm_1k.jpg': 'b940847648012f2db8c24b16e07ad1e39b3bd33ea493203364deca209606e4b4',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_diff_1k.jpg': '88b2d79829ffec7b11ac4d9c8554328f30b665d2c17f634197fde4f1ca8696fe',
  'model/props/concrete_road_barrier/textures/concrete_road_barrier_nor_gl_1k.jpg': 'c1072f51ff5c3d7158f0fbb0aa26e82b816b745b9f03639c4816832af2b37c52',
  'model/props/security_camera_01/security_camera_01.bin': 'c43dd3576213c169d1b3a9968788c0da2d14073e59c7d2503bc230c05042bb21',
  'model/props/security_camera_01/security_camera_01_1k.gltf': 'd2468fe353cd9f992a5549709cf9efcfae67e9fd17f80bf7ff3866e2881dd2ae',
  'model/props/security_camera_01/textures/security_camera_01_arm_1k.jpg': '68bb728aff5af6bd4141201cd221c7e17ef537f49978c321b0e183677f8877ba',
  'model/props/security_camera_01/textures/security_camera_01_diff_1k.jpg': '572968d8c693682aa5c87d59428e1db234b0d81ec620af8a019c72e3f011d53f',
  'model/props/security_camera_01/textures/security_camera_01_nor_gl_1k.jpg': '80e791da5d975177d16d5f30202deac0b262ffe6b13311605c09c630b93d0de5',
  'model/props/street_lamp_02/street_lamp_02.bin': 'e544c04855dcf728ff2724f691f6784690b8ba3ac323a9a332e56b271ffe1d7c',
  'model/props/street_lamp_02/street_lamp_02_1k.gltf': '3a8a42486c5dc4538a8b44aeeef502c64a1c9d0d42fa5610e37886c355337ff8',
  'model/props/street_lamp_02/textures/street_lamp_02_arm_1k.jpg': 'a1e2d654e7d5d48a1fdfbf720840192d171df54e5ea5f055145d0472d617eede',
  'model/props/street_lamp_02/textures/street_lamp_02_diff_1k.jpg': '19882567313dd43fef60f9fa41a4c55f81a957f9fee539e931fc36a32e386b6c',
  'model/props/street_lamp_02/textures/street_lamp_02_nor_gl_1k.jpg': 'fdd9fb26ca853020ed156fdd84e90ce3f9a68bf94edf71c0ffe72add67e316c6',
  'model/props/utility_box_02/textures/utility_box_02_arm_1k.jpg': 'f85575f891c97354d2fff11d5d0e2bc5f7d3aeab853ff3d75100c30c177a9cc5',
  'model/props/utility_box_02/textures/utility_box_02_diff_1k.jpg': '78a0c93b1d8d394beee5989c0d3470a9c8c4e902f708acf3c11cd4edafbe08b1',
  'model/props/utility_box_02/textures/utility_box_02_nor_gl_1k.jpg': 'e7c85b37fa5420591b6fa5dcef7875c927c8dc51f38c39c5844d53284ef37c74',
  'model/props/utility_box_02/utility_box_02.bin': '0f0a3f8ecc0358e36e97120aa752c2456a78bf922671e6f77e402b0aa58ecfce',
  'model/props/utility_box_02/utility_box_02_1k.gltf': 'd3f87ce0852709498602f6a096be99a9e13f0ac2619f99edcebad9e89f9faf00',
  'ref/crowd_plates/bangabandhu_crowd_2019.jpg': '6557474c28a545cecfcf6e6859f3c368945f94ad4e95dbbfa3d9a56e0d9985a5',
  'ref/crowd_plates/front_row_audience_unsplash.jpg': '7585fefb4bcb4b14af078fb1d4eb71663f3ef740ebf060f09ff3c5d2fce0c392',
  'ref/kenney_racing_kit/kenney_racing-kit.zip': '8a71ea16219315a01d00d5a90c4f6b5c090faddbc56d80ecf727e2b3b853c6c0',
  'tex/asphalt_04/asphalt_04_arm_1k.jpg': '35f582fb66d223d242d294616aec5749affdc6ca0a97067311cd6f247f7ef081',
  'tex/asphalt_04/asphalt_04_diff_1k.jpg': '837a78bb1e94864c221f847c85480484e953a9ee958772481dd2c501e18def2e',
  'tex/asphalt_04/asphalt_04_nor_gl_1k.jpg': '18b91c2a6d83a8fbaa8d7fe84e80a66bd6451e4ec2774a09bf4429498c8f3912',
  'tex/asphalt_pit_lane/asphalt_pit_lane_arm_1k.jpg': '3e4315b489f07ff88315017932bdf40d3b9670e3d04c07d4077aa86a16e98d37',
  'tex/asphalt_pit_lane/asphalt_pit_lane_diff_1k.jpg': '8aad5097f6de913aebc33f2b9b9271834b55c6942359955722db3196a9ce9bca',
  'tex/asphalt_pit_lane/asphalt_pit_lane_nor_gl_1k.jpg': 'a215356a1180664fbbf94076f3720a4620a1121e137780ce98059621bf8b444e',
  'tex/concrete046/Concrete046_1K-JPG.zip': '72bf4321acbb39ddbc3b786f5996813b2a3cede12efefb47955e97ea9668985b',
  'tex/corrugatedsteel003/CorrugatedSteel003_1K-JPG.zip': '0bad36b34cf9d0e445c06b125fcbb7ea78074505d85051087fabb37acfa18ca1',
  'tex/facade001/Facade001_1K-JPG.zip': 'e804ad49d692ca60b260394db2ec05d8a274ad319759f536a042471b58d38ea9',
  'tex/fence003/Fence003_1K-JPG.zip': '235f74060d50f379ab0154d7130178fff65ceaf6a6f8e5615260d57ec0f3e1f2',
  'tex/gravel_road/gravel_road_arm_1k.jpg': '1fa3f6f701df897975fcb2d8682acd8da949793d686b2be86320d7d3acd1858d',
  'tex/gravel_road/gravel_road_diff_1k.jpg': 'bccbb077a825bdd0eb6f607939578a6ee549822824278fb3a828f6eed3d05d45',
  'tex/gravel_road/gravel_road_nor_gl_1k.jpg': '0920996cab9f2d62a2eb73a3589804527aa0273c4ca61b9f526ce4cba37edebc',
  'tex/grass_medium_01/grass_medium_01_alpha_1k.png': '711a8e49af758d6a6ce1f610db858899a27be19da6d1866bd35c13bc7b8ffeff',
  'tex/grass_medium_01/grass_medium_01_dry_diff_1k.png': 'da85639d6eb8f029b50e7920aaf7e649940541bb24fe6ad239dbae7400af2eb2',
  'tex/plaster_grey_04/plaster_grey_04_arm_1k.jpg': '9c4a6d0dc9d019ebc4c2cefea095ae413ebce078189bd641fab2bdac49bfc52c',
  'tex/plaster_grey_04/plaster_grey_04_diff_1k.jpg': 'e78df7d6e762fe767634278e14316564e0d4510031986239458994ec9fc5410d',
  'tex/plaster_grey_04/plaster_grey_04_nor_gl_1k.jpg': '9d0eb5299f797c07eb841737eb7164755a2c8a2363540e175a76188a2aa5a2dc',
  'tex/plastic013a/Plastic013A_1K-JPG.zip': '2bf612fa6fe5556930196865beb55cefb833b83bd0bc3db1db7188074fb41260',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_arm_1k.jpg': '3c514c4f7983ab81ba4f715863c8f95945ecbf60f3a982780897835302b744cb',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_diff_1k.jpg': 'da12ad78e4de12c0b38ca5c9fe2783a6b49c4362310844ded51b1acd8821fbe0',
  'tex/preconcrete_wall_001_long/preconcrete_wall_001_long_nor_gl_1k.jpg': 'd6edfa39844a4ef480ae2bfcf1c3cce549d8ce6080edd58c4493845aca9ce92d',
  'tex/white_plaster_02/white_plaster_02_arm_1k.jpg': '2bb1115821715dfd8bbd1c5a294a5bb43b97d5c46b1aa8aa8f744bcaf5eeeb10',
  'tex/white_plaster_02/white_plaster_02_diff_1k.jpg': 'a1ebbe091bd1ae93d2abd5de8d69f9003a8d0ee6532bcf9a87c2492c97051f23',
  'tex/white_plaster_02/white_plaster_02_nor_gl_1k.jpg': 'eb572ca3630d5bfde72e2601b1f02412da23ca005cd19384dced8690be4cb783',
  'tex/withered_grass/withered_grass_arm_2k.jpg': '0b4bfb6549a56c48f7239be7f520124b38e7842188b8d1d53b0a376686c40371',
  'tex/withered_grass/withered_grass_diff_2k.jpg': '0cf0fca68cbf4277199a2b9b7b3a8013357e4087247b1367f86d4a53b4fafa7e',
  'tex/withered_grass/withered_grass_nor_gl_2k.jpg': '5fd42baf06224086cb9afcb2f7a3b9f26feddd719bf1f9aed65ec49c586e7ff9',
}
