import * as THREE from 'three'
import { SEASON, SEASON_GRASS } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry, ManifestAsset } from './assets'
import type { Quality } from './quality'
import { GREENUP_TILE_M, grassMaps, greenUpMask, macroMap } from './textures'

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
  const e = reg?.entry(key) as (ManifestAsset & { tile?: unknown }) | null | undefined
  return typeof e?.tile === 'number' && e.tile > 0 ? e.tile : fallback
}

export interface GrassSurfaceOpts {
  /** metres one unit of the geometry's (u, v) covers */
  uvMetres: readonly [number, number]
  /** period of the macro brightness variation along (u, v), metres */
  macroPeriodM: readonly [number, number]
  /** how far a fully green patch pulls the albedo towards the season's olive (0–1) */
  greenUp?: number
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
  mat.onBeforeCompile = (shader) => {
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
  }
  mat.customProgramCacheKey = () => 'macro|grass'
}

/**
 * Grass material for a ground surface whose uv unit spans `uvMetres`: `withered_grass` (2 m
 * photo tile, diff / nor_gl / arm) when the pack has it, the procedural SEASON tile otherwise —
 * both through addGrassSurface, so the two tiers differ in texture, not in look. The registry's
 * textures are shared with other consumers, so the repeat that maps THIS geometry's uv onto the
 * tile goes on clones (same GPU upload, own sampler state).
 */
export function grassSurfaceMaterial(reg: AssetRegistry | null, uvMetres: readonly [number, number], macroPeriodM: readonly [number, number], normalScale = 0.8): THREE.MeshStandardMaterial {
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
  addGrassSurface(m, { uvMetres, macroPeriodM })
  return m
}
