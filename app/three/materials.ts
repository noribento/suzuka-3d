import * as THREE from 'three'
import { SEASON, SEASON_GRASS } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry, ManifestAsset } from './assets'
import { COVER_COLOURS, COVER_DETAIL_M, coverDetailTile, type CoverLayer } from './landcover'
import type { Quality } from './quality'
import { ASPHALT_DETAIL_M, ASPHALT_TILE_M, ASPHALT_WIDTH_M, GREENUP_TILE_M, asphaltDetailMaps, grassMaps, greenUpMask, macroMap, type MaterialMaps } from './textures'

/**
 * Photo-PBR material factories on top of the asset registry.
 *
 * Every builder keeps its procedural material as the fallback: `pbrFromAssets` only replaces it
 * when the whole diff / nor_gl / arm triple arrived, so a half-loaded pack never mixes a photo
 * albedo with a procedural normal map (the tiling periods would not match).
 */

export interface PbrFromAssetsOpts {
  /** the procedural material to use when the pack is off or any of the three maps is missing */
  fallback: () => THREE.MeshStandardMaterial
  /** ground surface: the maps get the ground anisotropy budget (see `AssetRegistry.texture`) */
  ground?: boolean
  /** normal map strength (both axes), default 1 */
  normalScale?: number
  /**
   * The geometry's UVs were hand-built for this project's canvas textures (flipY = true, v = 0 at
   * the bottom of the image) rather than authored for glTF. See the normalScale note below.
   */
  handBuiltUv?: boolean
  /**
   * Skip the photo albedo: normal + ARM maps over the flat `extra.color`. For surfaces whose real
   * colour the photo does not have (the pit building's white panels on white_plaster_02, whose
   * albedo is a warm mid grey): a colour multiplier can only darken a map, never whiten it.
   */
  noMap?: boolean
  /** anything else for the material (repeat / side / envMapIntensity …); applied last */
  extra?: THREE.MeshStandardMaterialParameters
}

/**
 * MeshStandardMaterial from `tex/<asset>/diff`, `tex/<asset>/nor_gl`, `tex/<asset>/arm`.
 *
 * The ARM tile is one texture bound to three slots (R = ambient occlusion, G = roughness,
 * B = metalness — the channels three's aoMap / roughnessMap / metalnessMap read); `aoMap.channel`
 * stays 0 so the geometry needs no `uv2`. `roughness` / `metalness` are set to 1 because they
 * multiply the maps (the default metalness 0 would zero the metalness map out).
 *
 * WHY `normalScale.y` is negated for hand-built UVs: every external texture is loaded with
 * `flipY = false` (a KTX2 upload cannot be flipped, and one convention keeps WebP and KTX2
 * interchangeable). On UVs that were authored for flipped canvas textures this mirrors the image
 * in V — harmless for albedo and ARM, but a mirrored V axis reverses the tangent-space bitangent,
 * which is exactly the direction the green channel of an OpenGL-convention normal map encodes.
 * Flipping the green channel back (`normalScale.set(k, -k)`) restores correct shading without
 * touching the geometry. glTF-authored UVs already assume `flipY = false`, so they keep `(k, k)`.
 */
export function pbrFromAssets(reg: AssetRegistry, asset: string, opts: PbrFromAssetsOpts): THREE.MeshStandardMaterial {
  const t = { ground: opts.ground }
  const map = opts.noMap ? null : reg.texture(`tex/${asset}/diff`, t)
  const normalMap = reg.texture(`tex/${asset}/nor_gl`, t)
  const arm = reg.texture(`tex/${asset}/arm`, t)
  if ((!map && !opts.noMap) || !normalMap || !arm) return opts.fallback()
  const m = new THREE.MeshStandardMaterial({
    ...(map ? { map } : {}),
    normalMap,
    aoMap: arm,
    roughnessMap: arm,
    metalnessMap: arm,
    roughness: 1,
    metalness: 1,
    ...opts.extra,
  })
  const k = opts.normalScale ?? 1
  m.normalScale.set(k, opts.handBuiltUv ? -k : k)
  return m
}

/**
 * Alpha-cutout parameters for foliage / fences / crowd cards. With MSAA on the scene target,
 * alpha-to-coverage dithers the edge across the samples so a lower threshold does not bleed a
 * halo; without MSAA a plain, higher alphaTest is the only clean cut.
 */
export function cutoutParams(q: Quality): { alphaTest: number; alphaToCoverage: boolean } {
  return { alphaTest: q.msaa > 0 ? 0.3 : 0.5, alphaToCoverage: q.msaa > 0 }
}

/**
 * Set a tile's repeat so one texture tile covers `metresPerTile` metres of surface on a geometry
 * whose UV [0, 1] spans `uvMetres` metres (u, v). The repeat lives on the texture, so a tile that
 * is shared between surfaces of different size must be cloned first (`tex.clone()` shares the
 * upload; only the sampler state is duplicated). Returns the texture for chaining.
 */
export function repeatMetres<T extends THREE.Texture>(tex: T, metresPerTile: number, uvMetres: readonly [number, number]): T {
  tex.repeat.set(uvMetres[0] / metresPerTile, uvMetres[1] / metresPerTile)
  return tex
}

/** Physical size (m) of one tile of a manifest texture (its `tile` field), or `fallback` when unknown. */
export function tileMetres(reg: AssetRegistry | null, key: string, fallback: number): number {
  const e: ManifestAsset | null | undefined = reg?.entry(key)
  return typeof e?.tile === 'number' && e.tile > 0 ? e.tile : fallback
}

/** Width / height of a manifest texture's source image (its `aspect` field; 1 for square tiles), or `fallback` when unknown. */
export function assetAspect(reg: AssetRegistry | null, key: string, fallback: number): number {
  const e: ManifestAsset | null | undefined = reg?.entry(key)
  if (!e) return fallback
  return typeof e.aspect === 'number' && e.aspect > 0 ? e.aspect : 1
}

export interface CutoutFromAssetsOpts {
  /** the procedural material (already in metre UVs) when the pack is off or any map is missing */
  fallback: () => THREE.MeshStandardMaterial
  /** the tier: alpha test vs alpha-to-coverage (cutoutParams) */
  quality: Quality
  /** metres per tile when the manifest entry carries no `tile` (fence003 does not: 2.0 by the photo's mesh pitch) */
  tile: number
  /** see PbrFromAssetsOpts.handBuiltUv */
  handBuiltUv?: boolean
  normalScale?: number
  extra?: THREE.MeshStandardMaterialParameters
}

/**
 * Alpha-cutout material from `tex/<asset>/diff`, `nor_gl` and `opacity` (wire mesh, foliage
 * cards): all-or-nothing like pbrFromAssets, the opacity tile on `alphaMap`, DoubleSide, and the
 * tier's cutoutParams. The geometry's UVs are expected in METRES: the three maps are cloned and
 * given `1 / tile` repeat, so one texture tile covers `tile` metres (the manifest's `tile`, else
 * `opts.tile`). `normalScale.y` is negated for hand-built UVs (see pbrFromAssets).
 */
export function cutoutFromAssets(reg: AssetRegistry | null, asset: string, opts: CutoutFromAssetsOpts): THREE.MeshStandardMaterial {
  const map = reg?.texture(`tex/${asset}/diff`) ?? null
  const normalMap = reg?.texture(`tex/${asset}/nor_gl`) ?? null
  const alphaMap = reg?.texture(`tex/${asset}/opacity`) ?? null
  if (!reg || !map || !normalMap || !alphaMap) return opts.fallback()
  const tile = tileMetres(reg, `tex/${asset}/diff`, opts.tile)
  const uv: readonly [number, number] = [1, 1]
  const m = new THREE.MeshStandardMaterial({
    map: repeatMetres(map.clone(), tile, uv),
    normalMap: repeatMetres(normalMap.clone(), tile, uv),
    alphaMap: repeatMetres(alphaMap.clone(), tile, uv),
    side: THREE.DoubleSide,
    roughness: 0.6,
    metalness: 0.5,
    ...cutoutParams(opts.quality),
    ...opts.extra,
  })
  const k = opts.normalScale ?? 1
  m.normalScale.set(k, opts.handBuiltUv ? -k : k)
  return m
}

export interface GrassSurfaceOpts {
  /** metres one unit of the geometry's (u, v) covers */
  uvMetres: readonly [number, number]
  /** period of the macro brightness variation along (u, v), metres */
  macroPeriodM: readonly [number, number]
  /** how far a fully green patch pulls the albedo towards the season's olive (0–1) */
  greenUp?: number
  /**
   * The land-cover masks (landcover.ts): forest / paddies / roads / car parks / water / solar /
   * settlements splatted over the grass from world xz. null / undefined = plain grass.
   */
  cover?: CoverLayer | null
}

/**
 * The grass surface: sibling of addRoadSurface (track-mesh.ts) for the terrain and the run-off.
 *
 *  (i)  macro variation — the same low-frequency brightness / roughness modulation addMacro
 *       applies, so the 2 m photo tile (or the 8 m procedural one) stops reading as a repeat;
 *  (ii) green-up — greenUpMask() (30–60 m blobs) pulls the dormant straw towards the season's
 *       olive `patch` colour AT THE TEXEL'S OWN LUMINANCE, so the blade / clump shading of the
 *       tile survives inside a patch instead of flattening to one green;
 *  (iii) no mown stripes: the reference photos show none anywhere trackside.
 *
 * Both layers are sampled through `vMapUv`, which three has already multiplied by `map.repeat`
 * (the photo tile sets one to reach its physical 2 m). The metre periods are therefore divided
 * by the repeat here rather than baked into the geometry's uv. Own program cache key: a shared
 * 'macro' key would let the terrain be handed the road's program.
 */
export function addGrassSurface(mat: THREE.MeshStandardMaterial, opts: GrassSurfaceOpts) {
  const pal = SEASON_GRASS[SEASON]
  // sRGB hex → linear working colour, which is the space diffuseColor is in after map decoding
  const olive = new THREE.Color(pal.patch)
  const greenUp = opts.greenUp ?? (SEASON === 'spring' ? 0.5 : 0.3)
  const cover = opts.cover ?? null
  mat.onBeforeCompile = (shader, renderer) => {
    const rep = mat.map?.repeat ?? new THREE.Vector2(1, 1)
    shader.uniforms.uMacro = { value: macroMap() }
    shader.uniforms.uMacroScale = { value: new THREE.Vector2(opts.uvMetres[0] / (rep.x * opts.macroPeriodM[0]), opts.uvMetres[1] / (rep.y * opts.macroPeriodM[1])) }
    shader.uniforms.uGreenMask = { value: greenUpMask() }
    shader.uniforms.uGreenScale = { value: new THREE.Vector2(opts.uvMetres[0] / (rep.x * GREENUP_TILE_M), opts.uvMetres[1] / (rep.y * GREENUP_TILE_M)) }
    shader.uniforms.uGreenColour = { value: olive }
    shader.uniforms.uGreenUp = { value: greenUp }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacro;
        uniform vec2 uMacroScale;
        uniform sampler2D uGreenMask;
        uniform vec2 uGreenScale;
        uniform vec3 uGreenColour;
        uniform float uGreenUp;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macro = texture2D(uMacro, vMapUv * uMacroScale).r * 1.25;
        diffuseColor.rgb *= macro;
        float greenUp = texture2D(uGreenMask, vMapUv * uGreenScale).r * uGreenUp;
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        vec3 olive = uGreenColour * (dot(diffuseColor.rgb, LUMA) / max(dot(uGreenColour, LUMA), 1e-3));
        diffuseColor.rgb = mix(diffuseColor.rgb, olive, greenUp);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));`)
    if (cover) {
      addCoverSplat(shader, cover)
      // macro + green-up + the 2 masks + the tile, on top of the material's own maps, the envMap and the cascades
      checkSamplerBudget(shader, renderer, 4 + (cover.detail ? 1 : 0), 'grass+cover')
    }
  }
  mat.customProgramCacheKey = () => (cover ? `macro|grass|cover${cover.detail ? '|detail' : ''}` : 'macro|grass')
}

/** the class colours as linear working colours, in the shader's index order (built once) */
let coverPalette: THREE.Color[] | null = null
function coverColours(): THREE.Color[] {
  coverPalette ??= (['forest', 'farmland', 'paved', 'parking', 'water', 'solar', 'settle', 'edge', 'bund'] as const).map((k) => new THREE.Color(COVER_COLOURS[k]))
  return coverPalette
}

/**
 * The land-cover splat on top of a grass program (plan §1e). Runs after addGrassSurface's own
 * patch, so `macro` and the green-up line it anchors on are in place.
 *
 * Vertex: the world xz of the fragment (`vCoverPos`), computed from `transformed` after
 * begin_vertex (instanceMatrix applied when instanced, then modelMatrix), so the masks are
 * sampled in the same frame on the terrain chunks, the ring and the partition's grass faces —
 * a class edge crosses the partition boundary without a seam.
 *
 * Fragment: the material's one mask pair (CoverLayer — the inner rectangle's on the terrain and
 * the ground faces, the ring's on the ring; the ring's masks cover the inner area too, so a
 * fragment is never outside its own pair; ClampToEdge catches the last half texel). The classes
 * are then mixed in precedence order (forest < farmland < settle < solar < parking <
 * water < paved < the edge line), each class either a flat colour under the macro variation or,
 * with COVER_DETAIL, the detail tile's channel at its own world period. The paddy bunds share
 * the edge channel at half value with the road lines: a smoothstep window tells the two apart.
 * Where the splat is a hard surface (paved, parking, water, glass) the grass tile's normal is
 * faded to the geometry normal and the roughness set for that surface.
 */
function addCoverSplat(shader: THREE.WebGLProgramParametersWithUniforms, cover: CoverLayer) {
  shader.uniforms.uCoverA = { value: cover.masks.a }
  shader.uniforms.uCoverB = { value: cover.masks.b }
  shader.uniforms.uCoverOrg = { value: cover.masks.origin }
  shader.uniforms.uCoverInv = { value: cover.masks.invSize }
  shader.uniforms.uCoverCol = { value: coverColours() }
  if (cover.detail) {
    shader.uniforms.uCoverTile = { value: coverDetailTile() }
    shader.uniforms.uCoverPeriod = { value: new THREE.Vector4(1 / COVER_DETAIL_M.forest, 1 / COVER_DETAIL_M.farmland, 1 / COVER_DETAIL_M.paved, 1 / COVER_DETAIL_M.solar) }
  }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      varying vec2 vCoverPos;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 coverP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          coverP = instanceMatrix * coverP;
        #endif
        vCoverPos = (modelMatrix * coverP).xz;
      }`)
  shader.fragmentShader = shader.fragmentShader
    // the define goes into the source itself (not `defines`) so the program string alone decides
    .replace('#include <common>', `#include <common>
      ${cover.detail ? '#define COVER_DETAIL' : ''}
      varying vec2 vCoverPos;
      uniform sampler2D uCoverA;
      uniform sampler2D uCoverB;
      uniform vec2 uCoverOrg;
      uniform vec2 uCoverInv;
      uniform vec3 uCoverCol[9];
      #ifdef COVER_DETAIL
        uniform sampler2D uCoverTile;
        uniform vec4 uCoverPeriod;
      #endif`)
    .replace('diffuseColor.rgb = mix(diffuseColor.rgb, olive, greenUp);', `diffuseColor.rgb = mix(diffuseColor.rgb, olive, greenUp);
        // --- land cover (landcover.ts): a = forest, farmland, paved, parking; b = water, solar, settle, edge
        vec2 cuv = (vCoverPos - uCoverOrg) * uCoverInv;
        vec4 ca = texture2D(uCoverA, cuv);
        vec4 cb = texture2D(uCoverB, cuv);
        vec3 cForest = uCoverCol[0], cFarm = uCoverCol[1], cPaved = uCoverCol[2], cPark = uCoverCol[3];
        vec3 cWater = uCoverCol[4], cSolar = uCoverCol[5], cSettle = uCoverCol[6], cLine = uCoverCol[7], cBund = uCoverCol[8];
        float cPanel = 1.0;
        #ifdef COVER_DETAIL
          float dForest = texture2D(uCoverTile, vCoverPos * uCoverPeriod.x).r;
          float dFarm = texture2D(uCoverTile, vCoverPos * uCoverPeriod.y).g;
          float dGrain = texture2D(uCoverTile, vCoverPos * uCoverPeriod.z).b;
          float dSolar = texture2D(uCoverTile, vCoverPos * uCoverPeriod.w).a;
          cForest *= 0.55 + 0.9 * dForest;
          cFarm *= 0.7 + 0.6 * dFarm;
          cPaved *= 0.8 + 0.4 * dGrain;
          cPark *= 0.8 + 0.4 * dGrain;
          cPanel = smoothstep(0.2, 0.5, dSolar);
          float cFrame = smoothstep(0.75, 0.95, dSolar);
          // the gap between the rows is gravel; the frame is an aluminium glint on the glass
          cSolar = mix(cPark * 1.15, mix(cSolar, vec3(0.45), cFrame * 0.6), cPanel);
        #endif
        // the edge channel: road lines at 1, paddy bunds at 1/2
        float cLineW = smoothstep(0.6, 0.9, cb.a);
        float cBundW = smoothstep(0.2, 0.55, cb.a) * (1.0 - cLineW);
        cFarm = mix(cFarm, cBund, cBundW);
        vec3 coverRgb = diffuseColor.rgb;
        coverRgb = mix(coverRgb, cForest * macro, ca.r);
        coverRgb = mix(coverRgb, cFarm * macro, ca.g);
        coverRgb = mix(coverRgb, cSettle * macro, cb.b);
        coverRgb = mix(coverRgb, cSolar, cb.g);
        coverRgb = mix(coverRgb, cPark * macro, ca.a);
        coverRgb = mix(coverRgb, cWater, cb.r);
        coverRgb = mix(coverRgb, cPaved * macro, ca.b);
        coverRgb = mix(coverRgb, cLine, cLineW * 0.35 * ca.b);
        diffuseColor.rgb = coverRgb;
        // the hard surfaces of the splat: flatten the grass normal, hold the roughness
        float coverFlat = clamp(ca.b + ca.a + cb.r + cb.g * cPanel, 0.0, 1.0);`)
    .replace('roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));', `roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));
        roughnessFactor = mix(roughnessFactor, 0.85, clamp(ca.b + ca.a, 0.0, 1.0));
        roughnessFactor = mix(roughnessFactor, 0.35, cb.g * cPanel);
        roughnessFactor = mix(roughnessFactor, 0.6, cb.r);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(mix(normal, nonPerturbedNormal, coverFlat));`)
}

/**
 * Dev-only sampler budget check: a fragment program that binds more textures than the GPU has
 * units fails to link, and the e2e suite (SwiftShader, low tier) never sees the high tier's
 * program. Counts the material's own maps, the environment map, the shadow maps of every light
 * and `own` extra samplers against `renderer.capabilities.maxTextures`; a warning, never an
 * error (the build must not fail on a machine the check merely cannot read).
 */
export function checkSamplerBudget(shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer | undefined, own: number, what: string) {
  if (!import.meta.dev) return
  const p = shader as unknown as Record<string, unknown>
  const flags = ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'envMap', 'lightMap', 'emissiveMap', 'bumpMap', 'alphaMap', 'displacementMap', 'specularMap']
  let n = own
  for (const f of flags) if (p[f]) n++
  for (const f of ['numDirLightShadows', 'numSpotLightShadows', 'numPointLightShadows', 'numSpotLightMaps']) n += Number(p[f] ?? 0)
  const max = renderer?.capabilities?.maxTextures
  if (typeof max === 'number' && n > max) console.warn(`[materials] ${what}: ${n} samplers exceed the GPU's ${max} texture units — the program will not link`)
}

/**
 * Grass material for a ground surface whose uv unit spans `uvMetres`: `withered_grass` (2 m
 * photo tile, diff / nor_gl / arm) when the pack has it, the procedural SEASON tile otherwise —
 * both through addGrassSurface, so the two tiers differ in texture, not in look. The registry's
 * textures are shared with other consumers, so the repeat that maps THIS geometry's uv onto the
 * tile goes on clones (same GPU upload, own sampler state).
 */
export function grassSurfaceMaterial(reg: AssetRegistry | null, uvMetres: readonly [number, number], macroPeriodM: readonly [number, number], normalScale = 0.8, cover: CoverLayer | null = null): THREE.MeshStandardMaterial {
  const fallback = () => {
    const g = grassMaps(false)
    const m = new THREE.MeshStandardMaterial({ map: g.map, normalMap: g.normalMap, roughness: 1, metalness: 0 })
    m.normalScale.set(normalScale, normalScale)
    return m
  }
  const m = reg ? pbrFromAssets(reg, 'withered_grass', { fallback, ground: true, handBuiltUv: true, normalScale }) : fallback()
  if (reg && m.aoMap && m.map && m.normalMap) {
    const tile = tileMetres(reg, 'tex/withered_grass/diff', 2)
    m.map = repeatMetres(m.map.clone(), tile, uvMetres)
    m.normalMap = repeatMetres(m.normalMap.clone(), tile, uvMetres)
    const arm = repeatMetres(m.aoMap.clone(), tile, uvMetres)
    m.aoMap = m.roughnessMap = m.metalnessMap = arm
    // the photo tile is a pinkish beige (H ≈ 32°); the late-March sward measures H 37–41°, so a
    // linear multiplier pulls it towards khaki (≈ ×0.90 / 0.91 / 0.83 in sRGB terms)
    m.color.setRGB(0.79, 0.81, 0.66)
  }
  addGrassSurface(m, { uvMetres, macroPeriodM, cover })
  return m
}

/**
 * Macro variation: a second, very low-frequency texture modulates albedo (×0.85–1.15 → the
 * map stores 0.68–0.92, rescaled here) and roughness so a tiling surface stops repeating.
 * `scale` maps the material's uv into the macro texture (one macro period per 1/scale uv
 * units). Installed as an onBeforeCompile patch; setupMaterials chains it under CSM.
 */
export function addMacro(mat: THREE.MeshStandardMaterial, scale: THREE.Vector2, stripes = 0) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: macroMap() }
    shader.uniforms.uMacroScale = { value: scale }
    shader.uniforms.uStripes = { value: stripes }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacro;
        uniform vec2 uMacroScale;
        uniform float uStripes;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macro = texture2D(uMacro, vMapUv * uMacroScale).r * 1.25;
        diffuseColor.rgb *= macro;
        // mown bands: four per texture tile along v, alternately darker / lighter
        diffuseColor.rgb *= mix(1.0, mod(floor(vMapUv.y * 4.0), 2.0) < 0.5 ? 0.86 : 1.06, uStripes);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));`)
  }
  mat.customProgramCacheKey = () => 'macro'
}

/**
 * The asphalt surface: macro variation (as addMacro) plus the isotropic detail tile that carries
 * the aggregate the base map no longer can (see asphaltDetailMaps).
 *
 * The detail layer is sampled in METRIC uv — `vMapUv` scaled by the road's real size over the
 * detail tile's — so the grain keeps its physical size regardless of the base tile's anisotropic
 * texel budget. Its albedo term has mean 1.0 and its normal mean flat, so both simply cease to
 * exist under minification; there is deliberately no distance fade to maintain.
 *
 * This needs its OWN program cache key: addMacro hands out 'macro' to the pit lane, the paddock
 * and the terrain, and a shared key would let the grass be handed the road's program.
 */
export function addRoadSurface(mat: THREE.MeshStandardMaterial, macroScale: THREE.Vector2, uWidthM = ASPHALT_WIDTH_M) {
  const detail = asphaltDetailMaps()
  const detailScale = new THREE.Vector2(uWidthM / ASPHALT_DETAIL_M, ASPHALT_TILE_M / ASPHALT_DETAIL_M)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: macroMap() }
    shader.uniforms.uMacroScale = { value: macroScale }
    shader.uniforms.uDetail = { value: detail.map }
    shader.uniforms.uDetailNormal = { value: detail.normalMap! }
    shader.uniforms.uDetailScale = { value: detailScale }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacro;
        uniform vec2 uMacroScale;
        uniform sampler2D uDetail;
        uniform sampler2D uDetailNormal;
        uniform vec2 uDetailScale;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // ±7 %: the old ±15 % read as blotches at overview scale (2026-09 audit)
        float macro = 1.0 + (texture2D(uMacro, vMapUv * uMacroScale).r * 1.25 - 1.0) * 0.45;
        // mean-1.0 multiplier: its mips converge to 1.0, so the grain fades out on its own
        diffuseColor.rgb *= macro * (texture2D(uDetail, vMapUv * uDetailScale).r * 2.0);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));`)
      // Perturb AFTER the chunk rather than inside it: onBeforeCompile sees `#include` directives
      // (resolveIncludes runs later), and appending keeps this independent of the chunk's internals.
      // `mapN` and `tbn` are both declared in main()'s scope by normal_fragment_begin /
      // normal_fragment_maps, under exactly this define.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef USE_NORMALMAP_TANGENTSPACE
          mapN.xy += texture2D(uDetailNormal, vMapUv * uDetailScale).xy * 2.0 - 1.0;
          normal = normalize(tbn * mapN);
        #endif`)
    if (!shader.fragmentShader.includes('uDetailNormal, vMapUv')) {
      // a three upgrade that renamed the chunk would silently drop the aggregate; the e2e suite
      // fails on console.error, so this cannot ship unnoticed
      console.error('normal_fragment_maps not found: the asphalt detail normal was not applied')
    }
  }
  mat.customProgramCacheKey = () => 'macro|road'
}

/** MeshStandardMaterial from a procedural map set (map / normalMap / roughnessMap). */
export function pbr(maps: MaterialMaps, extra: THREE.MeshStandardMaterialParameters = {}, normalScale = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: maps.map, roughness: 1, metalness: 0, ...extra })
  if (maps.normalMap) {
    m.normalMap = maps.normalMap
    m.normalScale.set(normalScale, normalScale)
  }
  if (maps.roughnessMap) m.roughnessMap = maps.roughnessMap
  return m
}
