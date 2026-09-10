/**
 * Circuit structures that are not ground, barriers or stands: the crossover bridge, the
 * underpass parapets, the ground-mounted screens, the Leader Tower re-skin, signs and lamps.
 *
 * Built after the trackside props and BEFORE `boxes.flush()` so single-material boxes merge
 * into the shared `props` meshes; everything stands on `ground.standAt / standY` (never the
 * terrain height functions, R3) and nothing here draws an opaque horizontal ground face (R11).
 * Stub in C0: filled in by phase C3 of the S-phase plan.
 */
import type * as THREE from 'three'
import type { EnvBuildContext } from './environment'

export interface Structures {
  /** distance LOD for the instanced parts (masts, lamps); called from Environment.update */
  update(cameraPos: THREE.Vector3): void
}

export function buildStructures(_ctx: EnvBuildContext, _mats: { buildingRoofMat: THREE.MeshStandardMaterial }): Structures {
  return { update() {} }
}
