# Suzuka 3D — F1 Japanese Grand Prix, live in the browser

鈴鹿サーキット（実測 GeoJSON 由来の実コース形状・5.807 km・立体交差つき）を 3D で再現し、
2026 年グリッドの 22 台の F1 マシンがレースをする Web サイトです。
F1 の TV 中継風の UI（タイミングタワー、テレメトリ、トラックマップ、スタートシグナル、
ファステストラップ／オーバーテイク／ピット／スピードトラップのバナー、バトル表示、ロワーサード）と、
俯瞰・ヘリ・チェイス・オンボード・トラックサイド TV・自動ディレクターの 6 種類のカメラ、
手続き合成のエンジン音を備えています。TV カメラと自動ディレクターでは HUD が F1 ワールドフィード風の放送パッケージ
（2025–26 年スタイル: 常設タイミングタワー、ヘッダー横のストラップ、ロワーサード、バトル表示、オンボードクラスター、
ドライバートラッカー／天候／タイヤ戦略のペイン）に切り替わり、実際の放映に近い出入りのアニメーションで動きます。

## Stack

- **Nuxt 4** (SPA, `ssr: false`) + Vue 3.5 + TypeScript (strict)
- **three.js** r185 — 3D シーン、CSM 影、`Sky`、`EffectComposer`（GTAO / bloom / 望遠 DoF / モーションブラー・グレード / SMAA）、`PositionalAudio`。ドライバータグはカメラ行列で直接投影しています（`CSS2DRenderer` は不使用）
- 依存パッケージはこれだけです（フォントは Google Fonts の Titillium Web）。
- **外部アセット**は高品質ティアだけが読み込みます: `public/assets/`（KTX2 テクスチャと meshopt 圧縮 GLB、合計約 30 MB、
  すべて CC0 / CC-BY）。出典・ライセンス・ハッシュは `public/assets-manifest.json` に、表記は [CREDITS.md](CREDITS.md) と
  アプリ内のクレジットパネルにあります。低負荷ティア（E2E もこちら）は従来どおり全てノイズ生成で、外部ファイルを一切読みません。

## Setup

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # 本番ビルド（.output/）
pnpm preview
pnpm exec nuxi typecheck
pnpm check      # typecheck → textures-lint → import-misc --check → facilities-check → scene-cost 高/低 → surface-check 高/低（約 4〜8 分）
pnpm perf       # dev サーバー（:3100）に対して perf-probe → perf-gate（30 分超、check には入れない）
```

`?fx=0` を付けて開くと低負荷モード（ポストプロセス無し、影は 1024²×2 カスケード、観客・樹木・テクスチャを縮小）、
`?fx=1` で強制的に高品質モードになります（既定では GPU があれば高品質、SwiftShader などソフトウェア描画なら低負荷）。
ティアごとの数値は `app/three/quality.ts` の `QUALITY` に集約されています。高品質モードは fps に応じて描画解像度を
1 → 0.85 → 0.7 に自動で落とします（`?res=0` で等倍に固定）。
`?assets=0|1` でアセットパックの読み込みを強制できます（既定は高品質ティアで読む）。読み込めなかったファイルは
個別に手続き生成へフォールバックし、`console.warn` に一覧が出ます（`console.error` は出ません）。

### 外部アセットのパイプライン

```bash
node scripts/assets/fetch.mjs                 # Poly Haven / ambientCG / poly.pizza から misc/dl/ へ取得（ハッシュ検証）
node scripts/assets/bake-crowd-atlas.mjs      # 観客インポスターアトラスを焼く（Playwright、SwiftShader で可）— 行 0–13 素頭、14–27 キャップ、28–31 白ヘルメット（運営レイヤーのマーシャル／クルー、mask 黒 = 着色しない、`CROWD_HELMET_ROWS`）
node scripts/assets/bake-tree-atlas.mjs       # 樹木インポスターアトラス（種ごと 1 行、8 方位 × 2 仰角）を焼く — 樹木パックの import 後に
node scripts/assets/bake-car-atlas.mjs --glb  # 駐車場の車のアトラス（GLB 車体の行は GLB から、他は手続き車体）— 車両 GLB の import 後に
node scripts/assets/import-misc.mjs           # misc/ を変換して public/assets/ と manifest・CREDITS.md・credits.ts を生成
node scripts/assets/import-misc.mjs --check   # ライセンス・容量（≤ 200 MB）・VRAM 見積（≤ 512 MB）・KTX2 mip の検査
node scripts/assets/inspect-model.mjs misc/trees/<zip>   # ドロップした GLB/zip のノードパス・三角形数・material 名・画像を表示（sources.mjs の正規表現を書くため）
node scripts/assets/retouch-glb.mjs --dump <in.glb> <dir>  # GLB 内テクスチャの書き出し（バッジ・ナンバープレートの矩形を決める）/ --spec で blur・fill・dropParts・keepBox（AABB の外の三角形を落とす）
# sources.mjs のモデル項目: maxTex / simplify（gltfpack -si -sa）/ texEncode（GLB 内 KTX2: uastc は法線と MASK/BLEND の色、etc1s は他）/ dropNodes / keepNodes / overrideImages（'@<image>' でパック内の別画像、'misc/…' で手元の画像）/ retouch / dropParts / keepBox / retouchReviewed（retouch が要らない理由）。Sketchfab の CC-BY は misc/<group>/ に zip のまま置く（`MISC_GROUPS`: trees / road / buildings / vehicles / seats、I フェーズの受け口 ops / trackside / pit — 項目は各ドロップの取り込み時に追加）。`--check` は model/vehicles/* と model/ops/* に retouch か retouchReviewed を要求する
# I フェーズ（柵の内側）の CC0: Poly Haven の小物 16 件（256 px、KTX2、消火器のラベルと発電機の銘板は retouch 済み）と再エンコード 3 件（concrete_road_barrier 0.08 / street_lamp_02 0.2 / security_camera_01 0.3 に間引き + KTX2）、路面・壁の 512 px 8 + 4 件（asphalt_track / square_floor_patern_01 / concrete_floor_03 / blue_metal_plate / container_side / painted_metal_shutter / rectangular_facade_tiles / tarred_gravel、PavingStones099 / PaintedMetal010 / Asphalt033 / MetalWalkway012）。bleacher（5.6 MB、消費者なし）は SOURCES から外した
# I フェーズの Sketchfab CC-BY 4.0 ドロップ 20 件（I0-e2。zip は misc/ops・trackside・pit に置いたまま、license.txt の author / CC-BY-4.0 を検査し、全画像を `retouch-glb --dump` で書き出して読んだ）。group / モデル（作者、uid 先頭）/ 用途 / 処理:
#   ops: JDM Sport '99・Sigil '07・Ace '11・Urban '10・Lightbody '90 MD Flatbed・Tow Truck・Shvan '92 Ambulance（Daniel Zhabotinsky、6dd4ae19 / 22abe528 / 055ff8a2 / 2866efdf / 39195e55 / 5cba2080 / 2856dd3c）= SC・メディカルカー・コース車・回収車・救急車: 架空ブランド、512 px、simplify 0.4（7〜10 k tris）、バッジのノード（/Badges/）を落として badge アトラスごと削除（架空の中に ROVER / OUTBACK の綴りがあった）、ナンバープレートは架空の文字アトラス。救急車の 4K 車体シートは米国仕様なので Star of Life ×3・星条旗 ×2・911・EMERGENCY ブロック・269 64 PCT・MADE IN USA・HANDLE WITH CARE を車体色で fill（AMBULANCE / FIRST RESPONDER は残す）
#        Tent Canopy – rectangular（MozillaHubs、256b7c9e）マーキー 512 / Porta Potty（Sean Thomas、b970702e）仮設トイレ / Diesel Generator（Eugene Flerko、03db834f）発電機 / Forklift low poly（Ricardo Sanchez、8ab650b3）フォークリフト — いずれも文字なし、256（テントは 512）、retouchReviewed
#   trackside: Small Guard Booth（Arsen Ismailov、422ec83e）マーシャルキャビン: dropNodes で門扉（RootNode/Cube）を落とす、ガラスの KHR_materials_transmission は残る / Racetrack tire stack standard v2（mira9、65cc7bcf）側壁刻印なし / Flood light 02（CHAMOD、95ad365a）/ Barrier & Traffic Cone Pack（Sabri Ayeş、23c4dfca）keepNodes で Object_3・5（コーン）・13・14（縞ドラム）・10（ポール）・15〜17（小バリア 3 種）だけ残す（22 画像 256 px）— コーン 2 種はどちらも橙で、緑のピットレーンコーンには使わない（手続きのみ、I3 レビュー）/ Police Crowd Barrier（exiS7-Gs、27146861）"POLICE LINE - DO NOT CROSS / POLICE DEPT" をレールの青で fill
#   pit: Pit Board（Alex Werner、42e680a0）11 枚のパネル画像を白で fill（文字は実行時に描く）/ Impact wrench（chupin、538a84dc）工具ブランドなし（レーザー注意ラベルと CE のみ）/ Trolley Jack Lo Poly（almartin、c4ea505c）simplify 0.4 / Basic PC Monitors（Sousinho、58a2dba7）— 256 px。scaffold（@Js_TuruokaJunpei、90789439）は未ドロップ（TV 足場塔は手続きのまま）。合計 +7.9 MB / VRAM +36 MB（67.99 MB / 260.6 MB）
node scripts/facilities/build-facilities.mjs --offline   # OSM のフットプリント → app/data/suzuka-facilities.ts（ODbL、キャッシュは .cache/overpass/facilities.json）
node scripts/facilities/build-facilities.mjs --add-ways-from .cache/overpass/surroundings.json --role "apron:467386920;tunnel:184101996" --dry-run
                                              # 網なしで way を差し込む: キャッシュ済み Overpass 応答から id で引き、役割（apron / parking / tunnel / footbridge / road）を付けて既存行に触れず splice（--dry-run で新行だけ表示）
node scripts/facilities-check.mjs --strict    # スタンド・ピット定数・ガレージ順・GROUND_AREAS・周辺データの整合性
node scripts/textures-lint.mjs                # テクスチャに描く文字列の商標リント（denylist / allow は scripts/trademark-*.json、1 秒未満）
node scripts/audit/scene-cost.mjs --tier high # Node でシーンを組み、三角形・メッシュ・InstancedMesh・遠景をグループ別に集計して perf-budgets.json の static/data と照合（約 12 秒）
node scripts/audit/surface-check.mjs --strict # 地面の区画のガード G0〜G12（GPU も網も不要、1 ティアあたり約 95〜210 秒）
pnpm check                                    # 上をまとめて 8 段（typecheck → textures-lint → import-misc --check → facilities-check → scene-cost 高／低 → surface-check 高／低）
git config core.hooksPath .githooks           # 任意：コミット前に pnpm check を走らせるフック（.githooks/pre-commit、--no-verify で一回だけ飛ばせる）
node scripts/shots.mjs --assets 1             # 固定視点のスクリーンショット（--preset / --custom / --tier）
node scripts/audit/aerial.mjs                # 国土地理院シームレス空中写真 z18 を .cache/audit/ に取得してモザイク化
node scripts/audit/overlay.mjs               # アプリが描く線（暖色）と OSM（寒色）を写真に重ね、17 区間に切り出す
node scripts/audit/shoot.mjs                 # :3100 の現行シーンを区間ごとに真上・斜めから撮る
node scripts/audit/osm-edge.mjs 400 960 1 469261663   # OSM way の track 側の縁を (s, lateral) で出す（バリア表の起草用）
```

### 実写との突き合わせ

`scripts/audit/` は「アプリが今どこに何を描いているか」を国土地理院の空中写真（z18、約 0.49 m/px）に
重ねて区間ごとに見るためのものです。壁・縁石・白線・ランオフの位置はすべて
`app/data/suzuka-barriers-spec.ts` の表と `RUNOFF_ZONES` にあり、コードは表だけを描くので、
データを直したら `node scripts/audit/surface-check.mjs --strict` と
`node scripts/facilities-check.mjs --strict`（バリアが路面・他の道路・スタンドに入っていないか、
出典が run を覆っているか、パッチの輪郭が単純多角形か）を通し、`node scripts/audit/overlay.mjs` で
写真と突き合わせてから `node scripts/audit/shoot.mjs` でシーンを撮ります。
表の行が指す OSM way が `suzuka-facilities.ts` に無ければ `facilities-check` §6 が `--strict` で error にします。
bbox クエリのタグ条件に掛からない way（柵内の highway=service + area=yes の硬地 `apron`、amenity=parking の
`parking`、歩行者・構内のトンネル `tunnel`、歩道橋 `footbridge`、切通しの道路と柵内の管理道路・教習コース `road`）は
`build-facilities.mjs --add-ways-from .cache/overpass/surroundings.json --role "<役割>:<id,…>"` で
キャッシュ済みの Overpass 応答から網なしで差し込みます（`SPLICED_WAYS` / `SERVICE_ROAD_WAYS` に載せておくとフル再生成でも残ります）。
後ろへ行くほど高価で、後ろへ行くほど真実に近く、最初の 2 つは GPU もネットワークも要りません。タイル・モザイクは `.cache/audit/`（gitignore）に
置き、リポジトリには入れません。撮影は 2017–2020 年なので、2024 年以降の変更（緑帯・塗装・仮設
スタンド・乾いた調整池）はユーザーの実写（`misc/ref/user/`、gitignore）を正とします。

ログインが必要な素材（Eclair の CC0 人物 GLB、Sketchfab の CC-BY 座席、KTX-Software の `ktx` CLI）は `misc/`
（gitignore 済み）に置くと `import-misc.mjs` が拾います。`nuxt.config.ts` の `routeRules` は `/assets/**` に
immutable キャッシュを付けますが、これは Nitro 系のホストでだけ効きます（静的ホストでは各自のヘッダ設定で）。

レースは最初のクリックまたはキー操作で始まります（「TAP / CLICK TO START」、操作が無くても 8 秒後に自動開始）。
ブラウザの自動再生制限のため音はその操作後に作られ、スタートシグナルの 1 灯ごとの電子音もそこから鳴ります（消灯時は無音で、観客のどよめきだけが上がります）。

## Simulation harness (Node)

ブラウザと同じ `RaceSim` を Node で約 1000 倍速で回し、リアリティに関わる数値を検証します。

```bash
pnpm sim                             # 3 周、1 シード、コーナー頂点速度と結果を表示
pnpm sim -- --laps 53 --seeds 5      # フルレースを 5 シード
pnpm sim -- --laps 53 --json > out.json
pnpm sim -- --brakes --laps 3        # ブレーキディスク温度（コーナーごとのピーク F/R、裏ストレート・S 字の最低値）
```

出力: 周長（5807 m）、各コーナーの頂点速度と実測目標（`APEX_SPEED_TARGETS`）との差、理想ラップ、
ファステスト／レース時間、追い越し数（ゾーン別）、車体重なりサンプル（0 であること）、ピットロス、ピット周回の分布。
目安: 理想ラップ 1:26 台（予選相当）、レース平均 1:33 台、ファステスト 1:31 前後、追い越し 20〜45 回、ピットロス 26 s 前後（ピットレーンの分岐・合流を OSM の実線形に合わせた後の実測）。

## E2E tests (Playwright)

実際の WebGL シーンをヘッドレス Chromium で動かし、HUD・スタートシグナル・カメラ切替・
キーボード操作を検証します。GPU がない環境でも動くよう SwiftShader（ソフトウェア描画）を強制しているため、
1 テストあたり数十秒かかります。`tests/e2e/global-setup.ts` が最初に dev サーバーを一度読み込んで Vite の依存最適化を
済ませ（初回読み込みの 504 対策）、`audio.spec.ts` は OfflineAudioContext でエンジン音を 1 ボイス描画してスペクトルを
検証します（10,000 rpm 全負荷で 500 Hz 未満の帯域が 2 kHz 超より 8 dB 以上大きいこと、グリッドでアイドルが鳴ること、決定論性）。
描画コストは `node scripts/perf-probe.mjs`（dev サーバーに対してカメラごとの draw call・三角形数・区間時間を採取、`.perf/` に保存）で測れます。

```bash
pnpm dev --port 3100                          # 別シェルで（:3000 は通常の開発用）
pnpm perf                                     # perf-probe（両ティア、モード 1〜5）→ perf-gate --latest --strict
LABEL=after-C2 pnpm perf                      # .perf/after-C2-<timestamp>.json に保存
node scripts/perf-probe.mjs --modes 1,2,3,4,5,6 --tiers 0   # 6 = ディレクター（ゲートは報告のみ）
node scripts/perf-probe.mjs --views paddock-heli,garage-front --tiers 1   # モード歩行の後に固定視点（shot-presets.mjs）を `view:<name>` 行で採取（既定 3 視点、`--views none` で無し。ゲートは報告のみ）
pnpm perf:gate                                # 最新の .perf/*.json を scripts/perf-budgets.json と照合
node scripts/perf-gate.mjs --file .perf/after-C2-….json --against .perf/after-phase6-….json   # Δ 列付き
```

天井は `scripts/perf-budgets.json`（ティア／モードごとの三角形・draw call の平均と最大、setupMs、programs）にあり、
平均は budget × (1 + band) で FAIL、budget × 0.9 で警告、最大はベースラインの max/mean × 1.1 倍まで。数式はファイルの
`comment` にそのまま書いてあります。probe は遠景（`__suzuka.env.farField.pending === 0`）が組み上がるのを待ってから採取します。
天井の数値は R フェーズ末（2026-09-12、`.perf/after-r6-…`）の実測 +12.5 %（warnAt 0.9 の直下）で、最大は
max(従来値, 実測 max / mean × 1.1)、programs は実測の最大 +4（高）/ +2（低）です。R フェーズ（柵の外の道路リボン・道路脇の設備・
パックの樹木・ヒーロー家屋と車・太陽光の詳細・地形系）で俯瞰は draw call ≈ +110、三角形 ≈ +2 %、追従モードは 110 m 以内の樹木メッシュで三角形 +10〜17 %。低ティアの `setupMs` ≈ 17〜19 s（SwiftShader）は地面の区画（プラン ≈ 7.0 s＋
メッシュ ≈ 7.1 s、P3〜P6）で、周辺の同期ビルドは 1 s 未満、遠景は遅延ビルドなので setupMs に入りません。draw call の内訳（パスごと・グループごと）は `__suzuka.ctx.renderer.renderBufferDirect` を包んで数えるのが早道で、
高ティアは影のパス（CSM 3 段）が全体の 4〜6 割、そのうち車が 22 台 × 部品 × 段数で 250 前後を占めます。

```bash
pnpm exec playwright install --with-deps chromium   # 初回のみ（sudo が必要）
pnpm test:e2e            # dev サーバー（port 3100）を自動起動して実行
pnpm test:e2e:headed     # ブラウザを表示して実行
pnpm test:e2e:report     # 失敗時の HTML レポート / トレースを表示
```

テストは `tests/e2e/` にあり、シーンの描画確認には dev モードでのみ公開される
`window.__suzuka` フックを使っています。`race.spec.ts` の 'infield and ops layer'（I3-d）は運営レイヤーの事実を読みます:
`env.stats.ops.figures > 200`・`impostors === figures`・`near3d` が 0 か figures（高ティア + パックの 3D 近景は全員に付く）・`byRole` の 5 役割・`mode` が baked / procedural、`vehicles ≥ 30`、
`group.userData.ops` に 300 行超で truck / vehicle / cabin / tent / container / equipment / tyres / cone / flag の kind、静的車両は
`models` に入らない（22 のまま）、`stats.crowd.impostors` の窓（0.9 × budget … budget）が動かない、`farField.stats().byKind.ops ≥ 1`
と失敗 0、`ops-figures-` / `ops-vehicles-` / `ops-pitEquipment-` の接頭辞、`buildMs.ops`、`groundCensus()` の mismatch 0。

## Controls

| 操作 | 内容 |
| --- | --- |
| ドラッグ / ホイール | 俯瞰カメラの回転・ズーム（OrbitControls） |
| `W` `A` `S` `D` | 俯瞰カメラを画面の前後左右へ移動（カメラと回転の中心が一緒に動く。速さはズームに比例し、コース周辺の範囲で止まる） |
| 車・タグ・タイミング行をクリック | ドライバーを選択（テレメトリとロワーサードを表示） |
| `1` `2` `3` `4` `5` `6` | OVERVIEW / HELI / CHASE / ONBOARD / TV / AUTO（ディレクター） |
| `↑` `↓` | 選択ドライバーを順位順に切替 |
| `Space` | 一時停止 |
| `L` / `M` | ドライバータグ / トラックマップの表示切替 |
| `Esc` | 選択解除して俯瞰に戻る |
| TV / AUTO 中 | 操作 UI は自動的に隠れ、マウス移動・クリック・キー操作で 3 秒間表示。`M` はドライバートラッカーを常時表示に固定 |
| 画面右下 | シミュレーション速度 1×〜8×、音のオン／オフ、リスタート、時刻スライダー（太陽の位置） |

レースは最初のクリックまたはキー操作で始まり（操作が無ければ 8 秒後に自動開始）、音もその操作の後に始まります。
スタートシグナルには F1 公式ゲーム風の短い電子音（約 1.5 kHz・約 0.1 秒、5 灯とも同じ）が 1 灯ごとに付き、消灯は無音（実際のゲートリーと同じく、観客のスウェルのみ）で、グリッドではアイドル中のエンジンが鳴ってランプに合わせて回転が上がります。
エンジン音は 2026 年規定の V6 ターボハイブリッドを想定し、クランク回転数の ½・1・1½・3 次で低く重い芯を作り、ターボの吸気音、MGU-K の回生／放出音、
シフト・オーバーランの破裂音、距離による高域減衰、オンボードと外の音色差、観客のスウェルを合成しています。

## Structure

```
app/
  app.vue                      # ビューポート + HUD のレイアウト
  assets/css/main.css          # 中継グラフィックの共通スタイル
  components/
    RaceViewport.client.vue    # three.js シーン、レンダーループ、車の挙動表現、エフェクト、HUD 同期、ディレクター
    hud/                       # TimingTower / Telemetry / TrackMap / Controls / StartLights / Banners / Battle / LowerThird / ResultPanel / RaceHeader
    hud/broadcast/             # TV / AUTO 用の放送パッケージ: Layer（キャンバス）/ Tower + TowerRow / Strap / NameStrap / Battle / Onboard / Tracker / Weather / Strategy / Tyre
  composables/
    useRaceStore.ts            # HUD 用のリアクティブなレース状態（放送パッケージの状態 `bc` を含む）
    useBroadcastGraphics.ts    # 放送グラフィックスのディレクター（ストラップの優先待ち行列、ロワーサード、タワーモード周期、ペイン、バトルのヒステリシス）
    useHudScale.ts             # 1920×1080 の設計キャンバスをウィンドウに合わせて拡縮
    useTrackGeometry.ts        # コース形状の SVG パス（トラックマップとドライバートラッカーで共有）
  data/
    suzuka.ts                  # 中心線（実測）、標高・幅・カントのキーフレーム（DEM5A）、レーシングラインのピン、コーナー速度目標、DRS、ピット
    suzuka-facilities.ts       # OSM 由来のフットプリント（スタンド・ピットビル・建物・ランオフ・水面・レースウェイ・柵内の硬地 apron／駐車場 parking／歩行者トンネル tunnel／歩道橋 footbridge／柵内の管理道路と教習コース road（SERVICE_ROAD_WAYS）、ODbL、生成物）
    suzuka-facilities-spec.ts  # スタンドの列・蹴上・構造・色、ランオフ帯、塗装エプロン、ピット定数、季節パレット、地面行 GROUND_AREAS、インフィールドの施設 INFIELD_FACILITIES / INFIELD_PARKING / INFIELD_LAMPS / INFIELD_ISLAND_KERBS / SOUTH_COURSE_KERBS（手書き）
    suzuka-barriers-spec.ts    # 全周のバリア run（`BARRIERS` 73 本: I4-c で色・上部レール・写真窓・門・面塗装・広告帯のフィールド、`AD_PANELS` 5、`SIGNS` の pitEntry）・実在する縁石／緑帯・白線・二輪路・マーシャルポスト v2（`MARSHAL_POSTS` 32 行 + `marshalNumbers()` / `marshalNumberFaults()` + `TRACKSIDE_CCTV`）・`TV_CAMERAS`・`TYRE_STACK`（予備タイヤ列の寸法、barriers.ts と A11 が読む）・調整池（手書き、OSM way id 参照）
    suzuka-power.ts            # 送電鉄塔・架線（OSM、生成物）
    suzuka-dem.ts              # 柵の外の標高: 30 m 汎化グリッド（DEM5A σ20 m、±3.3×2.9 km）と 500 m 遠景グリッド（DEM10B、±35 km）。国土地理院、生成物、ASL 整数の int16 デルタ
    suzuka-surroundings.ts     # 柵の外の土地利用（森・田・草地・水面・小川・駐車場・太陽光・建物・道路・鉄道・サイト。OSM、ODbL、生成物）
    surroundings-spec.ts       # 柵の外の手書き定数（色・幅・密度・LOD レンジ、SUR_SKIP_IDS = building タグだが建物でない way。ODbL 外）
    en-codec.ts                # 周辺データの EN 座標ストリームの復号（int16 デルタ base64 → EN / world）
    dem-codec.ts               # DEM グリッドの形と復号（`DemGrid`、海の sentinel、双線形サンプル）
    crowd-atlas.ts             # 観客インポスターアトラスのレイアウト（焼き込みスクリプトと対；`CROWD_HELMET_ROWS` = 行 28–31 の白ヘルメット姿勢、運営レイヤー用）
    credits.ts                 # アプリ内クレジット（生成物）
    tree-species.ts            # 樹種の表（役割 → パックのノード正規表現・LOD・高さ・色味・樹冠色・風、TREE_MIX の配植比率。手書き）
    infield-trees.ts           # INFIELD_TREES の純展開 `infieldTreePlacements(track)`（行 → world 点 + 窓内の (s, lateral)。vegetation.ts と facilities-check O10 が同じ点を読む）
    ops-spec.ts                # 柵の内側の運営レイヤーの純データ・純関数（three 非依存。ops.ts の 3 ビルダー、facilities-check §16、ops-smoke が同じ行を読む）。4 区画: A 型と配置 `OPS_LAYOUT`（全座標を PIT_ENVELOPE.stop / GARAGE_CENTRES / PADDOCK_* から導く、停止位置のリテラル無し）+ 共有ヘルパー `stoppedCarRect(block)` / `lensColumns()` / `inWorkArea` / `crewSlots(block)` / `perchSeats(block)` / `coreEdges()` / `OPS_WINDOWS` / `OPS_TEXTS`（I3-a）、B `vehiclePlacements()`（I3-b）、C `pitEquipmentPlacements()` + `PIT_EQUIPMENT` / `fromStop` / `KEEP_OUT_EDGE` / `perchCentreS` / `perchOnPlatform`（I3-c）、D `figuresAt()` / `flagPlacements()`（I3-d）。A には I4-a の `MARSHAL_STAND` / `marshalStairSign` / `marshalSlots(post)` / `marshalPostFigures()` も（トラックサイドのマーシャル、mount 'trackside' / 'platform'、D の `figuresAt()` に含まれる）、I4-c の `windowSlots(lineAt)`（柵の写真窓の写真家、`figuresAt({ lineAt })` で付く）。`opsPlacements()` = B + C + D の連結
    drivers.ts                 # 2026 年グリッド（11 チーム 22 名）、チームカラー
  sim/
    track.ts                   # スプライン（5807 m 正規化）、曲率、幅・カント・勾配、最小曲率レーシングライン、立体交差、ピットレーン
    race.ts                    # 車両モデル（ライン曲率のキャリブレーション、グリップサークル、勾配、燃料/レースモード、タイヤ、追い越し、ピット、計時、ギア）
    brake-thermal.ts           # ブレーキディスクの熱モデル（入熱 ½Δv²、車速比例の対流、T⁴ 放射。レンダラーと Node ハーネスで共用）
  three/
    quality.ts                 # 品質ティアの数値テーブル `QUALITY` と GPU ケイパビリティ検出（`?fx`、`EXT_clip_control`）
    scene.ts                   # レンダラー、深度方式（反転 Z / 対数）、CSM 太陽光・影（更新間引き）、IBL、空、時刻（太陽位置）
    post.ts                    # ポストプロセス（GTAO、HDR bloom、望遠 DoF、モーションブラー、ビネット、グレイン、色収差、SMAA）
    emissive.ts                # 発光値の一覧（bloom 閾値に対する輝度設計、ブレーキディスクの黒体ランプ）
    instancing.ts              # サーキット全域の InstancedMesh を地形チャンク／距離でバケット分割（フラスタムカリング）
    ground.ts                  # 地面の入口: Ground（plan・field・standY／decalY／decal = 描画済み面）、デカールの段 LAYER、地面に立つ物の表 GROUND_OBJECTS
    ground-plan.ts             # 地面の区画（XZ で 1 点 1 オーナー）: 駅・カラム・範囲（fold／二等分線／橋の上限）・PRECEDENCE・RULE_OF・ownerAt、`{ cut }` 足跡（CutField の廊下多角形、範囲を広げない、廊下の s 幅に 1 m の行）、`roadFrameReach`
    ground-field.ts            # 唯一の連続した高さ場（路肩 2 m のストリップ規則、2〜8 m の混合、地形 + RUNOFF_LIFT）と CutField（I6: CUTS の廊下 = ポータルから heading へ grade で上がる床、壁裾 0.6 m の smoothstep、路面フレーム・BARRIERS 線・フィル列を避けた始端、`cutAt` / `yNoCut`。「切通しとトンネル（R6）」参照）
    ground-mesh.ts             # 区画をメッシュにする: 頂点プール（共有頂点・1 頂点 1 高さ）、ラスター、縫い合わせ帯、リングのワールド部、種類別 ground:<kind>
    ground-materials.ts        # 種類別マテリアル（路面・縁石・帯・エリア・パドック = 高ティアは asphalt_04 PBR + マクロ、パック無しは灰ノイズ・ヘリパッド・池）
    track-mesh.ts              # 地面でないもの: ソーセージ（地面に立つ物）、塗装エプロン・緑帯・DRS 線（描画済み面を切り出して持ち上げたデカール）、スタートゲートリー（白バナー 2.0 m、5 列 × 4 段のランプパネル — レースが点けるのは上 2 段、EM 情報板、右脚はピットウォールの歩廊上）
    barriers.ts                # 全周のバリア v2（実データ表 `BARRIERS` から: concrete046 のコンクリート壁（FrontSide + 裏面リボン）・セグメント化した帯のタイヤ壁 1.5 m とその裏のタイヤ積み（`infield-tyreStacks` プロップセット）・ガードレール・130R の 3 本ビーム・色付きデブリフェンス（緑／2024 黒、上部レール + ケーブル 2、写真窓、門、観客側 2 重柵）・シケインのスポンジブロック・壁面／壁天端の広告帯・自立 12 × 4 m パネル・ラウドスピーカーホーン。「柵・バリア・看板・サイン」参照）
    trackside.ts               # OSM way／実測サンプル → 所属道路の lateral(s) 解決（図 8 の折り返し対策つき）
    lines.ts                   # 白線レイヤー（全周のエッジライン、ピット各線、グリッド。描画済み面を切り出したデカール。画面上の最小幅を保つ頂点シェーダ）
    lanes.ts                   # 二輪シケイン・スリップロードの縁石（地面に立つ物: standY 上、幅は GROUND_OBJECTS で有界。舗装そのものは OFFSET_LANES の足跡として地面の区画が描く）。`sweepKerb`（規則・閉ループ可）はパドックの島縁石も掃く
    environment.ts             # 地形（高さ場: 路面 IDW → 実 DEM のクロスフェード、施設のリリーフ、格子縁のスナップと粗いリングの高さ・法線）と各ビルダーの共有コンテキスト、観覧車
    dem.ts                     # 実 DEM の高さ場（内側は双三次、遠景は双線形、外周 300 m でクロスフェード、水面ポリゴンの底）— 1 Track に 1 つ
    terrain-far.ts             # 格子の外: 粗いリング `terrainRing-0..3`（継ぎ目の頂点・法線を共有）、DEM_FAR の山並み `terrainFar`（頂点色、フォグの傾斜パッチ）、水面 `water-far`（材質は `waterFarMaterial()` — 池と同じ 1 プログラム、transparent 0.9）
    landcover.ts               # 土地利用マスク（OSM の層を CPU スキャンラインで RGBA8 2 組に描く: 森・田・舗装・駐車場・水・太陽光・集落・畦）と芝シェーダ用のディテールタイル。道路はカバレッジ AA の帯で、リボンの下は細める（遠方 LOD）
    farfield.ts                # 遠景の登録簿と遅延ビルド（250 m セルの LOD、ローディング後のタイムスライス）
    far-geometry.ts            # 地形の三角形に沿ってポリゴンを切る（`cellClippedPolygon`）: 区画の面と 140 m 圏を避け、standY に貼り、外周からスカートを立てる。リボン版 `cellClippedStrip`（四角ごとに地形三角形でクリップ、属性は逆双線形で補間、リングはノード高で drape）
    road-section.ts            # 柵の外の道路網（道路・設備・電柱・並木・地形系が共用）: OSM way の復号、交差点（共有ノード）、ランクとトリム／オーバーシュート、フィレット弧、区画線の抑止窓・停止線・横断歩道・信号、サンプル列、`nearestRoad`
    roads.ts                   # 道路リボン（'paving' ステージ、1 km ブロック static）: 断面行（路肩・クラウン・クラス段）、解析区画線の属性、橋の剛体デッキ＋高欄＋フェイシア、リングの tertiary+、キープアウト
    far-lines.ts               # 遠景ビルダー共通の折れ線・立地ヘルパー（`resample`・`siteOk`・`KeepOutGrid`・`TriSink`）— outskirts / roads / forest / terrain-side が共用
    model-proto.ts             # GLB → インスタンス用プロトタイプ（int16 属性の拡張・material 分割・ノードパス選択・原点合わせ・頂点色の保持）— 樹木・小物・車体が共用
    surroundings.ts            # 柵の外のビルダーの入口（'paving' → 'buildings' → 'dressing' の順に roads / buildings / vehicles / outskirts を遅延登録）
    forest.ts                  # 森（OSM の森ポリゴン）: 250 m セルの樹冠マス・森床、植林の等高線列／自然林の格子の配植（種は TREE_MIX）、生垣・竹の株、桜並木（サーキット道路とゲート周り）— 描画は trees.ts
    trees.ts                   # 樹木ライブラリ: パック GLB → 種ごとの LOD0/1/2 プロトタイプ（model-proto）、風・逆光半透過・個体色の葉材質、インポスターカード、セルごとの emitTrees（ヒーロー LOD0/LOD1 → 一般 LOD1/LOD2 → カード → 樹冠マス、Node／低ティアはコーン）
    buildings.ts               # 柵の外の建物: 種別ごとのマッシング（寄棟瓦・パラペット＋金属屋根・窓帯・キャノピー・温室のアーチ・トタン小屋）、14 層の facade 配列テクスチャ（瓦・釉薬瓦・トタン 2 種は写真の WebP を読み込み時に流し込む、法線配列付き）、ブロック塀と門、屋根の PV、室外機・LPG・給湯器、工場のシャッター、モートピアのコースターとプール、キャンプ場
    hero-buildings.ts          # 足跡に合う家屋を Sketchfab の GLB（reckzilla の日本家屋 3 種、kasuga のアパート）で置換: OBB の適合、正面は道路側、台座の上に、モデルごと 1 InstancedMesh
    vehicles.ts                # 駐車場の車: OSM の駐車場に枠を切り、近景は Sketchfab の軽ワゴン・軽トラ・ハイエース・路線バスの GLB（260 m、輝度マスクで塗装だけ着色）→ 手続き車体（500 m）→ インポスターカード → 俯瞰の点描（車種と配色は car-bodies.ts）
    car-glb.ts                 # GLB 車体の抽出（鼻を +z、CAR_DIMS の長さに）と輝度マスクの材質（明るいテクセル = 塗装が instanceColor を受ける、ガラス・タイヤは受けない）— インポスター焼きと共用
    car-bodies.ts              # 低ポリの車体 7 種（ミニバン・軽・軽トラ・SUV・ハッチ・セダン・バス、頂点色の部位マスク、軽 ≈ 33 %）— インポスターのベイクにも使う。運営レイヤー用の箱トラック 'truck'（アトラス行なし、CAR_MIX 外）
    outskirts.ts               # 郊外の設備: 太陽光アレイ（SolarPanel003 のパネル面、600 m 以内は架台の支柱・レール・インバータ小屋・外周フェンス）、外周フェンス、照明柱、JIS 12 m 級の電柱（8 角テーパー、高圧腕金＋低圧腕、6 本の架線、道路網に沿って交差点の口は避ける）
    terrain-side.ts            # 地形系のオーバーレイ（'dressing'、1 km ブロック static）: 田の畦（マスクと同じ 30×90 m 格子）と用水路、伊勢鉄道（バラスト道床＋枕木テクスチャ、盛土、高架の桁と橋脚、2 本のレール、踏切）、小川（集落内はコンクリート護岸、他は土手、川は堤防、水面帯、道路との交差は暗渠）
    road-furniture.ts          # 道路脇の設備（'dressing'、1 km ブロックごとに材質別 1 メッシュ、700 m）: Gr-C ガードレール（W ビーム＋φ114 支柱、県道は両側、市道は急カーブ外側と盛土）、視線誘導標、カーブミラー、止まれ／速度／警戒標識（erikkinc のパック、無ければ手続き板）、信号機と制御箱、電柱の変圧器
    structures.ts              # 立体交差の桁橋（スラブ・2.0 m 化粧板・青白ガードビーム・鋼桁・橋台・翼壁・側道）、地下道の高欄（`structures-underpass-rails`。シケイン側道橋は I6-b で FOOTBRIDGES → cuttings.ts へ）、看板とピット出口信号、ピット入口分離壁の 'PIT ENTRY' 板（mount barrierTop、I4-c）（signAtlas / signUv は pit-lane.ts の壁天端標識と共用。pitWall* の行は壁のビルダーが描く）
    lattice.ts                 # 鉄骨ラティスのプロトタイプ（送電鉄塔・リーダータワー・スタートゲートリーで共用、低ティアはブレース無し）
    impostor.ts                # インポスターの共通実装（アトラスのレイアウト・方位セル・マスク着色・疑似法線）— 観客・車・樹木で共用
    stands.ts                  # OSM フットプリントと座席仕様から全スタンドを生成（段床・座席・柱・屋根・ガラス帯・足場・裏方・案内板）、パスフレーム、座席数クランプ、地形リリーフ（スタンドの丘・台地、GP スクエア、パドックの右側 1 平面）
    pit-complex.ts             # ピット複合体の入口（buildPitComplex = pit-building を呼び buildingRoofMat を返す薄い層。ピットレーンとパドックは infield.ts の傘から）
    pit-geometry.ts            # ピット系の純幾何・キャンバス補助（frameAt / sweep / texturedWall / trackPrism / podLoft の弾丸ロフトと podBand / podFlank（帯・丸窓）、smoothProfile / remapV、canvas / label、PIT_TEXTS、3 ビルダーが共有する材質 pitMaterials(ctx) — soffitShellMat / railGlassMat を含む、addMerged）
    pit-building.ts            # ピットビル v2（2009 図面の断面を勾配追従スイープ: 1F ガレージ列・ファシア梁・2F/3F テラス・曲面キャノピー、折戸・シャッター・番号札、階段塔、銀灰のコントロールポッドとメディア区間、T1 ノーズ、ビジョン 8、ガレージ内装とウォッシュ・機材の prop set 'ops-garage'、裏キャノピー／タイル壁／窓帯／スパー橋、屋上設備、表彰台、テラスの観客 'ops-terrace'。canopyTopAt を export。§ピットビル v2）
    infield.ts                 # 柵の内側の傘: buildPitComplex の直後に pit-lane → paddock → ops → marshal-posts + tv-towers → infield-ground → infield-water → cuttings を同期で呼び、buildMs（pitLane / paddock / ops / trackside / infield）と stats.ops / trackside / infield を出す
    pit-lane.ts                # ピットレーン（PIT_WALL v2 の断面、「ピットレーン断面」参照）: 0.7 m コンクリート壁 1.8 m と入口端の白ブロック、両面の広告帯（レーン面に 80 リング）、天端のデブリ金網と支柱、歩廊 +0.5・白縁石 +0.45・パイプフープ 266（60 m ベイの IM）、固定プラットホーム 31–69、スターター台、ブロック境界のキャビネット、W ビーム区間（丸支柱 IM + 白パイプ柵）、補助レーンの青帯 + 白縁線（LAYER.pit.band のデカール）、壁天端の 60 / FIRE STATION 標識、リーダータワー（チームの prat perch は ops-pit.ts、I3-c）
    paddock.ts                 # パドック（I2-b/c、表 PADDOCK_BUILDINGS / PADDOCK_OFFICE / PADDOCK_FENCE / PADDOCK_LAMPS / PADDOCK_MASTS / PADDOCK_PARKING / PADDOCK_BAY；I5-b でインフィールドと共用の `layoutBays` / `bayLineQuads` / `carPropSets` / `parkCar` / `lampPoleProto` / `rollerShutterProto` を export）: チームオフィス段状モジュール（IM `teamOffices`）と A 棟 2 階、センターハウス（OSM 押出し + 楕円キャノピー + 丸柱 16 + 舗石デカール）、SMSC、給油所（島縁石 = islandKerb）、サービスハウス・タイヤガレージ、車両基地、緑金網フェンス（`paddockFence` 垂直面のみ + 支柱 IM）と門 3、街灯（`infield-lamps`、手続きポール）、照明マスト 2、駐車場（I2-c: `paddockBays` が世界座標 m で列を歩き paddock 面上・包絡外・フットプリント外・平らな区画だけ残し、白線デカール `paddockBayLines-<id>`、黄ハッチ `paddockHatches`、車 `infield-paddock-cars` = carBody / carGlb + covered_car）。v1 から残すのはトランスポーター・テント・旗（I3 まで）と BUILDINGS の他行の押出し（`paddockBuildings`）。I2-a: センターハウス芝島（PADDOCK_ISLAND）の縁石リング。地面は GROUND_AREAS の paddock 行（A 南列・回廊・B・B 斜め・E + 接続・前庭）
    ops.ts                     # 運営レイヤーの傘（I3-a）: ops-vehicles → ops-pit → ops-people を順に呼び、部分統計を `stats.ops`（figures / byRole / impostors / near3d / mode は people、vehicles は vehicles、equipment は pit + vehicles）に併合し、全配置を ctx.ops（= group.userData.ops）に積む
    ops-vehicles.ts            # 運営レイヤー (I3-b): 白箱トラックのトランスポーター（チーム色帯）、2 t トラック・バン、航空コンテナ、ホスピタリティ、ガゼボ／マーキー、放送コンパウンド、SC／メディカル／コース車両・クレーン（ops-spec B `vehiclePlacements()` 105 行 → registerPropSet 'ops-vehicles' / 'ops-hospitality' / 'ops-tents' / 'ops-containers' / 'ops-compound'；GLB 車両は部位毎 `carGlb|tint` + 共有白 map、遠段は手続き車体）
    ops-pit.ts                 # 運営レイヤー (I3-c): ガントリー（支柱・梁・腕・信号灯・ホースのホイールガン）、タイヤスタック、ジャッキ、燃料台車、モニター台、コーン、ケーブルランプ、消火器、ピットボード、ピットウォール・ペルチ v2、固定プラットホームの TV カメラ（ops-spec C `pitEquipmentPlacements()` / `PIT_EQUIPMENT`、registerPropSet 'ops-pitEquipment' / 'ops-perches' / 'ops-cones' / 'ops-cables'。「運営レイヤー」参照）
    ops-people.ts              # 運営レイヤー (I3-d): クルー／オフィシャル／マーシャル／写真家／スタッフ 298 体 + I4-a のトラックサイドマーシャル 90 + I4-c の柵の窓の写真家 7（ops-spec D `figuresAt({ lineAt })` → `figureToWorld` → figures.ts buildOpsFigures、役割毎の 'ops-figures-crew' / '-officials' / '-marshals' / '-photographers' / '-staff'）と E パドック縁の旗 8（`flagPlacements()` → registerPropSet 'ops-flags'、静止）。「人物配置」参照
    marshal-posts.ts           # マーシャルポスト v2（I4-a）: 架台上のキャビン 28 + 低ポスト 3（`registerPropSet 'infield-marshal-cabins'`、GLB の警備ブース／消火器が近景）、番号板 29（`marshalNumbers` メッシュ、8 × 4 アトラス）、消灯 EM パネル 30（`emPanels` IM、発光無し）、PTZ CCTV 42（`cctvPoles` / `cctvHeads`）、旗架・消火器・キャビネット。「マーシャルポスト v2」参照
    tv-towers.ts               # TV カメラ塔（I4-b: TV_CAMERAS の行ごとに足場塔／格子塔／黄クレーン柱／ポール、天板・手摺・梯子・三脚・カメラヘッド（security_camera_01 の glbOr）、操作者 1 人、registerPropSet 'infield-towers' / 'infield-tower-cams'、group.userData.tvLenses。「TV タワーとレンズ」参照）
    tv-lens.ts                 # TV レンズ点の唯一の解決（純関数）: cameraSide、'auto' 横位置 = バリア線 + 2.5、towerBaseAt（4 隅の最高地面）、tvForwardOf（天板半幅 + 張出し 0.7）、tvLensAt（塔中心・レンズ・世界座標）、TV_LENS / TV_TOWER_FOOTPRINT / TV_DECK_HALF — 塔ビルダー・カメラリグ・facilities-check O7 / A11・barriers.ts（塔下のタイヤ積み省略）・smoke が同じ数を読む
    infield-ground.ts          # インフィールドの地面の上の物（I5）: I5-a = 管理道路・教習コースの破線中央線デカール（`wayLineDecal`、LAYER.verge.line、面の無い所・路面・段差の上は塗らない）と BUILDINGS `builder: 'infield'` の押出し（交通教育センター）。I5-b = `buildInfieldFacilities`: 表 INFIELD_FACILITIES（シェッド・小屋・ガレージ + シャッター・西コントロールタワー・マーキー・タンク・ブロック / タイヤ積み（markObject tyreStack）・旗竿・照明マスト・壁・金網柵・コンパウンド）を材質毎の `furniture-infield-<mat>` と IM セット `infield-*` に、南コースのエイペックス縁石（SOUTH_COURSE_KERBS、laneKerb）、島縁石（INFIELD_ISLAND_KERBS）、インフィールド駐車場の車と白線（INFIELD_PARKING、paddock.ts の layoutBays / parkCar 共用）、管理道路の街灯（INFIELD_LAMPS）。地面そのものは GROUND_AREAS の行が描く（README「柵の内側の地面行」）。池は I5-c
    cuttings.ts                # 切通しとトンネル（I6-b: CUTS 廊下の擁壁 `furniture-cut-walls`（壁裾に立つ preconcrete 板 + パラペット + 手すり）、坑口ヘッドウォール `furniture-cut-portals` / 白笠木 / 黒箱 `furniture-cut-tunnelInterior`、歩行者トンネルの階段 `props-cut-stairs`、FOOTBRIDGES の剛体デッキ `structures-footbridge-<id>`（Q2 の歩道橋 3 + シケイン側道橋 v2）。場と地面行は I6-a: ground-field.ts CutField と GROUND_AREAS の `{ cut }` 行。「切通しとトンネル（R6）」参照）
    props-pack.ts              # 柵の内側の小物プロトタイプ: パック GLB（model-proto + orientPack、部品ごとの材質）か手続き版を同じ形 PropProto に、テクスチャ集合／色ごとに材質を共有する PropCache、ティアの切替 glbOr
    infield-lod.ts             # 小物セットの LOD と実体化 registerPropSet（250 m セル × 段ごとに 1 InstancedMesh、GLB の近景 → 手続きの遠景 → 空、近景だけが影を落とす、低ティアは 1 バケット）、周回柵の内外判定 insideRing（OSM 775428456）
    figures.ts                 # 人物の共通部（crowd.ts から昇格）: 焼き込み／手続きインポスター、GLB の 3D プロトタイプ（部位 id、白ヘルメットの第 5 部位）、部位着色材質、運営レイヤーの姿勢・役割（marshal / official / crew / photographer / staff / guest、座り姿 sit / sitF）と buildOpsFigures（kind 'ops'、観客予算とは別勘定）、ピットビル 2F/3F テラスの座席スロット terraceSlots
    props.ts                   # 距離看板（黄地黒数字、I4-c）、Spoon ランオフの塗装ロゴ（`runoffLogos` デカール、I4-c）、送電線（鉄塔はトラス腕・碍子連・架空地線の頂部、7 本目のケーブル）、二輪・カート舗装のキープアウト（マーシャルポストとデジタルフラッグは I4-a で marshal-posts.ts へ、TV カメラ塔は I4-b で tv-towers.ts へ、'SECTOR 2 / 3' 板は削除 — 鈴鹿に実在しない）
    vegetation.ts              # トラックサイドの樹木の散布（棄却サンプリング、桜ゾーン、キープアウト、柵リング 775428456 の内側は SUR_FOREST の外で禁止）、INFIELD_TREES の配植 `emitInfieldTrees`（'trees' ジョブの先頭 + 南コースの遅延ジョブ 'infield-south-trees'）と Node／低ティアのコーン原型
    infield-water.ts           # 池と乾いた池（I5-c）: BASINS の `surface` 行に水面 `furniture-infield-pond-<i>`（`waterFarMaterial` 共有、岸 −0.3 m、島の穴付き earcut）とデッキ、dry 行に葦 200（`infield-reeds`、{ map, alphaMap, alphaTest, DoubleSide } = 唯一の新プログラム）と水たまりデカール `infield-puddles`。「池と樹木」参照
    boxes.ts                   # 単一マテリアルの箱をマテリアルごとにマージする placer
    crowd.ts                   # 観客: 焼き込みアトラスのインポスター（方位・仰角セル、個体着色、歓声フリップブック）と近景 3D、60 m ベイの LOD、占有抽選 → 誤差拡散の予算配分（インポスター・プロトタイプ・材質は figures.ts）
    banks.ts                   # 芝土手の観客（クラスタ格子の立ち位置、レジャーシート、ポップアップテント）
    assets.ts                  # アセットパックのローダー（manifest、KTX2 / meshopt、404 フォールバック、進捗）
    materials.ts               # 実写 PBR マテリアルのファクトリ（ARM パック、hand-built UV の法線規約、芝の緑化ムラ）
    car-model.ts               # 2026 年規定のマシン（ロフト車体、翼型ウイング、可動フラップ、リバリー、キャスター／キャンバー付き足回り、ブレーキディスク、ドライバー人形、3 段階 LOD）
    driver-figure.ts           # ドライバーの胴体・腕（前腕はハンドルに追従）・ステアリングホイール
    particles.ts               # 火花（速度方向に伸びる）・タイヤスモークのパーティクル、テクスチャ付きで薄れるスキッドマーク
    sky-extras.ts              # 雲ドーム（半径 38 km、Sky と同じく far plane に固定。太陽ディスクは scene.ts の Sky パッチ、レンズフレアは post.ts のグレードが描く）
    sun-model.ts               # 太陽の数値モデル（空の輝度の膝、ディスク・光輪、太陽に向いたときの露出適応、フレア表）— three 非依存で Node から検証可能
    audio.ts                   # WebAudio 合成のエンジン音（次数スタック、ターボ、MGU-K、シフト／オーバーラン、ドップラー）、風切り音、群衆、スタートシグナルの電子音、オフラインプローブ
    cameras.ts                 # カメラリグ（オンボードの振動・G、TV カメラの操作者モデル — レンズ位置は setTvCameras で塔から受け取る、ヘリのバンク）
    textures.ts                # ノイズ生成の PBR テクスチャ（カラー／ノーマル／ラフネス）— 低負荷ティアと、アセットが無いときのフォールバック
scripts/
  sim-harness.mjs              # Node 用シミュレーションハーネス（pnpm sim、--brakes でディスク温度表、--pit-trace でピット包絡の実測、--envelope で 5 m ビンを書き出し）
  perf-probe.mjs               # 描画コストの計測（draw call、三角形数、区間時間をカメラ／ティアごとに採取、遠景の完成を待ってから。各行に race の時計と先頭車／選択車の s、`--views` で shot-presets の固定視点も `view:<name>` 行として採取）
  perf-gate.mjs                # .perf の計測を perf-budgets.json の天井と照合（pnpm perf:gate、--strict で FAIL なら exit 1。`view:` 行とディレクター行は報告のみ）
  perf-budgets.json            # ティア／モードごとの天井（平均・最大・setupMs・programs）と scene-cost 用の static/data 予算
  textures-lint.mjs            # テクスチャに描く文字列の商標リント（trademark-denylist.json / trademark-allow.json）
  sun-model-check.mjs          # 太陽モデルの不変条件（空の膝 < bloom 閾値 < 発光体 < プローブ < ディスク、露出の有界性、Sky.js のアンカー文字列）を Node で検証
  ts-hooks.mjs                 # `~/` エイリアスと .ts 解決のためのモジュールフック
  shots.mjs                    # 固定視点スクリーンショット（実写との比較用）
  shot-presets.mjs             # 固定視点の表 PRESETS（shots.mjs と perf-probe --views が共用。柵の内側の視点を含み、chase-in-box は PIT_ENVELOPE.stop から生成）
  facilities-check.mjs         # スタンド／ピット定数／ガレージ順／GROUND_AREAS の輪郭・layer 契約・RUNOFF_ZONES 衛生、表が参照する OSM id の実在（§6、--strict で error）、§16 ops-check O1–O12（運営レイヤー・マーシャルポスト・TV・インフィールドの表をピット包絡 PIT_ENVELOPE・chase レンズ・グリッド・バリア線・建物足跡・サーキットのリング・s 窓 OPS_WINDOWS と照合。停止車矩形 12 と chase レンズ柱 12 は ops-spec の `stoppedCarRect` / `lensColumns` から取り、全ブロックの `crewSlots` / `perchSeats` も今から検査。自由立ちの SIGNS は O2/O3/O4/O6 とレーン帯（ピット包絡は A11 の inPitLane）。`--envelope <json>`（`pnpm sim -- --envelope` の 5 m ビン）で箱帯の外の解析的キープアウトを実測に置き換え。無い表は「absent, skipped」）
  assets/                      # fetch / import-misc / bake-crowd-atlas / bake-car-atlas / sources（アセットパイプライン）、inspect-model（ドロップの中身）、retouch-glb（GLB 内画像の矩形修正・部品の削除）
  facilities/                  # build-facilities（Overpass → TS、--add-ways-from でキャッシュから役割付きの way を網なしで splice）、build-power、build-surroundings（柵の外の OSM → suzuka-surroundings.ts）、osm-common（Overpass 取得・EN 投影・DP・int16 デルタの共通部）、
                               #   dem-profile（DEM5A → 標高キーフレーム、--grid --far --write で suzuka-dem.ts、--relief で relief ゾーンの縁の検算、--verify で 34 駅の照合、--cuts で CUT 廊下の縦断表と廊下外の場の同一性）
  audit/                       # 実写との突き合わせ: aerial（国土地理院の空中写真モザイク）、overlay（アプリの線と OSM を重ねて区間ごとに切り出す）、shoot（区間ごとの真上・斜めショット）、osm-edge
                               #   surface-check（面のガード）、scene-cost（三角形／メッシュ／遠景の静的コスト）、app-runtime（アプリのビルダーを Node で走らせる土台）、
                               #   stub-registry（manifest の GLB をテクスチャ無しで読むスタブ登録簿と buildSceneWith — *-smoke の --glb が使う）、
                               #   ring（サーキットのリング 775428456 の復号と内外判定、Node 用）、smoke-common（I フェーズの smoke 共通部: 遠景の失敗 0・ops-*/infield-* の頂点有限とリング内・buildMs）、
                               #   pit-smoke / paddock-smoke / ops-smoke / trackside-smoke / infield-smoke（各フェーズの smoke、`--tier high|low|both`、check には入れない。trackside-smoke `checkPosts` = I4-a の事実、`--glb` で警備ブース／消火器／カメラのドロップ）
```

## Rendering notes

- **品質ティア** (`app/three/quality.ts`, `app/three/scene.ts`)：DPR、MSAA、影の解像度とカスケード数、観客・樹木・パーティクルの上限、各ポストパスの有無はティアごとに `QUALITY` にまとまっています。
  高品質モードは HDR（半精度・MSAA 4×）の描画ターゲットに float 深度テクスチャを付け、GTAO（追従カメラ時）→ bloom → 望遠 DoF（TV カメラが 8° 以下のとき）→
  グレード（カメラモーションブラー／ビネット／グレイン／色収差／放送風カラー）→ トーンマッピング（Khronos PBR Neutral）→ SMAA の順で合成します。
  深度は高品質モードでは反転 Z（`EXT_clip_control`、2 km 先でも mm 精度）で、対数深度は拡張が無い環境と低負荷モードのフォールバックです（そのときは深度を読むパスが無効）。
  bloom の閾値 4.5 は REC709 輝度に対する値なので、発光値は `app/three/emissive.ts` で輝度基準に設計しています
  （スタートシグナル、約 950 °C 以上のブレーキディスク、火花、ピットガレージの照明だけが光り、低負荷モードでは全体を 0.4 倍）。
  影は追従カメラでは毎フレーム、俯瞰では 2〜3 フレームに 1 回だけ再描画し、車は高品質で 250 m 以内が詳細メッシュ・400 m 以内が LOD1/2、低負荷では 120 m 以内だけが影を落とします（それより遠くは太陽方向に伸びる接地ブロブ）。
- **季節と施設**：再現しているのは 2026 年日本 GP 決勝日（3 月 29 日）です。路肩の高麗芝は休眠期の麦わら色（刈込縞なし、
  30〜60 m 周期の緑化ムラ）、桜が S 字・ヘアピン・パーク側に混じり、気象は 15 °C / 路温 26 °C。`SEASON`
  （`app/data/suzuka-facilities-spec.ts`）を `'autumn'` にすると 10 月のパレットに戻ります。スタンド約 30 基は OSM の
  フットプリント（ODbL）と座席図から生成し、C・E-1・E-2・I・IJ・J・Q1・R のように曲線内側で (s, lateral) スイープが
  折り返す所は OSM 前縁（`StandDef.path`）に沿ったパスフレームで組みます（`env.stats.pathStands`。右側スタンドは
  周回方向合わせのあとチェーンを反転させます — `sweep` は +v が +u の左にあるときだけ上を向くので、反転しないと段床が
  裏返ります。第 1 三角形の法線 y > 0 を全スタンドで検査し、dev では `console.error`、Node プローブは
  `env.stats.deckUp` を読みます）。屋根はデータ駆動の `StandRoof` 一本で、V2 の 18 × 186 m RC スラブ（`style: 'slab'`、
  ホスピタリティ帯が支えるので `columns: 'none'`）、A2 ピット側ブロック A2R と 130R の G 席後列バーの青灰の鋼製
  キャノピー（`style: 'canopy'`、`rise` で前縁から後縁へ立ち上がり、支柱は 420 m でカットしない独自の LOD）を同じ
  ビルダーが描きます。屋根の位置は地理院 z18 空中写真（`.cache/audit/sections/`）で読み、`unverified` に区間を記録。
  段床の下の丘や台地は `facilityRelief` が地形に切り欠き／盛土します。E-2 と E-1 の間の 13.2 m の階段の切り欠きは
  **1 つの主張**で、E-2 のプロファイルが端の接線方向に伸びて E-1 の最初の断面へ直線ランプで着地します（引き渡し線は
  横方向で動くので `notchAt(v)`）。同ランク同モードの主張は常に重み平均です。`TrackZone` は `side: -1` で道の**右**も
  主張でき、パドック（I0-c）がその唯一の例です: ピット直線の右、ピットエプロン（−24.9）から A/B 駐車場までは
  路面 −0.12 の**1 平面**（2009 年図面の 1,480 は基礎深さで段差ではありません）を `cut` で敷きます。`Terrain.flatZone` は
  最寄り中心線がピット直線の間しかその平面を出さず、S 字／NIPPO 側との二等分線の先は向こうの道の IDW で +2〜4 m の
  こぶ（ヘリパッドが +3.8 m）でした。核の外縁 A0(s) = min(125, D_NIPPO(s) − 56)（フェード 15 m の終端が NIPPO の hw 7 + 34 m の
  G5 帯の外に来る）、ヘリパッド円盤 (5566, −78, r 8) は核に含め、核は s 96 で終えて 12 m のフェードで T1 の池リング
  （rank 1 の cap、モード混在の継ぎ目を作らない）の手前 s 108 に着地、池リング内は主張しません。サンプル間の補間は
  両サンプルの接線方向距離の比（片側だけだと道から 90 m でサンプル切替ごとに 40〜60 mm 段になった）、核端では隣接する
  フェードサンプルと最寄り勝負（核優先だけだと 2 m 早く切り替わり 30 mm 段）。ピットビルは
  前面 lateral −25.1 / 奥行き 31.5 m の実寸で 2.8 % 勾配に追従し、ガレージ 1 は T1 側です。ガレージ区画は
  Mobilityland 2009 図面の 4.75 m × 4 ピット = 19 m ブロック 12 と 7 m コア 6（計 270 m、`GARAGE_CENTRES` /
  `PIT_CORES`、絶対位置は ±10 m 未確認）で、断面は 2009 図面のもの（§ピットビル v2）です。
  スタンドの裏には階段塔（天端は絶対値 = 最上段 + 1.1 m、0.5 m 以下なら省略）・入口ゲート・売店・V2 のボミトリーと、
  緑地に白の二か国語案内板（総合案内 / トイレ / 出口 / 入口 / 救護所 / 売店 / 西エリア。実在のロゴ・ワードマークは
  使いません）が付きます。
- **観客**：座席位置はスタンド生成器が返し、観客はその席に座ります（決勝の占有率 95 %、西エリアは疎）。高品質ティアは
  CC0 の人物モデルから焼いた 8 方位 × 2 仰角のアトラスをビルボードで使い、上着・ズボン・肌を個体ごとに着色、
  55 m 以内のベイは前列を 3D 人物で描きます。低負荷ティアは 16 体の手続きアトラスです。
  **占有の抽選が先**、そのあと 60 m ベイごとの誤差拡散で `rate = min(1, quality.crowd / 埋まった席)` を掛けるので、
  体数は決定的に `quality.crowd` 以下に収まります（高ティア 65,000 に対し 64,959 体、以前は約 79,000 体で予算超過）。
  座席スロットは出典のある公式席数だけにクランプします（C 13,698、V1 + V2 12,588 — 2026 年座席図 PDF の実測。
  列ごとの誤差拡散で間引き、デッキの椅子の家具は残します）。出典の無い席数は入れないので、生成器の総スロット数は
  約 83.7 k で、実物の公称値まで下げるには残りのスタンドの公式席数が要ります（`env.stats.seats`）。
- **芝土手の観客**（`app/three/banks.ts`）：逆バンクオアシス・E の丘・ヘアピン外側・J・西エリアの L / M / N・S 席の先の
  8 か所（`SPECTATOR_BANKS`）に、3〜6 人の塊が 1.5〜3 m 間隔で散らばるクラスタ格子で約 2,200 人を置きます。場所は
  `Ground.standY` の上（`SeatSlot.kind: 'lawn'`）なので、観客のベイ・LOD・アトラス・予算がそのまま効きます。座った塊の
  下には 1.8 m 角のレジャーシート（地面の面ではなくオブジェクト）、西エリアには 40 人に 1 つポップアップテント。
  焼き込みアトラスの座り姿は座席の上で焼いたので、芝の上では 0.40 m 沈めます。土手の近縁がフェンス付き BARRIERS run の
  後ろにあることと、ランオフに入っていないことは `facilities-check` が検査します。
- **光と時刻**：太陽は鈴鹿（北緯 34.84°）の 3 月末（赤緯 +3.2°）の時刻から計算し、スライダーで 10:00〜17:30 を動かせます。
  低い太陽では色温度・露出・フォグを暖色側へ寄せます。環境光は解析的スカイドームを PMREM 化したもので、
  `Sky` シェーダは背景専用です。r185 の `Sky` が描く太陽ディスク（線形値で約 3×10⁵、半精度の上限超え）と内蔵の雲は無効化し、
  `app/three/sun-model.ts` の数値で自前の太陽を描いています: 実寸 0.533° のディスク（60 linear）、Buie 型の光輪、
  そして散乱光全体を輝度 3.0 以下に抑える膝（bloom 閾値 4.5 の下なので空は決して bloom しません）。太陽が画角に入ると
  露出が 0.5〜1.1 EV 落ちて戻る（絞りは速く閉じ、ゆっくり開く）カメラの自動露出モデルが両ティアで動き、高品質ティアでは
  太陽が建物や山並みに隠れているかを 1×1 のプローブで測ってグレードパスのベイル・ストリーク・ゴースト（カメラ種別ごとの強さ）に反映します
  （山並みは深度を書くので、3 月 29 日の太陽は方位約 274° で鈴鹿山脈に沈みます）。
- **コース周辺の線形物**（`app/data/suzuka-barriers-spec.ts`）：バリア（73 本の run — I4-c で Spoon 内側の壁を追加）、縁石（実在する 28 本）、
  緑帯、白線、二輪シケインなどの舗装、マーシャルポスト、調整池はすべて実データです。出典は OSM の way id
  （`barrier=wall` / タイヤバリア / フェンス。閉じた面は track 側の縁だけを取る）と、空中写真から読んだ
  (s, lateral) サンプル。各 run は所属する道路の s 範囲を持ち、頂点はその窓の中だけで最近傍を探すので
  （`Track.nearestOnRange`）、図 8 の折り返しや立体交差で反対側の道路に飛びません。高さは所属道路の路面
  +3 m で頭打ちにして、他の道路の盛土を登らないようにしています。
  最近傍写像が使えない run もあります。シケインの Q2 スタンド足元の壁（OSM 470173101）は 160 m の 1 本ですが、
  コースがその間を北へ回り込むため、壁のどの頂点も最近傍の s が s 5178–5261 に入りません。こういう run は
  `source.project: 'ray'` を指定すると、各 s の垂線とウェイの交差で `lateral(s)` を求めます
  （このパラメータ化は単調ではないので、run は折り返し点で 2 本に分けます）。
- **地面の区画**（`RUNOFF_ZONES`・`KERBS`・`OFFSET_LANES`・`GROUND_AREAS` → `app/three/ground-plan.ts` → `ground-mesh.ts`）：
  地面は XZ の**区画**です。どの点も `PRECEDENCE`（路面 > 縁石 > 橋肩 > ピット > レーン > エリア > 帯 > 芝 > 地形）で
  決まる 1 つのオーナーが不透明に描き、隣り合うオーナーは境界の頂点を共有します（高さは 1 頂点 1 回、最上位の規則で）。
  ランオフは「路肩からの横方向の帯」を s に沿ってラスター化しますが、曲率半径 20〜23 m のアステモシケイン内側のように
  約 16 m 以上出すと**掃引フレームが反転して自己交差する**ので（`FOLD_SAFE`）、プランは範囲をフォールド・向かい合う
  道との二等分線・橋の 3 つの上限で切り、切られた面積は残余として計測します（`surface-check` G10）。帯で表せない面
  （カシオトライアングルの舗装、パドック、池、二輪シケインの舗装）は `GROUND_AREAS` のワールドポリゴン（OSM ウェイ、
  手読みの (s, lateral)）で、ラスターの外側だけをワールド XZ で三角形分割し、境界はラスターの頂点に縫い付けます。
  きつい曲がりの内側（ヘアピンの目、デグナー、シケインの T16）は折り返し（FOLD）でラスターが届かないので、そこは行で埋めます：
  OSM の `landuse=grass` / `natural=sand` ポリゴン（`osm`、共有辺のスリバーは `grow` で閉じ、`layer` で勝ち負けを決める）か、
  路肩の `edge` ノードと壁の `way` ノード（`verts` で使う頂点の範囲）で囲む手描きのリングです。(s, lateral) で書けるのは
  内側の縁の半径まで、その先は壁のポリラインを XZ で使います。
- **地面の契約**（`app/three/ground.ts`、`ground-plan.ts`、`ground-mesh.ts`、`ground-field.ts`。`scripts/audit/surface-check.mjs` が
  ビルドしたシーンをプランと突き合わせて全部計測し、`pnpm check` で強制します。ガード番号はそのスクリプトのものです）：
  - **R1 1 点 1 オーナー**。所有は `PRECEDENCE`（路面 > 縁石 > 橋肩 > ピットレーン > ピットエプロン > レーン > エリア行を
    layer 降順 > グラベル帯 > アスファルト帯 > 芝 > 地形）で**データの足跡**から XZ で決まり、ビルダーは高さで可視性を決めません。
    不透明な地面は区画の面だけ：`Terrain.addGroundFace` は `ground-mesh.ts` が発行した `GroundFace` しか受けません。
    G1 census（真上から見える面の種類 vs `plan.ownerAt`、境界 0.5 m の帯を除いて不一致 0。e2e は実行時の
    `__suzuka.groundCensus()` で同じことを見る）、G2 overlap（同じ点を覆う面は同じ面も含めて 0）。
    G1 は自前の格子（1 m × 0.5 m、プランを枠で引く）に加えて `ground-census.ts` の `groundCensus` そのものも走らせます
    （`runtime.mismatch` / `runtime.faces`）：e2e と同じ点集合（4 m × 2 m の路肩格子 + 各リングの内側 2 m 格子）を同じ
    世界座標の `plan.ownerAt(x, z)` で判定するので、ブラウザで落ちる census は `pnpm check` でも落ちます（I5-a で枠の往復
    `nearestOnRange → pointAt` が 40〜70 m 先で 0.3 m ずれ、リング判定だけが食い違った 2 点を G1 の格子は見ていなかった）。
  - **R2 不透明オーナー間にリフト無し**。隣り合うオーナーは境界の頂点を共有し、`LAYER` は「物」と「デカール」の段だけです。
    G9 seam（同じ XZ の頂点は位置も法線もビット同一）。
  - **R3 頂点の高さは 1 つ**。頂点プールが固有の XZ を 1 回だけ、最上位オーナーの `RULE_OF` 規則で評価します。地面モジュールの外は
    `terrain.heightAt / meshHeightAt / distanceToTrack` を呼ばず、`ground.standY / standAt / decalY` と `ground.plan.project`
    を使います（G8 のソース lint = 0）。スタンドだけは relief を自分で定義するので解析的な `ground.field` を読みます。
  - **R4 高さ場は C0**。`ground-field.ts` の `field.y` は連続で（サンプルごとのクロスフェード、ユークリッド距離のキャップ）、
    G5 が 0.25 m あたり 8 mm 超の跳びを数えます。残る跳びは `stands.ts` の relief の継ぎ目（許容、上限 313）。
    C4 で E-2 / E-1 の 11.54 m の段は消え（切り欠きを 1 主張に、端フェードを接線方向に、同ランク同モードは常に重み平均）、
    0.5 m 超の崖は 72 → 66 に。I0-c の補間の直し（両サンプルの接線距離の比、核端は最寄り勝負）で D_temp 対 D の 4.40 m も消え、
    313 → 231（崖 61）。残るのはモード混在の継ぎ目（D の段間 s 1492〜1544 の ≈ 2.2 m ほか、`WHY.reliefJoin` に列挙、P7）。
  - **R5 単射**。ラスターの幅は宣言帯 ∧ フォールド上限 ∧ 向かい合う道との二等分線 ∧ 立体交差の上限で、プランが切ります。
    切られた宣言帯は残余として G10 が型付きの上限と突き合わせます（P6 で OSM の砂の行が埋める）。
  - **R6 フレーム**。`road / kerb / deckShoulder / pitLane / pitApron` は路面平面（縁石は自分の横位置での断面）、他は高さ場。
    両者は共有頂点でしか会いません。G3：路面フレームは 2 mm 以内、場フレームは 40 mm 以内。縁石の端は 0.5 m の高さランプ
    （8 行、双線形セルの弦 1.2 mm）と、端の外 0.5 m で路肩へ収束する平らなくさび（縁石の所有）です。
    **I6 改訂 — 場は宣言された CUT に従う**: `CUTS`（`suzuka-facilities-spec.ts`）の各行の**廊下多角形**の内側では `field.y` は
    切通しの床（廊下中心線に沿う縦断 `field(portal) − depth + grade · d`、縁から `CUT_WALL_FOOT` 0.6 m 内側で外の場へ smoothstep）、
    外側は従来の規則で**ビット同一**（`dem-profile --cuts` が 2 m 格子 219 万点で検算）。廊下は authoring しない — ポータル・向き・
    勾配・地形から `ground-field.ts buildCutField` が**計算**します（床が `terrain + RUNOFF_LIFT − 0.2` に達した所、次の路面フレーム、
    way の終端、`level` の `length` で終わる）。CUT は路面の平面（road / kerb / deckShoulder / pitLane / pitApron）を変えず、
    `plan.ownerAt` が路面フレームの点と路肩 `CUT_KEEP_OFF` 2.5 m のフラットストリップ、両ポータル間のトンネル屋根には入りません
    （廊下の点はプランの `roadFrameReach`（縁石・橋肩・ピットレーン・エプロンの到達）+ 2.5 m の外だけ。ポータルは
    `hw + 2.5 + halfWidth` まで、さらに始端キャップの両隅がフィル列 5.5 m（`CAP_MIN_OFF`）を越えるまで押し出し、その側の
    BARRIERS 線から 0.6 m 外で始まる）。`Terrain.heightAt` は不変（G5 の対象外、231 のまま）。廊下は必ず地面行で覆い
    （`{ cut: id, part }` 足跡: 路面 ± 3.5 の asphaltArea layer 1 と全幅の gravelArea layer 0、階段ピットは asphalt の 2 重リング）、
    擁壁・坑口・階段は standY に立つ物（I6-b）です。廊下リングはラスターの範囲を**広げません**（宣言範囲の外はワールド部）。
  - **R7 ワールドリングは入れ子か素**。リングと範囲の交差ごとに駅を入れ、駅の法線上でリングは区間の列（`MAX_RING_INTERVALS`）。
    区間の合流・分岐はトラックを閉じて新しく始めます。部分的に重なるリングはビルドエラー（行を割る）。
  - **R8 地面の上に立つ物**（レーン縁石・ソーセージ、I フェーズのスポンジ・タイヤ積み・島の縁石）は `GROUND_OBJECTS` の行（幅の上限、縁の沈み
    15〜20 mm、天端 20〜120 mm）で `settle()` 後に `standY` に立ちます。G2 は幅を面積／延長で、G3 は沈みと天端を全頂点で測ります。
  - **R9 デカール**は `Ground.decal` で**描画済みの面の三角形そのものをクアッドで切り出し**、`LAYER` の段（8〜30 mm）だけ持ち上げた
    ものです。面のどんな折れとも共面。`polygonOffset` には頼りません（対数深度では無効）。G3-decal：台 +6 mm 未満のサンプル 0。
  - **R10 解像度**。面の XZ 辺は地形グリッド（13.3 m、低ティア 17.7 m）の半分以下、場フレームは 4 m 以下（`refine`：
    4 m → 場との偏差 40 mm で 1 m → オーナー不一致で 0.5 m → conform）。G7。
  - **R11 登録**。地面 0.3 m 以内・コース 60 m 以内の不透明な水平面は全部 `GroundFace`（G8 の幾何検査）。地形グリッドは
    `terrain.settle()` で全面の三角形の下へ厳密に沈み（G6）、三相ビルド（描く → settle → 置く）で設備はその後に立ちます。
  - **R12 メッシュ品質**。零面積 0、生きた頂点の零法線 0、場フレームの面の傾きは場の傾きから 10° 以内（G4、relief の縁は許容）。
    G11 は隣接駅で 0.5 m 超落ちる辺を「場が落ちない所」だけ数えます。
  - **R13 数値ベースラインを持たない**。0 でない許容は `surface-check.mjs` の `ALLOWANCES`（guard・key・上限・理由・期限フェーズ）
    だけで、期限フェーズに達すると落ちます。ガードはデータ・プラン・場・ビルド済みシーンしか import しません。
  - **R14 執筆**。面は表の 1 行（`RUNOFF_ZONES` / `KERBS` / `OFFSET_LANES` / `GROUND_AREAS`）。行に高さ・リフト・順序・
    メッシュ名・登録の語彙はありません。ワールド → s は必ずその行の窓で（`nearestOnRange` / `plan.project(x, z, window)`）。
  - **起動コスト**（Node、no assets、負荷の無い機で 3 回の中央値）: 高ティア プラン 4.4 s＋メッシュ 10.7 s、低ティア 4.4 s＋10.8 s、
    三角形 65.1 万（I5-a 直後は 19.8 / 15.9 s と 18.9 / 16.1 s、P6 は 5.8 / 6.2 s で 40.4 万）。ブラウザでは e2e の `setupMs` で見ます。
  - **分割の高速化（描画結果は不変）**。I5-a の 33 行でプランが 8.7 → 18.9 s、メッシュが 7.9 → 15.1 s になった原因は分割の
    アルゴリズムではなく定数係数でした（Node の `--cpu-prof`: `evalSide` の自己時間 9.6 s、`inRing` 3.1 s、交差ループ ≈ 4 s、
    `Pool.nearXZ` 2.6 s）。直したもの — どれも同じ入力に同じ数を返します：
    (1) 列の real 判定のメモ（(側, s, off) を 1 mm で）が `toFixed` の文字列キーで、評価 1 回に 200 万キー × 0.7 µs を 10 回の評価
    （eval0、pass 0/1 の中点評価、7 回の再評価）で払っていた → `fixedKey`（`toFixed` と同値の整数。積の丸めが半端に 1e-9 より近い
    値と負値は `toFixed` に落とす）で駅ごとの `Map` に。`rayHit` / `kerbAtCached` のキーも同じ量子化の整数。
    (2) `inWorldRing` の点判定が外周管理道路（1,534 頂点、箱 700 × 520 m）の全辺を歩いていた → 辺を z 帯（`RingIndex`、8 辺 / 帯）
    に分け、z を跨ぐ辺だけを同じ `a = ring[i], b = ring[i − 1]` の同じ式で判定（パリティは XOR なので順不同、ビット同一）。
    (3) `rayHitRing` は路肩の裏の交差も数えるので無限直線に対する全辺判定 → 箱では切れないが、16 辺ずつの箱の 4 隅が直線の片側に
    1e-6 m 以上離れていれば（f はアフィンなので隅で範囲が決まる）その 16 辺は飛ばせる。
    (4) 交差パスの O(列²) ループが `rowReal` を対ごとに評価していた → 行ごとに real 列と fill 列の添字列を 1 度作り、同じ昇順で合流
    （スナップが書くのは `off` だけなので `rowReal` は行の中で不変。対の訪問順は結果の一部）。
    (5) リング候補の駅の箱（`pointAt` × 2）はリングごとでなく駅ごとに 1 回、駐車位置（`pos`）はトラックごとの 4 定数、縁石列は駅ごとに
    1 回、`ownerAtSL` の縁石と駅確定後の `extentDrawn` は正確な s のメモ（側ごとの `Map` — `s × 2 + 側` は (s, +1) と (s + 0.5, −1) が
    衝突して駅が 2 つ減った）、`ownerAtSL` のリング走査は precedence 順なので勝てないリングの点判定を省く。
    (6) メッシュ側は `Pool` と `refine` の辺キーを整数に、`refine` の中点は自分の射影で `field.yProjected` を読む（`field.y` が同じ射影を
    もう一度していた）、縫い目の `fallback` の最寄りレール頂点は格子（距離が等しければ小さい添字 = 線形走査の `<` と同じ）、`uEdge`
    （書くだけで読まれない）を削除。
    残る床はメッシュ側の `terrain.heightAt`（38.8 万回 × 12 µs ≈ 4.7 s、メッシュの半分）— 地形場と relief（`stands.ts facilityRelief`）の
    定義そのもので、I5-a で三角形が 40.4 → 65.1 万に増えた分に比例します（三角形あたり 19.5 → 16 µs）。次に効くのは `needs` の
    重心の射影を `ownerAt` と共有すること（`GroundPlan` の API 追加）と GC（`refine` の三角形オブジェクト）で、どちらも 1 s 未満。
    同一性の証明（両ティア）: scene-cost `--all` の全行、surface-check `--json` の全計測値（`built` の ms 以外の 1,171 / 1,192 葉）、
    全 `ground:*` 面の position / normal / uv / index の SHA-256（1e-6 丸め）、プランの列・順序・駅・残余、`groundCensus` が一致
    （stations 7,052、crossings 2,213、passes [2035, 713, 131, 68, 39, 21, 14, 10] は不変）。
- **周辺（柵の外）**（`app/three/dem.ts`・`terrain-far.ts`・`landcover.ts`、データは `app/data/suzuka-dem.ts`・`suzuka-surroundings.ts`）：
  地形の遠方項は実 DEM です。国土地理院の DEM5A を σ20 m で平滑化して 30 m に間引いた汎化グリッド（±3.3×2.9 km、ASL デシメートル整数）と、
  DEM10B の 500 m 遠景グリッド（±35 km、西象限の 600 m 超は block-max で御在所の稜線を残す）をコミットし、読み込み時に datum（10.734 m ASL）を引きます。
  高さ場は内側が Catmull-Rom 双三次（双線形だと 30 m セルの折れを 6〜10 m の fill 列が弦で拾い G3 が超える）、遠景が双線形、内側の外周 300 m でクロスフェード。
  路面まわりは従来の IDW で、最寄り中心線から `DEM_BLEND` = 60 m（G5 の到達 41.5 m の外）から 140 m にかけて DEM へ smoothstep で渡します。
  スタンドとパドックの relief（`stands.ts`）は外側フェードを DEM に着地させます（`dem-profile.mjs --relief` で縁の差 ≤ 1.5 m を検算。パドックは右側 `side: -1` を −a で走査）。
  高さ格子の最外周は 4 ノード刻みで線形にスナップし、その外を 4 倍間隔の**粗いリング**（`terrain.ring`、高 25 セル×53 m、低 19 セル×71 m）が T 接合なしで継ぎます。
  継ぎ目の法線は両メッシュとも非対称差分（内側 1 間隔・外側 1 リング間隔）で、共有ノードの位置・法線は完全一致（Node で |Δ| 0 / 1.4e-7）。
  その外は `DEM_FAR` の**山並み** `terrainFar`（500 m / 低 1000 m セル、リングの下のセルは落とし、縁に接するノードはリング縁の最低高 −2 m に移す）で、
  頂点色は高度と斜度（海の灰青、30 m 未満の平野の温灰、30〜200 m の暗い森の緑、600 m 超は杉の緑に斜度で灰褐）、フォグは
  `vFogDepth = d ≤ 4 km ? d : 4 km + (d − 4 km)·0.2` の傾斜パッチで 20 km 先に約 27 % のコントラストを残します。遠クリップは 40 km、雲ドームは半径 38 km で
  Sky と同じく far plane に固定（カメラが中心から離れても切れない）。水面 `water-far` は OSM の水面ポリゴンのうち ≥ 400 m² かつ全頂点が中心線から ≥ 150 m のものを
  水位（岸の p05）− 0.3 m の平面に earcut し（非単純な輪郭は落として警告）、高さ場はその底を 12 m の土手で 1.5 m 沈めます。
  土地利用は**地形シェーダのマスク**です: OSM の層を起動時に CPU で RGBA8 2 組（内側矩形 1024²／リング 512²、低ティアは半分）に描き、芝の材質が class ごとに
  色とラフネスを混ぜ、田は各圃場の主軸で回転した 30×90 m の畦、道路はカバレッジ AA の帯（リボンが覆う内側グリッドでは細め、遠方 LOD とリングの表現）、中心線の各サンプル周りは hw + 30 m を空けます。
  区画の芝（`ground:grass` / `grassArea`）も同じマスクを引くので区画の縁は見えません。**柵の外に不透明な地面の面（GroundFace）は増やしません**（R1〜R14 と census は不変）—
  例外は水面と、`terrain` グループ下のリング・山並みだけで、道路リボンは森床と同じく `standY` の上に置く遠景オーバーレイです。地面に立つだけのもの（森・建物・駐車場・太陽光・道路・電柱・フェンス）は `farfield.ts` の登録簿に
  ローディング後の遅延ジョブで積まれ、250 m セルごとに LOD します。
- **道路（柵の外）**（`app/three/road-section.ts`・`roads.ts`・`materials.ts roadRibbonMaterial`）: OSM の highway way を `roadSectionOf`（`surroundings-spec.ts`: 車線 × 幅 + 路肩、`lanes` / `oneway` / `surface` / `width` タグ）で断面にし、
  共有ノードで交差点を取り（生成器が DP 1 m でも保護）、従が主の舗装縁 + 0.3 m までトリム、角は hw だけオーバーシュート、内部頂点は接線–弧のフィレット（R ≤ 種別の上限、≤ 6° 刻み）。
  リボンは `cellClippedStrip` で地形三角形ごとに切って `standY` + 0.05 m + クラス段（0 / 8 / 16 / 24 mm）に置くので森床と同じく z-fight せず、上位の道路が交差点で上に乗ります。
  行は ±hw（高ティアはさらに ±0.6 m の路肩行を頂点アルファ 1→0 の A2C で）と中央行の 1.5 % クラウン。区画線はテクスチャではなくフラグメントで解析描画: 頂点属性 `aRoad = (along, across, hw, style)` /
  `aMark = (路肩 L, 路肩 R, 停止線距離, 横断歩道距離)` から、白 0.15 m 破線 5 m/5 m（舗装 ≥ 5.5 m の対面通行）、白 0.20 実線（≥ 12 m）、黄 0.15 実線（tertiary+ の R < 150 m）、外側線 0.15 m、
  停止線 0.30 m、横断歩道 0.45/0.45 m、集落内の residential は L 型側溝 0.45 m の帯、`fwidth` の AA と画面最小半幅 0.6 px（被覆率で減光）、1.5〜3 km でフェード。アスファルトは Poly Haven `asphalt_04`（4 m タイル、ワールド UV なので重なりが同一テクセル）、農道は `gravel_road`。
  橋（`bridge` タグ）は両端 `standY` の lerp + 0.30 m の剛体デッキに 0.9 m の高欄とフェイシア。中心線から 76 m 以内（G8 の 75 m 帯）はリボンを置かずマスクのまま。高ティアはリングにも tertiary+ を 2 行で（ノード高で drape）。
  各 way のサンプル対ごとの四角が `ctx.keepOutPolys` に入り（駐車場の通路は除く）、車の枠と樹木は `KeepOutGrid` で避けます。ガードは `surface-check` の P6s 行（DEM の曲率で上がった G3/G4 を実測で上げ直したもの）と
  `facilities-check` §11（ヘッダ・合計 ≤ 1 MB・輪郭の単純性）、`dem-profile --verify`（34 駅で ±2.5 m）、`scene-cost`（三角形と生成データの予算）です。
- **樹木**（`app/data/tree-species.ts`・`app/three/trees.ts`・`forest.ts`・`vegetation.ts`）: 種の表（杉・檜・松・小松・欅の裸木・芽吹き・楠・桜 2 種・低木・竹）が Sketchfab CC-BY のパック
  （lolipop_1707 の松・モミ・オーク・低木、Sereib の桜、evolveduk の竹。オークは作者の季節アトラスで冬＝欅、春＝芽吹き、夏＝楠として 3 回 import）のノードパスを LOD0/1/2 に割り当て、
  `model-proto` で幹＋葉の 2 グループのプロトタイプに（高さ 1 に正規化、配置時に種の高さ範囲へスケール）。葉材質は A2C のカットアウト、高さ² × 風の 2 周波の揺れ、
  逆光の半透過、`instanceColor` の個体色（種の色味範囲）。LOD はセル単位: ヒーロー（トラック最寄り 24 本／セル）LOD0 < 60 m → LOD1 < 130 m、一般樹 LOD1 → LOD2、
  130 m から森の幹域（900 m）まではインポスターカード（`tex/tree_atlas`: 種ごと 1 行、8 方位 × 2 仰角、上向きの疑似法線で逆光でも黒くならない）、その先は樹冠マス。
  配植: 植林（landuse=forest）は等高線の列、自然林は格子、森縁の生垣、集落縁の竹の株、サーキット道路と 4 ゲート周りの桜並木、トラックサイドの散布は桜ゾーン付き。
  道路リボン・建物・駐車場のキープアウトと土地利用マスク（舗装・駐車場・水面）を避けます。Node と低ティアはコーンの原型のまま（静的予算はそれで測る）。
- **地形系**（`app/three/terrain-side.ts`）: 田は `landcover.ts` と同じ規則の畦線（圃場整備の 30 × 90 m、圃場の主軸）に 0.28 m の畦と境界の用水路のリボン（高ティア）、
  伊勢鉄道は 44 片を端点で繋いで 2 本の線に、道床（天端 3.4 m +0.35、枕木を描いたタイル）・layer=1 の盛土・bridge の高架（±60 m の最高地盤 + 6 m、橋脚 25 m、高欄）・
  軌間 1,067 mm のレール 2 本、道路との交差は道床を切って踏切（レールはリボンの上）、小川は集落内でコンクリート護岸、外は土手、川は堤防、水面は +0.03 m のリップル法線、
  道路との交差は暗渠として岸を開ける。全部 `cellClippedStrip` で地形三角形に沿わせ、リングの外側はノード高で drape、140 m 以内には置かない。
- **白線** (`app/three/lines.ts`)：全周のエッジライン、ピット入口・出口の分離線と合流テーパー、ピットレーンの
  各線、グリッドとスタートラインは 1 メッシュのジオメトリです。15 cm の線は遠景で 1 px を切るので、
  頂点シェーダが視距離から m/px を求めて画面上の半幅が 0.6 px を下回る分だけ横に押し広げます
  （近景では実寸のまま）。アスファルトのタイルには白線を焼き込みません。
- **コース形状** (`app/data/suzuka.ts`, `app/sim/track.ts`)：周長は公式 5807 m に正規化。幅は 10.5〜15 m のキーフレーム、
  カントは T1〜T2 とヘアピンが国土地理院 DEM5A の横断勾配（約 4°）、他はコーナーごとの推定値（±3°）、
  標高は DEM5A から求めた 34 キーフレーム（`scripts/facilities/dem-profile.mjs`、T2 出口 6.8 m が最低、200R〜スプーンの台地 47 m が最高、高低差 40 m、
  立体交差の上下差 6 m）です。
  レーシングラインは離散曲げエネルギーを最小化した線に、デグナー2・スプーン・130R・シケインのピンを重ねたものです。
- **車** (`app/three/car-model.ts`)：ホイールベース 3.40 m・全幅 1.90 m・18 インチタイヤ。フレークのクリアコート塗装、
  異方性カーボン、干渉色のバイザー、摩耗で艶の落ちるタイヤ。加減速と横 G でピッチ／ロール／沈み込みします。
  ステアは自転車モデルで、車体が実際に描く軌跡の曲率に約 0.2 秒先読みのレーシングライン曲率とアンダーステア勾配（0.012 rad/g）を足し、
  切れ角は ±20°（アッカーマン 60 %、キャスター 12°、静的キャンバー前 −3.4°／後 −1.5°）。コックピットのハンドルは 9:1 で ±120° まで切れ、
  グローブと前腕が追従します。ロックアップした前輪は止まり、ホイールスピンの後輪は速く回ります。
  ブレーキディスクは `app/sim/brake-thermal.ts` の熱モデルで車輪ごとに温度（°C）を持ち、グリッドの 80 °C からヘアピン／シケインで約 1,000 °C まで上がって
  黒体色（暗赤→橙→黄白）で発光します（ロック時は +170 °C）。テレメトリにはハンドル角と前後ディスク温度を表示します。
  リアのレインライトは実車どおり、ピットレーン・グリッドと回生中（減速・スロットルオフ）に点滅します。
  距離に応じて 3 段階の LOD に切り替わり、高品質モードでは LOD1 でも車輪が回転・操舵し、ディスクの発光が残ります。
- **エフェクト** (`app/three/particles.ts`)：高速からのハードブレーキングやストレートのバンプでプランクから火花が出ます。
  減速時に稀にフロントがロックしてタイヤスモークとスキッドマークが残り、スタートではホイールスピンの煙が出ます。
- **カメラ** (`app/three/cameras.ts`)：オンボードは回転数に同期した振動と横 G の傾き、TV カメラは減衰バネで追う操作者モデル
  （通過時に遅れて僅かにオーバーシュート、望遠でのぶれ、2°までズーム）、ヘリはコーナーでバンクします。
- **テクスチャ** (`app/three/textures.ts`, `app/three/materials.ts`)：低負荷ティアはタイル可能なノイズからアスファルト、芝、グラベル、縁石、
  コンクリート、カーボン、タイヤ、ホイール、リバリー、観客、ガレージ、看板、Armco（W ビーム・3 本ビーム）、金網、タイヤバリア（帯・塗装ブロック）、雲、火花などを生成します。
  高品質ティアは芝（Poly Haven withered_grass 2 K）、ピットレーン舗装、コンクリート、白壁、金網、座席などに写真 PBR（KTX2、ARM パック）を
  重ね、無い場合は同じ手続きマテリアルへ落ちます。実在ロゴ・スポンサー名はテクスチャに描きません（説明的な文字と汎用パネルのみ）。

### ピットビル v2

`app/three/pit-building.ts`（I1-b、データは `PIT_BUILDING.v2`）。Mobilityland 2009 年のピット／パドック図面（断面 pp4s2-4、立面
pphi-3/4、平面 pp4t-4、ピット仕様 p5spec、テラス pitph-12、コントロールタワー ct-13）から建て直した本体で、すべて路面フレームの
`sweep`（2.8 % の勾配に追従、高さは局所路面基準）です。

- **断面**（前 → 後、lateral は右が負）: 滴線 −25.1 に 2 m のファシア梁（y 2.85 → 5.05、`pitFascia` は 19 m ブロック 1 リピートの
  アトラス 3 行 = 2 種のパネル枠 + コア／メディア区間の無地）、その裏に 4.6 のソフィット（`pitSoffit`、2.8 m 毎の埋込ダウンライトを
  `emissiveMap`、`EMISSIVE.terraceDownlight` 輝度 0.45）、シャッター壁 0.35（面 −27.95 / 扉面 −28.3）に 4.2 × 3.0 の開口と
  0.55 m のピア（ブロック端 1.0）、ガレージ 23.3 m（床 0.025 `pitInterior` = `concrete_floor_03`、天井デッキ 4.6
  `pitInteriorCeiling` = 暗灰の `corrugatedsteel003`、裏壁 −51.6）、2F 5.05（滴線のガラス手摺 1.2 + 支柱 φ0.03 @ 1.5 m、3 段
  tread 0.85 / riser 0.30 で −25.4 → −27.95、ラウンジガラス −28.6）、3F（パラペット −28.0 高 1.1、5 段 8.15 → 9.85、デッキ
  9.85 → 裏壁 −52、丸柱 φ0.35 を各ピット境界 = 55 本 `pitColumns-<bay>`）、曲面キャノピー（`[(−52, 13.4), (−40, 13.9),
  (−28, 14.8), (−22, 15.3)]` を Catmull-Rom で滑らかにした 0.4 m 厚、前縁 0.3 の立上り、上面 `pitCanopy`、下面は白）。
  シャッター壁のヘッダーは扉面 −28.3 と面 −27.95 の間に下面（3.0）と上面（4.6）を持ち、開口の上から 3F ソフィットが透けません。
  **下向きの白面**（キャノピー下面・3F ソフィット・ファシア梁とヘッダーの下面・裏キャノピー下面）は別マージ `pitShellSoffit` =
  `soffitShellMat`（shellMat + `EMISSIVE.soffitBounce` 0xf4f4f0 × 0.18、輝度 0.16、ティア非依存）: 下向き法線は太陽を受けず
  半球光の地面色と暗い下半球しか拾わないので、オンボード／S/F の最大の面がオリーブ色に沈んでいたのをエプロン反射の代用で持ち上げます。
  滴線のガラス手摺の板は `pitRailGlass` = `railGlassMat`（透明 opacity 0.3、depthWrite 無し、map + alphaMap の白 8² キャンバス =
  props.ts の制動ラバーデカールと同じプログラム）で、着席の観客が透けて見えます。
- **s 方向**: コントロールポッド 5554.5 → 5590（`podLoft` 銀灰アルミ 0xb9bcc0、天端 12.5 = pphi-4 / ct-13 の読み: ポッドの
  丸い天端はキャノピー線の下・3F と同レベルで、キャノピーは 5566.5（肩）から掛かりノーズが突き出す — 尾部の緩和無し、
  `v2.unverified` 'pod height 12.5'；ガラス帯 9.6–11.4 は `podBand` の別ジオメトリ
  `controlPodGlass` = `facade001`、その下に暗青のサイン帯 0.8、+s 側 8 m の 2F は暗ガラスのレースコントロール角、
  丸窓 φ0.6 × 8 を両舷）、その 1F は OSM 外形のプリズム（医務室）。メディア区間 5590 → 5625 は 2F/3F の直線ガラス体（面 −26.0、
  テラス無し）。ブロック 12（5625–5644）は平らな表彰台テラス（灰コンクリのバックドロップ壁）、ブロック 1–11 は段付きテラス。
  88 → 92 はパドックインフォメーション（1F 白箱 + ガラス窓口、2F/3F は白のリンク体）、T1 ノーズ 92 → 103.3 は同じロフトの
  鏡像（top 11、帯 5.2–7.4、丸窓 8）。1F ガレージ列は 5590 → 88（キャップ 49–55 はメディア区間の下、ファシアに
  SCRUTINEERING 帯 10 × 0.8 `pitCapBand`）。階段塔 7 基（5 × 6.3 m、−46…−52.3 — タイル壁 −52 より 0.3 m 手前で同一面に
  ならない、天端 17.0）は `pitStairTowers`。パドック側ビジョン `pit_paddock` は 5748（中央コアの階段塔 5735–5740 を避ける）。
- **扉と番号札**: チームブロック 11 は折り畳んだガラス折戸（開口の両脇に 0.6 × 0.15 × 3.0 の葉、白枠（railMat）+ 淡いガラスの
  2 材質 IM `pitDoorLeaves-<bay>`、88 枚 — pitbox.jpg / podium.jpg の白枠の折戸）、ブロック 12 とキャップ 49–55 は閉じたリブ付き
  シャッター（`painted_metal_shutter`、無しなら 0.1 m リブの手続きタイル）。番号札は奇数方式（ブロック b の +s 端ピアに 4b+1、
  中央ピアに 4b+3 → 1, 3 … 47、キャップ 49–55）、0.35 m 黒地白数字でピアの面（−27.93）の y 2.3 — ファシア梁（底 2.85）の下なので
  TV／オンボード／スタンドから読める（ヘッダー帯 3.55 では梁に隠れていた）、表彰台入口は人物扉 + PODIUM 札（同じ y、`pitPodiumDoor`）。
- **chase レンズの契約**（`PIT_ENVELOPE.chaseLens`）: 各ブロックの s ∈ [boxS − 13, boxS − 3] × lateral −23.5 ± 1.5 の柱には
  2F ソフィット（4.6）より低い建物の頂点が一つも無いこと — ファシア／手摺 −25.1、丸柱 −28.0、ピア −28.3 はすべて外。
  `scripts/audit/pit-smoke.mjs checkBuilding` が実メッシュ（IM はプロトタイプ境界 × 全インスタンス行列）で検査し、
  表からの数（札 28 = 12 × 2 + 4、葉 88、柱 55、シャッター 11）、階段塔の天端、全 `pit*` 頂点の有限性と路面下 0.5 m 以内、
  ビジョン 8 行の描画も確認します。
- **ガレージ内装**（I1-b 3/4、`PIT_BUILDING.v2.interior`、pitbox.jpg）: ブロック境界に白のエキスパンドメタル側壁（`fence003`
  カットアウトの白 tint、パック無しは金網キャンバス、`pitInteriorMesh`）、床前縁 1 m のチーム色帯（`pitInteriorBands`、
  instanceColor の IM 1 つ、床の 12 mm 上 ≥ `LAYER_MIN_STEP`）、裏は白いピットルーム壁（`pitInteriorRoom` + ピアは boxes）に
  ピット毎の裏扉 3.6 × 3.0 — チームブロックは開（ヘッダー下に巻き上げたシャッター、ガレージ越しにパドックが見える）、
  ブロック 12 とキャップ 49–55 は閉じたリブ付きシャッター（両面、`pitShutters` に合流）。**ウォッシュ**: 金網・ピットルーム
  の材質に `EMISSIVE.garageWash`（0xf4f6ff × 0.12、輝度 0.11 — 日陰のアルベドを持ち上げるだけで光源ではない、`sun-model-check`
  の sub-threshold に独自の下限 0.05）。床は無発光で `concrete_floor_03` を読みます（0.72 では開口全体がクリーム一色の板になって
  機材も奥行きも消えた — I1 レビュー V3）。emissive 色はプログラムを変えません。機材は `registerPropSet(ctx, 'ops', 'ops-garage', …)`（プロトタイプ × 250 m セル毎に
  IM 1 つ、受けのみ、全て lateral ≤ −29）: 工具壁ユニット 2、ロールキャビネット 3（`metal_tool_chest`）、棚 2
  （`steel_frame_shelves_01`）、タイヤスタック 6（チーム色ブランケットの筒 = instanceColor + 上に裸のタイヤ `tyreMaps`）、
  モニター机 + 3 × 2 画面壁（`pc_monitors`、手続き版は `EMISSIVE.opsMonitor` の emissiveMap）、天井下の 17 m 照明トラス（0.3 角
  ラチス、路面勾配に合わせて傾ける）、ケーブルドラム 2、クレート 4（`plastic_crate_02`）。チーム 11 × 28 + FIA 9 = 317 体。
  GLB は `Quality.infield.glb` とドロップがある時だけ近景 L0、手続き箱が常に L1／唯一の段（Node・低ティアが測るもの）。
- **裏面**: ピットルーム壁のヘッダー外面 + 1F 裏キャノピー（ソフィット 4.35 → 3.81、厚 0.3、`pitRearLower`、下面は
  `pitShellSoffit`）、その縁下に φ0.30 の丸柱 9.5 m 毎（`pitRearColumns-<bay>`、32 本）— 裏歩廊 −51.6…−57.3 の地面は
  GROUND_AREAS の行「ピットビル裏の歩廊」（kind paddock、band −1、s 5590→88 × lat [−57.3, −51.6]、ガレージ裏壁まで — パドック行を
  −51.6 まで広げると s ≥ 90 の T1 の池のリングが切り直されて G4 water.steep が 989 → 1043 になったので別行）で、柱・開いた裏扉・
  階段塔はパドック面 −0.07 に立ちます。
  2F/3F 裏壁は `rectangular_facade_tiles` の法線／ARM を平坦な淡色 0xdcdedb の下に（`noMap`、`pitRearUpper`、キャノピー
  天端 4.65 から屋根まで — 写真アルベドは暗い茶灰で日向の壁が茶色く写った、pphi-4 / padoc.jpg は淡いパネル）に 19 m 1 リピートの窓帯（`pitRearWindows`: 2F 6.3–7.8 の連続ガラス、3F 10.6–11.6 の暗いスパンドレルに
  小窓 8）。スパーはトンネルホール（5771.5–5778.9 × −56.7…−66、高 5.0）にガラス帯、2F ブリッジ 5773–5777 × −52…−84 は
  y 5.05–8.55 の白箱 + 両側の窓帯（boxes）。
- **屋上設備**（`v2.roof`）: HVAC 箱 10（2 × 1.5 × 1.2、lateral −45、ブロック 1–10 の中心 +4 m）、アンテナ 3 本 6 m at 5595 (−40)
  （横棒 3 段）、屋上ビジョン 4 基は黒ラチス pylon 2 本（`latticeGeometry` panel 1.0、キャノピー天端 → パネル天端、
  `pitScreenPylons`）に置き換え（角柱 4 本は廃止）。
- **表彰台** 5632（`v2.rostrum`）: 灰コンクリ壁の面に市松バックドロップ 7 × 4（`podiumTexture` 行 0: 市松 + 白い菱形に
  SUZUKA CIRCUIT）、その前に黒の 3 段（1 位 0.9 中央、2 位 0.6 / 3 位 0.45 両脇、1.2 m 角、boxes）、ベイのファシアに架空の
  JAPANESE GRAND PRIX バナー 9.5 × 2.1（行 1、`PIT_TEXTS[10]`）。まとめて `pitPodium`。
- **テラスの観客**（`v2.guests`）: `figures.terraceSlots(track)` — チームブロック 11 の 2F 3 列 × 26 席、3F 5 列 × 20 席を
  占有 0.85 で抽選（seat pitch 0.55 の座席位置に一致、seed 固定、1,653 体）、座り姿 sit / sitF、役割 guest、トラック向き → `buildOpsFigures(ctx, slots,
  'ops-terrace')`。表彰台ベイとメディア区間は空。`stats.infield['ops-terrace']` に計上（観客 `crowd` の窓は不変）。手続き
  アトラス（低ティア／パック無し）には座り姿のセルが無いので official の立ち姿カードで代用されます。
- ファシアのアトラス行: キャンバス上端の行 0 は CanvasTexture（flipY）では v ∈ [2/3, 1]。2/4 の `remapV(row/3 …)` は行が
  上下逆（ブロックが無地、コアがパネル）だったので `(2 − row) / 3` に直しました。
- 削除した v1 キー: `PIT_BUILDING.floors / garage / podium / controlPod / spur / colour / unverified`（読む所は無かった）。
  残る v1 は `terrace2F.seatColour` と `glass` だけ。
- 静的コスト（Node、アセット無し、高ティア）: 2/4 で +47.9 k tris / +7 メッシュ / +9 IM、3/4 で +81.9 k tris / +9 メッシュ /
  +27 IM / +5 エントリ（`scene-cost` 3,795,667 / 910 / 769 / 996、予算 4,039,200 / 982 / 807 / 1,090 内；低 1,950,829 / 673 / 649）。うち
  `farField/ops` 66,010 tris / 21 IM / 1,962 体（機材 317 + 観客 1,653）、`pitScreenPylons` 12.7 k。I1 レビュー修正後（ヘッダー
  下面／上面の掃引、キャノピーの 5566.5 への延長、`pitShellSoffit` / `pitRailGlass` / `pitCapBand` の 3 メッシュ）: 3,823,991 /
  932 / 788 / 996（`pitShell` 6,647 + `pitShellSoffit` 6,478、`pitCanopy` 7,058）。

### ピットレーン断面

`app/three/pit-lane.ts` が `PIT_WALL`（`app/data/suzuka-facilities-spec.ts`）から建てる断面。横位置は中心線からの m（負 = ピット側）、高さは路面平面から。
壁と設備はピットビルと同じく路面平面に沿って掃引し、ピット直線の 2.8 % 勾配に追従します（Mobilityland 2009 図面 pp4s2-4 と padroad.jpg / west.jpg）。

| 横位置 | 何 | 高さ・材 |
|---|---|---|
| −9.05…−9.75 | コンクリート壁（`pitWall`、concrete046、s 5556→95、トラック面は路面下 0.1 まで沈めて描画帯との隙間を消す）。入口端の 10 m は白ブロック（`pitWallBlock`）で、60 リングと FIRE STATION の板（SIGNS の mount `pitWallTop`、`pitWallSigns`）が天端 +0.4 の 2 本の支柱に立つ（横向きの板の支柱は壁の幅内 ±0.30 に収める） | 天端 1.8。両面に広告帯 y 0.9–1.8（`pitWallBoards` / `pitWallBoardsLane`、4096 × 64 のキャンバス = 64 m × 0.9 m の 8 m スロット 8 枚、レーン面は 64 m ごとの 80 リング = SIGNS `pit-lane-80`）。天端の金網（`pitDebrisFence`、fence003 / 手続き）はボックス帯 [5625, 88] で 1.0 m、入口・出口区間で 1.8 m、支柱 φ0.09 を 4 m 毎に IM |
| −9.75…−11.05 | 歩廊（`concretePitWalkway`） | +0.5。チームの prat perch v2 は運営レイヤー（`ops-pit.ts`、mount 'wall'）、ブロック境界のキャビネット 0.6 × 0.9 × 1.2（`pitCabinets`、13）、スターター台（`pitRostrum`: 3 × 2.4 × 2.6 の暗鋼キャビン、床 +3.0、脚 φ0.1 × 4、8 段の階段、金網窓、白パネル。s 5.5 = ゲートリー脚の T1 側） |
| −9.75…−11.05（s 31–69） | 固定プラットホーム（`concretePitPlatform`） | デッキ +1.3、レーン側に 0.35 のパラペット、その上に白パイプ柵 1.1 |
| −11.05…−11.5 | 白縁石（`concretePitKerb`、plaster_grey_04 白） | +0.45。逆 U のパイプフープ（幅 1.2、高 1.0、φ50）を 1.3 m ピッチで ⌊346 / 1.3⌋ = 266 体（`pitHoops-<bay>`、76 tris の 1 プロトタイプを 60 m ベイで IM） |
| −11.5…−16.05 | 速走レーン | 破線 divider −16.05 は `LINES` |
| −16.05…−19.1 | 補助レーン | 末尾 1 m の青帯 −19.1…−18.1 と白縁線 −18.1…−18.0 は `ground.decal`（`pitBlueBand`、rung `LAYER.pit.band` 12 mm、材 0x1e6fd6 / 白の 2 グループ、`plan.lattice(5556, 95, 1)` の行ごとの四角、uncovered ≈ 0） |
| −19.1…−28.7 | コンクリート作業エリア（`pitApron`、road frame、シャッター線 −28.3 の 0.4 m 先＝ガレージ床の縁の下まで。ピア −27.95 と折戸の葉はコンクリの上に立つ — `pit-smoke` が全ピット位置で所有者を検査） | `ground-materials.ts apronConcreteMaps()`: 1024² = 6 m の打設区画、25 mm の目地 2 本（縦横）を暗線 + 高さ場の溝で描き法線に出す。uv は横 6 m / 縦 4 m なので縦の repeat 2/3 で正方に。両ティア同じ（エプロンにパック材は無い）。停止車は −23.5（`PIT_ENVELOPE.stop`） |

壁の前後 5538→5556 と 95→125 は W ビームのガードレール（`pitWBeam`、armco 白 tint、0.34→0.8）+ 丸支柱 φ0.114 を 2 m 毎に IM（`pitWBeamPosts-<bay>`）+ 白パイプ柵 1.1。
スタートゲートリー（`track-mesh.ts`）は白バナー箱 (2hw + 6) × 2.0 × 0.45 at 8.85、黒ラチス脚 2 本（右脚は歩廊の中央 −10.4 に立ち、壁と縁石を貫かない）、
5 列 × 4 段の 0.28 m ランプ 20 個（`startLampMaterials` は列ごとの 5 本で、レースが点けるのは上 2 段。HUD / 音の開始シーケンス API は不変）、その左に暗い EM 情報板 1.5 × 1.0。
sim の包絡: ボックス帯の走行レーン [−19.1, −11.5] にはレーンの物を置かず（壁側の設備はすべて lateral ≥ −11.5）、chase レンズ柱 s [boxS − 13, boxS − 9] × lat −23.5 ± 1.5 は空 — `scripts/audit/pit-smoke.mjs` の `checkLane` が実頂点から検査します
（フープ数 ± 1、青帯の uncovered、全 pit* 頂点が有限で路面 −0.5 m 以上、標識が白ブロック上、W ビームが区間内、ゲートリーの 5 × 4）。programs は増えません（concrete046 は FrontSide、金網は barriers と同じ fence003 cutout、W ビームは barriers の guardMat と同じ組合せ）。
未確認寸法は `PIT_WALL.unverified`（歩廊・縁石の横位置 ±0.5、金網高、W ビーム区間、白ブロック長、パラペット、スターター台）。

### パドック

`app/three/paddock.ts`（I2-b/c、データは `PADDOCK_BUILDINGS` / `PADDOCK_OFFICE` / `PADDOCK_PLANE` / `PADDOCK_FENCE` / `PADDOCK_LAMPS` /
`PADDOCK_MASTS` / `PADDOCK_PARKING` / `PADDOCK_BAY`）。Mobilityland 2009 図面のパドック配置（pphi-3、2.22 px/m で読み ±5 m）、チームオフィス図（pitpad-6 / p6_sec）、
写真（pad-14）と OSM 外形から建て直したもの。地面は I0-c の 1 平面（路面 −0.12 = `PADDOCK_PLANE.drop`）で、平面上の建物は
路面フレームに、平面の外（S 駐車場、タイヤガレージ）は `ground.standY` に立ちます（R3: terrain は読まない）。

- **チームオフィス**（E 3 / D 4 / C 3 / WC 1 / B 3 モジュール、A 棟は 2 階 32 × 10）: 1 モジュール = 11.4 × 10.5 m（3 室 × 3.8）、
  軒 3.2、屋根 3.53（青灰 0x8fa4b4 の浅い棟）、前ポーチ 1.0（ピット側 −79.5）／後ポーチ 1.5（−92.5）、壁 = 白塗り波板
  （`corrugatedsteel007a` の法線・ARM のみ `noMap`、色 0xe9ebe8、1 m リピート — diff は青緑の塗装板で柵の外の作業場用（`FACADE_LAYER.corrugatedBlue`）、
  pad-14 ③ のオフィスは白壁 + 青灰屋根; パック無しは同色の縦リブのキャンバス）、開口アトラス（扉 0.9 × 2.1 + 窓 1.2 × 1.0 を面から 12 mm 浮かせた quad）、
  プリンス（コンクリ）と各扉の 2 m ランプ — 4 材質グループ 66 tris の 1 プロトタイプを `bucketedInstancedMeshes`（`teamOffices-<bay>`、
  高ティアは cast）。**床は 1 モジュール 1 枚の平板**: 平面 + 0.15 をモジュールの −s 端（登り側）で取り、内部で勾配に追従しない
  （列が 0.32 m ずつ段になる = 立面図どおり）。プリンスは登り側の深さ 0.30 + 勾配分まで潜る。ピット面に室ごとの灰ロールドア
  2.5 × 2.6（`infield-office-shutters`: `rollershutter_door` GLB を非等方に伸ばし、bbox 中心にあるレフを z = 0（壁 + 0.05 の置き位置 → 壁から
  3 cm 前、巻取り箱は 33 cm 前）へ 0.13 ずらしたプロトタイプ／手続きリブ箱、L0 120 m）、パドック面に
  室外機（`infield-office-aircon`: `exterior_aircon_unit`／箱）。OSM の 3 面（184423963 / 184430911 / 184430909）は BUILDINGS に
  `builder: 'paddock'` で残し（OWNED → SUR 再生成で再出荷しない）、外形は使いません（OSM はポーチ線 17 m 幅）。
- **センターハウス** 184430907（BUILDINGS `centre_house`、軒 8.7 = I1 の 2F ブリッジ天端 8.55 + 0.15）: OSM リングを白 plaster で
  押出し、丸側の 1F に `facade001` のガラス帯 0.2–3.8、全周に 2F 窓帯 5.6–7.2、丸側に 2 m バルコニー（5.05 = ブリッジ床）+ 手摺、
  −s 側に外階段 25 段、楕円キャノピー 52（横）× 44（s）m の 0.35 スラブを 9.6 に（`centreHouseCanopy`、白、`userData.canopy` に
  路面フレームの楕円）、丸柱 φ0.35 × 16（平側を ±85° 空けた扇 85°…275° の楕円 0.94 上 — D 形リング 33.4 × 42 の平側の角は楕円の縁の
  外なので柱は立てられない; 柱の中心は壁から ≥ 2.4 m = バルコニー 2 + 半径 + 0.25 でバルコニーと手摺を貫かず、楕円の 0.97 より内で
  スラブの下。リングの内側やバルコニー内に落ちる柱は 1.03 倍ずつ外へ押して 0.97 で止める安全網、`centreHouseColumns`）、周囲 3 m の舗石デカール（`paddockPaving`、
  `pavingstones099`／手続き、`LAYER.paddock.hatch` 10 mm、頂点を角の二等分線で外へ出した重ならない四角、uncovered 0）。
- **SMSC 事務所**（s 63–88 × −102…−124、単層 4.0）: 白コンクリ箱、+lateral 面は全面ガラス、屋根スラブ 0.5 を 3 m 張出し、
  丸柱 φ0.3 @ 5 m。**給油所**（s 98–122 × −60…−96）: 2 本の amenity=fuel ウェイ（469451640 / 469451655）の重心を結ぶ軸に回した
  キャノピー 24 × 9 × 0.6 at 5.0、柱 φ0.4 × 4、島縁石 2（スタジアム形の閉ループを `sweepKerb` で掃き `GROUND_OBJECTS.islandKerb`、
  `paddockFuelIslands`）、ディスペンサー 4（`infield-fuel`）、キオスク 6 × 4 × 3.2（エプロンの −s 端）。給油所は平面の素地に立ちます
  （エプロン行は試して戻した: S 字脚に駅を挿入して池の raster が変わり G3 water 8.8 → 10.6 %、P7 まで見送り）。
- **サービスハウス**（2 層 7.5、`corrugatedsteel009` + 窓帯 2 段）と**タイヤサービスガレージ**（6.0、+lateral 面にロールドア 3.5 × 4.0 × 6
  `infield-garage-shutters`）は自然地盤: 四隅の standY の最小 −0.5 から最大 + 軒まで。**車両基地** 184429429（BUILDINGS
  `course_vehicle_base` 5.0）: 押出し + 窓帯 2.2–3.4（ドア面だけ 3.9–5.1 = ドア 3.2 の上）+ −s 面（最小 s の辺）にロールドア 2.2 × 3.2 × 3（`infield-base-shutters`）。
- **トンネル頭**: I2-b のコンクリ箱（逆バンクランプ頭 (5543.5, −64)）と門型 + 擁壁スタブ（構内道路南西頭 (117, −38)）は I6-b で
  廃止。ランプは `CUTS` の廊下（gyakuTunnelR / worksSW）、坑口は cuttings.ts のヘッドウォール（「切通しとトンネル（R6）」）。
- **囲いフェンス**（`PADDOCK_FENCE`）: OSM 474537488 / 474537494 / 474099241（fold 行 → EN のみ、s 射影無し）+ ピット出口ヤード縁
  469636518（最終頂点はピット出口レーンのキープアウトに入るので落とす）+ ヤードを T1 端で閉じる手描き 3 点。各辺を支柱ピッチの
  半分 1.5 m で割った小区間ごとに 1 枚の垂直カード（両端 standY − 0.05、高 3.0、m 単位 uv、支柱は小区間端の 1 つおき — OSM の辺は
  28–65 m でヘリパッド囲いの relief フェードを跨ぎ、1 辺 1 枚では中央が 1.5 m 浮いた; 低ティアの粗い地形格子は 3.5 m の間に 0.2 m
  折れるので半ピッチ; 残る誤差は描いた面と素地の継ぎ目の段（高 0.26 / 低 0.6 m、P7 まで）をカードが跨ぐ分）を `fence003` カットアウトの緑 tint（無しは金網キャンバス）で `paddockFence`
  （法線はすべて水平 = G8 に掛からない）、支柱 φ0.06 @ 3 m を 250 m セルで IM `paddockFencePosts-<cell>`、門 3（8 m の切欠き +
  φ0.1 の門柱 2 + 上桟、`paddockGates`）: ヘリパッド囲い (5548, −60)、ヤード (200, −46)、OFFSET_LANES 411291883 が横切る
  ピット入口外側 (5331, −27.5)。総延長 633 m（smoke の基準は 600 m = 表の 4 ウェイ + ヤード縁; 計画の 1,200 m は OSM に
  それだけのフェンスが無く届かない）。
- **街灯**（`PADDOCK_LAMPS`）: パドック道路 SUR_ROADS 184429431（給油所 → S 駐車場 → A 駐車場）・支線 184429432・回廊 184429434 /
  469650860 に 40 m 毎（右 3.5 m、腕は道路へ）+ 手置き 13（オフィス前 −75.5 = ハッチ帯 −79.4…−76.4 の外、車両基地、給油所
  −s 端 (130, −64) = 池 184005565 の縁の外の芝）= 29 本、両段とも手続きポール（φ0.12→0.06 の 8 m マスト + 腕 1.6 + 箱ヘッド +
  ベース板、68 tris; `street_lamp_02` は 1.7 m の壁付けランタンでポールが無く、8 m に scaleTo すると宙に浮いたので使わない —
  パックには残る）、`registerPropSet(ctx, 'infield', 'infield-lamps', …)` 段 [700 m, ∞]。water 面に落ちる街灯とロールドアの
  ハッチに掛かる手置きは builder が捨てる。計画の 184120107 は
  GP スクエア裏のサービスロードでパドックを通らない。**照明マスト**（`PADDOCK_MASTS`）: 22 m の 0.6 角ラチス（panel 1.5、X ブレース
  は `Quality.infield.detail`）+ 横桟に `trackside_flood_light`／箱 3 灯（`infield-flood-heads`、−lateral 向き）を E パドック縁
  (5480, −38) と最終コーナー内 (5330, −34) に（`paddockMasts`）。(5480, −38) は I3 の放送コンパウンド帯 s 5440–5510 の中に立つ:
  各マストの円 r 2.2 を `ctx.keepOut` に積むので、I3 は `PADDOCK_MASTS.at` と keepOut を読んで避ける。
- v1 から残す: 旗 5 + 6（門の旗は s 5548 → 5538、トンネル頭と囲いの位置）、BUILDINGS の他行（ダンロップ事務所・西タワー・
  CIRCUIT PLAZA）の押出し（`paddockBuildings` / `paddockRoofs`）。削除: 8 m の窓無しスラブ、プレハブ 6、駐車場の 1 cm スラブ線と
  箱の車（I2-c の `ground.decal` の区画線と `infield-paddock-cars`）、v1 のトランスポーター（−64.5）とキャブ・円錐テント 6
  （I3-b で `ops-vehicles.ts` の白箱トラック・ホスピタリティ・ガゼボに置き換え）。
- **駐車場**（I2-c、`PADDOCK_PARKING` / `PADDOCK_BAY`）: 1 行 = 1 街区 `{ id, s: [a, b], lat: [l0, l1], rows, angle: 0 | 45, pitch: 2.5, occupancy }`
  — 列は lat[0]（コース寄り）から背中合わせの 2 列 1 組（区画 2.5 × 5、`CAR_PARK` と同じ数）+ 通路 6 m で並び、45° は +s に傾いて
  s ピッチ 3.54・列奥行 5.3。表: A（s 5604–5739、−101…−143、6 列 = 軸 −106/−122/−138、0.85）、B（s 2–45、−107…−133、4 列、0.7）、
  B 斜め（s 68–96、−130…−158、45°、0.6）、E（s 5350–5440、−40…−95、8 列、0.9; **s 5440–5510 は I3 の放送コンパウンド用に空**）、
  ヤード（車両基地脇 s 150–197、−46.5…−51.5、1 列、0.7）、S（サービスハウス前 s 5624–5667、−150…−225、6 列、0.6）。
  行は高さも世界座標も持たず、`paddockBays(row)` が列を **世界座標の m** で歩いて（路面フレームはコーナーの内側で縮む: E は最終
  コーナー内 R ≈ 130–360 m の lat −40…−95 にあり s 1 m が世界の 0.42–0.86 m — 列長は lat 中心線を 0.25 m 刻みで積算し、区画中心の
  s は積算長の逆引き、区画の s 成分は局所計量 `Bay.k` で割るので区画は剛体の 2.5 × 5、車同士は ≥ 2.2 m）**四隅 + 中心が描かれた `paddock` 面の上
  （`ground.builtY` の kind と `plan.ownerAtSL`）、sim のピット包絡（`PIT_ENVELOPE.keepOut` about `Track.pitLateralAt` + ボックス帯）の外、
  全フットプリント（PADDOCK_BUILDINGS の OSM リング／路面枠 + ポーチとランプ、BUILDINGS の他行、ヘリパッド、マスト、**運営レイヤーの
  パドック行** = ops-spec `vehiclePlacements()` の mount 'paddock' の足跡 + 0.3 m — トランスポーター・ホスピタリティ・テント・
  コンテナ・コンパウンド、I3-b）・フェンス run（0.6 m）・街灯（0.7 m。街灯自身も運営レイヤーの足跡の中なら立てない
  `paddock-lampsUnderOps`）に触れず、`CAR_PARK.slopeGrade`（対角 × 4.5 %）より平ら** な区画だけ残す
  （`group.userData.paddockParking` に街区ごとの walked / kept / rejects / cars）。現状 792 区画中 414（A 182 / B 32 / B45 14 /
  E 95 / ヤード 17 / S 74）: 落ちるのはほぼ `slope` = I2-a の外側リング（A 南列 −127 から、B −123 から、E −66 から）が relief 核の
  外で DEM フェードに乗って 6–20 % の勾配になる区画で、P7 の relief 継ぎが平らにするまで線も車も置かない（面だけ舗装）。
  I3-b からは **B 街区が全部マーキーの下か斜面**（68 区画 = slope 34 + footprint 34、車 0・区画線無し。I3 レビューでマーキーを
  平坦帯 −108.5…−123.5 の 15 × 15 × 3 に縮めても −112 軸の区画は足跡、−128 軸の区画は斜面で落ちる）で、台数は
  min(`paddockCars`, Σ occupancy × kept) = 高 305 / 低 140。
  **区画線**: 残した区画の長辺に白 0.1 m の quad（列内で隣と共有する線は 1 本）を街区ごとに `ground.decal`（yHint = その点の
  standY、rung `LAYER.paddock.line` 20 mm、`paddockBayLines-<id>`、`markDecal`、uncovered 0、plain colour）。**黄ハッチ**: チーム
  オフィスの各ロールドア前（39 = `infield-office-shutters`）に 3 × 3 m の黄縁 + 45° ストライプを、写真どおり暗い舗装パッチの上に描いた
  不透明キャンバス（`yellowHatchTexture`、plain map — 高ティアの fence003 カットアウトは法線マップ付きで program を共有できないので
  カットアウトにしない）の 1 デカール `paddockHatches`（`LAYER.paddock.hatch` 10 mm）。
  中心 lat −77.9（計画の −78.5 だとピット側ポーチ −79.5 のスラブに 0.5 m 潜るので 0.6 m 外へ）。**駐車車両**: `carBodyGeometry(kind)`
  + `carBodyMaterial()`（`carBody|tint`、`CAR_MIX` / `pickCarBody` / `pickCarColour`、後ろ向き駐車 `CAR_PARK.noseOut` 70 %、ヨー
  ±2°・位置 ±0.15 のジッタ、`standY` + 0.02）を種類別 PropSet に、高ティア + パックは `CAR_GLB` の kei / keitruck / minivan を
  `carGlbGeometry` + `carGlbMaterial(map, 'tint')`（`carGlb|tint`、map 必須）で L0、A 街区に `covered_car` × 3（長辺を Z に回す、
  無しは灰ボディ）。`registerPropSet(ctx, 'infield', 'infield-paddock-cars', …)` 段 [GLB `Quality.infield.vehiclesNearM` 260 m, 手続き
  `farField.rangeFar`（ramp 100）, 空]（Node / 低は手続き 1 段）。台数 = min(`Quality.infield.paddockCars`（高 320 / 低 140）, Σ round(occupancy × 区画数))
  を街区の occupancy × 区画数で按分（予算を超える需要は縮めて端数を最大街区で合わせるので厳密に一致; 高ティアは需要 291 < 320 なので 291）。影は落とさない（車高 < 2.5 m、§横断 6）。
- 計画 I2.md からの差分（I2 レビューで棚卸し）: A 南列・B の内縁は −126 でなく −124（帯の 1 m 内側、layer 1 — 芝の筋を出さない）;
  サービスハウス前庭は s 5620–5760 × −146…−222 の枠でなく OSM 469896634 そのもの（枠は S 字の道路を切る）; E 接続は三角でなく
  OSM 頂点 31–32 の壁ポリラインから s 5536 まで（5480–5536）; センターハウスは 8.0 でなく 8.7（I1 ブリッジ天端 + 0.15）で柱は
  リムでなくバルコニー外 ≥ 2.4 m; 給油所は 98–128 × −70…−97 でなく 98–122 × −60…−96 でエプロン行は無し（上記）; 構内道路の門は
  '−s' でなく '−lateral'; 街灯の道路は 184120107 でなく 184429431/432/434 + 469650860 で 29 本、GLB でなく手続きポール; モジュールは
  ≈ 300 tris / 3 群でなく 66 tris / 4 群 + 開口アトラス; 区画線の yHint は路面でなく standY、uncovered は === 0 でなく < 1;
  フェンスは 1,200 m でなく 633 m（smoke 600）; ヘアピンのマストは I4。
- 検査: `scripts/audit/paddock-smoke.mjs --tier both`（モジュール数 = 表、床 |y − (路面(s0) − 0.12 + 0.15)| ≤ 20 mm、柱 16 =
  `centreHouseColumns` の XZ クラスタで楕円の ≤ 0.97・OSM リングから ≥ 2.4 m、マスト 2 = 頂点クラスタ（トンネル頭は I6-b で廃止）、デカール
  uncovered 0、島縁石の markObject、フェンス ≥ 600 m・法線水平・各カードの下辺が 1 m 刻みで standY ± 0.15 m（地面が 1 m 内に ≥ 0.2 m 段になる継ぎ目の標本は除く）・門 3、街灯 ≥ 20 で
  water 面上に無くハッチ内に無い、`stats.infield` の一致、全 paddock* が
  リング内; I2-c: `paddockBayLines-*` が rung 20 mm・uncovered < 1、ハッチ数 = ロールドア数・面積 = n × 9、車 = min(`paddockCars`,
  occupancy 需要) ちょうど（≥ 250 高 / ≥ 110 低）、L0 の車の中心同士 ≥ 2.2 m、全車が paddock 面上・フットプリント外・ピット包絡外・E の放送帯外・リング内、
  `userData.paddockParking` の合計一致; `--glb` は stub registry の車 GLB で L0 = `car-<kind>-glb`・L1 = 手続き・covered_car 3 を確認）; facilities-check §16 O6 / O11（PADDOCK_BUILDINGS の外形は互いに交差せず、重心は自分の
  s 窓に射影 — O11 は `OsmFeature.centroid` を EN と読んでいたので EN 重心の射影に直した）。静的コスト（Node、高）: I2-b で
  3,869,335 tris / 965 メッシュ / 808 IM / 1,010 エントリ（IM 予算を 807 → 889 = 実測 × 1.10 に、低ティアはメッシュ 722 → 801）、
  I2-c で 3,898,362 tris / 972 メッシュ / 830 IM / 1,014 エントリ（+29 k tris = 区画線デカール 8.8 k + 車 320 × ≈ 70 + ハッチ、
  +7 メッシュ = デカール 7、+22 IM = 車の種類 7 × セル）、低ティアは 2,039,776 tris / 688 IM が予算 2,038,400 / 686 を超えたので
  実測 × 1.10 = 2,243,800 / 757 に置き直し（`measuredAt` I2-c）。I2 レビュー修正後（フェンス小区間 126 → 430 カード、車 291、
  街灯ポール 68 tris）は高 3,900,418 tris / 975 メッシュ / 831 IM / 1,014 エントリ、低 2,043,572 tris / 738 メッシュ / 688 IM / 797
  エントリ（いずれも予算内、予算は据え置き）。生成データ 1,018,297 B（変わらず）。programs は増えません
  （plain colour / plain map / `carBody|tint` / `carGlb|tint`、いずれも既存）。未確認寸法は各行の `unverified`。

### 運営レイヤー

`app/three/ops.ts`（I3-a の傘）が `ops-vehicles` → `ops-pit` → `ops-people` を順に呼び、全配置を `ctx.ops`（= `group.userData.ops`）に
積んで `stats.ops` に併合します。データはすべて `app/data/ops-spec.ts`（純データ、three 非依存、座標は `PIT_ENVELOPE.stop` /
`GARAGE_CENTRES` / `PADDOCK_*` から導く）で、`facilities-check §16` の O1–O12 と `scripts/audit/ops-smoke.mjs` が同じ行を読みます。

#### 車両・ホスピタリティ・テント・コンパウンド

`app/three/ops-vehicles.ts`（I3-b、ops-spec **B 区画** `vehiclePlacements()` = 103 行: truck 25 / vehicle 17 / crane 1 / cabin 11 / tent 15 /
container 16 / equipment 4 / generator 2 / barrier 12）。すべて `registerPropSet(ctx, 'ops', …)` の InstancedMesh（高 3 セル、低 1 バケット）、
`ground.standAt` の上（長い箱は四隅の最低値、勾配で浮かない — だから剛体の箱は街区の平坦帯にしか置けない: I2 の relief 環は B 街区の
外周で 3.9 m、E 街区で 3.2 m 登り、ops-smoke は四隅の地面が原点から 0.3 m 以上ばらつく箱を落とす）、影は高さ ≥ 2.5 m の L0 だけ（§横断 6）。
**静的車両は `models` に入らない**。

- **トランスポーター**（`ops-vehicles`、`OPS_VEHICLE_MODELS`）: 白い日本の箱トラック = `car-bodies.ts` 'truck'（12 × 2.5 × 3.9、`carBody|tint`
  に白の instanceColor）+ **チーム色の帯 0.3 m**（ドア高さ 2.0–2.3、両側面 + 後扉の薄板、plain 白 + instanceColor の別 IM）。チーム毎 2 台
  `boxS ± 6.2`、**平行駐車**（yaw −45°: 鼻は +s とパドック歩廊側）— 計画の V 字は 19 m ピッチでは隣ブロック同士が交差し、45° の 12 × 2.5
  の車体は横幅 10.25 m（表の 8.5 は幅を無視）で −63.5 中心だとホスピタリティに 1.1 m 食い込むので、**−62（1.5 m キャノピー寄り）**
  に置く（テールリフトは滴線 −56.4 から 0.5 m、鼻はユニットから 0.4 m）。**ブロック 5（5769.5）は 1 台**: +s 側の枠が裏スパーのトンネル
  ホール（5771.5–5778.9 × −56.7…−66）。21 台。白 2 t トラック 4（'truck' を 6 × 2 × 2.8 に縮めた車体、B パドック北の帯 −104.5、鼻は
  マーキー側）、バン 6（`van_h100` GLB `carGlb|tint`／手続きミニバン、ホスピタリティの隙間 −72、歩廊 −74.5 とトラックの鼻から 2.5 m）。
- **航空コンテナ** 20 ft（`ops-containers`、6.06 × 2.44 × 2.59、白灰 0xe6e7e3 の plain に `container_side` の法線 + ARM だけ（`noMap`:
  Poly Haven の albedo は緑の海上コンテナで、色の乗算では白くならない — I3 レビュー。program は pit-building の white_plaster_02 と同じ）、
  隅柱と扉バー）: コア裏 6 スタック
  （2 段 × 4 + 1 段 × 2 = 10 基）を **横向き**（yaw 90、core.mid + 0.5）で −63.5 に（表の −66 だと遠端がトラックの鼻に当たる）。
- **ホスピタリティ**（`ops-hospitality`、手続きのみ、`unverified: form`）: チーム毎 1 基 (boxS, −71) 10 × 7 × 6.6 — コンクリ床スラブ
  （IM = G8 免除）、1F 全面ガラス（`facade001`／glassMat）+ 白の頭帯、2F 白パネル（`paintedmetal010`／plain）を歩廊側に 1.5 m
  セットバックしたバルコニー + 手摺、屋上手摺（`Quality.infield.detail`）、+s 端 1.5 m の帯に外階段（`modular_fire_escape` GLB を
  高さ 3.45 に、足跡が帯に収まらなければ傾斜箱の手続き階段 + 踊り場）。**チーム色ビニール帯 1.2 m**（4.5–5.7）と**屋上ロゴ枠**
  （3 × 1.2、文字無し）は 1 つの着色 IM。ブロック 5 のユニットは 2F ブリッジ（5773–5777、ソフィット 5.05）を避けて **−s に 3 m**（5766.5）。
- **テント**（`ops-tents`）: ガゼボ 3 × 3 × 2.8（脚 4 + 四角錐 + 垂れ幕、`plastic013a`／plain）をコア毎 2 — **core.mid − 5.5 / − 2**
  （45° トラックの側面がコア間を斜めに横切るので ±2.5 では鼻に当たる；スパー脇のコアは core.mid − 1 に 1 基）= 11。マーキー
  （PVC 壁 3.0 + 切妻、近段は `tent_canopy` GLB を箱に非等方 fit）を **B パドックに 15 × 15 × 4.5 を s 沿いに 3**（s 5, 22, 39 × −116、
  yaw 0、17 m ピッチ・2 m 通路、−108.5…−123.5 = 街区の平坦帯。計画の 35 × 15 は 17 m ピッチに重なり、I3-b の横向き 35 m
  −108.5…−143.5 は −124 から 3.9 m 登る斜面に掛かって高い側の壁が埋まった — I3 レビュー、四隅ばらつき ≤ 0.25 m）、メディアマーキー 20 × 10 を
  E パドック縁 (5496, −88) に横向き（表の (5480, −92) 縦向きはコンパウンド南フェンスの上、しかも E パドックはピット入口の曲線の内側で
  s 20 m が世界の 15 m）。
- **放送コンパウンド**（`ops-compound`、E パドック予備地の舗装部 OSM 474537492: s 5448–5488 × −51.5…−80。舗装が平らなのは −51…−63.6
  だけで −66 から relief 環が 3.2 m 登るので、剛体は全部その帯に置く — I3 レビュー: 横向き 2 列目 −73 は端が 3.1 m 埋まっていた）:
  40 ft コンテナ 12.2 × 2.44 × 2.9 × 6（**s 沿い 3 列 × 2**、−53.5 / −57.5 / −61.5、4 m ピッチ・1.56 m 通路、室外機 + 扉、四隅ばらつき
  ≤ 0.25 m）、パラボラ 3.0 φ × 3（−54 / −58 / −62、Lathe の椀を 40° に、三脚 + フィード）、発電機 2（−57 / −61、`diesel_generator` GLB／
  箱 + 排気管）、ケーブルランプ 1 列（s 5473.8、黄黒 0.9 m 分割）、白パイプフェンス 1.1 m（支柱 + 2 桟の 2.5 m パネルを世界の端から端へ
  並べる — ピット入口の曲線の内側では s 沿いの行の (s, lat) 矩形が世界では短い；s 沿いの辺は 10 m 行 × 4）+ 60° に開いた門扉。
- **車両**（`OPS_VEHICLE_MODELS`、GLB は `modelPrototype` を材質毎の部位に分け全部 `carGlbMaterial(map, 'tint')` — 車体材質に map が
  無いので共有の 1 × 1 白 map（null map は別 program）、暗い写真部位は luma で無着色、+X 前 → +Z、`carGlb|tint` 1 program；遠段は
  `carBodyGeometry` + `carBodyMaterial`；灯火バー・帯・ブーム・黒ルーフは両段に出る手続きの別 IM）: FIA SC = `jdm_sport_99` 赤 +
  琥珀バー、メディカル = `sigil_07` 銀 + 赤帯 + バー、鈴鹿 SC = `ace_11` 黄 + 黒ルーフ + LED バー、SUV = `urban_10` 黒 × 2、救急車 =
  `shvan_92_ambulance`（車体テクスチャ）× 2、消防 = `van_h100` 赤 + 赤バー × 2、クレーン = `lightbody_flatbed` 黄 + 折り畳みブーム、
  回収車 = `lightbody_tow` + バー、トラクター = 手続き箱 + 車輪 4。位置: **FIA SC / メディカルはピット出口ヤードのレーン側帯
  (154 / 160, −30)** — 計画の `OPS_LAYOUT.scPocket` (91–97, −24.3) は T1 キャップの中（OSM 外形 184422099 は s 92–103 で −24.3、
  88–92 は案内箱）で置けない；救急車 (168 / 174, −30)、消防 (180 / 186, −30)、車両基地のエプロン（ロールドア前 2 列: 鈴鹿 SC・SUV 2
  at s 142.5、クレーン・回収車・トラクター at 134）。計 43 台。
- 検査: `facilities-check --strict` §16（103 行 0 faults）; `node scripts/audit/ops-smoke.mjs --tier both [--glb]` の `checkVehicles`
  — 行数 = ctx.ops、L0 全インスタンスがどれかの足跡の中、**各インスタンスの bbox が配置の箱 ± 0.3 m**（剛体は中心フレームの
  直箱、端から端へ並べる薄い行は (s, lat) 四辺形）、車両 y ≥ standY − 0.05、**地面に立つ剛体の全インスタンスで四隅の地面
  （`ground.standAt`）が原点 ± 0.3 m**（I3 レビュー: 斜面に掛かるマーキー・コンテナを捕まえる。最大ばらつき 0.29 m = bc-container-21）、
  chase レンズ柱 12 / レンズ→車の経路に何も無い、
  駐車車両・街灯が足跡の中に無い、Node は 2 段（手続き + 空）で `-glb-` 無し; `--glb`（stub registry の ops / van / 非常階段 13 モデル）
  は GLB 12 種が L0、車両プロトタイプ ≤ 12 k tris（最大 10,349）、ピットセルの可視 Σtris ≤ 1.2 M。静的コスト（Node）: I3-b 時点
  3,922,859 tris / 970 メッシュ / 872 IM / 1,022 エントリ、低 2,058,769 / 733 / 723 / 802（I3 の各コミットの数は「人物配置」末尾の
  I3-d 実測が現行）。programs +0（plain / plain + instanceColor / {map} / pbrFromAssets / `carBody|tint` / `carGlb|tint`）。GPU 未確認:
  GLB 車両の着色（luma 帯の写真部位）、テントキャノピーの非等方 fit、ホスピタリティの PBR パネル、白灰コンテナの法線だけの凹凸。

#### ピットレーン機材とプラットペルチ

`app/three/ops-pit.ts`（I3-c）が ops-spec **C 区画** `pitEquipmentPlacements()`（255 行）を描きます。行の座標は `fromStop(dLat)` =
`PIT_ENVELOPE.stop + dLat`（フォールバック停止 −17.1 なら補助レーン外 −19.5 に畳む同じ関数、未使用）と `PIT_EQUIPMENT` 表から。

- **包絡の 2 つの事実が配置を決める**: (1) §16 O1 はボックス帯でも解析キープアウト `[c − 6.5, …]` = [−21.1, −9.1] を保つので、静的な物は
  `KEEP_OUT_EDGE` −21.1 より左に立てない — 計画の「走行レーン縁 −19.5 のコーン」「−19.3 からのケーブルランプ」は不可能で、どちらも
  キープアウト縁から始める。(2) 隣ブロックへ到着する車は最後の 25 m を**停止 lateral そのもの**で走る（race.ts は boxS の 100 m 手前で
  `PIT_PLANNED.stopLateral` に切り替える。53 周 × 3 seeds の実測: 24 m 手前で中心 ≤ stop + 0.5、14 m 手前で ≤ + 0.11）ので、ボックス帯
  全長の **stop ± 0.95（`PIT_ENVELOPE.carHalf`）は車の空間** — 機材の列はすべて停止線のガレージ側に置く（両ジャッキ stop − 1.8、コーンは
  コア前 stop − 2.0。I3-c の「前ジャッキは停止線上、コーン stop + 0.8」は、ブロック g に入る全車が g + 1 の前ジャッキとコーンを踏んで
  いた — I3 レビュー）。§16 O1 はこの到着帯（ボックス帯 × stop ± carHalf、踏まれて良い ≤ 0.1 m のケーブルランプは除く；人物は点で同じ帯を弾く）も
  弾き、`pnpm sim -- --pit-trace` が全ピットレーン車の車体（s ± 2.9 × ± 0.95）と機材列・クルー人物（r 0.3）の接触を数える（機材列は
  接触 0 が門、人物はブロック別に報告）。**注意**: sim は静的レイヤーと衝突判定しない。A 区画のクルー行（stop + 1.9 のガンナー）は
  「人物配置」の判断。
- **チームブロック毎**（11、空きベイ 12 は消火器のみ）: ガントリー = 0.25² 支柱 2（`(boxS ± 2.9, stop − 2.4)` 4.2 m、OPS_LAYOUT.gantry の
  2.9 — 計画の 3.6 は梁端がレンズ経路 boxS − 3 に入る）+ 梁行 1（mount `'roof'`、y 3.85、boxS ± 2.9 × stop − 2.4…**+ 2.3**
  = キープアウト縁 −21.2 まで。s 方向の梁は支柱天端間 5.8、ホイールライン ±1.7 の腕 2 本が車の上を渡り、前腕の下に信号灯箱
  0.5 × 0.4 × 0.3（下段 2 灯 = `EMISSIVE.pitExitLight` 緑・上段 2 灯は消灯の暗赤）、腕からホース（φ0.024 の管 — LineSegments は
  +1 program で IM に入らない）で 4 丁のホイールガン（`impact_wrench` Object_2 / 箱 0.35、底 1.15 m）を車輪の上に吊る = 停止車矩形
  内にある唯一の物）；タイヤスタック 3（`(boxS − 6 / −7.5 / −9, stop − 3.9)`: 計画の −3.2 はクルー表のタイヤ係と同点なので 0.7 m 奥、
  白ブランケット φ0.72 × 1.0 を instanceColor チーム色 + 上に `tyreMaps` の裸タイヤ、手続きのみ）；ジャッキ 2（`trolley_jack` / 箱、
  前 (boxS + 4.6, stop − 1.8)・後 (boxS − 4.6, stop − 1.8)、どちらもジャッキ係の脇のガレージ側）；燃料ドラム + ホース台車 (boxS + 7, **−30.5**) interior（OPS_LAYOUT.fuel の −33 は
  pit-building のガレージ内タイヤ山と同点）；モニター台 1.9 m (boxS **+ 6**, stop − 3.9)（計画の (−7, −3.5) は第 2 タイヤスタックの
  上、−s 側は後ジャッキ係の位置。画面 2 枚 = `pc_monitors` / 箱 0.55 × 0.35 の `opsMonitor` 発光面）。
- **コア毎**（6）: 緑コーン 5（コアの −s 面 + 0.4 から 0.9 m ピッチ、中心線は空ける、ガレージ側 stop − 2.0 — 手続きの円錐 + 白帯のみ、
  全ティア: `cone_pack` の 2 種のコーンはどちらも橙で GLB 近段は手続き色を受けないので、高ティアで橙 → 120 m で緑に跳んでいた）、
  ケーブルランプ 1 × 0.3 × 0.05 黄黒を中心線上に −21.2 → −28.2 の 7 枚（IM `ops-cables`、エプロン +10 mm ≥ LAYER_MIN_STEP）。
  消火器 48（各ピットの +s ピア前、−27.85、`korean_fire_extinguisher_01` / 赤の車輪付き筒 φ0.32 × 1.0）。
- **プラットペルチ v2**（mount `'wall'`、`perch-<b>`）: アルミ φ0.04 管の枠 5.5 × 1.3 × 2.6 を歩廊 +0.5 の中心 −10.4 に、床 +1.0、
  壁側にデスク +1.75 とモニター 4（座席側 −lateral 向き）、スツール 3（座面 +1.45 = `perchSeats` の y 1.4、I3-d が座らせる）、
  後隅に傘 2（φ1.4、天 +3.2）、天端にチーム色キャノピー（instanceColor）。**固定プラットホーム 31–69 上のペルチ**（ブロック 2 と、
  端 31 に跨るブロック 3 → 31.5–37.0 に移動）はデッキ +1.3 の上に幅 1.0（パラペット −11.05…−10.85 と壁の間、中心 −10.35）。
  **ブロック 4（s 7.5）はスターター台 + 階段（3.7…9.5）と重なるので s 10.1–15.6** に置く（`perchCentreS(block)`、
  `perchOnPlatform(block)` を C 区画から export。A 区画の `perchSeats` は boxS のままなので I3-d はこれを読む）。
  ピットボード（`pit_board` / 0.8 × 0.5 板 + 柄、全高 1.2 で歩廊に立て掛け）を各ペルチの +s 側 3.75 m（枠半分 2.75 + 1.0、`PIT_EQUIPMENT.board.dS`）に。固定プラットホームに TV カメラ 2
  （s 40 / 60、三脚 1.4 + `security_camera_01` / 箱）とモニター台 1 (45.5)。v1 の `perchCanopies` / `perchBacks`（pit-lane.ts）は削除。
- LOD / コスト: 4 セット `registerPropSet(ctx, 'ops', 'ops-pitEquipment' | 'ops-perches' | 'ops-cones' | 'ops-cables', …)`、段
  [GLB `Quality.infield.propsNearM` 120 m, 手続き `propsFarM` 600 m, 空]（Node / 低は手続き 1 段 1 バケット）、受けのみ（建物級無し）。
  GLB / 手続きの対は長辺を local x に揃え同じ四半回転で置く（pit-building と同じ規約）。静的コスト（Node、高、I3-c 時点）: 近段 489 体 /
  40.4 k tris（I3 レビューでコーンに白帯）、`farField/ops` 66,010 → 105,234 tris / 21 → 60 IM / 1,962 → 2,459 体；合計 3,938,843 tris /
  975 メッシュ / 867 IM / 1,022 エントリ（予算内、再ベース無し。I3-b の 872 IM との差はコミット間の遠景セルの再分割）、低 2,080,257 / 738 / 708 / 801。programs は増えません（plain / plain + instanceColor / plain + emissive /
  {map, normalMap, roughnessMap} のタイヤ、いずれも既存）。
- 検査: `facilities-check §16`（255 行すべて O1 / O3 / O5 / O12、梁行は 'roof' で地面規則を支柱に委ね O3 は受ける）、
  `scripts/audit/ops-smoke.mjs checkPitEquipment`（4 セットの存在、`userData.ops` に C 区画の全行、近段 489 体の世界 bbox がすべて作業
  エリア / 歩廊帯 [−12, −9.05] / ガレージ内のどれかに入る、底 1.0 m 未満の物が 12 の停止車矩形に無い、レンズ柱に 2.9 m 超無し・
  レンズ→車の経路に何も無し、ガントリー天端がキープアウト縁 −21.1 より左に出ない、歩廊帯は壁の歩廊面 −9.75 まで（壁天端 1.8 を越える物だけレーン面 −9.05 まで）、ケーブルランプ
  42 枚が +8 mm 以上、`--glb` で stub registry の 6 プロトタイプ（コーンは手続きのみ）が ≤ 2.9 m / ≤ 6 k tris で手続き遠段を持つ）、
  `pit-smoke checkLane`（レーン帯・レンズ柱、v1 ペルチ名を外した）。
- GPU で確認すること: `pc_monitors` の画面の向き（`front: 'moreArea'` — ペルチでは座席側、モニター台では車側）、`impact_wrench` の
  吊り姿勢、`trolley_jack` のレバーの向き、`pit_board` の白パネル、120 m の L0 ↔ 手続き切替、キャノピー / ブランケットの instanceColor、
  信号灯の緑 2 灯（輝度 2.3、halo 無し）、緑コーンの白帯。

#### 人物配置

`app/three/ops-people.ts`（I3-d）が ops-spec **D 区画** `figuresAt()`（298 体、I4-a のトラックサイドマーシャル 90 を足して 388）を描きます。行は `(s, lateral, yawDeg, pose, role, team?,
y?, mount)` の純データで、座標はすべて `PIT_ENVELOPE.stop`（A 区画 `crewSlots`）、C 区画の `perchCentreS` / `perchOnPlatform` /
`PIT_EQUIPMENT.perch`（`perchSeats` はスツールの位置に座らせる: 縁石側の縁から 0.3 m、トラック向き、原点 = 台床 + 0.05 — 座り姿のアトラスは腰 0.4 m
の座席上で焼いてあるので原点は床）、`coreEdges()`、`PIT_WALL.platform`、`PIT_BUILDING.v2.podium / rostrum / floors`、`OPS_LAYOUT.officials /
marshals / photographers`、`STAFF`（歩廊の線、前庭、コンパウンドと車両基地の空き通路）から導きます。`figureToWorld` が
`track.pointAt` で世界へ、高さは地面に立つ行が `ground.standAt`（路面基準の差分を `pointAt` の yOffset に）、'wall' / 'roof' の行が
`y`（路面基準: ペルチ床、固定プラットホームのデッキ +1.3、表彰台 2F +5.05）、向きは `yawDeg`（0 = +s、+90 = +lateral）を群衆の
`atan2(dx, dz)` に。役割毎に `buildOpsFigures`（figures.ts、kind 'ops' の 250 m セル、3D 段 `figures3dM` 80 m はパック時のみ、
インポスター `figuresFarM` 600 m、`crowd|baked / crowd|figure / crowd|procedural` の共有 program、観客予算とは無関係）。

- **ピットクルー 165** = 各チーム 12（ガンナー 4 `(boxS ± 1.7, stop ± 1.9)` crouch、タイヤ係 2 `(−6 / −7.5, −3.2)`、ジャッキ係 2
  — 前 `(4.6, −2.6)`・後 `(−4.4, −2.7)`、どちらも自分のジャッキ (± 4.6, −1.8) の脇 — ロリポップ **`(5.8, −1.6)` ガレージ側**（I3-d の
  レーン側 (5.5, +1.5) は退出車の車体が毎回通った）、シャッター前 3 `(± 3 / 0, −27.0)`）+ ペルチ 3 座り。チーム色シャツ / 0x1e2126 /
  白ヘルメット。**退出車との関係**（I3 レビュー、race.ts `PIT_EXIT_HOLD_M` 3.5 / `PIT_STEER_EXIT_BOOST` 3.0）: リリースされた車は
  停止 lateral を 3.5 m 保ってからレーンへ切るので、53 周 × 3 seeds = 66 ストップの実測で退出車は自ブロックの人物・ジャッキ・コーンに
  触れず（車体 s ± 2.9 × ± 0.95、人物 r 0.3。テールが前ガンナーを過ぎる時に中心 ≤ + 0.49、鼻が次ブロックの後ガンナー boxS + 17.3 に
  届く時に ≥ + 3.56）、pit-trace の門（停止 −23.5 ± 0.5・重なり 0・復帰中央値 26.1 m ≤ 40・8 周混雑ピットロス 26.0 s・53 周 21.7 s）は
  緑のまま。**注意**: 到着車は最後の 25 m を停止 lateral で走るので隣（−s 側）ブロックのレーン側ガンナー 2 の 0.65 m 脇を毎回通り、
  コアを挟む 26 m ピッチ（ブロック 0 / 2 / 4 / 6 / 8）ではまだ寄り切っておらず（24…30 m 手前で + 0.4…1.2）2 人を横切る（66 中 29）、
  43 m 手前（中心 + 3.0…3.5、車体縁 −21.45）では 2 つ前のブロックの前ガンナー（−21.6）を掠める（66 中 38）；混雑した harness
  （22 台同一周回のストップ）ではチームメイトの脇 stop + 2.0 で待つ車が通り抜ける — sim は静的レイヤーと衝突せず、chase-in-box の
  画のためのクルーなので受容（O1 の停止車矩形と到着帯は守る）。`pnpm sim -- --pit-trace` がこの接触をブロック別に報告する。
- **オフィシャル 27**（白 / 0x14161a）: コア扉前 2 × 6（core.mid ± 1.2、−27.0）、固定プラットホーム 6（s 41.5 / 47 / 48 / 57.5 / 64 / 66
  × −10.2、デッキ +1.3 — ペルチ 2 基・ボード・キャビネット・TV カメラの空き）、表彰台テラス 4（5632 ± 1.6 / 3.2 × −27.8: 黒ステップ
  −27.2 と背景壁 −28.3 の間、mount 'roof'）、出口灯 2（129 / 130.3 × −21.7: 灯柱 (128, −21.5) と `pit-exit-outer` 壁面 −22.3 の間、
  解析キープアウト縁 −21.0 の外 — 計画の (127, −22.5) は壁の中）、入口 3（5539…5542 × −21.7: 縁 −21.1 の外。計画の −20.5 は中）。
- **マーシャル 18 + 90**（橙 0xf07020 上下 + 白ヘルメット）: コア面 12（面から 0.5 m 外、−26.6 — 計画の −27.5 はコア脇ピットの消火器
  −27.85 と接触）、出口ヤード 4（145 / 157 / 169 / 181 × −26、レーン側車両列 −29…−31 の 3 m 手前）、入口 2（5548 / 5552 × −21.7）。
  トラックサイドポストの 90 体は I4-a の `marshalSlots(post)`（A 区画、「マーシャルポスト v2」）— 合計 108。
- **写真家 11**（黒）: プラットホーム 5（39 / 44.3 / 58.5 / 65 / 67.5、`lookUp` をカメラ構えの代用）、出口ヤード壁裏 4（145…175 × −24.4
  — 壁は −22.0…−20.4、エプロンは s 180 まで）、E パドックのメディアマーキー脇 2。
- **スタッフ 77**（灰白 / 黒、walk / stand）: 63 がホスピタリティ歩廊（ユニット面 −74.5 から 0.7 m の歩き線 −75.2 ± 0.25 と、
  オフィス側の立ち話ペア −76.6 — B / A 棟の OSM 外形はポーチ込みで −77.6 / −76.8 まで来るので O6 が −78.6 を弾いた；街灯 (…, −77) から
  1.5 m 空ける、6.2 m ピッチ + seeded ±1 m）、ユニット間の隙間（バンの両脇 ±2.7）、センターハウス前庭 8、放送コンパウンド 8
  （コンテナ列とパラボラの間の通路）、車両基地 6（扉列と後列の間、ロールドア前、帯の車の間）。
- **旗**（I3-e）: E パドック縁の 9 m ポール 8 本（5410…5500 × −34 — 計画の 5350 からだと囲いフェンス 474537488 が 5360–5395 で
  −34 を横切る）、架空 3 色（上下帯 + 白。`FLAG_COLOURS` は赤・青・緑を避けた teal / 橙 / 紫 / 金 / 炭 の対 — I3-d の赤白青・青白赤・
  緑白赤・赤白緑はオランダ・ロシア・イラン・ハンガリーの国旗そのものだった、I3 レビュー）を色対毎の手続きプロトタイプ（plain DoubleSide、paddock.ts の門旗と同じ program）で
  `ops-flags` に IM。**静止**: 波打ちは props.ts の `onBeforeCompile` program で、§横断 7 の下では新 program を作れない（paddock.ts の
  T1 キャップ／門の旗も静止）。
- 検査: `facilities-check §16` O9 を mount 対応に（'wall' は歩廊帯、'roof' は O3 / O4 のみ、他は O1–O4。O1 は到着帯 stop ± 0.95 も弾く）、さらに全人物が ops 足跡の外
  （座りクルーの自ペルチ枠と 'roof' 行の下は除く）と建物外形の外（O6）— 298 体 0 faults、`--envelope` の実測包絡でも同じ；
  `scripts/audit/ops-smoke.mjs checkPeople`（5 セット、インポスター 298 = 行数、各行の描画原点が `figureToWorld` の点 ± 5 cm、
  **手続きインポスターの `aCell` が役割のアトラスセル**（marshalAtlas は上から描いて flipY で上げるので行 r は v = (3 − r) / 4 — I3-d
  までは行が 0 ↔ 3 / 1 ↔ 2 に鏡映し、低ティアの McLaren クルーが Aston Martin 色・マーシャルが Alpine〜Cadillac のクルー色で出ていた、
  I3 レビュー figures.ts）、standY からの高さが mount の帯 [地面 −0.05…0.3 / wall 0.4…2.6 / roof 4.5…5.5]、Node で mode 'procedural'、停止車矩形・レンズ経路・
  ops 足跡・パドック駐車車両の中に誰もいない、旗 8 本が接地、`--glb` は eclair の姿勢 GLB を stub registry に積んで 3D プロトタイプ
  ≤ 1.4 k tris — ヘルメットのドームを 20×14 → 16×12（352 tris）に落とした: 男性 + ヘルメット 1,240、女性素体 1,356）。
  `pnpm sim -- --laps 8 --seeds 3 --envelope` の 181 ビン（進入ラグ 4.26 / 退出 1.99、停止 −23.50、重なり 0）で O1 再検証済み。
  静的コスト（Node、高）: `farField/ops` 105,234 → 130,338 tris / 60 → 118 IM（人物の役割 × セル + 旗）、合計 3,961,823 tris / 970
  メッシュ / **926 IM** / 1,044 エントリ — IM 予算 889 を超えたので実測 × 1.10 = **1,019** に置き直し（`measuredAt` I3-d）；低
  2,097,733 / 733 / 752 / 812（予算内）。programs +0（群衆の 3 program と plain DoubleSide の再利用）。I3 レビュー後（コンテナ 8 → 6、
  コーンは手続きのみ + 白帯）: 高 3,961,961 / 970 / 924 / 1,044、低 2,100,167 / 733 / 752 / 812 — 予算内、再ベース無し。
- GPU で確認すること（I3 レビュー、`?fx=1&assets=1`）: 低ティア／パック無しの手続きインポスターがクルー = チーム色・マーシャル = 橙・
  オフィシャル = 白で出ること（`?assets=0`）、白灰コンテナ（法線 + ARM だけ）、緑コーンの白帯、B パドックの 15 × 15 マーキー 3 と
  放送コンパウンドの s 沿いコンテナ列が平坦帯に立つこと（`--custom "b-marquee:60,-100,8:20,-116,4"`）、退出車が自ブロックのクルーを
  避けてからレーンへ切ること（chase-in-box）、旗の新配色。
- GPU で確認すること: 80 m（`Quality.infield.figures3dM`）の 3D ↔ インポスター切替が pit-follow の chase（ガレージ前 8–25 m）と
  ヘリで目立たないこと、白ヘルメット行（アトラス行 28–31 の再焼き後）とドームの継ぎ目、橙 0xf07020 の彩度が日陰のエプロンで
  くすまず MSAA で縁がにじまないこと、座りクルーがスツールに沈まず浮かないこと（原点 = 台床 + 0.05）、表彰台の 4 人が黒ステップと
  背景壁の間に立つこと、旗の帯が両面から見えること。

### トラックサイド

#### マーシャルポスト v2

`app/three/marshal-posts.ts`（I4-a）が `MARSHAL_POSTS`（`app/data/suzuka-barriers-spec.ts`、32 行）を描きます。行は `(s, lateral)` =
キャビン本体の中心で、`type`（cabin / low / building）、`platform`（架台高、既定 2.0）、`stair`（'aft' = −s 側、既定 / 'fore'）、
`number`（番号アンカー: 1 @ 390、26 @ 4961 = r130_post.jpg、28 @ 5240）、`secondary`（同じポストの 2 つ目の小屋: 番号板・パネル・
カメラ無し）、`facing`、`osmWay` / `size`、`panel`、`figures`（1–4、既定 3）を持ちます。`marshalNumbers()` が building でも secondary
でもない行を s 昇順に採番し、アンカーに正確に着地しないと facilities-check O8 が落ちます（29 番まで、全番号 unverified）。

- **v1 からの変更**: props.ts の 1.3 m の「冷蔵庫」+ 3.6 m ポール + 常時緑の旗 + 常時緑発光のデジタルフラッグ（`EMISSIVE.digitalFlag`、
  削除）を廃し、'SECTOR 2 / 3' 板も削除。5 行追加（577 / 666 / 2204 の低ポスト、865、4961 = ポスト 26）。バリア線に掛かっていた行を
  動かした: 390（0.3 m）、650（−16.5 → −18.8: t1-t2-inside 線上）、1010（0.3）、2650 → (2652, 15.0, stair 'fore')（ヘアピンの「(」壁の
  斜辺が階段を横切る）、4110（1 m）、4536（1.7 m、線上）、5450（−22.3 → −22.6: 架台 2.7 m の近縁がキープアウト −21.1 の外）。3 m を超えて
  動かした 3 行は根拠付き: 3288/13.5 → (3292, 24.7)（OSM 184419748 の足跡は 200r-outside 壁の 1.1 m 裏、v1 はランオフの中）、4840/10.5 →
  25.7（130r-inside-wall のフェンスの内側 13 m に小屋は立たない、unverified）、5235/−19.5 → (5240, −28.1)（斜めのタイヤ壁の裏。航空写真の
  もう 1 候補 (5255, −22) は駐車場フェンス 474537488 が −21 を走るので跨ぐ）。2515 と 4536 を `secondary` に（110R と橋アプローチの
  両側の対、番号は 29 個 = 実物「28 以上」と整合）。
- **キャビン** = `MARSHAL_STAND`（ops-spec A 区画、guard と smoke が同じ数値を読む）: 架台 4 柱 0.1² × 2.0 + 中段タイ、床 2.7 × 3.7 × 0.12
  （本体 2.5 + 階段側デッキ 1.1、両端 0.1 の張出し）、デッキ手摺 3 辺（階段の 0.8 m 切欠き）、階段 10 段（蹴上 0.212 × 踏面 0.24、桁 2 本、
  手摺）。本体 2.5³: 下半 1.3 と背面は `blue_metal_plate` の法線 / ARM を 0xe6e6e2 に（`noMap`、ピットビルの白漆喰と同じレシピ、無パックは
  plain）、上半の正面 + 両側面は暗い金網の開口（`cutoutFromAssets('fence003')` の tint 0x3a3c40、barriers.ts の fenceMat と同じ define、
  奥に 0x1a1c20 の内箱）、赤白帯 0.25（本体 +0.4、トリムアトラスの帯行 × 5 周期 = 50 cm ピッチ）、屋根 2.7 × 2.7 × 0.1 0x3a4a5c。端壁に
  旗架（白板 0.6 × 0.9 + 巻旗 5: 黄・赤・青・緑・白）。消火器 3（架台脚元 2 + デッキ 1、`korean_fire_extinguisher_01` / 赤円柱）。パック
  時は本体を Small Guard Booth（`packProp` `scaleTo long 2.5` → 高さ 1.87 m、`front 'moreArea'` を −x へ回す; ガラスの transmission は
  `propMaterial` が plain Standard に作り直すので落ちる）にし、手続き本体を L1 に。`type 'low'` = 2.0 × 1.6 × 2.0 灰箱 0xb9bcc0 + 屋根 0.08。
  すべて `registerPropSet(ctx, 'infield', 'infield-marshal-cabins', …)`（`propsNearM` 120 / `propsFarM` 600、架台・本体・低ポストは
  `quality.farField.shadows` のとき L0 で影を落とす、消火器は受けのみ）。
- **番号板**: 1.2 × 0.8 の白板 0.06、中心 2.4 m、ポストの s に最も近いフェンス柱（run の `sRange[0] + 4k`、barriers.ts と同じ）の走行側
  0.08 m に柵と平行に掛け、**トラックを向く 1.2 × 0.8 の面**（BoxGeometry の ±x 面: 左のポストは −x、右は +x — I4 レビュー前は ±z の
  6 cm 小口に数字が乗っていて全 29 枚が白紙だった）に `marshalNumberAtlas()`（8 × 4、セル 0 空白、数字 0.67 m）のセル；行の `facing`
  は読まない（ポール立ての板用に予約）。柵付きの run で低ティア（柵を描かない）は線の 0.3 m 走行側に自前の柱、**柵の無い run**（素の壁・
  レール）は線の裏（壁厚 + 予備タイヤ列 + 0.2）に自前の柱。1 メッシュ `marshalNumbers`。文字は `TRACKSIDE_TEXTS`（数字のみ、textures-lint）。
- **EM ライトパネル = 消灯**（lpfront.jpg: グリーンフラッグ中は黒い枠に暗い LED 面だけ）: 黒箱 0.7 × 0.6 × 0.2、`panel.s ?? s − 3.2` を
  柱ピッチにスナップ、**柵付きの run**（`RunAt.hung`: fence kind か fence > 0、ティア非依存）では柱から 0.35 m の亜鉛アーム（φ0.05）で
  走行側へ（面の中心は線から 0.7 m；柵を描かないティアは自前の柱）、**柵の無い run** では線の裏（壁厚 + 予備タイヤ列 + 0.2 m、hw + 1.5
  の包絡の外）に自前の柱 — I4 レビュー前はガードレールだけの区間で筐体がランオフの路肩（白線から 0.3 m）に立っていた。面 0.62 × 0.52 =
  `emPanelTexture()` の 64 × 48 ドット（0x2a1f1d、**発光無し**: `EMISSIVE.digitalFlag` と sun-model-check の登録を削除、旗状態の発光行は
  後日）。ベージュの制御キャビネット 0.5 × 0.4 × 0.7 は筐体の背面（+s 側、天端 0.05 下）にボルト留め（lprear.jpg — 地上の箱と脚は無し）。
  IM `emPanels`（筐体 + 面 + キャビネットの 3 材質）、`group.userData.trackside.panels = [{ s, lateral, x, y, z }]`。building 行（3245 の
  役員室、幾何は I5 の INFIELD_FACILITIES）はパネルとカメラだけ。
- **PTZ CCTV**（web-suzuka: 43–44 台）: 番号付き / building のポスト 30 に各 1（s + 3 の柱の裏）+ `TRACKSIDE_CCTV` 12 行（直線、
  unverified）= 42。6 m 灰ポール φ0.08（`cctvPoles`）+ `security_camera_02` / 0.25 × 0.15 × 0.2 箱（`cctvHeads`）、フェンス線の裏
  （壁厚 + タイヤ run の予備タイヤ列 0.84 + 0.25）。mount 'fencePost' 相当で O5 免除。
- **傾斜地の架台**（I4 レビュー）: 架台の原点は 4 本の脚の下の地面（`ground.standY`、行の路面フレーム）の**最高点**に置き、低い脚には
  0.1² の継ぎ足し（地面 − 原点 > 3 cm）、階段の足元には桁受け 2 本 + 踏み台 0.8 × 0.4（> 5 cm）を `marshalFootings`（1 メッシュ、鋼色）
  で足す — 200R 土手のポスト 18（3292, 24.7）は脚の地面差 2.0 m、以前は 2 本が宙に浮き 2 本が埋まっていた。
- **人物**: `marshalSlots(post)`（ops-spec A、純関数）= デッキに 1（本体の前、−s 向き、mount 'platform'、y = 2.12）+ 地上 1–3（床の
  走行側縁から 0.35 m、1.5 m 間隔、トラック向き ± 20°、mount 'trackside'）— 計 90 体（32 行、5450 はキープアウトのため 1、5240 は
  斜めタイヤ壁のため 2）。`figuresAt()` に含まれるので ops-people.ts が他の運営人物と同じ `ops-figures-marshals` に描き、
  `stats.ops.figures` は 298 → 388（I4-c の柵の窓の写真家 7 で 395）。
- **検査**: facilities-check O8（中心 hw + 2、番号の一意・単調・欠番無し・アンカー一致 — `marshalNumbers()` はアンカーで計数を
  リセットするので、アンカーの手前で行が増減したことは `marshalNumberFaults()`（計数の到達値 vs アンカー）が報告する（I4 レビュー前の
  「アンカー ≠ 計数」は恒真だった）、架台 + 階段 / 低箱 / 建物矩形が O1 / O2 / O4、最寄り run
  の観客側 ≥ 0.6 m、他の重なる run から ≥ 0.2 m — run の窓の内側だけで評価する: 端の clamp 値で手前の小屋を裁かない、'fence' kind =
  駐車場外周は除外）、O9 / O12 は 'trackside' / 'platform' を窓検査から外す（O1 / O2 / リング / 建物は掛かる）；
  `scripts/audit/trackside-smoke.mjs checkPosts`（stats = 表、架台の床 + 階段の世界隅が最寄り run の観客側 ≥ 0.6 m、階段の向き、
  架台の原点が最高脚の地面上（浮き無し）、番号板 29 が一意・単調・2.4 m で数字がトラック向きの 1.2 × 0.8 面（番号付き三角形が板ごとに
  2 枚・0.48 m²・法線が横軸）、`emPanels` 30 の材質に emissive 無し・3 グループ目のキャビネットが筐体の裏、パネルが柱ピッチ内・柵付き
  run では線から 0.35–0.75 m 走行側・柵無し run では裏 0.2–0.9 m、板とパネルが hw + 1.5 の外、カメラ 42 が線の裏、
  スロット 90 が包絡の外、`--glb` で警備ブース 686 tris / 1.87 m と L1 の手続き段）。低ティア（fence 無し）は板・パネルが自前の柱に。
#### TV タワーとレンズ

`app/three/tv-towers.ts`（I4-b）が `TV_CAMERAS`（suzuka-barriers-spec.ts、16 行: レンズ行 13 + `lens: false` の塔 3）を塔にし、
`app/three/tv-lens.ts` がレンズ点を解決します。旧 `TV_CAMERA_SPOTS`（suzuka.ts）と `TV_MAST_OVERRIDES` は廃止 — v1 では
cameras.ts のレンズ（`cameraSide · (hw + 9)`、路面 +7.9）と props.ts のマスト（override 3 本）が別の場所に立っていた
（inv-camera-coverage）。今はビルダー・カメラリグ・ガード・smoke が `tvLensAt(track, row, standAt?)` ひとつを読みます。

- **行**: `{ id, s, lateral: number | 'auto', height, tower: scaffold | lattice | crane | pole, lens?: false, unverified }`。
  レンズ行は放送ディレクターが切ってきた 13 の s（250 / 640 / 1180 / 1500 / 1960 / 2230 / 2640 / 3100 / 3650 / 4350 / 4900 / 5250 /
  5560、s 順 = CAM 番号順、height 7.9 = 旧レンズ高）。`'auto'` = `cameraSide` 側の解決した BARRIERS 線 + 2.5 m（`TV_LENS.autoSetback`、
  観客側、グラベルに塔を立てない）。3650 −40 / 4350 −24 は旧 override の明示値。塔だけの行: `b-tower`（602, +88, 22 m 格子塔 —
  計画の (520, +70) は sports_centre リング（そこで +61 まで）の外、航空写真 03 の (575, +70) は B2 の足跡（背面 +76）の中なので
  B2 の背後へ；I4-b の (590, +82) は B スタンド裏のサービス道路 `roads-b6`（+79…+84.5）の真ん中だったので I4 レビューで道路の外側、
  リング（+93）の手前の芝へ）、`hairpin-column`（2680, +14, 6 m 黄クレーン柱、hairpin.jpg）、`t1-crane`（455, −24, 6 m）。FOM の実位置は
  全部 unverified。
- **レンズ点**: 塔中心 `towerLateralAt` の地面 `towerBaseAt`（4 隅の `ground.standAt` の**最高値** — 傾斜地では低い脚に `towerFootings`
  を継ぎ足す、200R 塔は ±0.4 m）+ `height`、トラック側へ `tvForwardOf(tower)` = 天板半幅（`TV_DECK_HALF` scaffold 1.2 / lattice 1.5）+
  `TV_LENS.overhang` 0.7 m（scaffold 1.9 m）。カメラヘッドは前手摺の上に張り出し、その後端が天板前縁 — **天板前縁はレンズの 0.7 m 後ろ、
  前手摺（柱・中桟・幅木）は 0.75 m 後ろ、天板の上面は `deckDrop` 0.6 m 下**（リグの NEAR 0.5 の外: 俯角 49° まで手摺が画角に入らない。
  I4-b の `forward` 0.65 は手摺をレンズの 0.5 m **前**に置いていて、車を見下ろすたびに中央の柱が NEAR 面を跨いだ）。手摺 1.1 m、前面の
  中柱はカメラ湾の両脇 ±0.5 に 2 本。
  `RaceViewport` は `buildEnvironment` の直後に `rig.setTvCameras(env.group.userData.tvLenses)`（13、表順）；未設定時は
  cameras.ts のコンストラクタが旧式で埋める（フォールバック）。**旧レンズとの差**（smoke の表）: 200R 0.2 m のほかは 1.1–22.9 m
  移動 — v1 の hw + 9 は 9 本でバリア線の手前（グラベル・ランオフの中）に立っていて、'auto' 規則が塔を線の後ろへ出す。
  計画の「override 3 本以外 ≤ 1 m」は成り立たない（規則はデータのもの、smoke は表を note として出す）。距離は自動ズームが吸収。
- **幾何**（手続き、`registerPropSet(ctx, 'infield', 'infield-towers', …)` 段 [700 m, 空]、L0 の影は `farField.shadows`）:
  scaffold = `latticeParts({ height: h − 0.65, baseHalf 1.2, topHalf 1.2, panel 2, leg 0.06, ring 0.05, brace 0.04, braces: quality.fence })`
  + 天板 2.4² × 0.05（`MetalWalkway012` PBR、パック無しは鋼色）+ 手摺（柱・上下レール・幅木）+ 背面梯子 + 三脚（脚 3 本は天板内、
  頭は前手摺の 0.1 m 内側、カメラヘッドはその上から手摺越しに張り出す）；lattice（b-tower）=
  `latticeParts({ 21.35, 1.6, 1.0, 3, 0.12, 0.08, 0.06 })` + アウトリガー + 3 × 3 天板；crane = 台座 1.5² × 0.3 + 黄柱 φ0.5（0xf0b400）
  + ジブ 0.25² × 4 m 25° + 尾部 + 平衡錘 + ヨークで吊るカメラ；pole = 旧円柱（行なし）。カメラヘッド（箱 0.5 × 0.35 × 0.6 + フード）は
  別セット `infield-tower-cams`（`security_camera_01` を glbOr、近段 `propsNearM`）。塔ごとにキープアウト円（樹木散布）。
  program +0（plain 色は `propMaterial` の共有、天板は `pbrFromAssets` の既存組合せ）。
- **人物**: ops-spec A 区画 `cameraSlots(tower)` — 天板上（三脚の 0.05 m 後ろ）／クレーン台座上（柱の 0.5 m 後ろ）に 1 人、
  役割 photographer（黒）、mount 'roof'（`y` = 床の路面基準高、`figureToWorld`）。`figuresAt({ towers })` で同じ行を付けられる
  （既定の `figuresAt()` は変えない: O9 の窓はピット・パドックのもの）。`infield-towers-crew` 16。
- **検査**: `facilities-check §16 O7`（レンズ行 13 が CAM 順の s に 1:1、id 一意、足跡 `TV_TOWER_FOOTPRINT`（2.4 / 3.2 / 1.5 / 0.5）
  の縁が hw + 1.5 の外・バリア線の観客側 0.6 m 外・スタンド足跡と `pavedApronAt` の外・リングの中、'auto' = 線 + 2.5、
  天板 ≤ y_lens − 0.5 と天板前縁・前手摺がレンズの ≥ 0.5 m **後ろ**（`tvForwardOf − (TV_DECK_HALF − 0.05) − 0.02`）、操作者が
  足跡上）；`scripts/audit/trackside-smoke.mjs checkTowers`（両ティア + `--glb`: towers 16、tvLenses 13 = `tvLensAt`、各塔が行の
  位置 ± 5 cm で最高脚の地面上、線からの距離、`roads-*` リボンに脚が乗らない（中心 + 4 隅 + 0.5 m の鉛直レイ）、天板／手摺／レンズ
  前進量、フェンス天端 + 1.5 以上、影の有無、カメラヘッド 14 = 天板の塔数、操作者 16 が床上 ± 5 cm、`--glb` は近段が `tv-camera-glb`）。
  静的コスト（Node）: 高 3,960,909 → 3,982,181 tris / IM 924 → 959 / エントリ 1,044 → 1,079（`farField/infield` 20,204 → 42,048、
  props.ts の tvMasts 2 IM は消えた）、低 2,114,627 / 733 / 755 / 815 — 予算内、再ベース無し。
- GPU で確認すること: 黄クレーン柱（0xf0b400、無発光）が bloom で光らないこと、天板の `MetalWalkway012` の法線の向きと目地、
  TV カメラで前手摺・三脚が画角に掛からないこと（レンズは前手摺の 0.75 m 前・0.5 m 上、車が真横を通る俯角でも）、700 m の LOD 切替、
  22 m 格子塔の影が B2 の屋根に落ちること、カメラヘッドの GLB ↔ 手続き切替（120 m）、200R 塔の脚の継ぎ足しが土手に合うこと。

#### 柵・バリア・看板・サイン

`app/three/barriers.ts`（I4-c）が `BARRIERS`（73 本: I4-b までの 72 + Spoon 内側の壁）を v2 のフィールドで描きます。ビューポートが
`buildBarriers(track, q, env.ground, assets, env.farField)` を環境の後に呼ぶのは変わらず（Node の `buildScene` には入らないので
scene-cost / surface-check はこのグループを測らない — `trackside-smoke checkBarriers` が同じ関数で組んで検査する）。

- **フィールド**（`BarrierRun`）: `fenceColour`（既定 `FENCE_GREEN` '#1f5a34'、`FENCE_BLACK` '#101214' = 2024 年の黒塗替え: c-foot /
  t3-outside / l-front / spoon1-outside-tyres / spoon2-outside / spoon-exit-outside / west-straight-trap-wall / degner2-trap-back /
  130r-*、web-suzuka）、`fenceSide 'both'`（観客側にもう 1 枚: 逆バンク外側・s-front・t18-outside-tyres、`FENCE_BACK_SETBACK` 2.0 m 裏、
  3 m 素柵）、`fenceRange`（hairpin-inside は「(」壁 2645–2760 だけに柵）、`topRail`（φ0.06 の上部レール + 1/3・2/3 高のケーブル 2、柵付き
  全 run）、`windows`（写真窓 1.2 × 0.8、敷居 0.5: gs-front [40, 5700, 5640]、hairpin-outside-tyres [2700]、spoon2-outside [3760]、
  130r-inside-wall [4870]、chicane-q2-front-wall [5300] — メッシュを s で割って開口の上下だけ残し、枠 4 本）、`gates`（1.2 m の切れ目 + 枠付き
  扉葉 + 両側の太柱、マーシャルポストの 6 m 先に 5 箇所、unverified）、`face 'painted-rwg'` + `painted`（タイヤ壁は赤／白／緑 2 m ブロック
  `paintedBlockTexture` — 130r-outside-tyres のポスト 26 前後 8 m、hairpin-outside-tyres 2704–2720；コンクリートは `tricolourWallTexture` の
  3 段帯 — t1-t2-inside 560–690、unverified）、`boards`（壁面の広告帯、gs-front）、`adBand 0.9`（壁天端に立つ広告帯: gs-front /
  t1-inside-island / t1-t2-inside / t2-exit-outside / hairpin-outside-tyres / hairpin-exit-right / 130r-inside-wall / 130r-exit-wall）。
  柵を足した run: degner2-trap-back（黒）、dunlop-outside-tyres / dunlop-exit-tyres / bridge-approach-left / gyaku-inside（緑）、
  130r-outside-tyres（黒）、hairpin-inside の「(」、t3-outside（黒）。A10 / A10b の遮蔽は全スタンド 100 %（BANK_I 97 % は既存）。
- **Spoon 内側の壁** `spoon-inside-wall`（concrete、3400–3797、硬地の縁 +13 → +25 → +40.8、航空写真のみ ±3 m）— **I5 レビュー
  F5 / V3 で削除**: 空撮 11 は Spoon 内側 3400–3797 にバリアを読まず（G11-03「phantom left Armco」）、この線は硬地の縁そのもの
  だった（I5-a の硬地行がループ道路の中心線 −2 m を縁にしたので、壁は s 3430–3530 で舗装の 5〜7 m 内側に立っていた）。縁は硬地行
  'スプーン インフィールド硬地' の手描き頂点が引き継ぐ（下の「I5 レビューの修正」）。BARRIERS は 72 run。
- **タイヤ壁 v2**: `tyreWallTexture()` を 3.96 m × 1.5 m のタイル（0.66 m 毎の縦縫い目 6、上端 0.15 m の折返し帯、継目の黄マーカー
  0.1 × 0.3、帯越しのタイヤの膨らみ）にし、`BARRIER_KIND.tyre.top` 1.95 → **1.5**（写真 1.2–1.5 m。A10 は柵の有無で遮蔽を決めるので
  影響なし）。実タイヤ積み: タイヤ run の柵柱位置（4 m ピッチ）ごとに 2 本（±0.45 m）、壁の裏面に接して地面に立つ（観客側から見える
  予備列）— `tire_stack` GLB（960 tris、近段 `propsNearM`）／トーラス 5 段（0.3 / 0.12、5 × 10 分割 = 500 tris、遠段）を
  `registerPropSet(…, 'infield', 'infield-tyreStacks', …)` で登録（`markObject tyreStack`、y = standAt − 0.015；寸法は
  suzuka-barriers-spec.ts の `TYRE_STACK`、A11 も読む）。**TV 塔の足跡の下は省く**（`tyreStackKeepOuts`: 足場塔 / 格子塔の中心から
  足跡半幅 + 0.42 + 0.1 の正方形 — 'auto' の塔はタイヤ壁の裏 2.5 m に立つので近い脚がちょうど予備列の上に来る；815 → 802 本、13 本省略）。
  低ティアは `infield.detail` が偽なので無し。計画の 6 × 12 分割は 587 k tris になるので 5 × 10（408 k、近景は GLB）。
- **スポンジブロック**: chicane-exit-tyres の前 0.3 m（壁に直角に測る: この壁は道路に対して最大 40° 斜め）に 1.5 × 1.0 × 1.0 の灰タープ箱
  （0x9a9b98 rough 0.95）を**列自身の世界長で 1.5 m ピッチ**（`spongeSteps`: 箱の乗るオフセット線の XZ 弧長を積分 — s で 1.5 m 刻むと
  斜めの壁と曲がりの外側で世界の間隔が 2–2.5 m に開き、箱の間に隙間が出ていた）で 48 + 上段 48（+0.4 ずらし）、壁の向きに回して置く
  （壁の傾き `wallSlope` は run の窓の内側で差分を取る）。IM `spongeBlocks`（`markObject sponge`）/ `spongeBlocksTop`。`tecproTexture` は
  削除し `Tecpro` を trademark-denylist に追加（textures-lint）。
- **130R の 3 本ビーム**: `kind 'guardrail3'`（0.25–0.95、`armco3Maps()`: 3 本の丸ビーム + ボルト、白）を 130r-inside-verge /
  130r-outside-verge の 2 run だけに（r130.jpg）。メッシュ `guardrails3`。
- **コンクリート壁**: `pbrFromAssets(reg, 'concrete046', { handBuiltUv, normalScale 0.5, color 0xd8d8d4 })` **FrontSide**（走行側の面と
  裏面リボンを別々に巻く: `wallGeometry` は +lateral 向きなので右側の面／左側の裏面は巻きを反転）、パック無しは手続き `concreteMaps`。
  programs +0（pit-geometry.ts の壁と同じ組合せ）。
- **看板**: `BOARD_TEXTS`（textures.ts、16 語: SUZUKA / JAPANESE GP / ROUND 17 / SUZUKA CIRCUIT / PIT LANE / 2026 / EAST COURSE /
  WEST COURSE / GRAND PRIX / MOTORSPORT / RACE DAY / SPOON CURVE / 130R / HAIRPIN / CHICANE / DEGNER — 'F1 LIVE' と 'MOBILITY RESORT' の
  面は消えた、B2 のボードも同じ帯）で `boardTexture()` 16 面 × 8 m（`BOARD_TILE_M` 128）。看板は**片面**（`boardMat` / `panelMat`
  FrontSide、`wallGeometry` の巻きは +lateral 向きなので左側の run は反転）で、右側（side −1）の帯は u を折り返す（`mirrorU`: 走行側から
  見ると右側の壁は +s が左へ走るので、I4-c では 5 本の帯の文字が鏡文字だった）；裏には無地の灰シート（`adPanelBacks`、`postMat`、面の
  `BOARD_BACK` 0.03 m 裏 — DoubleSide だった I4-c は観客側／Degner 2 の chase から鏡文字が透けていた）。自立パネル `AD_PANELS`（12 × 4 m、
  `bigPanelTexture()` の 4 セル、柱 2 本、メッシュ `adPanels` / `adPanelBacks` / `adPanelPosts`）は 5 枚: (600, +45)、(680, +27)、
  (2682, −42)、(4830, −47.5)、(4915, −25.5) — 計画の座標はタイヤ壁の線の内側（ランオフ）だったので各 run の裏に；I4 レビューで
  panel-hairpin（2690, −40: 端が I スタンドの足跡、予備タイヤが貫通）・panel-130r-a（−46: 予備列から 0.3 m）・panel-130r-b（4900, −25.5:
  130r 足場塔の格子を貫通）を動かした。facilities-check A11 が hw + 1.5・スタンド足跡（板の両端）・ピットレーン・舗装エプロン・バリア線の
  観客側 ≥ 0.28 m・タイヤ run の予備列（中心線 = 線 + 1.3 + 0.42）から ≥ 0.72 m・足場 / 格子塔の足跡 + 1 m の外を検査。Spoon ランオフの塗装ロゴ（props.ts
  `buildRunoffLogos`: 3600–3700 右 −14…−26 に 12 × 6 m × 3、`runoffLogoTexture()`、`ground.decal` @ `LAYER.verge.paint`、`markDecal`、
  メッシュ `runoffLogos`）。橋: 化粧板の天端を +0.95 に上げて 2.0 m（`FASCIA_TOP`、`FASCIA_BOTTOM` / `SOFFIT` / `GIRDER_Y` は不変 —
  chase レンズは桁下を通る）、高欄の走行側 0.3 m に青白のガードビーム 0.4 m（`bridgeRailTexture()`、4 m 箱 + 短柱、`BRIDGE_RAIL`、
  mlc.jpg）。ラウドスピーカーホーン: 柵柱に 40 m 毎（`FENCE_HORN`、IM `pitHorns`、148）。
- **距離板**: `distanceBoardTexture(label)` 黄地黒数字 0.9² + 黒ストライプ 4 本（unverified）。DRS 板の下端 1.5 → 2.0 m。
- **サイン**: `SIGNS` に `pit-entry`（kind `pitEntry`、mount `barrierTop`、`run 't18-pit-entry-separator'`、s 5400、'PIT ENTRY' 白地 +
  緑矢印 = `SIGN_CELL.pitEntry` 6）。structures.ts が `barrierProfile(run)` の線の上、壁天端 + 0.5 の柱 2 本に板を立てる（行の lateral は
  名目、A11 は `run` の存在と s を検査）。
- **写真家**: ops-spec D の `windowSlots(lineAt)`（純関数、線の解決は呼び手が渡す: ops-people.ts と guard は trackside.ts
  `barrierLateralAt`）が窓ごとに 1 人（壁の裏 + 0.6 m、カメラ上げ／立ち、トラック向き ± 15°、mount 'trackside'）— `figuresAt({ lineAt })`
  で 7 人（`stats.ops.byRole.photographer` 11 → 18）。
- **検査**: `scripts/audit/trackside-smoke.mjs checkBarriers`（両ティア + `--glb`: 73 run、Spoon 壁の頂点、柵の 2 色バケット
  `fencePosts` 1236 / `fencePostsDark` 396、`debrisFence` / `debrisFenceDark` / `fenceRails` / `fenceRailsDark`、逆バンクの 2 重柵、窓 7 の開口に
  頂点無し、タイヤ積み 802 = 柵柱位置 × 2 − 塔の下 13 が壁の裏・包絡の外・塔の足跡 + 0.42 の外、スポンジ 96 が線から ≥ 0.7 m（折線への
  XZ 距離）で隣と 1.5 m ± 5 cm（列が連続）、guardrail3 が 2 run だけ、広告帯 8 / パネル 5 / 塗装面 3、看板が FrontSide で裏シート
  `adPanelBacks` の三角形数が 5 枚 + 8 帯分、帯 8 本の u の勾配の符号 = side（走行側から左→右に読める）、ホーン、門 5、化粧板天端 +0.95 と
  桁定数、TecPro 無し、写真家 7、pit-entry 板）；facilities-check A10 / A11（AD_PANELS、barrierTop の `run`）/ O9（`figuresAt({ lineAt })`）。
  静的コスト（Node、バリアは含まない）: 高 4,014,014 tris / 969 meshes / 1,031 IM / 1,110 entries — IM と entries が I4-a + I4-b の
  合流（ポストとタワーのセル別セット）+ 写真家の新セルで予算 1,019 / 1,090 を超えたので実測 × 1.10 = 1,134 / 1,221 に置き直し
  （`measuredAt` I4-c）；低 2,146,796 / 732 / 762 / 816（予算内）。バリアのグループ自体は高 119,700 tris + タイヤ積み 407,500（遠段）
  / 782,400（GLB 近段）、低 33,556。I4 レビュー後: 高 4,015,210 tris / 970 meshes（`marshalFootings` + `towerFootings`）/ 1,031 IM /
  1,110 entries、バリアのグループ 121,764 tris（裏シート + スポンジ 96）+ タイヤ積み 401,000、低 35,620 — 予算内、再ベース無し。
- GPU で確認すること: fence003 の金網が緑 / 黒の tint で A2C の縁がにじまず、斜めから見てモアレが出ないこと（上部レールとケーブルは
  金網より手前に見えること）、タイヤ壁の 3.96 m タイルの継目と黄マーカーが chase の速度で滲まないこと、帯の折返し帯が天端リボンの
  白と段差無く繋がること、concrete046 の壁の法線の向き（FrontSide: 裏面リボンが両側から見えること）、パネル 12 × 4 m の mips
  （3 : 1 セルの文字が遠景で潰れないこと）、タイヤ積みの GLB ↔ トーラス切替（120 m）とスタックの影の無さ、写真窓の枠が金網から
  浮かないこと、橋の化粧板 2 m が桁の影で暗くならないこと、青白ビームの縞。

### 柵の内側の地面行

I5-a は柵の内側で舗装されているのに何も描いていなかった面を `GROUND_AREAS` の行にしました（`app/data/suzuka-facilities-spec.ts`
「the infield ground (I5-a)」以降の 33 行）。地面の契約（R1〜R14）どおり、行が言えるのは「何が・どこに」だけです。原則: **OSM
ポリゴン 1 面 = 1 行**（`patchOutline` は `osm: [a, b]` を 1 つのリングに繋ぐので、接している面しか同居できない）、20 m² < A <
20,000 m²、fold を跨ぐ形は `{ way, verts }` ノード、曲がりの半径より外は `{ en: [E, N] }` ノード（I5-a で `PatchNode` に追加、
`track.enToWorld`）、s の射影が曖昧な行は必ず `sRange` の窓。kind は `paddock` = 灰の駐車場アスファルト（A11 の `pavedApronAt`
対象外）、`asphaltArea` = 管理道路の濃いタール舗装（A11 が看板・ボード・バリアを寄せつけない）、`helipad`、`gravelArea`。

| 行 | kind / layer | footprint | 根拠 |
|---|---|---|---|
| D パドック | paddock | `{ way: 469065002, verts: [4, 35] }`（頂点 0–3 は路面の中: 登録が 3 m ずれている） | OSM |
| ピット出口エプロン 東 | paddock L1 | osm 469451642 [130, 230] | OSM。西 469451657 はピットレーンとエプロンの下（所有 0 %）なので行にしない |
| 構内トンネル北口エプロン | paddock | osm 469657637 [65, 140] latMax 30 | OSM、用途 unverified |
| C パドック駐車場 / T3 外側駐車場 | paddock L−1 / L−2 | osm 469079400 [300, 880] / 184429450 [850, 900] | OSM（池の行と辺を共有するので下の layer） |
| E スタンド下 管理道路 | asphaltArea | 467945733 の `{ way, verts }` 2 本 + 手ノード 7（NIPPO 出口の路側は guardrail の 0.6 m 裏） | OSM（トンネル部 45–49 を除く） |
| D 裏エプロン | paddock | osm 184253118 [1355, 1430]（BANK_OASIS を 1360 で切る） | OSM |
| ダンロップ内側 管理道路 | asphaltArea | osm 467913438 [1660, 1975] latMax 60（BANK_E_HILL を lateral 28 から） | OSM |
| ダンロップループ 舗装エプロン | paddock | ring (1851, 34) (1849, 82) (2064, 82) (2066, 60) (2030, 45) (2010, 34) | 空撮 06 / 15、±5 m |
| 第 2 ヘリパッド | helipad L1 | disc `HELIPAD_2` (2050, 70, r 10)、アトラス 2 枚目（橙の四角枠） | 空撮 06、±5 m |
| デグナー側 くさびの管理道路 | asphaltArea L−1 | 467386920 頂点 81–87 を −1 / −5 m オフセットした 4 m 帯 [1860, 2194] | OSM の service area 境界。130R 側の帯は G12 residual で断念 |
| シケイン右 エプロン延長 / T17 出口右 管理道路 | asphaltArea L−2 / L0 | `{ way: 467417584, verts: [14, 24] }` / `{ way: 467223464, verts: [7, 43] }` | OSM（端の頂点を落として列の反転を消す） |
| スプーン インフィールド硬地 | paddock | `{ way: 184419756, verts: [0, 12], offset: 2 }` + 手描き 6 頂点 (3530, 22.5) → (3405, 13) + `{ verts: [20, 30], offset: 2 }`、18,207 m² | OSM + 空撮。ループ道路の頂点 13–19（s 3555 → 3421、+23.8 → +11.1）は空撮の縁 +15 @3430 → +22.5 @3530 より 2〜7 m 路面寄りだったので、その区間だけ手描き（I5 レビュー V3: 縁石と硬地の間の枯れ芝の路肩が戻る）。1 リングで足りるので 3 分割しない |
| 西パドック エプロン / 西コース ピット出口路 | paddock L1 / asphaltArea L2 | ring [3900, 15] + ループ頂点 21–25 (offset 2) + [4060, 40] [4100, 15] / edge 3937–3972 off 1.4 + フェンス 184419761 頂点 11–13 | 空撮 13、±3 m |
| 西パドック駐車場 東 / 西 | paddock L0 / L1 | osm 184415332 / 184415335 [4260, 4360] | OSM（空撮の「南コースパドック駐車場」はこの 2 面） |
| 南コース パドックエプロン 北 / 南 / ガレージ前 | paddock | osm 467572919 / 467572920 / 468377676 `grow: -1` | OSM（縁が 8 m ループの中心線から 3.5–5.8 m: 南コースの幅を 10 → 8 に） |
| L ヤード | paddock | ring [3300, −15.6] … [3462, −45]（l-yard-edge の 0.6 m 裏、L 席の手前） | 空撮 11、±3 m |
| 200R 管理帯 | asphaltArea L−1 | band −1 [3200, 3260] lat [−15, −10] | 空撮 11 |
| スプーン外側 管理道路 | asphaltArea | ring 17 点（壁 184104883/881 の 2–4 m 裏 → [3720…3770, −76]） | 空撮 12、±3 m |
| デグナー東 駐車場 / スプーン駐車場 | paddock | osm 184410563 [2240, 2310] latMax 100 / 183953784 [3740, 3770] | OSM |
| 交通教育センター 周回路 | asphaltArea | `{ ways: [{ id: 1461954354, verts: [4, 19] }, { id: 1489655892 }], width: 8 }`（I5-a で追加した連結 way の足跡: 閉じた鎖は環になる） | OSM。内側の 3 本 (1461954352/353/355) は交差点で重なるので行にしない |
| 交通教育センター スキッドパッド 1–3 | paddock | disc (168, 88) (190, 80) (188, 106) r 10 | 空撮 01 / 02、±8 m |
| 管理道路 4 本 | asphaltArea | `{ way, width: 4 }`: 1420756725（T1 インフィールド [140, 890]）、470173099（A2 裏 [80, 550]、L1）、184120107（外周 A2・B・C 裏、窓無し）、468709099（C・D5 裏 [570, 1335]、L2） | OSM `SERVICE_ROAD_WAYS`（`build-facilities.mjs --add-ways-from … --role road`） |

- **落とした行**（計画にあったもの）: 西コース ピットエプロン 468377672（路面の中、残り 17 m² < A9 の 20）、ピット出口エプロン 西、
  130R 出口タイヤバリア裏の帯（fold の中で Dunlop 側の駅の光線がその 4 m の端を掠め、G12 residual 46 mm）、南コース駐車場の手描き
  リング（空撮の白枠は西パドック駐車場 184415332/335 そのもの）、200R 越しの 411303620（L ヤードの中、s 3481 でトンネル）、教習
  コース内側の 3 本。
- **破線中央線**: `infield-ground.ts wayLineDecal(ground, track, way | ways, 0.15, [3, 3])` — way の折れ線に沿って 3 m 毎の破線を
  ≤ 2 m の quad に切り、`ground.decal` で面の三角形に乗せ（`LAYER.verge.line` 16 mm、`markDecal`）、面が無い所・路面フレームの面・
  0.25 m 毎の標本で 8 cm 以上段差のある所・面のソース（ラスター／ワールド／ステッチ）が跨がる所は塗らない（C 席の段の上で 5 mm
  埋まった）。`stats.infield`: wayLineM ≈ 1,875 m、skipped ≈ 420 m、uncovered 0。`infield-wayLines-<way>` 5 メッシュ。
- **交通教育センター**: BUILDINGS `stec`（OSM 466925741、8 m、2 階、`anchor 'terrain'`、`builder: 'infield'`）を
  `pit-geometry.ts extrudeFootprint()`（paddock.ts の v1 押出しも同じ関数）で `infield-buildings` / `infield-buildingRoofs` に。
  `build-surroundings.mjs --offline` で SUR_BUILDINGS から落ちる（OWNED）。
- **西ループの新舗装（aFresh）**: `FRESH_ASPHALT`（s 3540–4760、両端 40 m の smoothstep、unverified）を `ground-mesh.ts` が
  `ground:road` の頂点属性 `aFresh` に書き、`materials.ts addRoadSurface` が `diffuse *= mix(1, 0.72, aFresh)`、roughness −0.1·aFresh
  で読む。同じ `'macro|road'` プログラム（属性の無いジオメトリは 0 を読む）、program +0。`asphaltArea` は `lane` と分かれて自前の材質に:
  高ティアは `Asphalt033`（2.5 m タイル、`pbrFromAssets + addMacro` = paddock と同じ 'macro' プログラム）、無パックは 0x8c8c8a。
- **ヘリパッド 2 面**: `helipadTexture()` は 2 タイルのアトラス（左 = 白丸の H、右 = 橙の四角枠の H）になり、`uvOf` は最寄りの
  `HELIPADS[].mark` のタイルに写す（材質 1 つ、program +0）。
- **計測**（surface-check `--suggest`、high）: G1 mismatch 0、G2 0、G5 jumps 231（上限 313、不変）、G9 0、G12 residual 0 / untraced 0。
  ALLOWANCES 'P6i'（理由は既存の `WHY.infieldRings` / `demCurvature`）: G3 `ground:asphaltArea` 0 → 3.87 %（上限 4.07、E スタンド下の
  管理道路が D/E の段を弦で渡る、max 3.7 m）、`ground:water` 8.7 → 10.86（11.41、C パドックが池の岸に駅を入れる）；G4 `.steep`
  asphaltArea 19 → 1,899（1,994）、paddock 257 → 2,987（3,137）、helipad 0 → 2（3）、grass 1,559 → 1,800（1,890）、asphaltBand 267 →
  321（338）、gravelBand 42 → 53（56）、lane 44 → 51（54）、gravelArea 62 → 153（161: 南コースの幅で 130R グラベルのワールド部が
  三角形分割し直された）。**起動コスト**（Node、行の追加だけで）: プラン 8.7 → 18.9 s（高）/ 10.6 → ≈ 22 s（低）、メッシュ 7.9 → 15.1 s
  （高）。駅 8,633 → 11,694（crossings 1,275 → 2,116、snapped 2,087 → 3,405）、パス 1,210 → 1,940 で pass-detect / pass-eval が 2.5 倍。
  計画の見込み +1.5〜2.5 s を大きく超えており、低ティアの `setupMs`（perf-gate 19.4 s WARN / 29.1 s FAIL）は I7 の実測で判断が
  要る — P7 のラスター精緻化と同時に、リングの箱に光線が届く駅だけを候補にする剪定が要る。`infield-smoke.mjs` が差分を印字する。
  → **解消**: 増分は駅の数ではなく定数係数（文字列キーのメモ、全辺の点判定）で、「地面の契約」の**分割の高速化**でプラン 4.4 s /
  メッシュ 10.7 s（高、描画結果は不変）。`infield-smoke.mjs` の BASE_MS はその値。
- **ガードで直したもの**: `ground-mesh.ts Pool` の 1 mm 丸め境界を跨ぐ重複頂点（G9 crackY、C 席裏の管理道路）、`resolveFootprint`
  の way の連続重複頂点（掃引の零長セグメント）。

#### インフィールドの施設・車・街灯

I5-b は柵の内側で「地面の上に立つ物」を表 `INFIELD_FACILITIES`（`app/data/suzuka-facilities-spec.ts` 末尾の区画、49 行）にし、
`infield-ground.ts buildInfieldFacilities` が同期で建てます（`buildMs.infield` に含む: 高 ≈ 320 ms、低 ≈ 330 ms）。行は
`kind`（shed / hut / office / marquee / tank / stack / tyres / garage / tower / pumphouse / flagpole / fence / wall / compound /
forklift / toilet / mast — 計画の 12 種に tyres / forklift / toilet / mast / wall を足した）、`osmWay`（足跡 = OSM リング、`sRange`
= O11 の窓）か `s / lateral / size / yaw`（手置き）、`height / levels / roof / wall / count / cols / doors`、全部 `unverified`。

- **押出し**: OSM リング・手置きの矩形とも `pit-geometry.ts extrudeFootprint()`（EN 経由、底 0.5 m 沈める）。床は足跡の頂点の
  **最低** `standY`、軒は最高 + `height`（西コースのガレージ 184415314 は足跡で DEM が 3.5 m 落ちる: 端が浮かない）。材質は
  ピット複合体の共有セット（`whiteMat` / `concreteMat` / `buildingRoofMat` / `glassMat` / `railMat`）+ 灰・波板・青／茶／赤屋根の
  plain 色。材質毎に 1 メッシュ `furniture-infield-<mat>`（cast）。`furniture` 接頭辞は G8 の免除なので、床・パッドの水平面は
  作らない（smoke が props* / furniture* 配下の ±0.3 m の上向き面積を report-only で印字: furniture 0.7–1.2 m²）。
- **場所ごと**: Spoon ヤード = シェッド 15 × 10 × 4 ×2 (3882, +38) (3911, +44)、ブロック積み (3993, +39)（1 × 1 × 0.5 × 12、IM
  `infield-blocks` 2 段）、タイヤ保管 (3960, +30) 20 本 + フォークリフト（`forklift` GLB / 箱）；200R 役員室 (3245, −19) 20 × 5 × 3.2
  （MARSHAL_POSTS 3245 の消灯パネルと CCTV はガードレールに掛かり、足跡 −16.5…−21.5 の外）；L ヤード = 円タンク φ8 × 6 (3410, −95)
  + 小屋 183953734 / 736；西コースピット = ガレージ 184415314（8 × 24 × 4、`rollershutter_door` 6 枚を最長辺の走路側に）、トイレ
  184415315、小屋 184415316 / 184419747 / 750 / 184415312、**西コントロールタワー** 184415318 = 9 m / 2 階（BUILDINGS の 12 m / 3 階
  から移動、unverified）: 白い殻 + 上階の全周ガラス帯（1.2 % 外へ、`glassMat`）+ 1.2 m バルコニー（灰スラブ + 手摺）+ 屋上アンテナ
  と設備箱；南コース = ピットガレージ 184415311（L 字、4.5 m、シャッター 12）、小屋 184415313、コントロール小屋 184410555、旗竿 3
  (4470, −200)、壁 468377679 / 683（`wall`: 1 m 幅の OSM `area=yes` は中心線に潰す）、柵 184417654 / 655 / 468750064 / 068 /
  184415338（`fence` 2.4 m）、仮設トイレ 4 (4530, −100)（`porta_potty` GLB / 箱）；ダンロップループ = シェッド 184103155 / 156 / 158 /
  159 / 160（白平屋根 4 m、`office`）、マーキー 25 × 12 × 4 (2000, +45)、コンパウンド柵 20 × 20 (1830, +40) と中の灰小屋；ヘアピン =
  タイヤ島 12 本 (2700, **+13.5**)（計画の +18 は内側の折れの外: 内壁の半径 15–18 m の内側でしか (s, lateral) は正確でない — 目の
  土の上、hairpin-inside 壁の 2.5 m 裏）、照明マスト 22 m (**2806, −44**)（計画の (2700, −38) は I 席 s 2692–2738 × −26…−48 の中。
  hairpin.jpg の出口先のマストを IJ / J の隙間に）；デグナー東 = マーキー **20 × 12** (2146, +72) + コンパウンド **24 × 22**（計画の
  25 × 15 / 30 × 30 は degner2-trap-back のタイヤ線 +57 と外周リング（lateral 83–85）の間に入らない）；T1 = 茶屋根 30 × 20 × 6.5
  (275, −88)、ポンプ小屋 10 × 6 × 3.5 (640, −45) + 柵 8 × 8 と小タンク (640, −54)；遠い OSM 小屋 467591741 / 468750070 / 184430910 /
  184120098 / 184120102。
- **地面行の追加**（今回許した唯一の行）: `ダンロップループ 砂利パッド`（gravelArea ring [1852…1900, +85…+100]）と `デグナー東
  砂利パッド`（ring 8 点: 内縁はタイヤ線の 1.5–2 m 裏、外縁 +80 — リングの外は描かない）。A9 / A3 / G1 緑、ALLOWANCES 不変。
- **南コースの縁石**: `SOUTH_COURSE_KERBS` — 周回路 153525062 を 1 m で再標本し、±4 m の回転角 / m が 0.015 以上の区間 ≥ 12 m を
  「エイペックス」として両縁に `lanes.ts sweepKerb`（GROUND_OBJECTS.laneKerb、`kerbMaps`、リボン縁の 0.5 m 内側 = 面の上に丸ごと）。
  15 区間 / 792 m、`infield-southKerbs`（markObject laneKerb）。計画の「12 区間」は閾値で 15 になった。
- **島縁石**: `INFIELD_ISLAND_KERBS` — T1 車寄せ (305, −68) r 2.5、西パドック (4000, +30) r 3 = `infield-islandKerbs`
  （GROUND_OBJECTS.islandKerb）。南コースパドック北エプロンの島 (4473, −240) は I5 レビュー V10 で削除（航空写真に島は無く、
  中が素のアスファルトの縁石環はヘリから白い円に見えた）。
- **タイヤ積み**: `infield-tyres` = `tire_stack` GLB（高 + ドロップ）/ 開いた円筒 + 上面リング（上向き面積 0.26 m²/本、G2 の幅 ≤ 0.7
  は count × 0.7 の length で）。IM の各レベルに `markObject('tyreStack')`（G3: 底 −15 mm、冠 +915 mm）。
- **車**: `INFIELD_PARKING`（PADDOCK_PARKING と同じ約束、`lot` = 乗る GROUND_AREAS 行）8 区画 — C パドック 0.7、T3 0.6、D 裏 0.5
  （左側: lat [112, 64]）、デグナー東 0.7（左側）、西パドック 0.5、南コース北／南 0.4、スプーン 0.3。`paddock.ts` から `layoutBays`
  （面・所有者・勾配の共通判定 + 呼び手の veto）/ `bayLineQuads` / `carPropSets` / `parkCar` を切り出して共用（パドックも同じ関数を
  呼ぶ）。veto = 全標本 |lateral| ≥ hw + 8（O2）、四隅がリングの内、施設の足跡と街灯の外。白線 `infield-bayLines-<id>`（LAYER.paddock.
  line）、車 `infield-cars`（段 [{ vehiclesNearM: GLB }, { 500 }, 空]）、予算 `Quality.infield.infieldCars`（高 260 / 低 110）。区画 455
  （C 345: 池・管理道路・芝の上は face で落ちる；西パドックは DEM の勾配で 4 しか残らない — CAR_PARK.slopeGrade の実測）。
  **I5 レビュー V1**: C 区画の s 範囲 [305, 875] は T1–T2 を回り込み、二つの脚（s ≈ 320–405 と 735–830）が同じ舗装面に乗るので
  区画が二重に敷かれ、車が車の上に・白線が交差して描かれていた — veto の最後で既採用区画の XZ（0.9 倍に縮めた四角）との
  `quadHits` を弾く（`BayReject 'overlap'`、全行共通: C と T3 は s 869–875 で触れる）。207 + 6 区画が overlap で落ち、smoke は
  車の最近接対 ≥ 2.3 m を主張。**V2 相当の F6**: 予算は一様スケールではなく「小さい区画に occupancy × 区画をまず与え、最大の
  区画（C）に残り」— 高: T3 23 / D 裏 6 / デグナー東 13 / 西 2 / 南北 12 / 南南 3 / スプーン 0、C 201；低: 小区画は同じ 59、
  C 51（小区画の合計が予算を超える将来の予算だけ一様スケールに戻る）。デグナー東が航空写真の ~40 台に届かないのは区画の
  多角形（18 区画）の問題で、予算ではない。
- **街灯**: `INFIELD_LAMPS`（40 m 毎、中心線から 3 m、ラップに近い側）を役割 'road' の `{ way }` asphaltArea 行 4 本に —
  `paddock.ts lampPoleProto`（共用の手続きポール）、`infield-service-lamps` 87 本（路面・水面・リング外・施設内は落とす）。
- **柵・壁**: 金網は paddock.ts の柵と同じ作り（3 m ピッチの半分で分割した垂直カード、両端が `standY`、`fence003` cutout /
  `chainLinkTexture`、支柱 IM `furniture-infield-fencePosts`）。カードは `Quality.infield.fences`（低ティア無し）、支柱は常に。壁は
  両面 0.2 m + 天端 `furniture-infield-walls`（`concreteMat`）。716 m / 245 本、壁 103 m。smoke: 地面 0.5 m 以内に水平面 0。
- **生成器**: `SUR_SKIP_IDS`（surroundings-spec、183953732 = L ヤードの舗装は偽の建物）と INFIELD_FACILITIES の osmWay を
  `build-surroundings.mjs` の OWNED に（12 面が SUR_BUILDINGS から落ちる、625,751 B）。facilities-check §11 も同じ集合で衝突を見る。
  §16 に手置き行の O2 / O5 / リング検査を追加（20 行；OSM の 29 行は O11 / §6）。
- **計測**: scene-cost 高 4,266,752 tris / 991 meshes / 1,039 IM / 1,088 entries（meshes 982 → 1,090、IM 1,019 → 1,143 に再ベース
  = 実測 × 1.10）、低 2,398,082 / 755 / 780 / 817（予算内）。surface-check 両ティア strict 緑、`--suggest` 0（新 ALLOWANCES 無し）。
  `infield-smoke.mjs --tier both --glb`: `checkFacilities`（表の件数 = 49 箱、箱の四隅がリングの内で hw + 1.5 の外、壁・柵に
  水平面無し、タイヤ / 縁石のタグ、車が paddock 面上で hw + 8 の外、街灯 ≥ 30、buildMs.infield < 1500、`--glb` で 6 セットの
  `-glb-` 近景と L1 の手続き段、タイヤの GLB 段もタグ付き）。

#### 池と樹木

I5-c は柵の内側の水面 2 面と乾いた池 2 面の演出、そして柵の内側の樹木を**表**にしました（`app/three/infield-water.ts`、
`app/three/stands.ts` の BASINS ループ、`app/three/vegetation.ts`、`app/data/infield-trees.ts`）。

- **BASINS（`suzuka-barriers-spec.ts`）**: `BasinDef` に `ring / sRange`（OSM に無い池の手描きリング、GROUND_AREAS のリングと
  同じ `PatchNode`）、`surface`（水面を描く）、`level`（岸の高さ、OSM 面は重心 s の路面基準、手描きリングは **`sRange` 内の最も
  低い路面**基準 — I5 レビュー F1、既定 +0.2）、`bank`（既定 9 m）、`island`（`bank` 既定 4 m の独自の土手）、
  `platform` を足しました。`stands.ts resolveBasin(track, b)` が OSM 面と手描きリングを同じ形（world xz の外周 + 島の穴 + shoreY /
  floorY / bank）に解き、`facilityRelief` の PolyZone（床は cap = 下げるだけ、岸から `bank` m で smoothstep）と水面が同じ多角形を
  読みます。島は穴: 中は何も主張せず（自然地形のまま）、島の岸も土手になります（幅は `island.bank`、既定 4 m — 外周の
  `bank` とは別の尺度、I5 レビュー）。`GROUND_AREAS` の 'water' 行は
  `...BASINS.filter(b => b.ring)` から生成（外形の権威は BASINS 1 か所）、島は grassArea L1 の円盤。
- **池は 2 面（計画の 3 面ではない）**: 空撮 14 を測り直すと、計画の「(4590, +75) の島付き」と「ヘアピン間 35 × 35 m
  (lower 2380–2420, +60…+90)」は**同じ池を 2 つのフレームで読んだもの**でした（world で 30 m 差、外形が重なる — A3 で同層重複）。
  1 面に統合: **130R 池** = (4597, +78) r 21 の 12 角形（横に 8 m 外: 路面ラスターの境界を跨ぐと world 部が閉じない；s は読みの
  +5 m — I5 レビューで西の頂点が盛土裾の低い所に掛かったため）、`level −6.3` / `bank 10`（130R は盛土上で、その足元の地形が路面
  −5〜−7 m；土手を緩くしないと地形格子の「堀」が岸の外で水面を割る — 下の「I5 レビューの修正」）、島 r 2.5（土手 4 m）に木製
  デッキ 4 × 6（`boxes` +0.3、'props'）。
  **西ストレート池** = 近岸は空撮 13 の線（−26 @3970 → −45 @4160 → 4245 で −60、計画の −25 @4280 は西コースピットの
  小屋の下になるので不採用）、遠岸は地形が路面 +1.5 m 以内の所まで（空撮の「さらに 120 m 南西」は DEM で 3〜13 m の窪地 —
  岸が水面より低くなるので林の斜面のまま；I5 レビューで南西の 3 頂点を 4〜7 m 内に寄せ、遠岸 s 4100–4160 の切込みは残す）、
  18,890 m²（A9 < 20,000）、`level −0.4`（谷底の路面 33.37 基準 = 水面 32.67 — +0.2 と窓の中点基準では近岸 114 m が水面より
  0.75 m 低かった）、`bank 16`（北東端は路面 +3〜4 m の地形なので 6〜7 m の土手）。OSM に natural=water は無い
  （raw cache を検索: 最寄りは 184415331、s 610 +175 で別物）。この池は周回柵 775428456 の**外**（柵は西ストレート右の −20 m を通る）。
  **どちらも水は「ユーザーの既定」で unverified**（3 月の写真が権威。T1 池 184005565 と T1–T2 調整池 132793884 は dry のまま）。
- **水面**: `terrain-far.ts waterFarMaterial()`（0x33443f、roughness 0.15、4 m リップル法線、**transparent 0.9 / depthWrite false**）
  を遠景の水面 `water-far` と池 `furniture-infield-pond-<i>` が同じパラメータで持つ。three は `transparent` で OPAQUE define が
  消えるので、計画の「clone して transparent」は別プログラムになる — 遠景の水面も同じ組合せに揃えて**水はシーンで 1 プログラム**。
  earcut（島の穴付き）を岸 − 0.3 m の平面に、`furniture-` 接頭辞 + 透明で G8 対象外。`stats.infield['infield-ponds']` 2、
  `infield-pondDecks` 1。
- **乾いた池の演出**: 葦 200 株（3 枚交差 1.2 m カード、`registerBuckets 'infield-reeds'` kind 'infield'、岸から 3〜14 m の
  土手の裾、影は落とさない）— 材質 `MeshStandardMaterial { map, alphaMap, alphaTest, DoubleSide }`（高ティアは A2C）に
  `reedTexture()`（64 × 128 の DataTexture 対、藁色の枯れ葦）を**全ティア**で（I5 レビュー V11: パックの `grass_medium_01` は
  緑の草地カードで 3 月の泥の上の芝の点に見えた；株は 1.2〜1.95 m）。**I5-c で予算した唯一の +1 プログラム**（全ティア共通の
  組合せ、smoke がシーンの他材質に同じ組合せが無いことを確認）。水たまり 3（T1 池 2、調整池 1）
  = `puddleTexture()` の楕円を `ground.decal`（LAYER.verge.paint、transparent / depthWrite false = brakingRubber と同じ組合せ、
  program +0）で床に。砂利の岸道 = GROUND_AREAS gravelArea 行 'T1 池の岸道'（OSM リングを `grow: 3`、水行の半層下 −0.5、
  ピット出口ヤードの上）。`{ way, width: 3 }` の環は岸線 1.5 m 内側の内周と岸線が T1 池の北東端で駅の光線に掠められ G12 residual
  2.15 m だったので不採用。**T1–T2 調整池の岸道は行にしない**: 近岸を T1 管理道路 1420756725 が s 490–530 で走り、道路・岸線・
  岸道の 3 境界が 3 m 内に並ぶと水面に 35 標本の重複（G2 water|water、grow 2 / 3・環のどれでも）— 道路がそのまま岸道。
- **INFIELD_TREES（`suzuka-facilities-spec.ts` 末尾、16 行 342 本）**: 行の形は `along`（OSM way を左／閉じた環は外側へ offset、
  または (s, lat) 折れ線）、`circle`、`rect`（pitch 格子か count 散布）、`disc`、`points`、`skipS`（スタンドの足跡や並走する道を跨ぐ
  区間を空ける）。`app/data/infield-trees.ts infieldTreePlacements(track)` が純関数で world 点 + 窓内の (s, lateral, d) に展開し、
  **facilities-check O10 と vegetation.ts が同じ点を読む**（O10: |lat| ≥ hw + 6、asphaltArea のリング**と way 掃引**の外、paddock /
  gravelArea 行の外、INFIELD_FACILITIES の足跡の外、スタンド足跡の外、柵内、バリア線から 0.6 m — 後の 2 つは I5 レビュー F3）。行:
  外周管理道路 184120107 沿いの裸欅（−6、8 m、A1 裏小屋 184120098、A1/B2/C/D1–4 の足跡と A2 裏道路の並走区間を skip）、2 調整池の環
  （欅／芽吹き、+6、12 m；T1 池はピット出口ヤードと岸道の凹角 3 か所を skip）、ピット入口レーンの欅（−28、4 頂点の折れ線 — 1 本の
  弦は world で −33 に流れて E パドックに乗った）、T18 の楠 6（二輪ループの車線の間の点）、ヘアピン／130R 台地の低木 20（I5-c の
  杉 6 m 格子は hairpin-pond カメラと池の間に立って池を隠したので削除 — 空撮 08 の読みは「茶色の低木」、07 の常緑帯はデグナー
  くさび）、ヘアピン外側の桜 5、ダンロップループの竹 2 群（40 / 25 本）、デグナーくさびの楠（計画の +85…+100 は柵の外、
  s 2110–2160 はマーキーの砂利パッドとコンパウンド → (2158…2182, +74…+82) の 3 本）、逆バンク外側の桜 6
  （計画の (1300, +60) は D1–4 の足跡の中 → D5 と D1–4 の隙間 (1127, +47)）、西ストレート池の岸の松・欅（柵内側の岸だけ）、130R 池の環
  （r 27）、南コース外周の杉 + 檜 50（**唯一の遅延ジョブ** `farField.defer('forest', 'infield-south-trees', 400)`）。**計画の Spoon
  杉／檜帯 (3480…3560, +45…+70) は硬地の上なので落とした**（アプローン内側の芝は 5 m 幅、空撮に木は無い）。
- **配植**: `buildTrees` の 'trees' ジョブが散布の前に `emitInfieldTrees(ctx, 'infield-trees', …)`（セル毎 `emitTrees`、高さ・色・
  yaw は配置の seed から、hero は d < 120）。舗装／車線／水／帯／**paddock / gravelArea** の面に載る配置と **INFIELD_FACILITIES の
  足跡（`ctx.infieldFootprints`）の中**の配置は植えずに `infield-treesSkipped` に数える（smoke と e2e は 0 を要求 — 行の側で直す）。**散布の抑止**: `treeSiteBlocked` に「柵リング 775428456 の内側かつ SUR_FOREST の外は禁止」
  （`infield-lod.ts insideRing` + ctx 毎に 1 回解く森ポリゴン）。楠の tint を [[0.6, 0.75], [0.7, 0.85], [0.5, 0.65]] に落とした。
- **計測**（Node、no assets）: scene-cost 高 4,215,843 → 4,268,831 tris / 972 → 977 meshes / 990 → 1,008 IM / 1,068 → 1,086
  entries（予算内、再ベース無し）；起動: 低ティアの `buildMs.plan` / `meshes`（Node）は I5-a 後の 18.4 / 15.0 s に対し 18.6 / 14.7 s
  （4 行分の差はノイズ内、岸道 2 行の版で +1.7 / +1.7 s）。
  surface-check `--suggest`（P6i、WHY は既存）: G3 `ground:water` 11.41 → 12.49（実測 11.76、2 池の土手）、`ground:gravelBand`
  1.55 → 1.77（実測 1.68、岸道のリングが S 字側の帯に駅を入れる）；G4 `water.steep` 1040 → 1417（実測 1,349、西ストレート池の
  12 m 土手と 130R 池の盛土裾）、`gravelArea.steep` 161 → 216（実測 205、T1 池の岸道が土手の縁に乗る）；G1 / G2 / G5（231）/ G9 /
  G11 不変、G12 residual 0、untraced 0。`infield-smoke.mjs checkPondsTrees` が上の事実（水面 2・材質の組合せ・岸道・葦 200・
  水たまり・INFIELD_TREES 366 全配置の O10 + 柵内・2 ジョブの消化・散布 0 本）を見る。

#### I5 レビューの修正

I5 のレビュー（確認済みの所見 F1 / F3 / F5 / F6 / V1 / V2 / V3 / V4 / V7 と、安価な低優先の V9 / V10 / V11 / V12 / F7 / F9）を
1 コミットで直したもの。**F2（130R 池のリングが立体交差の縫い目を折り返し、下の道路の路肩の草 ≈ 140 m² が二重に描かれる —
`[ground-mesh] stitch side 1 s 2357-2398 … does not triangulate`）と V8 は `ground-mesh.ts` の `mutualPair` / 耳切りの
フォールバックの問題で、同じファイルを性能で直している別の作業に譲る**（データ側の寄せ — 池の中心 lateral 78 → 83、s 4592 → 4597 —
では折返しは消えないことをレビューが計測済み。本コミットの s 4597 も同じ）。V6（斜面の上の施設に切土・盛土のパッドを敷く
`mode: 'level'` の PolyZone）は cut と fill を同時に行う新しい relief で、下の「堀」の通り 13〜18 m 格子の上では建物の周りの地形を
崩すので見送り（西ガレージの足跡は 3.6 m の高低差のまま = 谷側の壁が 7.6 m）。

- **池の水位（F1 / V2）**: 手描きリングの基準を「窓の中点の路面」から **`sRange` 内の最も低い路面**にした（`resolveBasin`、5 m 毎に
  標本）。西ストレートは谷（34.96 @3960、33.37 @4040、38.03 @4260）で、中点基準 +0.2 は水面を路面より 0.84 m、近岸より 0.75 m
  高く置いていた（725 m の岸のうち 338 m が水面の下）。西ストレート池 `level −0.4`（水面 32.67）/ `bank 16`、南西の 3 頂点を
  4〜7 m 内へ；130R 池は中心 s 4597、`level −6.3` / `bank 10`、島 r 2.5 に独自の土手 4 m（`island.bank`、`PolyZone.holeBank`）。
  **地形格子の「堀」**: `environment.ts clampUnderSheets` は水面（水底の面）に掛かる地形格子の三角形を丸ごと面の下に押すので、
  岸のすぐ外の地形メッシュは「1 セル内側の水底の深さ」だけ沈む（高 13.3 m 格子で ≈ 0.4〜1 m、低 17.7 m で 1〜3 m）。岸の外に
  描かれた面が無い所（西ストレート池の遠岸、130R 池の西）ではこれが水面より下になり得るので、`bank` を緩くして水面を岸の下に置く
  しかない（切込みを直線にすると窪地を通って 50 m の岸が水面の下になった — 残す）。**低ティアは遠岸で最大 1.3 m の堀が残る**
  （既知の限界、`?fx=0` = SwiftShader の e2e ティア）。130R 池は土手が広い分、水底の 73 % が水面より上（水面は中央の環）。
  `infield-smoke checkPondsTrees` が **岸の各頂点とその外 0.5 / 3 m の `standY` ≥ 水面** を高ティアで主張（低は報告のみ、堀の理由付き）、
  水底の頂点のうち水面より上の割合を報告。乾いた池の泥面（'water' の spring 材質）は `gravelMaps()` を 0x8a7d66 に着色したもの
  （同じ map + normalMap の組合せ = 砂利と同じプログラム；平色の #8a7d66 は 3〜12 m の無地の帯に見えた）。
- **樹木（F3 / V4 / V9）**: `TREELESS_FACES` に `paddock` / `gravelArea`、`emitInfieldTrees` は `ctx.infieldFootprints`（INFIELD_FACILITIES
  の足跡、infield-ground.ts が claim）の中も植えない；O10 も paddock / gravelArea 行（`resolveFootprint`）と施設の足跡（OSM リング／
  寸法箱を infield-ground.ts `ringOf` と同じ式で）を落とす。行: デグナーくさびの楠 → s 2158–2182（マーキーとコンパウンドの東、
  3 本）、ピット入口の欅 4 頂点、外周道路の欅に skip [130, 142]（A1 裏小屋）、T1 池の環に skip 3 か所、南コース檜 s ≤ 4458
  （北エプロンの手前）、ヘアピン台地の杉削除・低木 20、竹 40 / 25。16 行 343 本、skipped 0（smoke・e2e）。
- **Spoon（F5 / V3）**: BARRIERS `spoon-inside-wall` 削除、硬地の縁を空撮の線に（上の表）。`infield-smoke`: s 3430–3530 で縁の
  1.5 m 内は grass、外は paddock；`trackside-smoke`: 72 run、左側に 3410–3790 を覆う run 無し。プリセット 'spoon-inside-wall' →
  'spoon-inside-edge'。
- **駐車（V1 / F6）**: 上の「車」の段落。区画 455、高 260 / 低 110 台、最近接対 2.37 m。
- **島縁石（V10）**: 南コースの島を削除（上）。
- **屋根（V9）**: `roof: 'white'`（0xdcdcd8 の漆喰／膜、`furniture-infield-roofWhite`）をダンロップループのシェッド 5、スプーンの
  シェッド 2、西コースの小屋・トイレ 5 に — 空撮 06 / 11 / 13 の白い平屋根（ピット棟の灰は素の灰箱に見えた）。
- **葦（V11）**: `reedTexture()` を全ティアで、株 1.2〜1.95 m（上）。硬地の低ティアの明度や欅の遠景インポスターは未対応。
- **プリセット（V7 / V12）**: `spoon-yard-sheds` / `west-pits-yard` / `south-course-pits` / `south-course-control`（I5-b の施設を
  実際に写す）と、GPU でしか判断できない事実用の `afresh-in` / `afresh-out` / `west-pond-shore` / `c-lot-heli` / `spoon-entry-verge` /
  `130r-pond` / `dunlop-road` / `west-garage`（I7 で実 GPU で撮る）。
- **e2e（F9）**: 'infield and ops layer' に `stats.infield['infield-ponds'] === 2`、`infield-treesSkipped` / `infield-south-treesSkipped`
  === 0、`infield-trees` > 200、`furniture-infield-walls` の存在、far `byKind.infield` ≥ 1（Node の smoke と同じ事実）。計画からの
  他の逸脱（池 3 → 2、Spoon 杉帯なし、施設の kind の増加、INFIELD_PARKING 表、マーキー 20 × 12 等）は上の各段落に書いてある通り。
- **計測**（Node、no assets）: `scene-cost --tier high --all` = **4,331,278 tris / 1,000 meshes / 1,106 IM / 1,149 entries**
  （予算 4,637,500 / 1,090 / 1,143 / 1,221 の内、再ベース無し — 上の I5-c の段落の 4,268,831 / 977 / 1,008 / 1,086 はこの数字で
  上書き）。差の主因は竹 +51 本、白屋根のバケット +1、葦の株の拡大（三角形は不変）。surface-check `--suggest`（既存 WHY、P7 まで）:
  G3 `ground:water` 12.49 → 14.65（実測 低 13.95 / 高 12.0 — 池の土手が深く広くなった分）、G4 `water.steep` 1417 → 1581
  （実測 1,505 両ティア — 西池北東端の 6〜7 m の土手と島の 4 m 土手）。他の鍵は不変。

### 切通しとトンネル（R6）

I6 は P8 で先送りしていた「掘る」を、地面の契約の R6 改訂として入れます（上の R6 の I6 改訂の項）。I6-a はデータ・場・地面行・
ツールで、擁壁・坑口・階段・歩道橋の物は I6-b です。

- **データ** `CUTS`（`suzuka-facilities-spec.ts`、全行 unverified）: `CutDef { id, osmWay?, portal, window, depth, grade, halfWidth,
  wall, level?, length?, kind? }`。`portal` は手置き `{ s, lateral, heading }`（heading = 廊下が出て行く方位角、0 = 北）か way の
  ノード `{ from: 'first' | 'last' }`（`tunnel=yes` の way ならトンネルから出る向き、開いた way ならその way に沿って進む）。
  行: 県道三行庄野線の `loopSouth`（34096664 first、南進入路、10 %）・`cut643`（183309812 first = ダンロップ北のポータル、
  39 m の切通し、7 % でシケイントンネルまで — 計画の `loopNorth` は同じノード・同じ向きの同じ廊下だったので 1 行に、`level` は
  やめた: 水平では シケイン進入路の下が 7.1 m、トンネル内で 2.7 m 段差）・`chicaneLeft`（34096665 first、8 %）、構内道路
  `worksNE`（175231859 first）/ `worksSW`（手置き (117, −28, 231)、エプロン −28.7 の外）、`r200service`（(3190, +13, 200):
  計画の 20 はトンネル自身の向き。南へ 12 m で西ストレート側の地面に会う — `SHORT_CUTS`）、逆バンクトンネル `gyakuTunnelR / L`
  （469010265 の両端に手置き、**3.5 m / 10 %**: 計画の 5 m / 8 % ではパドック台地が NIPPO との二等分線で切れる 38 m 先までに
  地上へ出られず NIPPO の路肩まで 95 m 掘れてしまう）、歩行者トンネル 6 本の階段ピット `stairPit(…)`（`STAIR_PIT` 3.5 × 7 × 3.0、
  両端、向きは way の方位）。**183969196 は 1 本のトンネル**（全ノード tunnel=yes、200R の下から折れ目沿いに西ストレートの下まで）
  なので計画の中間ノード 2 つのピットは作らず、両端 `ped200Rb_R` / `pedWest_R` だけ。
- **場** `buildCutField(track, terrain, cuts)`（プランより前に組む: プランの `{ cut }` 行が廊下を要るので、路面フレームは
  `ground-plan.ts roadFrameReach` の純関数で判定）: 中心線を 0.5 m 刻みで歩き、始端は路面フレーム + `CAP_CLEAR` 0.3 m の外・
  始端キャップの両隅がフィル列 5.5 m の外（`CAP_MIN_OFF`。プランはリングの out 列を最初の区間の下のフィル列に「駐車」させるので、
  ロールキャップの折れ列 3.7〜4.0 m とその間にキャップの隅があると駐車列が折れ列を横切る — 解けない residual）・その側の
  BARRIERS 線の 0.6 m 外（`barrierReach`: 始端 2·halfWidth + 1 m の範囲で線と交わる／0.6 m 以内の多角形辺の最遠サンプルの先で始める。
  歩行者トンネルのノードは壁の内側に digitise されている）。壁裾は路面フレームに入る隅を 0.25 m ずつ引き込む。多角形の内側判定は
  32 m セルの索引 → 廊下の箱 → 中心線サンプルへの射影（隣サンプルとの幅の補間）。重なる廊下は深い方。`corridor(id, 'road')` は
  ± `CUT_ROAD_HALF` 3.5（halfWidth − 0.75 まで）で始端の 1 m 先から、`level` なら終端の 1 m 手前まで — 内側リングのキャップが
  壁裾のカラムになる（無いとフィル列 5 m にわたって床が天端へ弦を張った）。
- **プラン**: `{ cut }` 足跡は CutField の多角形（simplifyRing → 2 m 再標本）、`sRange` = 行の `window`。廊下の s 幅に半メートル位置の
  行を入れる（`stats.cutRows`。整数メートルだと G1 の格子点がスリバーの辺に乗る）。廊下リングはラスターの reach を広げない。
- **ツール**: `dem-profile.mjs --cuts`（廊下ごとに 1 m 毎の床／場（有・無）／DEM の表、始端・終端・理由・最大深さ、廊下外 2 m 格子の
  同一性 = 0 点差、廊下内で場が上がる点 0）、`infield-smoke.mjs --cuts`（20 廊下: 終端 30〜120 m（`SHORT_CUTS`）／ピット 7 m、
  床 = portal − depth、BARRIERS 線・STANDS 足跡と交わらない、行がプランのリング、中心線上の面が asphaltArea で場から 1.5 m 以内、
  廊下内で場は下がるだけ、路面フレーム 20,328 点で `cutAt` null、buildMs）。
- **廊下の座標系**: 路面に直角（±3° 以内、way に沿わない）な廊下は **track frame** — 中心線はポータルの駅の法線そのもの、壁は
  `portal.s ∓ w` の法線上に正確に（パドック駐車場の矩形の端と同じ扱い）。ワールド直線の壁が法線と 0.3° で交わると、駅 2 つの間で
  その列がフィル列を全部横切って潰れ、法線に沿った 10〜23 m の辺が残った（G7）。3° 以上ずれる廊下（県道の 3 本、逆バンク R、
  ピット数本）はワールド frame（法線に対し 10 m 毎にフィル列を 1 本横切り、crossing pass が駅を入れる）。
- **計測**（I6-a、Node no assets、両ティア同値）: 20 廊下（loopSouth 44 m / cut643 38.5 m wayEnd / chicaneLeft 57.5 m / worksNE 107 m /
  worksSW 64.5 m / r200service 9.5 m / 逆バンク 32〜33 m / ピット 7 m）、最大深さ 6.35 m（cut643 の d 10、シケイン側の地面の方が高い）。
  `buildMs.cuts` ≈ 0.17 s、plan 4.4 → 5.6 s、meshes 10.7 → 12.3 s（高; 低 4.4 → 5.7 / 10.8 → 11.0; +22 リング・+cutRows）、
  三角形 65.1 → 70.0 万; scene-cost 高 4,394,862 / 999 / 1,099 / 1,148、低 2,526,565 / 763 / 803 / 840（予算内、再ベース無し）。
  G1 mismatch 0（runtime 0）、G5 231、G7 0、G11 0、G12 residual 0。ALLOWANCES（両ティア `--suggest`、`WHY.cutWalls` を追記 —
  壁裾 0.6 m は 10° より急で 45° の崖より緩い帯、かつ G4 は場の法線を丸めたメートル位置で読むので壁から 1 m 以内の床・路肩の
  三角形が壁の法線と比べられる）: G3 asphaltArea 4.07 → 4.4（実測 4.19）、gravelArea 7.5 → 8.73（8.31）；G4 gravelArea.steep
  216 → 3,898（3,712: 廊下の砂利リングは壁沿い 0.5〜2 m の帯そのもの）、asphaltArea.steep 1,994 → 3,128（2,979）、grass.steep
  1,890 → 2,796（2,662）、lane.steep 54 → 73（69）、gravelBand.steep 56 → 63（60）、asphaltBand.steep 338 → 370（352）。
  I6-b の擁壁が壁裾を覆えば下がる（P7 の崖行が本命）。

I6-b は廊下の上に**立つ物**（`cuttings.ts buildCuttings`、infield.ts の傘の最後、`buildMs.infield` に含む）。地面は変えず、地面の面も
描かない（R11）。すべて `ground.standY` / `field.cutAt` を読む（R3）。新しいプログラム無し（pit 材質・`pbrFromAssets
('preconcrete_wall_001_long')`・素の色）。事実は `group.userData.cuttings`（壁の内側ポリライン・高さ、坑口の敷居線・背面線・開口高、
デッキの天端／桁下／余裕）に出し、`infield-smoke --cuts` が読む。

- **擁壁** `furniture-cut-walls`（cast、両側 = 廊下 × 2 = 40 本）: 廊下縁ポリライン（`CutField.corridor` = 地面行と同じ多角形）に
  沿う縦壁。見える面は**壁裾**（縁の 0.6 m 内側 = 場が床に達する線）、背は縁 — 場の smoothstep の土手はコンクリの中。
  底 = 床 − 0.3、天 = 縁の 0.5 m 外の `standY` + パラペット 0.3（1 m ピッチ、天端が床から 0.5 m 未満になる所 — 日照端の手前 — で
  止める）。天端に手すり 1.1（`props-cut-rails`、`Quality.infield.detail`）。preconcrete 板（4 × 1.33 m タイル、tint 0x9a9894）、
  パック無しは素の灰。
- **坑口** `furniture-cut-portals`（concrete046）+ 白笠木 `furniture-cut-copings` + 黒箱 `furniture-cut-tunnelInterior`（`interiorMat`、
  受光のみ）: 道路廊下の始端キャップ（8）と、次のトンネルで終わる cut643 の終端（1）、階段ピットの始端（12）= 21。幅 = 廊下 + 翼
  0.5 × 2、高 = 床 + depth + 1（背後の地面 + 0.8 以上）、背面はキャップ上（キャップは BARRIERS 線の 0.6 m 外で始まる）— BARRIERS
  線が 0.6 m より近ければ 0.1 m ずつ廊下側へ（cut643 終端: シケイン進入路のガードレールに斜めに会う翼の隅が 0.27 m → 0.4 m 入る）、
  厚 0.8。開口 = 擁壁の面の間の全幅 × 4.5（depth − 0.5 まで: 逆バンク 3.0、200R 4.0；ピットは 2.5 × 2.5 中央）、黒箱は背面から
  8 m 奥（天井は上の描かれた地面 − 0.45 に押さえ、足りなければ 6 / 4 / 3 m に縮める）。両坑口の間のトンネル屋根は場のまま。
  cut643 の終端はウェイがシケイン進入路のストリップに斜めに入り最後の 3 m で右壁が 5.5 → 1 m に引き込まれる（I6-a の多角形）ので、
  開口は 5.3 m・左寄り、右擁壁はそれに沿って曲がる。
- **歩行者トンネル**: 12 ピットの始端に上の坑口（2.5 × 2.5）、終端に階段 `props-cut-stairs`（rise / 0.17 段 × 踏面 0.3、擁壁面の
  間の全幅 2.3、上段はキャップ = 地面）+ 両側手すり 0.9。**pedNippo_L は 4.5 m / 10 m**（I6-a は 3.0 / 7）: NIPPO 外側の土手は
  横断 30 % で、3 m ピットの低い側は床から 1.7 m しか無く、2.5 m 開口の黒箱が地表を破った。
- **歩道橋** `FOOTBRIDGES`（`FootbridgeDef { osmWay, name, window, deckW, railH, ramp?, shift?, clearance, kind }`、`FOOTBRIDGE`
  定数）→ `structures-footbridge-<id>`（cast: デッキ + 橋台）+ `props-footbridge-steps` / `-rails` / `-parapets`: ウェイ両端の間の
  **剛体デッキ 1 枚**、天端 = max(スパン下の standY + minGap 0.6、スパン下の切通し床／舗装面 + clearance 4.5) + スラブ（foot 0.35 /
  road 0.6）、両端に橋台（0.6 × (deckW − 0.4)、standY − 0.3 から）、端は階段（riser 0.17 × 踏面 0.3、幅 deckW − 0.4）か 1:8 ランプ
  （`ramp`）。Q2 の 3 本（184103165 / 184103564 / 184103565、11 m、Q2 のバー 3 本の隙間 3.1〜3.5 m を前後に渡る歩道: 下は地面
  だけなので 0.6 m 上に; 184103165 は北ランプ、`shift` 0.3 / −0.44 で隙間の中央に = O5 の 0.6 m）と**シケイン側道橋 v2**
  467219905（4 m 車両デッキ、chicaneLeft 廊下の床から桁下 4.5 = 天端 46.30、両端 1:8 ランプ、コンクリ高欄 0.9; v1 の芝に置いた
  6 m スラブ `structures-underpass-bridge` は廃止、`structures-underpass-rails` は残る）。計画の「(5095, +25) → (5120, −20) の走路横断」は
  OSM に無く fold の誤読 → 建てない。
- **廃止**: I2-b のトンネル頭（`gyaku_bank_head` / `works_road_head` の PADDOCK_BUILDINGS 行、`paddockTunnelHeads` /
  `paddockRetainingWalls`、`PaddockBuildingKind` の tunnelHead / portal）。`UNDERPASSES.portal` は記録だけ。
- **ガード**: `infield-smoke --cuts`（壁 = 廊下 × 2、壁の内側線と橋台／階段の足跡が BARRIERS 線・STANDS 足跡から ≥ 0.6、坑口の敷居が
  BARRIERS 線を横切らず背面 ≥ 0.6、開口 ≥ 2.4（歩行者）/ 1.8、デッキ桁下 ≥ clearance（廊下の全サンプル）、4 本の名前、v1 スラブ無し）、
  facilities-check §6（FOOTBRIDGES の id）+ §16 O11（両端ノードが window に射影、shift ≤ 1 m、deckW 1.5–6、clearance ≥ 2.5）、
  e2e の名前一覧（`furniture-cut-walls` / `-portals` / `structures-footbridge-*` × 4、`structures-underpass-bridge` 無し）。
- **計測**（I6-b、Node no assets）: 壁 40 / 坑口 21 / 階段 12 / 橋 4、三角形 walls 3,424 / portals 462 / copings 252 / interior 210 /
  stairs 856；scene-cost 高 4,421,565 / 1,007 / 1,099 / 1,148（予算内、再ベース無し）；`buildMs.infield` 0.35 s、plan / meshes は
  I6-a と同じ（cuts 0.16 s）；G1 mismatch 0（runtime 0）、G5 231、G8（`furniture-` / `props-` 接頭辞: 壁天端 14.8 m²、階段 10.7 m²、
  橋の段 13.5 m² は免除、デッキは 0.95 m 上）、G11 0、G12 residual 0、ALLOWANCES 不変（pedNippo_L の深化で G3 / G4 は許容内）。
- **unverified**: 全行（擁壁の材・パラペット・手すり、坑口の寸法と白笠木、黒箱の奥行、階段の段、歩道橋の高さ・幅・階段／ランプ・
  `shift`、側道橋の幅 4 と桁下 4.5、pedNippo_L 4.5 / 10）。空撮はデッキの線と白い坑口しか解像しない。

## GPU で確認すること

このリポジトリの検証はすべてソフトウェア描画（SwiftShader）で行っているため、高品質ティアの見た目は実 GPU で確認してください
（`?fx=1`、必要なら `?assets=1`）:

- KTX2 の転送先フォーマット（ASTC / BC7 / ETC2）で芝・アスファルト・コンクリートのタイルが正しく出ること、法線の向きが逆でないこと（低い横光で確認）
- MSAA の alpha-to-coverage で観客・金網・樹木の縁がにじまないこと、55 m 以内の 3D 観客と遠景インポスターの切替が目立たないこと
- グランドスタンドのガラス帯とピットビル 2F ガラスの空の反射、白壁の法線マップ、V1/V2/Q2 の座席インスタンス、スタンド屋根の影
- ピットビル v2（I1-b）: 銀灰アルミのポッド（0xb9bcc0、metalness 0.35）の反射が白飛びしないこと、`facade001` のガラス帯と
  暗ガラスの角の反射、`concrete_floor_03` のガレージ床と `painted_metal_shutter` のリブの法線の向き、折戸の葉（2 材質 IM）の
  ガラスが暗枠から浮かないこと、ソフィットのダウンライト（輝度 0.45）が日陰のガレージ前で点いて見えて halo が出ないこと、
  曲面キャノピーの上面／下面の継ぎ目と前縁の立上り、pit-follow の chase 枠（stop −23.5 の 11 m 後方 +3.4）でファシア梁
  （底 2.85）が右端に掛からないこと、2F 手摺ガラス（`pitRailGlass`、透明）越しに着席の観客が見え手摺の管が上に載ること
- ピットビル v2（I1 レビュー修正）: `pitShellSoffit` のキャノピー下面が pitlane-onboard / garage-front でファシア（≈ sRGB 150）
  に対して明灰（≈ 120–130）に読めること（`soffitBounce` は AO の後で暗くなりすぎない）、ポッド天端 12.5 の上に掛かるキャノピー
  下面の陰影、ピア面 y 2.3 の番号札が TV ピットビルカム／オンボードから読めること、裏壁の淡いパネル 0xdcdedb にタイル目地の
  法線が出ること、折戸の白枠と淡いガラス
- ピットビル v2 3/4: ガレージのウォッシュ（`garageWash` 0.11）が日陰の開口の奥で「点いた室内」に見えて床の `concrete_floor_03`
  （無発光）が読めること、`fence003` の白い金網が A2C でにじまないこと、開いた裏扉からパドックの光が抜けること、
  `metal_tool_chest` / `steel_frame_shelves_01` / `plastic_crate_02` / `pc_monitors` の近景 L0 ↔ 手続き L1 の切替（120 m）が
  目立たないこと、タイヤブランケットの instanceColor、モニター壁の `opsMonitor` 発光（GLB の emissive スロットは未使用）、
  `rectangular_facade_tiles` の法線の向きと窓帯の反射、屋上ラチス pylon の影、テラスの座り姿インポスター（1,653）が座席に
  沈まず・浮かず、55 m 以内の 3D 座り姿（`male_sitting` / `female_sitting`）との切替
- 60 fps を保てること（保てなければ描画解像度が自動で下がります。`?assets=0` で差分を切り分け）
- 白線が近景で実寸（15 cm）、俯瞰・ヘリでも消えずに 1 px 強で残ること（`app/three/lines.ts` の最小幅シェーダ）
- 乾いた調整池（T1 インフィールド・T1–T2）の法面と床が地形と馴染んでいること
- ピットレーン舗装の明度が本線と揃っていること
- パドック（`paddock.ts`、I2-b）: `corrugatedsteel007a` の縦リブの法線の向き（低い横光で凹凸が逆に見えないこと）とモジュール
  境の 0.32 m 段、開口 quad（12 mm 浮き）が反転 Z で壁と z-fight しないこと、`rollershutter_door` を非等方に伸ばしたシャッターの
  法線、センターハウスの `facade001` ガラス帯と楕円キャノピーの影が丸柱 16 本の間に落ちること、`pavingstones099` デカール
  （10 mm）が舗装面から浮かず縁が切れないこと、給油所の島縁石（sink 20 / crown 120）とディスペンサー、緑 tint の `fence003`
  金網が A2C でにじまず両面から見えること（小区間カードの継ぎ目で uv が切れないこと）、白塗り波板（`noMap` + 法線）の
  オフィス壁がピットビル裏の白と揃うこと、ロールドアのレフが壁の 3 cm 前に見えて巻取り箱が浮かないこと、キャノピーの柱がバルコニー
  の外に立つこと、ポール街灯の 700 m LOD 切替、照明マストの X ブレース、
  トンネル頭の暗い開口が面から浮かないこと
- パドック駐車場（I2-c）: 区画線デカール（`LAYER.paddock.line` 20 mm）が黄ハッチ（10 mm）とセンターハウスの舗石（10 mm）の上に
  出て反転 Z で z-fight しないこと、ハッチの暗いパッチが `asphalt_04` の面から浮かず色味が離れすぎないこと、`infield-paddock-cars` の GLB（kei / 軽トラ /
  ハイエース、`carGlb|tint` の輝度マスクで塗装だけ instanceColor）↔ 手続きボディの切替（260 m、`Quality.infield.vehiclesNearM`）が
  ヘリ／chase の S 字 s ≈ 1505 から目立たないこと、`covered_car` の布の法線、A 南列の外側 2 列（勾配で空）が「線の無い舗装」として
  読めること（P7 で埋まる）
- ピットレーン断面（`pit-lane.ts`）: concrete046 の壁と歩廊の法線の向き（低い横光）、金網（fence003）の A2C の縁と 1.0 / 1.8 m の段、白縁石上のフープ 266 体の影の落ち方（受けのみ）、青帯デカール（12 mm）が反転 Z で z-fight しないこと、
  エプロンの目地（`apronConcreteMaps` の法線溝）が 14:00 の斜光で段として読めること、壁天端の 60 / FIRE STATION 板の向き（−s 面に印刷）、スターター台の金網窓、W ビームの armco 法線と白パイプ柵、ゲートリーの 5 × 4 ランプの上 2 段だけがスタートシーケンスで光り下 2 段が暗いままなこと、白バナー 2.0 m の文字
- 土地利用マスクの境界（森・田・舗装・集落）が区画の縁や地形チャンクとリングの継ぎ目で途切れないこと、ミップ／異方性でヘリからのちらつきが出ないこと（`?fx=1` で detail タイルも）
- 山並み（`terrainFar`）の霞: 4 km から先のフォグの傾斜で 20 km の稜線にコントラストが残り、低い太陽で山に沈むこと（プローブが太陽を隠すこと）
- 水面 `water-far` の反射（`scene.environment` の IBL とリップル法線）が濁った緑灰で、岸の 12 m の土手に対して平面が浮いて見えないこと
- 森の樹冠のマス（`forest.ts` の `forest-<cell>`）と地形の z-fight、樹木の LOD 切替（60 m / 130 m のメッシュ → 130〜900 m のインポスターカード → 樹冠マス）の飛び、森床の落ち葉色
- 樹木（`trees.ts`）: 葉の A2C の縁、GTAO のハロー（50 m 以内）、風の揺れの振幅（`store.weather.wind` / 8）と逆光の半透過、130 m 以内の葉影のアクネ、桜の色、カードの方位段（8 方位）と 10°/45° の仰角帯の切替、杉（モミのパック）の針葉の暖色化
- 建物のファサード（`app/three/buildings.ts` の `DataArrayTexture`）: 7 層の sRGB デコードとミップが正しく出ること、瓦・リブ金属・窓帯が層ごとに入れ替わらないこと。おかしければ `FACADE_ARRAY_TEXTURE = false` で 4 枚の通常マテリアルに落とせる
- 駐車場の車（`vehicles.ts`）: 500 m でのカードへの切替、カードの向きと着色（`tex/car_atlas` のマスク）、俯瞰の点描が地面に埋まらないこと
- A2R・130R G 席の青いキャノピーの影と支柱の接地、芝土手のレジャーシートの z-fight（standY +2 mm）、焼き込みアトラスの座り姿が芝の上で 0.40 m 沈んで見えること
- 柵の外の道路（`roads.ts`）: `asphalt_04` / `gravel_road` の KTX2 と法線の向き（低い横光）、路肩の A2C フェードにディザ模様が出ないこと、解析区画線が近景で実寸（15 cm）・1 km 先でも ≥ 0.6 px で残り
  MSAA / SMAA でちらつかないこと、破線が遠方で 50 % の実線に溶けること、交差点の重なり（8 mm のクラス段、反転 Z）が z-fight しないこと、リング上のリボンが丘で浮き沈みしないこと、橋のデッキと高欄
- 道路脇の設備（`road-furniture.ts`）: ガードレールの armco 法線と影、標識板の向き（印刷面が走行方向を向くこと）、ミラーの鏡面、信号機のレンズの点灯色、電柱の変圧器と 6 本の架線、`ROAD_FURNITURE.pole.hero` を true にしたときの jp_denchu スキャンの見え方（SwiftShader では茶色い塊に見えたので既定は off）
- 建物（`buildings.ts` / `hero-buildings.ts`）: 14 層の `sampler2DArray` の法線とミップ、WebP → 配列の色管理（写真層は塗り層の平均輝度に正規化）、ヒーロー家屋の台座と正面の向き（最寄り道路側）、釉薬瓦の暗さ、遠方のシャッターのモアレ、乾田の泥タイル（`dry_mud_field_001`）
- 車両・太陽光・鉄塔: GLB 車体の輝度マスク（ガラスの反射が塗装扱いにならないこと、ハイエースの暗い屋根）、260 m での GLB → 手続き車体の切替、太陽光フェンスの A2C とインバータ小屋、鉄塔のトラス腕と碍子連
- 地形系（`terrain-side.ts`）: 反転 Z での 3 cm の水面帯・畦のリフト、ヘリからの枕木テクスチャのエイリアス、1 km 先の 7 cm のレール、水面帯のリップル法線
- マーシャルポスト v2（`marshal-posts.ts`）: `blue_metal_plate` の法線 / ARM が白灰 0xe6e6e2 の上で低い横光に凹凸を出すこと、開口の
  `fence003` 金網（tint 0x3a3c40）が A2C でにじまず内箱の暗さが「日陰の室内」に読めること、Small Guard Booth（1.87 m、`front 'moreArea'`
  で −x = トラック向きに回してある — 窓面が本当にトラックを向くか）↔ 手続き本体 2.5 m の 120 m 切替の飛び、番号板の数字が chase / TV
  から読めること（板は柵柱の走行側 0.08 m、金網と z-fight しないこと）、消灯パネルの LED ドット面が黒枠から浮かず反射で緑に見えないこと、
  赤白帯の 5 周期が四隅で切れないこと、架台 + 本体の影と 6 m の CCTV ポールの細さ（1 km 先で消えてよい）
- 柵の内側の地面行（I5-a）: 西ループ（s 3540–4760）の `aFresh` 新舗装が両端 40 m で滑らかに濃くなり、macro の斑と detail の骨材が
  その上でも読めること（0.72 倍が黒つぶれしないこと、roughness −0.1 の艶が反転 Z の反射で白飛びしないこと）、`asphaltArea` の
  `Asphalt033`（2.5 m タイル、法線 0.8）が paddock の `asphalt_04` より濃く粗く見え、南コース・管理道路・教習コースで 13 × 20 m の
  ワールド uv にモアレが出ないこと、破線中央線（16 mm）が反転 Z で管理道路の面と z-fight せず 300 m 先でも残ること、第 2 ヘリパッド
  の橙の四角枠と H がアトラスの左タイル（白丸）と混ざらないこと（ClampToEdge の継ぎ目）、C パドック駐車場・スプーン硬地・L ヤードの
  灰アスファルトが DEM の起伏で段になって見えないこと（P7 まで 2 m ラスターの弦）
- インフィールドの施設（I5-b）: 西コントロールタワーのガラス帯（`glassMat`、殻から 1.2 % 外）が白い殻と z-fight せず、バルコニーの
  手摺が 260 m の chase から読めること；`rollershutter_door` の葉が西コース / 南コースのガレージ壁の 0.05 m 前で埋まらないこと；
  `tire_stack` GLB（0.93 m に scaleTo）と手続きの開いた円筒の 120 m 切替、`forklift`（cm 単位を 3.7 m に scaleTo、front moreArea）
  の向き、`porta_potty` 4 台の扉の向き；`tent_canopy` をマーキーの箱に伸ばした天幕の UV の伸び（20 × 12 と 25 × 12）；ヘアピン出口の
  22 m マストのヘッド 3 つが路面を向くこと（`toRoad` の符号）；南コースの縁石 15 区間が 240 m 先でも赤白に読め、8 m リボンの縁から
  0.5 m 内側で面と z-fight しないこと；インフィールド駐車場の車の GLB 段（`vehiclesNearM`）と `infield-bayLines-C` の白線が C パドック
  の 2 m ラスターの弦（P7 まで）で埋まって見えないこと；金網柵（`fence003` cutout、DoubleSide、alphaToCoverage）が南コースの傾斜で
  カード毎に折れて見えないこと（3 m ピッチの半分で分割）

- 池と樹木（I5-c）: 水面（`waterFarMaterial`、transparent 0.9 / depthWrite false）の反射と 4 m リップルが西ストレート池・130R 池で
  遠景の水面と同じに見え、透明パスの並び順で岸の土手（mud）が水面の下に透けること（反転 Z で水面と土手が z-fight しないこと）、
  島とデッキが水面から 0.6 / 0.9 m 出ていること；葦カード（`grass_medium_01` diff + opacity、alphaTest 0.3 + A2C、DoubleSide）に
  ディザ模様や白縁が出ないこと、裏面の陰影が黒くならないこと；水たまりの楕円が乾いた池の床に張り付き（LAYER.verge.paint 8 mm）
  斜めから浮かないこと；`aFresh` の境界 40 m（s 3540 / 4760）が路面の艶と色で段に見えないこと；INFIELD_TREES の欅・楠・杉が
  ヒーロー距離 120 m で LOD0 に切り替わるときの飛び、楠の暗い tint が夕方の低い光で黒つぶれしないこと、柵の内側に散布の木が
  残っていないこと（森ポリゴンの内側だけ）
- 切通しとトンネル（I6-b）: 黒箱 `furniture-cut-tunnelInterior`（0x33363b、受光のみ）が GTAO で坑口の奥に「暗い穴」として読め、
  ハローや箱の縁の線が出ないこと、笠木の白が日向で飛ばないこと；preconcrete 擁壁の法線の向き（低い横光で目地が凹に見えること —
  `handBuiltUv` で V を反転している）と 4 × 1.33 m タイルの継ぎ目、壁裾の smoothstep の土手が壁の中に隠れて床と壁の境が直線に
  見えること（0.6 m 内側の面）；cut643 終端の左寄り開口と曲がる右壁が chase から破綻して見えないこと；反転 Z で階段の踏面と
  ピット床（2 重リング）が z-fight しないこと（踏面は床 + 0.17 以上）；歩道橋デッキの影が Q2 の隙間に落ちること、側道橋 v2 の
  桁下から chicaneLeft の床が見えること（4.5 m）、ランプ 1:8 の板が芝から浮かないこと；坑口の背面が BARRIERS 線の 0.6 m 外で
  ガードレールに食い込まないこと
- `node scripts/perf-probe.mjs --gpu` で draw call と三角形数を採取し、`.perf/` の SwiftShader 値と比較

## Simulation notes

- 速度プロファイルは、レーシングラインの曲率を各コーナーの実測頂点速度（`APEX_SPEED_TARGETS`）に合わせてキャリブレーションし、
  グリップサークル（旋回中の制動・駆動力の減少）、カントによる横 G の増減、勾配による加減速を含む前後パスで求めます。
- 理想ラップは予選相当（約 1:26）。レースでは燃料重量（100 kg → 0、周回で減少）とエンジン／タイヤ管理モードの係数が掛かり、
  平均 1:33 台・ファステスト 1:31 前後になります。
- 車間・追い越し（横方向レーンチェンジ）、車体の重なり解消（同一区画に 2 台は入れない）、1 ストップのピット戦略
  （80 km/h 制限区間 425 m、ピットロス 26 s 前後、分岐 s 5290・合流 s 385 は OSM の Pit Lane way 実測）を実装しています。
- ピットの区画は Mobilityland 2009 図面（4.75 m × 4 ピット = 19 m ブロック 12 + 7 m コア 6 = 270 m、ブロック中心
  `GARAGE_CENTRES`、絶対位置 ±10 m 未確認）で、停止位置はシャッター前の作業エリア lateral −23.5（`PIT_PLANNED.stopLateral`、
  boxS の 100 m 手前でレーン中心線から切り替え）。ピットレーンでは進入の分岐・ボックス手前 40 m・退出でレーン中心線に
  戻るまで横方向レートを 2 倍にし（80 km/h 以下でグリップ限界から遠い）、先行車の 5.2 m 後ろに止まれる速度に抑えます。
  リリースされた車は停止 lateral を **3.5 m 保ってから**（`PIT_EXIT_HOLD_M`）最初の 40 m はレートを 3 倍（`PIT_STEER_EXIT_BOOST`）で
  レーンへ切ります — 車体が自ブロックのレーン側クルーを過ぎてから曲がり、次ブロックの後ガンナー (boxS + 17.3) には届く前に
  stop + 2.6 を越える（9 m 保持だと次ブロックのガンナーを掃き復帰も 40 m を越える。I3 レビュー、「運営レイヤー」）。
  実測（`pnpm sim -- --laps 8 --seeds 3 --pit-trace`、22 台が同じ周に入る混雑ケース）：停止 −23.5 ± 0.1、退出 26.1 m で
  中心線 +2 m 以内（交通に譲ると最大 82 m）、進入ランプの遅れは分岐点で 4.3 m、退出ランプ 2.0 m 以下、ピットロス平均
  26.0 s（53 周では 21.7 s）。包絡は `PIT_ENVELOPE` が持ち、ops-check §16 と `--pit-trace` が同じ表を読み、`--pit-trace` は
  静的運営レイヤー（ops-spec の機材列とクルー人物）との接触も数えます（機材列は 0 が門）。
  `pnpm sim -- --laps 8 --seeds 3 --envelope out.json` は 5 m ビンごとの実測（車体中心 lateral の min / max）を書き出し、
  `node scripts/facilities-check.mjs --strict --envelope out.json` がそれで箱帯（PIT_BOX_STRIP）の外の解析的キープアウト
  [c − 6.5, max(c + 5.5, −hw)] を [min − 0.95 − 1, max + 0.95 + 1] に置き換えて再検証します（箱帯の中は車が作業エリアへ
  斜めに渡るのでビンが作業エリアを覆ってしまい、レーン帯 + 停止車矩形の明示規則のまま）。ファイルはコミットしません。
- ギアは 8 速（12,000 rpm リミッター、11,800 でシフトアップ、7,600 未満でシフトダウン、減速時はエンジンブレーキ側へ早めにシフトダウン）。
  1 速はローンチ専用で、最高速 332 km/h は 8 速 ≈ 11,900 rpm、ヘアピン（約 70 km/h）は 2 速 ≈ 8,200 rpm、130R は 8 速になります。
- ギャップ／インターバルは 20 m ごとのチェックポイント通過時刻から算出しています。
- 53 周のレース終了後はリザルトパネルが表示され、リスタートできます。

ドライバー名・番号・チームカラーは `app/data/drivers.ts` で編集できます。
