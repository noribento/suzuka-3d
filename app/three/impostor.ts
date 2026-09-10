import * as THREE from 'three'
import type { ImpostorLayout } from '~/data/impostor-atlas'

/**
 * Baked-atlas impostors: one instanced quad per subject that billboards towards the camera
 * (yaw only) and picks its atlas cell from the camera's bearing relative to the instance's own
 * facing (and, with two pitch bands, from the camera's elevation). The spectators, the far
 * trees and the parked cars share the shader; the layout (`~/data/impostor-atlas.ts`) and the
 * options say what differs.
 *
 * Instanced attributes the caller fills per instance (`impostorAttributes`):
 *  - aInfo  (rest row, cheer row or −1, facing yaw, phase)
 *  - aTint0 (rgb, a): 'crowd' = shirt rgb + skin multiplier; 'body' = body / foliage rgb
 *  - aTint1 (rgb):    'crowd' = pants rgb; 'body' = unused
 */
export interface ImpostorOptions {
  /** 1 = one camera pitch in the atlas, 2 = two bands split at the midpoint of `layout.elevations` */
  pitchBands: 1 | 2
  /** flip a paired row into its cheer row now and then (aInfo.y ≥ 0) */
  cheer: boolean
  /** lateral sway amplitude at the top of the quad (m), 0 = rigid */
  sway: number
  /**
   * 'crowd' tints through the mask's three channels (R shirt, G pants, B skin);
   * 'body' tints only where the mask's R channel is set, from aTint0 rgb (no mask: everywhere)
   */
  maskMode: 'crowd' | 'body'
  cutout: { alphaTest: number; alphaToCoverage: boolean }
  /** `customProgramCacheKey`: one per (layout, options) combination that changes the shader */
  cacheKey: string
  /** shared uniforms: the animation clock (s) and the camera position, world space */
  time: { value: number }
  camPos: { value: THREE.Vector3 }
  /** default 0.9 */
  roughness?: number
}

/** the instanced attributes `impostorMaterial` reads (name, item size) */
export const IMPOSTOR_ATTRIBUTES: readonly { name: string; size: number }[] = [
  { name: 'aInfo', size: 4 },
  { name: 'aTint0', size: 4 },
  { name: 'aTint1', size: 3 },
]

/** a GLSL float literal ("8.0", "0.02") */
const lit = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x))

/**
 * The quad of one impostor: `layout.quadW` of a cell wide, one cell tall, its base `padM`
 * below the instance origin so the subject's feet / tyres / trunk sit on the instance position.
 */
export function impostorGeometry(layout: ImpostorLayout): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(layout.cellM * layout.quadW, layout.cellM)
  geo.translate(0, layout.cellM / 2 - layout.padM, 0)
  return geo
}

/**
 * The impostor material for `atlas` laid out as `layout`. The shader billboards the quad
 * towards the camera, picks the yaw column from the camera's bearing relative to the instance's
 * facing (aInfo.z) and the pitch band from its elevation, optionally flips paired rows into
 * their cheer pose, and tints through the mask texture.
 */
export function impostorMaterial(atlas: { map: THREE.Texture; mask?: THREE.Texture }, layout: ImpostorLayout, opts: ImpostorOptions): THREE.MeshStandardMaterial {
  if (opts.pitchBands === 2 && layout.elevations.length < 2) throw new Error(`impostor ${opts.cacheKey}: two pitch bands need two elevations in the layout`)
  if (layout.bandAxis === 'cols' && layout.cols < layout.yaws * layout.elevations.length) throw new Error(`impostor ${opts.cacheKey}: ${layout.cols} columns cannot hold ${layout.elevations.length} bands of ${layout.yaws} yaws`)
  const { map, mask } = atlas
  const crowd = opts.maskMode === 'crowd'
  if (crowd && !mask) throw new Error(`impostor ${opts.cacheKey}: the 'crowd' mask mode needs a mask texture`)
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: opts.cutout.alphaTest, alphaToCoverage: opts.cutout.alphaToCoverage, roughness: opts.roughness ?? 0.9, side: THREE.FrontSide })
  mat.customProgramCacheKey = () => opts.cacheKey
  // two bands: the atlas holds a low and a high camera, split halfway between their pitches
  const e0 = layout.elevations[0]!
  const e1 = layout.elevations[1] ?? e0
  const split = (e0 + e1) / 2
  const bandSelect = opts.pitchBands === 2
    ? `
        // pitch band: ${e0}° cameras below ${split}° elevation, ${e1}° cameras above
        if (atan(toCam.y, dHor) > ${(split * Math.PI / 180).toFixed(2)}) ${layout.bandAxis === 'cols' ? `col += ${lit(layout.yaws)};` : 'row += 1.0;'}`
    : ''
  // 'rows' bands need the row before the band test; 'cols' keep the crowd's order (col first)
  const rowDecl = `
        float row = aInfo.x;`
  const cheer = opts.cheer
    ? `
        // a paired figure cheers for ≈ 1.7 s every ≈ 14 s, each on its own phase
        float cyc = fract(uTime * 0.07 + aInfo.w * 3.0);
        if (aInfo.y >= 0.0 && cyc < 0.12) row = aInfo.y;`
    : ''
  const sway = opts.sway > 0
    ? `
        // gentle sway, then face the camera (yaw only: the pitch is in the atlas)
        transformed.x += sin(uTime * 1.6 + aInfo.w * 40.0) * ${lit(opts.sway)} * uv.y;`
    : `
        // face the camera (yaw only: the pitch is in the atlas)`
  const inset = ((1 - layout.quadW) / 2).toFixed(2)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = opts.time
    shader.uniforms.uCamPos = opts.camPos
    if (mask) shader.uniforms.uMask = { value: mask }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        // (rest row, cheer row or -1, ${crowd ? 'seat' : 'instance'} facing yaw, phase)
        attribute vec4 aInfo;
        ${crowd ? `// (shirt rgb, skin multiplier), pants rgb
        attribute vec4 aTint0;
        attribute vec3 aTint1;` : `// body rgb
        attribute vec4 aTint0;`}
        uniform float uTime;
        uniform vec3 uCamPos;
        ${crowd ? `varying vec3 vShirt;
        varying vec3 vPants;
        varying float vSkin;` : 'varying vec3 vTint;'}
        float bbYaw;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        ${crowd ? `vShirt = aTint0.rgb;
        vSkin = aTint0.a;
        vPants = aTint1;` : 'vTint = aTint0.rgb;'}
        vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = uCamPos - iPos;
        float dHor = max(length(toCam.xz), 1e-3);
        bbYaw = atan(toCam.x, toCam.z);
        // the bake put the camera at (sin yaw, cos yaw) in the ${crowd ? 'figure' : 'subject'}'s frame (yaw 0 = facing it)
        float rel = bbYaw - aInfo.z;
        float col = mod(floor(rel / (PI2 / ${lit(layout.yaws)}) + 0.5), ${lit(layout.yaws)});${layout.bandAxis === 'cols' ? bandSelect + rowDecl : rowDecl + bandSelect}${cheer}
        vMapUv = vec2((col + ${inset} + ${layout.quadW.toFixed(2)} * uv.x) / ${lit(layout.cols)}, (row + (1.0 - uv.y)) / ${lit(layout.rows)});`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // lit as a rounded shape facing the camera, a little upwards, not as a flat card
        objectNormal = normalize(vec3(0.0, 0.55, 1.0));
        { float cy = cos(bbYaw), sy = sin(bbYaw); objectNormal.xz = vec2(objectNormal.x * cy + objectNormal.z * sy, -objectNormal.x * sy + objectNormal.z * cy); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${sway}
        { float cy = cos(bbYaw), sy = sin(bbYaw); transformed.xz = vec2(transformed.x * cy + transformed.z * sy, -transformed.x * sy + transformed.z * cy); }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${mask ? `uniform sampler2D uMask;
        ` : ''}${crowd ? `varying vec3 vShirt;
        varying vec3 vPants;
        varying float vSkin;` : 'varying vec3 vTint;'}`)
      .replace('#include <map_fragment>', crowd
        ? `
        vec4 texel = texture2D(map, vMapUv);
        vec3 mk = texture2D(uMask, vMapUv).rgb;
        vec3 tint = mix(vec3(1.0), vShirt, mk.r);
        tint = mix(tint, vPants, mk.g);
        tint = mix(tint, vec3(vSkin), mk.b);
        diffuseColor *= vec4(texel.rgb * tint, texel.a);`
        : `
        vec4 texel = texture2D(map, vMapUv);
        ${mask ? 'vec3 tint = mix(vec3(1.0), vTint, texture2D(uMask, vMapUv).r);' : 'vec3 tint = vTint;'}
        diffuseColor *= vec4(texel.rgb * tint, texel.a);`)
  }
  return mat
}
