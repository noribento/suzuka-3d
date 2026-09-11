/**
 * The tree species of the scene (plan R フェーズ Phase 2) — one hand-written table that every
 * tree consumer reads: the trackside scatter and the forest (which species stands where), the
 * prototype library (which pack node is which LOD, how tall it is, how it is tinted), the
 * impostor bake (one atlas row per species) and the canopy mass (its mean crown colour).
 *
 * Late March at Suzuka: the plantations are sugi / hinoki, the natural woods are matsu (red /
 * black pine) with evergreen kusunoki and a bare or just-budding broadleaf share (keyaki, cherry
 * before the bloom), the cherries at the gates and along サーキット道路 are in full bloom, the
 * hedges are evergreen shrubs and the village edges carry bamboo.
 *
 * The packs are Sketchfab CC-BY 4.0 drops (misc/trees/, imported by scripts/assets/sources.mjs
 * to `model/trees/<pack>`); their trees are addressed by NODE PATH (gltfpack -kn keeps the node
 * names) — the regexes below are written against `node scripts/assets/inspect-model.mjs` output.
 * The oak pack is imported three times with different cluster atlases (the author's season set):
 * summer = kusunoki (evergreen broadleaf), winter = keyaki (bare), spring = budding.
 *
 * Not a generated file.
 */

export type TreeRole =
  | 'sugi' | 'hinoki' | 'matsu' | 'matsuSmall' | 'keyakiBare' | 'budding' | 'kusunoki'
  | 'sakura' | 'sakuraB' | 'bush' | 'bamboo'

/** one LOD mesh set of a pack variant: the GLB key and the node-path regex of its meshes */
export interface TreeLod {
  key: string
  nodes: RegExp
}

/** one tree of a pack: LOD0 / LOD1 / LOD2 (null = reuse LOD1) */
export interface TreeVariant {
  lods: [TreeLod, TreeLod, TreeLod | null]
}

export interface TreeSpecies {
  role: TreeRole
  /** impostor atlas row (app/data/impostor-atlas.ts TREE_LAYOUT) */
  row: number
  /** metric height range the variant's natural height is scaled into (uniform pick per tree) */
  height: [number, number]
  variants: TreeVariant[]
  /** material names that are foliage (the rest is bark) */
  leafRe: RegExp
  /** the procedural fallback prototype (Node, the low tier, a missing pack) */
  cone: 'evergreen' | 'deciduous'
  /** per-instance albedo multiplier ranges (r, g, b) — species tone and individual variety */
  tint: [[number, number], [number, number], [number, number]]
  /** mean crown colour (sRGB) — the canopy mass beyond the stem range and the cone fallback */
  crown: string
  /** bark casts shadows on the high tier (foliage only inside Quality.farField.leafShadowM) */
  casts: boolean
  /** sway amplitude scale of the foliage material's wind term */
  wind: number
  /** bamboo: three culms per placement (a clump) */
  clump?: number
}

const PINE = 'model/trees/pine_pack'
const FIR = 'model/trees/fir_pack'
const OAK = 'model/trees/oak_pack'
const OAK_WINTER = 'model/trees/oak_winter'
const OAK_SPRING = 'model/trees/oak_spring'
const BUSH = 'model/trees/bush_pack'
const CHERRY_M = 'model/trees/cherry_medium'
const CHERRY_L = 'model/trees/cherry_low'
const BAMBOO = 'model/trees/bamboo'

/**
 * A lolipop_1707 pack tree: `<name>_LOD0|1|2` under a node named `<name>`. The regex is written
 * against the node names as THREE'S GLTFLoader reports them, not the glTF's: it sanitises every
 * node name for animation bindings (PropertyBinding.sanitizeNodeName — whitespace becomes '_',
 * the characters `[].:/` vanish), so the fir pack's 'Christmas tree_LOD0' is 'Christmas_tree_LOD0'
 * at runtime and the oak pack's 'Large_oak_tree_002_LOD0.001' (its Seasons Example copies) is
 * 'Large_oak_tree_002_LOD0001' — which the `(/|$)` tail keeps out.
 */
function packTree(key: string, name: string): TreeVariant {
  const safe = name.replace(/\s/g, '_').replace(/[[\].:/]/g, '')
  const lod = (n: number): TreeLod => ({ key, nodes: new RegExp(`(^|/)${safe.replace(/[.*+?^${}()|[\]\\ ]/g, '\\$&')}_LOD${n}(/|$)`) })
  return { lods: [lod(0), lod(1), lod(2)] }
}

const LEAF_PACK = /cluster|brunch|branch|blossom|leaf|leaves|needle|foliage/i

export const TREE_SPECIES: Record<TreeRole, TreeSpecies> = {
  // 杉: the plantation rows — the fir pack's spire read as Cryptomeria once the needles are warmed
  sugi: {
    role: 'sugi', row: 0, height: [14, 20],
    variants: [packTree(FIR, 'Christmas tree'), packTree(FIR, 'Christmas tree_2')],
    leafRe: LEAF_PACK, cone: 'evergreen',
    tint: [[0.95, 1.1], [0.85, 0.95], [0.55, 0.7]], crown: '#2f4a2a', casts: true, wind: 0.6,
  },
  // 檜: the same spire, lighter and yellower, a little shorter
  hinoki: {
    role: 'hinoki', row: 1, height: [10, 15],
    variants: [packTree(FIR, 'Christmas tree_2'), packTree(FIR, 'Christmas tree')],
    leafRe: LEAF_PACK, cone: 'evergreen',
    tint: [[1.0, 1.15], [1.0, 1.1], [0.6, 0.75]], crown: '#3b5530', casts: true, wind: 0.6,
  },
  // 赤松・黒松: the pine pack's large and big trees
  matsu: {
    role: 'matsu', row: 2, height: [9, 14],
    variants: ['Pine_large_1', 'Pine_large_2', 'Pine_large_3', 'Pine_big_1', 'Pine_big_2', 'Pine_big_3'].map((n) => packTree(PINE, n)),
    leafRe: LEAF_PACK, cone: 'evergreen',
    tint: [[0.9, 1.05], [0.95, 1.05], [0.8, 0.95]], crown: '#3a5a34', casts: true, wind: 0.8,
  },
  matsuSmall: {
    role: 'matsuSmall', row: 3, height: [4.5, 8],
    variants: ['Pine_medium_1', 'Pine_medium_2', 'Pine_medium_3', 'Pine_small_1', 'Pine_small_2', 'Pine_small_3'].map((n) => packTree(PINE, n)),
    leafRe: LEAF_PACK, cone: 'evergreen',
    tint: [[0.9, 1.05], [0.95, 1.05], [0.8, 0.95]], crown: '#3f5f36', casts: true, wind: 1.0,
  },
  // 欅（裸木）: the oak skeletons with the winter cluster atlas
  keyakiBare: {
    role: 'keyakiBare', row: 4, height: [10, 18],
    variants: ['Big_oak_tree__001', 'Big_oak_tree__002', 'Big_oak_tree__003', 'Big_oak_tree__004', 'Medium_oak_tree__001', 'Medium_oak_tree__002', 'Medium_oak_tree__003'].map((n) => packTree(OAK_WINTER, n)),
    leafRe: LEAF_PACK, cone: 'deciduous',
    tint: [[0.9, 1.05], [0.88, 1.0], [0.85, 1.0]], crown: '#6b5a48', casts: true, wind: 0.5,
  },
  // 芽吹き: the spring atlas on the medium / small oaks
  budding: {
    role: 'budding', row: 5, height: [6, 10],
    variants: ['Medium_oak_tree__001', 'Medium_oak_tree__002', 'Medium_oak_tree__003', 'Small_oak_tree__001', 'Small_oak_tree__002', 'Small_oak_tree__003'].map((n) => packTree(OAK_SPRING, n)),
    leafRe: LEAF_PACK, cone: 'deciduous',
    tint: [[0.9, 1.05], [0.95, 1.1], [0.7, 0.9]], crown: '#8aa060', casts: true, wind: 0.9,
  },
  // 楠: the evergreen broadleaf — the summer atlas darkened
  kusunoki: {
    role: 'kusunoki', row: 6, height: [12, 18],
    variants: ['Large_oak_tree_001', 'Large_oak_tree_002', 'Large_oak_tree_003', 'Large_oak_tree_004'].map((n) => packTree(OAK, n)),
    leafRe: LEAF_PACK, cone: 'deciduous',
    tint: [[0.7, 0.85], [0.8, 0.95], [0.6, 0.75]], crown: '#2e4d2e', casts: true, wind: 0.6,
  },
  // 桜（満開）: Sereib's Prunus serrulata — medium as LOD0, low as LOD1 / LOD2
  sakura: {
    role: 'sakura', row: 7, height: [6, 9],
    variants: [{ lods: [{ key: CHERRY_M, nodes: /Object_/ }, { key: CHERRY_L, nodes: /Object_/ }, null] }],
    leafRe: /blossom/i, cone: 'deciduous',
    tint: [[1.08, 1.15], [1.0, 1.06], [1.02, 1.1]], crown: '#efc6d2', casts: true, wind: 0.7,
  },
  // the young roadside rows: the same tree, smaller and pinker
  sakuraB: {
    role: 'sakuraB', row: 8, height: [4, 6],
    variants: [{ lods: [{ key: CHERRY_L, nodes: /Object_/ }, { key: CHERRY_L, nodes: /Object_/ }, null] }],
    leafRe: /blossom/i, cone: 'deciduous',
    tint: [[1.06, 1.12], [0.94, 1.0], [1.0, 1.06]], crown: '#f2cad6', casts: true, wind: 0.8,
  },
  // hedges and the forest edge: the bush pack (heights per size class come from the variant)
  bush: {
    role: 'bush', row: 9, height: [0.8, 2.6],
    variants: ['Bush_big_001', 'Bush_big_002', 'Bush_big_003', 'Bush_medium_001', 'Bush_medium_002', 'Bush_medium_003', 'Bush_small_001', 'Bush_small_002'].map((n) => packTree(BUSH, n)),
    leafRe: LEAF_PACK, cone: 'evergreen',
    tint: [[0.85, 1.0], [0.9, 1.05], [0.7, 0.9]], crown: '#3f5f33', casts: false, wind: 1.2,
  },
  // 竹: one culm-with-leaves model, three per clump
  bamboo: {
    role: 'bamboo', row: 10, height: [8, 12],
    variants: [{ lods: [{ key: BAMBOO, nodes: /Tree_/ }, { key: BAMBOO, nodes: /Tree_/ }, null] }],
    leafRe: /Tree_1Mat/i, cone: 'evergreen',
    tint: [[0.9, 1.05], [0.95, 1.1], [0.75, 0.9]], crown: '#7fa050', casts: false, wind: 1.5, clump: 3,
  },
}

/** which species stand where — weights, normalised by the picker */
export type TreeMixKind = 'plantation' | 'wood' | 'garden' | 'scrub' | 'scatter' | 'cherryZone' | 'roadside' | 'village' | 'hedge'
export const TREE_MIX: Record<TreeMixKind, Partial<Record<TreeRole, number>>> = {
  /** landuse=forest: the sugi / hinoki plantations with a few bare broadleaves at the edges */
  plantation: { sugi: 0.65, hinoki: 0.25, keyakiBare: 0.1 },
  /** natural=wood: the mixed hill woods */
  wood: { matsu: 0.3, kusunoki: 0.15, keyakiBare: 0.25, budding: 0.15, sugi: 0.1, matsuSmall: 0.05 },
  /** the pruned garden woods inside Motopia */
  garden: { keyakiBare: 0.3, budding: 0.3, sakura: 0.2, matsuSmall: 0.2 },
  scrub: { bush: 1 },
  /** the trackside scatter outside the woods */
  scatter: { matsu: 0.3, sugi: 0.15, kusunoki: 0.15, keyakiBare: 0.22, budding: 0.08, matsuSmall: 0.07, sakura: 0.03 },
  /** the hairpin / S-curve / gate cherry zones of vegetation.ts */
  cherryZone: { sakura: 0.45, sakuraB: 0.15, keyakiBare: 0.15, matsu: 0.15, budding: 0.1 },
  /** the rows along サーキット道路 and the gate approaches */
  roadside: { sakura: 0.7, sakuraB: 0.3 },
  /** clumps at the settlement edges */
  village: { keyakiBare: 0.3, budding: 0.2, kusunoki: 0.2, sakura: 0.1, matsuSmall: 0.2 },
  hedge: { bush: 1 },
}

/** the species of the packs' bark / foliage classification, for consumers that only know a material name */
export const TREE_LEAF_RE = LEAF_PACK
