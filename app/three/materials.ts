import * as THREE from 'three'
import type { AssetRegistry } from './assets'
import type { Quality } from './quality'

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
  const map = reg.texture(`tex/${asset}/diff`, t)
  const normalMap = reg.texture(`tex/${asset}/nor_gl`, t)
  const arm = reg.texture(`tex/${asset}/arm`, t)
  if (!map || !normalMap || !arm) return opts.fallback()
  const m = new THREE.MeshStandardMaterial({
    map,
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
