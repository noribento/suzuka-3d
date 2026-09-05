/**
 * Suzuka International Racing Course — real-world geometry.
 *
 * CENTERLINE_EN holds the racing circuit centreline projected to local metres
 * (x = east, y = north) around the circuit centroid. Source: the F1 circuits
 * GeoJSON dataset (jp-1962), 172 vertices, closed loop, driving direction,
 * first vertex on the start/finish line.
 */

export const CIRCUIT = {
  name: 'Suzuka International Racing Course',
  shortName: 'SUZUKA',
  gpName: 'JAPANESE GRAND PRIX',
  country: 'JPN',
  officialLength: 5807,
  laps: 53,
  /** Maximum track width in metres (the per-section width lives in WIDTH_KEYFRAMES). */
  width: 15,
  /** Sector boundaries: s (metres) where sector 2 and sector 3 start. */
  sectors: [2010, 4060] as const,
  /** DRS: detection point and activation zone (zone wraps across the start line). */
  drs: { detection: 5150, start: 5590, end: 430, enabledFromLap: 3 },
  /**
   * Pit lane geometry, expressed as offsets from the main centreline. As at the real circuit
   * the lane diverges to the right after the chicane, runs inside Turn 18 and along the main
   * straight between the pit wall and the pit building under an 80 km/h limit for ~425 m
   * (real: 415 m), and the exit road continues on the inside of the straight to merge just
   * before the Turn 1 braking zone. Net pit loss ≈ 22 s.
   *
   * Lateral layout on the straight (metres right of the centreline): track edge 7.5 →
   * pit wall 9.4 → fast lane 10.5–14.5 → working lane / boxes 14.5–20.5 → garages 21–34 →
   * paddock beyond.
   */
  pit: {
    entryS: 5340, // pit lane starts diverging here (after the chicane)
    limitStartS: 5560, // speed limit line
    limitEndS: 180, // speed limit ends
    exitS: 430, // rejoins the track at the entry of Turn 1
    entryRamp: 90, // metres over which the lane peels away from the track
    exitRamp: 180, // metres over which the exit road blends back
    laneOffset: -15.5, // lane centreline, metres to the right of the track centreline
    laneWidth: 10, // fast lane + working lane
    wallOffset: -9.4, // pit wall (between track and pit lane)
    garageFront: -21, // pit-lane face of the pit building
    boxStartS: 5640, // first garage
    boxSpacing: 26, // one box per team
    speedLimit: 80 / 3.6,
  },
  /** Default overview camera azimuth (degrees, east = 0, counter-clockwise). -90 = camera south of the circuit, north up. */
  overviewAzimuthDeg: -90,
} as const

export interface CornerInfo {
  from: number
  to: number
  name: string
  short: string
}

/** Named sections along the lap (s in metres) — used for lower-thirds and TV cameras. */
export const SECTIONS: CornerInfo[] = [
  { from: 5520, to: 450, name: 'Main Straight', short: 'S/F' },
  { from: 450, to: 830, name: 'Turns 1-2 (First Curve)', short: 'T1-2' },
  { from: 830, to: 1000, name: 'Run to the Esses', short: 'T2 exit' },
  { from: 1000, to: 1660, name: 'Turns 3-6 (S Curves)', short: 'S Curves' },
  { from: 1660, to: 2040, name: 'Turn 7 (NIPPO Corner)', short: 'NIPPO' },
  { from: 2040, to: 2160, name: 'Turn 8 (Degner 1)', short: 'Degner 1' },
  { from: 2160, to: 2300, name: 'Turn 9 (Degner 2)', short: 'Degner 2' },
  { from: 2300, to: 2520, name: 'Turn 10 (Crossover)', short: 'Crossover' },
  { from: 2520, to: 2760, name: 'Turn 11 (Hairpin)', short: 'Hairpin' },
  { from: 2760, to: 3450, name: 'Turn 12 (200R)', short: '200R' },
  { from: 3450, to: 3980, name: 'Turns 13-14 (Spoon Curve)', short: 'Spoon' },
  { from: 3980, to: 4740, name: 'Back Straight', short: 'Back Str.' },
  { from: 4740, to: 5060, name: 'Turn 15 (130R)', short: '130R' },
  { from: 5060, to: 5340, name: 'Turns 16-17 (Astemo Chicane)', short: 'Chicane' },
  { from: 5340, to: 5520, name: 'Turn 18', short: 'T18' },
]

/**
 * Elevation keyframes [s, height(m)] derived from the GSI 5 m DEM — 標高は「基盤地図情報 数値標高
 * モデル（DEM5A）」（国土地理院）（https://maps.gsi.go.jp/development/ichiran.html）をもとに作成。
 * Regenerate with `node scripts/facilities/dem-profile.mjs`; the raw tiles stay outside the repo.
 * Datum: project height = metres ASL − 10.73, so the start line keeps its 21.0 m and everything
 * placed around it is unchanged. Method: median of 13 samples across the road every 5 m along
 * the app's own centreline, the four spots where the bare-earth DEM shows a spectator tunnel or
 * the crossover road *below* the deck repaired, Douglas–Peucker at 0.5 m, then the residual
 * artefact notches (s≈1765/4670/5125) and a 0.5 m tunnel-edge kink at s≈105–130 on the main
 * straight removed by hand — the Hermite interpolation in Track.elevationAt would turn those
 * into visible bumps. The real profile spans 6.8 m (Turn 2 exit, s≈545) to 47.0 m (200R → Spoon,
 * s≈3570): the pit straight falls at −3 % into Turn 1, the lap climbs from the Turn 2 exit
 * through the Esses to the Dunlop crest (s≈1710), drops under the crossover (32.7 m at s≈2321),
 * rises again to the hairpin → 200R → Spoon plateau (44–47 m, the highest part of the lap, not
 * Degner as previously modelled), falls at −5 % onto the back straight, crosses the bridge
 * (38.8 m at s≈4691, 6.0 m above the road beneath), peaks once more before the chicane (44.3 m)
 * and drops −3 % through T18 back to the line.
 */
export const ELEVATION_KEYFRAMES: [number, number][] = [
  [0, 21],
  [490, 7.3],
  [550, 6.8],
  [910, 13.3],
  [1265, 28.3],
  [1320, 28.7],
  [1420, 26.5],
  [1470, 27.1],
  [1640, 38.3],
  [1710, 40.7],
  [2065, 37.1],
  [2245, 32.6],
  [2380, 32.7],
  [2460, 34.3],
  [2635, 42.8],
  [2685, 44.4],
  [3005, 46.8],
  [3065, 46],
  [3160, 42.1],
  [3215, 41.4],
  [3415, 46],
  [3570, 47],
  [3775, 46.4],
  [3825, 44.3],
  [3945, 35.7],
  [4025, 33.4],
  [4125, 34.6],
  [4310, 38.8],
  [4675, 38.8],
  [4830, 39.6],
  [5160, 44.3],
  [5280, 41.6],
  [5375, 35.4],
  [5475, 30.5],
]

/**
 * Track width keyframes [s, width(m)], linearly interpolated: the pit straight and the
 * run into Turn 1 are the widest parts of the lap, the Esses, Degners and 200R the
 * narrowest.
 */
export const WIDTH_KEYFRAMES: [number, number][] = [
  [0, 15],
  [380, 15],
  [560, 14],
  [780, 13],
  [900, 12],
  [1400, 12],
  [1650, 11],
  [1950, 11],
  [2050, 10.5],
  [2300, 10.5],
  [2450, 11.5],
  [2650, 12],
  [2850, 11],
  [3350, 11],
  [3500, 12],
  [3850, 12],
  [4000, 11.5],
  [4600, 11.5],
  [4720, 14],
  [4950, 14],
  [5080, 11],
  [5260, 11],
  [5320, 14],
  [5520, 15],
]

/**
 * Cross-slope keyframes [s, degrees], linearly interpolated. Positive values bank the
 * road into the local corner (outside edge higher), negative ones are off-camber.
 * Turns 1–2 and the hairpin follow the DEM5A cross-slope ((h(+6) − h(−6)) / 12 ≈ 7 %, i.e.
 * ≈4° banked into the corner, see scripts/facilities/dem-profile.mjs); the rest are still
 * estimates — the DEM also hints at 2–3° in Degner 2, Dunlop and the 200R, but the road is
 * ≤ 11 m wide there and the ±6 m samples reach the kerbs, so those were left alone. Suzuka is
 * otherwise flat-crowned (straights read −0.1…−0.8 % of drainage fall).
 */
export const CAMBER_KEYFRAMES: [number, number][] = [
  [0, 0],
  [400, 0],
  [470, 3.5],
  [560, 3.5],
  [640, 4],
  [720, 1],
  [800, 0],
  [860, 1],
  [1330, 1],
  [1450, 0],
  [1520, 2.5],
  [1740, 3],
  [1900, 1],
  [2000, 0],
  [2180, 0],
  [2220, 2],
  [2280, 0],
  [2600, 0],
  [2660, 4.5],
  [2740, 0],
  [3500, 0],
  [3600, 1],
  [3700, -1],
  [3760, 2],
  [3860, 0],
  [4680, 0],
  [4740, 2],
  [4820, 2],
  [4900, 0],
  [5110, 0],
  [5160, 0.5],
  [5230, 0.5],
  [5280, 0],
  [5300, 2],
  [5400, 1],
  [5480, 0],
]

/**
 * Racing-line pins [s, lateral(m, + = left), halfLength(m)] applied on top of the
 * minimum-curvature line where the F1 line differs from the pure geometric optimum:
 * a late apex at Degner 2, the shallow first / late second apex of Spoon, keeping to the
 * left on the approach to 130R, and straight-lining the chicane.
 */
export const APEX_OVERRIDES: [number, number, number][] = [
  [2230, -2.2, 25], // Degner 2: late apex hugging the inside
  [3600, -0.5, 60], // Spoon 1: shallow, keep momentum
  [3790, -2.8, 40], // Spoon 2: late apex for the run onto the back straight
  [4600, 3.2, 120], // 130R approach: stay left
  [4750, -3.0, 30], // 130R apex
  [5150, -2.0, 15], // chicane 1 apex (right)
  [5210, 2.0, 15], // chicane 2 apex (left)
]

/**
 * Race-condition minimum speeds at each corner (km/h), from public race telemetry
 * (±5 %). The simulation calibrates its corner curvature so the reference car matches
 * them; the harness reports deviations.
 */
export const APEX_SPEED_TARGETS: { s: number; kmh: number; name: string }[] = [
  { s: 474, kmh: 245, name: 'T1' },
  { s: 592, kmh: 175, name: 'T2' },
  { s: 876, kmh: 235, name: 'T3' },
  { s: 1004, kmh: 200, name: 'T4' },
  { s: 1132, kmh: 215, name: 'T5' },
  { s: 1314, kmh: 180, name: 'T6' },
  { s: 1548, kmh: 215, name: 'NIPPO' },
  { s: 2062, kmh: 230, name: 'Degner 1' },
  { s: 2222, kmh: 140, name: 'Degner 2' },
  { s: 2674, kmh: 70, name: 'Hairpin' },
  { s: 3084, kmh: 290, name: '200R' },
  { s: 3748, kmh: 165, name: 'Spoon' },
  { s: 4736, kmh: 300, name: '130R' },
  { s: 5160, kmh: 85, name: 'Chicane 1' },
  { s: 5210, kmh: 80, name: 'Chicane 2' },
  { s: 5298, kmh: 165, name: 'T18' },
]

/** Corners whose exit kerbs carry yellow sausage kerbs behind the flat kerb. */
export const SAUSAGE_KERB_CORNERS = ['T2', 'T6', 'Degner 1', 'Spoon', 'Chicane 1', 'Chicane 2']

/** Where overtakes happen at Suzuka: braking zones (s of the braking point). */
export const OVERTAKE_ZONES: { s: number; name: string }[] = [
  { s: 414, name: 'T1' },
  { s: 2648, name: 'Hairpin' },
  { s: 3534, name: 'Spoon' },
  { s: 5134, name: 'Chicane' },
]

/** Trackside broadcast cameras: s position; side is resolved from the corner direction. */
export const TV_CAMERA_SPOTS: number[] = [
  250, 640, 1180, 1500, 1960, 2230, 2640, 3100, 3650, 4350, 4900, 5250, 5560,
]

export const CENTERLINE_EN: [number, number][] = [
  [681.79, -137.77], [802.93, -283.6], [944.63, -457.26], [957.6, -475.63], [964.82, -494.77],
  [968.57, -512.03], [968.29, -528.95], [966.19, -541.97], [949.66, -593.07], [941.8, -606.43],
  [930.38, -616.56], [920.79, -622.01], [903.52, -626.24], [887.81, -625.69], [870.54, -619.9],
  [854.46, -607.21], [838.11, -582.49], [754.51, -454.14], [738.71, -440.67], [725.09, -436.33],
  [704.54, -432.77], [661.32, -432.44], [639.58, -426.2], [624.23, -415.4], [612.63, -401.27],
  [607.15, -387.46], [587.69, -313.55], [579.56, -294.62], [566.58, -278.37], [551.51, -267.35],
  [532.5, -258.44], [513.04, -254.77], [462.8, -253.99], [439.59, -249.54], [423.69, -241.97],
  [407.25, -229.28], [395.19, -211.58], [387.79, -193.54], [384.41, -176.51], [384.59, -160.26],
  [387.7, -146.46], [412.37, -79], [416.11, -65.3], [416.75, -47.27], [414.1, -35.36],
  [407.61, -18.1], [397.93, -3.41], [379.38, 9.73], [356.82, 21.97], [330.05, 35.44],
  [306.48, 44.9], [288.94, 49.8], [264.27, 53.92], [236.31, 54.36], [214.3, 53.47],
  [195.93, 48.58], [181.04, 42.23], [157.84, 32.32], [133.44, 18.63], [105.39, -4.3],
  [83.47, -27.57], [-8.71, -139.33], [-13.47, -145.79], [-28.17, -149.24], [-162.84, -161.37],
  [-171.52, -160.26], [-180.75, -154.03], [-184.49, -143.45], [-186.14, -134.54], [-206.6, -50.39],
  [-233.92, 107.69], [-239.13, 136.74], [-240.4, 151.44], [-238.94, 166.57], [-236.02, 182.27],
  [-229.81, 198.52], [-222.77, 214.66], [-201.03, 264.54], [-198.74, 272.22], [-200.39, 279.23],
  [-204.5, 285.69], [-211.54, 290.47], [-219.67, 293.03], [-227.52, 292.48], [-236.48, 286.47],
  [-243.88, 275.78], [-275.58, 221.01], [-301.34, 179.71], [-318.15, 155.22], [-332.04, 139.08],
  [-344.01, 128.84], [-364.56, 112.58], [-386.22, 101.01], [-408.87, 94.22], [-448.34, 88.43],
  [-485.71, 86.87], [-513.85, 88.99], [-547.38, 96.33], [-584.1, 106.68], [-625.22, 122.05],
  [-651.16, 134.07], [-673.91, 147.76], [-694.92, 163.46], [-717.12, 183.38], [-740.06, 208.76],
  [-755.22, 230.92], [-768.83, 255.19], [-802.45, 344.69], [-820.45, 383.87], [-829.59, 399.57],
  [-842.01, 411.14], [-858.28, 418.49], [-877.74, 422.16], [-901.03, 421.61], [-922.59, 418.49],
  [-943.7, 413.82], [-964.25, 405.36], [-981.06, 392.55], [-991.21, 376.3], [-995.13, 360.38],
  [-993.95, 340.34], [-989.38, 325.43], [-982.71, 310.4], [-971.29, 297.82], [-948.72, 276.67],
  [-920.49, 253.18], [-892.9, 229.02], [-857.91, 202.53], [-817.89, 175.26], [-776.96, 149.65],
  [-731.19, 127.84], [-690.26, 106.91], [-648.24, 90.88], [-579.99, 67.28], [-504.89, 38],
  [-413.99, 6.16], [-323.82, -22.33], [-261.42, -43.93], [-180.75, -74.77], [-162.29, -79.44],
  [-143.93, -80], [-124.47, -76.32], [-105.56, -71.09], [-71.48, -57.96], [-40.14, -42.26],
  [-13.83, -26.01], [13.39, -4.86], [64.28, 42.79], [133.99, 107.8], [153.36, 123.83],
  [167.15, 133.51], [179.76, 141.86], [188.72, 147.21], [193.56, 147.65], [199.95, 144.98],
  [215.67, 130.95], [227, 121.49], [236.22, 118.82], [244.9, 120.49], [255.13, 127.28],
  [271.94, 142.53], [290.86, 156.11], [311.96, 165.02], [337.72, 167.24], [361.75, 165.91],
  [387.15, 160.67], [412.55, 150.77], [434.11, 140.41], [461.15, 122.05], [485.45, 99.45],
  [510.4, 71.62],
]
