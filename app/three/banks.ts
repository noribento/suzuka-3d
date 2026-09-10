import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { alongAt, SPECTATOR_BANKS, type BankDef } from '~/data/suzuka-facilities-spec'
import { Rng } from '~/sim/random'
import { forwardDelta } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import type { SeatSlot } from './stands'

/**
 * The grass banks people watch from: the 逆バンク oasis plateau, the E hill, the lawns beside the
 * hairpin and J, the West Area lawns at L / M / N and the slope past S (SPECTATOR_BANKS).
 *
 * A bank is not a stand: there are no rows, so the places are a CLUSTERED lattice — blobs of
 * three to six people 1.5–3 m apart, which is how a lawn reads from the air and from the track
 * (an even grid reads as a car park of people). Each place is a `SeatSlot` with `kind: 'lawn'`
 * appended to the stand generator's list, so the crowd's bays, LOD, atlas and instance budget
 * carry the bank people with no special case — the only difference is that the baked atlas sinks
 * a seated lawn figure by `look.sink` (crowd.ts), because those rows were baked sitting on a seat.
 *
 * What this module draws itself is the kit around the people: a leisure sheet under every seated
 * blob (1.8 × 1.8 m instanced quads, 2 mm over `Ground.standY` — an object on the ground, not a
 * ground face) and a pop-up tent per 40 people on the West Area lawns.
 */

/** what the bank generator measured — `Stands.stats.banks`, read by the probes and the e2e suite */
export interface BankStats {
  /** per bank: places generated, of them seated, and the kit drawn */
  rows: { id: string; people: number; seated: number; sheets: number; tents: number }[]
  people: number
  seated: number
  sheets: number
  tents: number
  /** banks that produced at least one place (the crowd's bank bays) */
  bays: number
}

/** leisure-sheet colours (the blue / silver / beige tarpaulins of every Japanese race-day lawn) */
const SHEET_COLOURS = ['#3f6fb5', '#b9bec4', '#cfc0a0']
/** a seated blob's sheet is 1.8 × 1.8 m — well under the 5 m² G8 looks at, and it is instanced anyway */
const SHEET_SIZE = 1.8
/** people per pop-up tent on the West Area lawns */
const PEOPLE_PER_TENT = 40
/** average blob size, so the lattice pitch can be solved from the bank's density */
const BLOB_MEAN = 4.5

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _s = new THREE.Vector3()
const Y_UP = new THREE.Vector3(0, 1, 0)

/** the bank band at s: [near, far] metres from the centreline on the bank's own side */
function bandAt(bank: BankDef, s: number): [number, number] {
  return [alongAt(bank.lateral[0], s, bank.sRange), alongAt(bank.lateral[1], s, bank.sRange)]
}

/** A pop-up tent: 2.6 m square canopy on four legs, apex 0.5 m over the eaves. */
function tentGeometry(): THREE.BufferGeometry {
  const half = 1.3, eave = 2.0, apex = 2.5, leg = 0.05
  const parts: THREE.BufferGeometry[] = []
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const g = new THREE.BoxGeometry(leg, eave, leg)
    g.translate(dx * (half - 0.1), eave / 2, dz * (half - 0.1))
    parts.push(g)
  }
  // canopy: four triangles from the eave square to the apex (indexed with a uv, so it merges
  // with the boxes above — mergeGeometries needs the same attributes and an index in all or none)
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const corners: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]]
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i]!, [x1, z1] = corners[(i + 1) % 4]!
    pos.push(x0, eave, z0, x1, eave, z1, 0, apex, 0)
    uv.push(0, 0, 1, 0, 0.5, 1)
    index.push(i * 3, i * 3 + 1, i * 3 + 2)
  }
  const canopy = new THREE.BufferGeometry()
  canopy.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3))
  canopy.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uv), 2))
  canopy.setIndex(index)
  canopy.computeVertexNormals()
  parts.push(canopy)
  const merged = mergeGeometries(parts, false)!
  for (const g of parts) g.dispose()
  return merged
}

/**
 * Every spectator bank: the lawn places (returned as seat slots for the crowd) and the kit drawn
 * on them. `settled` must already be true — the places sit on `Ground.standY`, the drawn ground.
 */
export function buildBanks(ctx: EnvBuildContext): { seats: SeatSlot[]; group: THREE.Group; stats: BankStats } {
  const { track, ground } = ctx
  const L = track.length
  const rng = new Rng(23)
  const group = new THREE.Group()
  group.name = 'banks'
  const seats: SeatSlot[] = []
  const rows: BankStats['rows'] = []
  const sheetMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, side: THREE.DoubleSide })
  sheetMat.name = 'bankSheet'
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.68, side: THREE.DoubleSide })
  tentMat.name = 'bankTent'
  const sheetGeo = new THREE.PlaneGeometry(SHEET_SIZE, SHEET_SIZE).rotateX(-Math.PI / 2)
  const tentGeo = tentGeometry()
  let totalPeople = 0, totalSeated = 0, totalSheets = 0, totalTents = 0, bays = 0

  for (const bank of SPECTATOR_BANKS) {
    const [s0, s1] = bank.sRange
    const len = forwardDelta(s0, s1, L) || L
    // lattice pitch from the bank's density: one blob of BLOB_MEAN people per cell
    const pitch = Math.sqrt(BLOB_MEAN / Math.max(0.01, bank.density))
    const sheetM: THREE.Matrix4[] = []
    const sheetCol: THREE.Color[] = []
    const tents: THREE.BufferGeometry[] = []
    let people = 0, seated = 0
    const nS = Math.max(1, Math.round(len / pitch))
    for (let i = 0; i < nS; i++) {
      const s = track.wrap(s0 + ((i + 0.5) * len) / nS + (rng.next() - 0.5) * pitch * 0.6)
      const [near, far] = bandAt(bank, s)
      const width = far - near
      if (width < 1.5) continue
      const nV = Math.max(1, Math.round(width / pitch))
      for (let j = 0; j < nV; j++) {
        if (rng.next() > bank.occupancy) continue
        const v = near + ((j + 0.5) * width) / nV + (rng.next() - 0.5) * pitch * 0.6
        if (v < near + 0.5 || v > far - 0.5) continue
        const blob = 3 + Math.floor(rng.next() * 4)
        const blobSeated = rng.next() < bank.seated
        // the blob's own centre on the ground, for the sheet and the yaw
        const h = track.headingAt(s)
        const yaw = Math.atan2(-bank.side * h.tz, bank.side * h.tx)
        let placed = 0
        for (let k = 0; k < blob; k++) {
          // a ring of places around the centre, 0.55–1.3 m out
          const a = (k / blob) * Math.PI * 2 + rng.next() * 0.7
          const r = k === 0 ? 0 : 0.55 + rng.next() * 0.75
          const ds = Math.cos(a) * r, dv = Math.sin(a) * r
          const ss = track.wrap(s + ds)
          const vv = v + dv
          if (vv < near || vv > far) continue
          track.pointAt(ss, bank.side * vv, _p, 0)
          const y = ground.standY(_p.x, _p.z)
          seats.push({
            standId: bank.id,
            tierId: bank.id,
            // "row" orders the crowd's truncation: the places nearest the track go first
            row: Math.max(0, Math.round((vv - near) / 2)),
            s: ss,
            lateral: bank.side * vv,
            x: _p.x,
            y,
            z: _p.z,
            yaw: yaw + (rng.next() - 0.5) * 0.5,
            kind: 'lawn',
          })
          placed++
        }
        if (!placed) continue
        people += placed
        if (blobSeated) {
          seated += placed
          track.pointAt(s, bank.side * v, _p, 0)
          _p.y = ground.standY(_p.x, _p.z) + 0.002
          _q.setFromAxisAngle(Y_UP, yaw + (rng.next() - 0.5) * 0.6)
          _s.setScalar(1)
          sheetM.push(new THREE.Matrix4().compose(_p, _q, _s))
          sheetCol.push(new THREE.Color(SHEET_COLOURS[Math.floor(rng.next() * SHEET_COLOURS.length)]!))
        }
      }
    }
    // pop-up tents on the West Area lawns, one per 40 people, spread along the bank's back edge
    if (bank.west) {
      const n = Math.floor(people / PEOPLE_PER_TENT)
      for (let i = 0; i < n; i++) {
        const s = track.wrap(s0 + ((i + 0.5) * len) / Math.max(1, n))
        const [, far] = bandAt(bank, s)
        track.pointAt(s, bank.side * (far - 2.5), _p, 0)
        _p.y = ground.standY(_p.x, _p.z)
        const g = tentGeo.clone()
        _q.setFromAxisAngle(Y_UP, rng.next() * Math.PI * 2)
        g.applyMatrix4(_m.compose(_p, _q, _s.setScalar(1)))
        tents.push(g)
      }
    }
    if (sheetM.length) {
      const inst = new THREE.InstancedMesh(sheetGeo, sheetMat, sheetM.length)
      inst.name = `bankSheets-${bank.id}`
      for (let i = 0; i < sheetM.length; i++) {
        inst.setMatrixAt(i, sheetM[i]!)
        inst.setColorAt(i, sheetCol[i]!)
      }
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      inst.castShadow = false
      inst.receiveShadow = true
      inst.computeBoundingSphere()
      group.add(inst)
    }
    if (tents.length) {
      const merged = mergeGeometries(tents, false)
      for (const g of tents) g.dispose()
      if (merged) {
        const mesh = new THREE.Mesh(merged, tentMat)
        mesh.name = `bankTents-${bank.id}`
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
      }
    }
    rows.push({ id: bank.id, people, seated, sheets: sheetM.length, tents: tents.length })
    totalPeople += people
    totalSeated += seated
    totalSheets += sheetM.length
    totalTents += tents.length
    if (people) bays++
  }
  if (import.meta.dev) console.info(`[banks] ${SPECTATOR_BANKS.length} banks, ${totalPeople} places (${totalSeated} seated), ${totalSheets} sheets, ${totalTents} tents`)
  return { seats, group, stats: { rows, people: totalPeople, seated: totalSeated, sheets: totalSheets, tents: totalTents, bays } }
}
