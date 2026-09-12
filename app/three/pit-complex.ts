import type * as THREE from 'three'
import type { EnvBuildContext } from './environment'
import { buildPitBuilding } from './pit-building'

/**
 * The pit complex's entry (plan I1-a): `buildEnvironment` calls it right after the crowd and
 * laps it as 'pit'; it builds the pit building (pit-building.ts) and returns the shared roof
 * material the marshal huts (props.ts) and the paddock reuse. The pit lane (pit-lane.ts) and the
 * paddock (paddock.ts) follow through the infield umbrella (infield.ts) so they can lap their
 * own wall-clock; the geometry / canvas helpers and the shared materials live in
 * pit-geometry.ts.
 */
export function buildPitComplex(ctx: EnvBuildContext): { buildingRoofMat: THREE.MeshStandardMaterial } {
  return buildPitBuilding(ctx)
}
