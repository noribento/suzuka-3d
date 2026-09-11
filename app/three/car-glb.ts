import * as THREE from 'three'
import { CAR_DIMS, type CarBody } from './car-bodies'
import { modelPrototype } from './model-proto'
import type { AssetRegistry } from './assets'

/**
 * The photo-textured GLB car bodies (R フェーズ Phase 5): four Sketchfab CC-BY vehicles from the
 * pack (`model/vehicles/*`, misc/vehicles/ drops through import-misc.mjs) drawn as the nearest
 * level of the parked cars — vehicles.ts `carParkHero-<cell>` inside `CAR_PARK.lod.hero`, the
 * procedural bodies of car-bodies.ts behind them — and baked into the impostor atlas rows of
 * those bodies by scripts/assets/bake-car-atlas.mjs `--glb`. Pure three plus the two pure
 * modules it needs (car-bodies.ts for the frame and the lengths, model-proto.ts for the
 * extraction), so the bake page loads it transpiled through bake/serve.mjs exactly as the
 * runtime does.
 *
 * Frame: `carGlbGeometry` puts a model into the procedural bodies' frame — standing on y = 0,
 * the footprint centred on the origin, the nose towards +Z, the overall length `CAR_DIMS[kind].l`
 * — so one placement matrix (position, yaw, scale 1) serves the GLB, the procedural body and the
 * impostor card of the same car. `CAR_GLB[kind].forward` names the axis the AUTHORED model's
 * nose points along (measured on the drops: the Hiace's wheel nodes FL / FR sit at +z, the two
 * kei bodies carry their bonnet at +z, the bus's longer rear overhang puts its front at +x).
 *
 * Paint: three of the four bodies are a single photo material, so there is no material name to
 * hang the tint on — the paintwork is decided per TEXEL by its luminance (`carGlbMaterial`):
 * bright texels (the paint) take the instance colour, dark ones (glass, tyres, grilles, lamps)
 * keep the photo. The photos are not white where the car is: the Carry's cab is a shaded
 * white at linear 0.2–0.3, the Hiace a press-photo silver at 0.45, so each model carries its
 * own band (`luma`, measured on the sheet) and a `gain` that lifts its paint texels to white
 * before the tint multiplies them — the same instance colour then means the same paint on
 * every body, and the impostor bake applies the same gain so the cards match. The RGBA `color`
 * attribute of the procedural bodies is kept (A = 1 everywhere) so a model could still mask
 * parts per vertex; today the luma rule alone decides. Coaches are always painted white
 * (vehicles.ts), so the bus livery comes through untinted.
 */

export interface CarGlbSpec {
  /** manifest key of the model */
  key: string
  /** the axis the authored model's nose points along (see the module comment) */
  forward: 'x' | '-x' | 'z' | '-z'
  /** how the paintwork is told from the rest: by texel luminance (the only rule today) */
  paint: 'luma'
  /**
   * luminance band (linear, of the map texel) over which the tint fades in: below `[0]` the
   * texel keeps the photo, above `[1]` it is paint. Default `LUMA_BAND`.
   */
  luma?: readonly [number, number]
  /** multiplier on the paint texels (clamped to 1) that brings the photo's paint to white; default 1 */
  gain?: number
}

/** the default luminance band: white paint (linear ≥ 0.6) is fully tinted, mid greys half, glass and tyres not at all */
export const LUMA_BAND: readonly [number, number] = [0.3, 0.55]

export const CAR_GLB: Partial<Record<CarBody, CarGlbSpec>> = {
  // a decal sheet on a pure white body (linear 1.0), the glass a flat 0.04: the default band
  kei: { key: 'model/vehicles/kei_wagon', forward: 'z', paint: 'luma' },
  // the Carry's cab is photographed in shade — paint p10 0.10 / p50 0.21 / p90 0.30, glass p50
  // 0.06 (reflections to 0.31), the bed tarp 0.48 — so the band sits under the paint and the
  // gain lifts 0.21 to ≈ 0.5 (the tarp clamps to white, which a silver tarp can bear)
  keitruck: { key: 'model/vehicles/kei_truck', forward: 'z', paint: 'luma', luma: [0.1, 0.22], gain: 2.4 },
  // the H100's photo is silver (side panels p10 0.24 / p50 0.45 / p90 0.55, the glass and tyres
  // ≤ 0.01): a lower band, so the tint takes the whole panel and not the windows; ×1.6 → white
  minivan: { key: 'model/vehicles/van_h100', forward: 'z', paint: 'luma', luma: [0.2, 0.4], gain: 1.6 },
  // the livery stays (white 0.44, green 0.55: both count as paint, and the coach tint is white)
  coach: { key: 'model/vehicles/bus_mid', forward: 'x', paint: 'luma' },
}

/** yaw about +Y that turns the authored nose axis onto +z */
function noseTurn(forward: CarGlbSpec['forward']): number {
  switch (forward) {
    case 'z': return 0
    case '-z': return Math.PI
    case 'x': return -Math.PI / 2
    case '-x': return Math.PI / 2
  }
}

/**
 * The model's meshes merged into one non-indexed geometry in the car frame (see the module
 * comment): widened from the pack's quantised attributes, baked through the node transforms,
 * recentred, turned nose-forward and scaled to `CAR_DIMS[kind].l` — model-proto.ts does the
 * extraction, the turn is the spec's `forward`. An RGBA `color` attribute (A = 1) is added so
 * the material's part rule has the same input as the procedural bodies. `map` is the first
 * material's colour map (null for an untextured drop). null when the scene holds no mesh.
 */
export function carGlbGeometry(scene: THREE.Group, kind: CarBody, spec: CarGlbSpec): { geometry: THREE.BufferGeometry; map: THREE.Texture | null } | null {
  // model-proto reads through a registry; a one-key shim over the loaded scene keeps one extraction path
  const reg = { model: (k: string) => (k === spec.key ? { scene, primitives: [] } : null) } as unknown as AssetRegistry
  const proto = modelPrototype(reg, spec.key, { scaleTo: { long: CAR_DIMS[kind].l } })
  if (!proto) return null
  const part = proto.parts.main
  if (!part) return null
  const geometry = part.geometry
  const turn = noseTurn(spec.forward)
  if (turn) geometry.rotateY(turn)
  const n = geometry.getAttribute('position').count
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(1), 4))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return { geometry, map: part.source?.map ?? null }
}

/**
 * The material of a GLB body in one of the three modes of car-bodies.ts's `patchCarVertexColour`:
 *  - 'tint':  the runtime — paint texels (lifted by `gain`) are multiplied by the instance colour (1.0 unless instanced)
 *  - 'plain': the bake's colour pass — the photo as is (paint lifted by `gain`), lit
 *  - 'mask':  the bake's mask pass — R = the paint weight, unlit
 * The paint weight is `w = vColor.a × smoothstep(luma.x, luma.y, luminance(texel))` — the map's
 * texels are linear by the time the fragment reads them (an sRGB map is decoded on upload), so
 * the band is in linear light. `<color_fragment>` is dropped: the vertex colour's alpha is the
 * part mask, not an opacity. Roughness / metalness as `carBodyMaterial`; the bake page lowers
 * them (no environment map there). Program key `carGlb|<mode>` — one program per mode, the
 * band and the gain are one uniform.
 */
export function carGlbMaterial(map: THREE.Texture | null, mode: 'tint' | 'plain' | 'mask', luma: readonly [number, number] = LUMA_BAND, gain = 1): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
  const mat = mode === 'mask'
    ? new THREE.MeshBasicMaterial({ map, vertexColors: true, color: 0xffffff })
    : new THREE.MeshStandardMaterial({ map, vertexColors: true, color: 0xffffff, roughness: 0.42, metalness: 0.22 })
  const weight = `
      #ifdef USE_MAP
      vec4 texel = texture2D( map, vMapUv );
      float w = vColor.a * smoothstep( uLuma.x, uLuma.y, dot( texel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      vec3 paint = min( texel.rgb * uLuma.z, vec3( 1.0 ) );
      #else
      vec4 texel = vec4( 1.0 );
      float w = vColor.a;
      vec3 paint = vec3( 1.0 );
      #endif`
  const apply = mode === 'tint'
    ? 'diffuseColor *= vec4( mix( texel.rgb, paint * vTint, w ), texel.a );'
    : mode === 'plain'
      ? 'diffuseColor *= vec4( mix( texel.rgb, paint, w ), texel.a );'
      : 'diffuseColor = vec4( w, 0.0, 0.0, 1.0 );'
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLuma = { value: new THREE.Vector3(luma[0], luma[1], gain) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      // the part mask rides in vColor.a; the tint is the instance colour, never folded into vColor
      .replace('#include <color_vertex>', `
        vColor = vec4( 1.0, 1.0, 1.0, color.a );
        #ifdef USE_INSTANCING_COLOR
        vTint = instanceColor.rgb;
        #else
        vTint = vec3( 1.0 );
        #endif`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nuniform vec3 uLuma;')
      .replace('#include <map_fragment>', `${weight}\n      ${apply}`)
      .replace('#include <color_fragment>', '')
  }
  mat.customProgramCacheKey = () => `carGlb|${mode}`
  return mat
}
