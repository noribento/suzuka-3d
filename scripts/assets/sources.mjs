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
 * (pine_tree_01.bin is 948 MB), and the Suzuka wordmark (trademark).
 *
 * Map roles: diff → sRGB colour, nor_gl → linear OpenGL-convention normal, arm → linear packed
 * R = ambient occlusion (1.0 when the source has none), G = roughness, B = metalness (0 when
 * absent), opacity → linear cut-out mask.
 *
 * Only '2k' for the hero grass; everything else ships at 1K (budget §6: ≤ 80 MB, ≤ 250 MB RGBA8).
 */

/** User-Agent for every request: poly.pizza needs the Mozilla prefix, Wikimedia wants a contact. */
export const UA = 'Mozilla/5.0 (compatible; suzuka3d/0.1; +mailto:bhyg756@gmail.com)'

export const RES_PX = { '1k': 1024, '2k': 2048, '4k': 4096 }

/** Licences that may ever reach public/assets (checked by `import-misc.mjs --check`). */
export const LICENCES = {
  'CC0-1.0': { name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-3.0': { name: 'Creative Commons Attribution 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  'CC-BY-4.0': { name: 'Creative Commons Attribution 4.0', url: 'http://creativecommons.org/licenses/by/4.0/' },
  'Apache-2.0': { name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
}

const PH_TEX = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg'

/** Poly Haven texture: predictable URL template, three maps (diff / nor_gl / arm). */
function polyhavenTexture (id, { name, author, res = '1k', tile, use }) {
  const f = (map) => `${id}_${map}_${res}.jpg`
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
    tile,
    use,
    files: Object.fromEntries(['diff', 'nor_gl', 'arm'].map(m => [f(m), `${PH_TEX}/${res}/${id}/${f(m)}`])),
    maps: { diff: f('diff'), nor_gl: f('nor_gl'), arm: f('arm') },
  }
}

/**
 * ambientCG texture: one zip per resolution behind a 302. Map values are member-name suffixes;
 * a trailing '?' marks an optional member (packed with a neutral value when missing).
 */
function ambientcgTexture (id, { name, res = '1k', tile, use, maps }) {
  const zip = `${id}_${res.toUpperCase()}-JPG.zip`
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
    tile,
    use,
    files: { [zip]: `https://ambientcg.com/get?file=${zip}` },
    zip,
    maps,
  }
}

/** poly.pizza GLB (Quaternius CC0 mirror). `publicId` is the page slug, `resourceId` the file. */
function polypizzaModel (key, { name, publicId, resourceId, author = 'Quaternius', use, maxTex }) {
  const file = `${key.split('/').pop()}.glb`
  return {
    ...(maxTex ? { maxTex } : {}),
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

/** Poly Haven model: the .bin folder is not derivable, so fetch.mjs resolves it via the API. */
function polyhavenModel (id, { name, author, res = '1k', use, maxTex }) {
  return {
    ...(maxTex ? { maxTex } : {}),
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

  // ---- vegetation models (low-poly; sakura via instanceColor) ---------------------------------
  // The textured Quaternius pines/trees carry a stylised 1K bark tile + flat leaf-card sheet
  // (three PNGs, ~2 MB and 22 MB of RGBA8 VRAM per file) — far-field trees never need more than
  // 512 px, so `maxTex` caps them (default cap is 1K, applied to everything else).
  polypizzaModel('model/trees/pine_trees', { name: 'Pine Trees', publicId: 'oYtDty0fR6', resourceId: '1d499f8b-5a1b-4966-9a35-10c0d3841e91', use: 'tree line' }),
  polypizzaModel('model/trees/pine_a', { maxTex: 512, name: 'Pine', publicId: 'igSu0cPoBz', resourceId: '712aaefa-ae7f-4cb3-8834-a1b8860df3b2', use: 'tree line' }),
  polypizzaModel('model/trees/pine_b', { maxTex: 512, name: 'Pine', publicId: '79gmlLnweB', resourceId: '082c2026-56af-4e3f-bea7-9ae5de71101f', use: 'tree line' }),
  polypizzaModel('model/trees/pine_c', { maxTex: 512, name: 'Pine', publicId: '699sFuLCN2', resourceId: 'c55b8641-4679-4a85-8bd8-2a20e79abecd', use: 'tree line' }),
  polypizzaModel('model/trees/trees', { maxTex: 512, name: 'Trees', publicId: 'etFGNvsiFv', resourceId: '53a83125-e16a-4024-b8f6-1e72679c7ddf', use: 'broadleaf variety' }),
  polypizzaModel('model/trees/autumn_tree', { name: 'Autumn Tree', publicId: '2lRubrT6Na', resourceId: '653f3101-2c31-4d15-9e54-3d81aeca345a', use: 'recoloured pink → sakura' }),
  polypizzaModel('model/trees/bush', { name: 'Bush', publicId: 'ooG6CkLyE8', resourceId: '6bbb833e-26cb-4bf9-ae67-a31b98e30bd9', use: 'low bushes' }),
  polyhavenModel('shrub_03', { name: 'Shrub 03', author: 'Rico Cilliers', use: 'veg: undergrowth along the tree line' }),

  // ---- props (small objects seen from > 20 m: 512 px textures) -------------------------------
  polyhavenModel('concrete_road_barrier', { maxTex: 512, name: 'Concrete Road Barrier', author: 'Rico Cilliers', use: 'props: pit entry / paddock separation blocks' }),
  polyhavenModel('security_camera_01', { maxTex: 512, name: 'Security Camera 01', author: 'Rico Cilliers', use: 'props: trackside TV camera stand-in' }),
  polyhavenModel('street_lamp_02', { maxTex: 512, name: 'Street Lamp 02', author: 'Rico Cilliers', use: 'props: paddock / car-park lighting' }),

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
  'model/trees/autumn_tree/autumn_tree.glb': 'dcec1dcaa91c1b43a82dfc082c9b64b1e533bfb484b2de151d9817b3a1e07f03',
  'model/trees/bush/bush.glb': '917de9eee116cd439637abeca201ac0a823cb534c4618e15dcbca34d3a916782',
  'model/trees/pine_a/pine_a.glb': 'b2cc7f2e672f94a41925ba831af8b3db9cbe6621172fb6f2717881c81c074e18',
  'model/trees/pine_b/pine_b.glb': '240e6f60c5b106a892c80490d7c710f20ef902b328b5e173c0a567334e4df972',
  'model/trees/pine_c/pine_c.glb': '3a5db923999bd47281f1f38cf8451c1544acfad33d953892fa95ca74765be361',
  'model/trees/pine_trees/pine_trees.glb': 'aea959025a31b0d250d7c94c96cf9456f9fcdaf9fb269790029d85adae3703c4',
  'model/trees/trees/trees.glb': '2dc587f401a3a86e0e1ee0bb95b4a0293b620b445a26278fcf55b5b68b40b097',
  'model/veg/shrub_03/shrub_03.bin': 'bf4df21e6d2a2bc5f00b4c9142f776171fe7da00cf960001825748067af542b6',
  'model/veg/shrub_03/shrub_03_1k.gltf': 'b76d7c14bc027e834e82d3f984c32b5d060e62908aa90ff9420a637ca253a8ea',
  'model/veg/shrub_03/textures/shrub_03_arm_1k.jpg': '3e2b16812a623037138eedace958210c5f3443a827bbe69663045bba5612f815',
  'model/veg/shrub_03/textures/shrub_03_diff_1k.jpg': '3cadc7aba46d3aabbd7d6d2b1d04aa32e2a7da0bc87c2d38ef3cb1ee42cb03ec',
  'model/veg/shrub_03/textures/shrub_03_nor_gl_1k.jpg': 'ff856bacfce859b8a7555dd9a3b92fbd36b2e775d486be71df485afb4235d6c9',
  'ref/crowd_plates/bangabandhu_crowd_2019.jpg': '6557474c28a545cecfcf6e6859f3c368945f94ad4e95dbbfa3d9a56e0d9985a5',
  'ref/crowd_plates/front_row_audience_unsplash.jpg': '7585fefb4bcb4b14af078fb1d4eb71663f3ef740ebf060f09ff3c5d2fce0c392',
  'ref/kenney_racing_kit/kenney_racing-kit.zip': '8a71ea16219315a01d00d5a90c4f6b5c090faddbc56d80ecf727e2b3b853c6c0',
  'tex/asphalt_pit_lane/asphalt_pit_lane_arm_1k.jpg': '3e4315b489f07ff88315017932bdf40d3b9670e3d04c07d4077aa86a16e98d37',
  'tex/asphalt_pit_lane/asphalt_pit_lane_diff_1k.jpg': '8aad5097f6de913aebc33f2b9b9271834b55c6942359955722db3196a9ce9bca',
  'tex/asphalt_pit_lane/asphalt_pit_lane_nor_gl_1k.jpg': 'a215356a1180664fbbf94076f3720a4620a1121e137780ce98059621bf8b444e',
  'tex/concrete046/Concrete046_1K-JPG.zip': '72bf4321acbb39ddbc3b786f5996813b2a3cede12efefb47955e97ea9668985b',
  'tex/corrugatedsteel003/CorrugatedSteel003_1K-JPG.zip': '0bad36b34cf9d0e445c06b125fcbb7ea78074505d85051087fabb37acfa18ca1',
  'tex/facade001/Facade001_1K-JPG.zip': 'e804ad49d692ca60b260394db2ec05d8a274ad319759f536a042471b58d38ea9',
  'tex/fence003/Fence003_1K-JPG.zip': '235f74060d50f379ab0154d7130178fff65ceaf6a6f8e5615260d57ec0f3e1f2',
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
