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
#   trackside: Small Guard Booth（Arsen Ismailov、422ec83e）マーシャルキャビン: dropNodes で門扉（RootNode/Cube）を落とす、ガラスの KHR_materials_transmission は残る / Racetrack tire stack standard v2（mira9、65cc7bcf）側壁刻印なし / Flood light 02（CHAMOD、95ad365a）/ Barrier & Traffic Cone Pack（Sabri Ayeş、23c4dfca）keepNodes で Object_3・5（コーン）・13・14（縞ドラム）・10（ポール）・15〜17（小バリア 3 種）だけ残す（22 画像 256 px）/ Police Crowd Barrier（exiS7-Gs、27146861）"POLICE LINE - DO NOT CROSS / POLICE DEPT" をレールの青で fill
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
`parking`、歩行者・構内のトンネル `tunnel`、歩道橋 `footbridge`、切通しの道路 `road`）は
`build-facilities.mjs --add-ways-from .cache/overpass/surroundings.json --role "<役割>:<id,…>"` で
キャッシュ済みの Overpass 応答から網なしで差し込みます（`SPLICED_WAYS` に載せておくとフル再生成でも残ります）。
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
`window.__suzuka` フックを使っています。

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
    suzuka-facilities.ts       # OSM 由来のフットプリント（スタンド・ピットビル・建物・ランオフ・水面・レースウェイ・柵内の硬地 apron／駐車場 parking／歩行者トンネル tunnel／歩道橋 footbridge、ODbL、生成物）
    suzuka-facilities-spec.ts  # スタンドの列・蹴上・構造・色、ランオフ帯、塗装エプロン、ピット定数、季節パレット（手書き）
    suzuka-barriers-spec.ts    # 全周のバリア run・実在する縁石／緑帯・白線・二輪路・マーシャルポスト・調整池（手書き、OSM way id 参照）
    suzuka-power.ts            # 送電鉄塔・架線（OSM、生成物）
    suzuka-dem.ts              # 柵の外の標高: 30 m 汎化グリッド（DEM5A σ20 m、±3.3×2.9 km）と 500 m 遠景グリッド（DEM10B、±35 km）。国土地理院、生成物、ASL 整数の int16 デルタ
    suzuka-surroundings.ts     # 柵の外の土地利用（森・田・草地・水面・小川・駐車場・太陽光・建物・道路・鉄道・サイト。OSM、ODbL、生成物）
    surroundings-spec.ts       # 柵の外の手書き定数（色・幅・密度・LOD レンジ。ODbL 外）
    en-codec.ts                # 周辺データの EN 座標ストリームの復号（int16 デルタ base64 → EN / world）
    dem-codec.ts               # DEM グリッドの形と復号（`DemGrid`、海の sentinel、双線形サンプル）
    crowd-atlas.ts             # 観客インポスターアトラスのレイアウト（焼き込みスクリプトと対；`CROWD_HELMET_ROWS` = 行 28–31 の白ヘルメット姿勢、運営レイヤー用）
    credits.ts                 # アプリ内クレジット（生成物）
    tree-species.ts            # 樹種の表（役割 → パックのノード正規表現・LOD・高さ・色味・樹冠色・風、TREE_MIX の配植比率。手書き）
    ops-spec.ts                # 柵の内側の運営レイヤーの純データ・純関数（`opsPlacements()` / `figuresAt()` / `OPS_TEXTS`、three 非依存。facilities-check §16 と smoke が読む。I3 が埋めるまで空）
    drivers.ts                 # 2026 年グリッド（11 チーム 22 名）、チームカラー
    ops-spec.ts                # 運営レイヤーのデータ（行の形 OpsPlacement / OpsMount と `opsPlacements()`。three 非依存、ops-check と ops.ts が同じ行を読む。表は I3 で）
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
    ground-plan.ts             # 地面の区画（XZ で 1 点 1 オーナー）: 駅・カラム・範囲（fold／二等分線／橋の上限）・PRECEDENCE・RULE_OF・ownerAt
    ground-field.ts            # 唯一の連続した高さ場（路肩 2 m のストリップ規則、2〜8 m の混合、地形 + RUNOFF_LIFT）
    ground-mesh.ts             # 区画をメッシュにする: 頂点プール（共有頂点・1 頂点 1 高さ）、ラスター、縫い合わせ帯、リングのワールド部、種類別 ground:<kind>
    ground-materials.ts        # 種類別マテリアル（路面・縁石・帯・エリア・パドック = 高ティアは asphalt_04 PBR + マクロ、パック無しは灰ノイズ・ヘリパッド・池）
    track-mesh.ts              # 地面でないもの: ソーセージ（地面に立つ物）、塗装エプロン・緑帯・DRS 線（描画済み面を切り出して持ち上げたデカール）、スタートゲートリー（白バナー 2.0 m、5 列 × 4 段のランプパネル — レースが点けるのは上 2 段、EM 情報板、右脚はピットウォールの歩廊上）
    barriers.ts                # 全周のバリア（実データ表 `BARRIERS` から: コンクリート壁・タイヤ壁・ガードレール・デブリフェンス）
    trackside.ts               # OSM way／実測サンプル → 所属道路の lateral(s) 解決（図 8 の折り返し対策つき）
    lines.ts                   # 白線レイヤー（全周のエッジライン、ピット各線、グリッド。描画済み面を切り出したデカール。画面上の最小幅を保つ頂点シェーダ）
    lanes.ts                   # 二輪シケイン・スリップロードの縁石（地面に立つ物: standY 上、幅は GROUND_OBJECTS で有界。舗装そのものは OFFSET_LANES の足跡として地面の区画が描く）。`sweepKerb`（規則・閉ループ可）はパドックの島縁石も掃く
    environment.ts             # 地形（高さ場: 路面 IDW → 実 DEM のクロスフェード、施設のリリーフ、格子縁のスナップと粗いリングの高さ・法線）と各ビルダーの共有コンテキスト、観覧車
    dem.ts                     # 実 DEM の高さ場（内側は双三次、遠景は双線形、外周 300 m でクロスフェード、水面ポリゴンの底）— 1 Track に 1 つ
    terrain-far.ts             # 格子の外: 粗いリング `terrainRing-0..3`（継ぎ目の頂点・法線を共有）、DEM_FAR の山並み `terrainFar`（頂点色、フォグの傾斜パッチ）、水面 `water-far`
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
    structures.ts              # 立体交差の桁橋（スラブ・化粧板・鋼桁・橋台・翼壁・側道）、地下道の高欄、看板とピット出口信号（signAtlas / signUv は pit-lane.ts の壁天端標識と共用。mount 付きの行は壁のビルダーが描く）
    lattice.ts                 # 鉄骨ラティスのプロトタイプ（送電鉄塔・リーダータワー・スタートゲートリーで共用、低ティアはブレース無し）
    impostor.ts                # インポスターの共通実装（アトラスのレイアウト・方位セル・マスク着色・疑似法線）— 観客・車・樹木で共用
    stands.ts                  # OSM フットプリントと座席仕様から全スタンドを生成（段床・座席・柱・屋根・ガラス帯・足場・裏方・案内板）、パスフレーム、座席数クランプ、地形リリーフ（スタンドの丘・台地、GP スクエア、パドックの右側 1 平面）
    pit-complex.ts             # ピット複合体の入口（buildPitComplex = pit-building を呼び buildingRoofMat を返す薄い層。ピットレーンとパドックは infield.ts の傘から）
    pit-geometry.ts            # ピット系の純幾何・キャンバス補助（frameAt / sweep / texturedWall / trackPrism / podLoft の弾丸ロフトと podBand / podFlank（帯・丸窓）、smoothProfile / remapV、canvas / label、PIT_TEXTS、3 ビルダーが共有する材質 pitMaterials(ctx) — soffitShellMat / railGlassMat を含む、addMerged）
    pit-building.ts            # ピットビル v2（2009 図面の断面を勾配追従スイープ: 1F ガレージ列・ファシア梁・2F/3F テラス・曲面キャノピー、折戸・シャッター・番号札、階段塔、銀灰のコントロールポッドとメディア区間、T1 ノーズ、ビジョン 8、ガレージ内装とウォッシュ・機材の prop set 'ops-garage'、裏キャノピー／タイル壁／窓帯／スパー橋、屋上設備、表彰台、テラスの観客 'ops-terrace'。canopyTopAt を export。§ピットビル v2）
    infield.ts                 # 柵の内側の傘: buildPitComplex の直後に pit-lane → paddock → ops → marshal-posts + tv-towers → infield-ground → cuttings を同期で呼び、buildMs（pitLane / paddock / ops / trackside / infield）と stats.ops / trackside / infield を出す
    pit-lane.ts                # ピットレーン（PIT_WALL v2 の断面、「ピットレーン断面」参照）: 0.7 m コンクリート壁 1.8 m と入口端の白ブロック、両面の広告帯（レーン面に 80 リング）、天端のデブリ金網と支柱、歩廊 +0.5・白縁石 +0.45・パイプフープ 266（60 m ベイの IM）、固定プラットホーム 31–69、スターター台、ブロック境界のキャビネット、W ビーム区間（丸支柱 IM + 白パイプ柵）、補助レーンの青帯 + 白縁線（LAYER.pit.band のデカール）、壁天端の 60 / FIRE STATION 標識、v1 の prat perch（I3-c が置き換える）、リーダータワー
    paddock.ts                 # パドック: BUILDINGS と OSM 建物の押出し、プレハブ列、トランスポーター、テント、旗、駐車場（v1。I2 がチームオフィス列・センターハウス・フェンスと門に建て替える）。I2-a: センターハウス芝島（PADDOCK_ISLAND）の縁石リング（GROUND_OBJECTS.islandKerb、markObject）。地面は GROUND_AREAS の paddock 行（A 南列・回廊・B・B 斜め・E + 接続・前庭）
    ops.ts                     # 運営レイヤー（I3: トランスポーター、ホスピタリティ、ピット機材、人物、SC／メディカル／コース車両、クレーン。ops-spec の行を置き ctx.ops に積む。I0 は入口のみ）
    marshal-posts.ts           # マーシャルポスト（I4: 架台上のキャビン、低ポスト、番号板、ライトパネル、人物スロット。I0 は入口のみ）
    tv-towers.ts               # TV カメラ塔（I4: 足場塔・格子塔・架台、レンズ点。I0 は入口のみ）
    infield-ground.ts          # インフィールドの施設・壁・柵・池の岸・西／南コースのピット・車・街灯（I5。地面そのものは GROUND_AREAS の行が描く。I0 は入口のみ）
    cuttings.ts                # 切通しとトンネル（I6 / P8: 壁・坑口・高欄。I0 は入口のみ）
    props-pack.ts              # 柵の内側の小物プロトタイプ: パック GLB（model-proto + orientPack、部品ごとの材質）か手続き版を同じ形 PropProto に、テクスチャ集合／色ごとに材質を共有する PropCache、ティアの切替 glbOr
    infield-lod.ts             # 小物セットの LOD と実体化 registerPropSet（250 m セル × 段ごとに 1 InstancedMesh、GLB の近景 → 手続きの遠景 → 空、近景だけが影を落とす、低ティアは 1 バケット）、周回柵の内外判定 insideRing（OSM 775428456）
    figures.ts                 # 人物の共通部（crowd.ts から昇格）: 焼き込み／手続きインポスター、GLB の 3D プロトタイプ（部位 id、白ヘルメットの第 5 部位）、部位着色材質、運営レイヤーの姿勢・役割（marshal / official / crew / photographer / staff / guest、座り姿 sit / sitF）と buildOpsFigures（kind 'ops'、観客予算とは別勘定）、ピットビル 2F/3F テラスの座席スロット terraceSlots
    props.ts                   # 距離看板、マーシャルポスト＋デジタルフラッグ、TV カメラ塔、送電線（鉄塔はトラス腕・碍子連・架空地線の頂部、7 本目のケーブル）、二輪・カート舗装
    vegetation.ts              # トラックサイドの樹木の散布（棄却サンプリング、桜ゾーン、キープアウト）と Node／低ティアのコーン原型
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
    cameras.ts                 # カメラリグ（オンボードの振動・G、TV カメラの操作者モデル、ヘリのバンク）
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
  facilities-check.mjs         # スタンド／ピット定数／ガレージ順／GROUND_AREAS の輪郭・layer 契約・RUNOFF_ZONES 衛生、表が参照する OSM id の実在（§6、--strict で error）、§16 ops-check O1–O11（運営レイヤー・マーシャルポスト・TV・インフィールドの表をピット包絡 PIT_ENVELOPE・chase レンズ・グリッド・バリア線・建物足跡・サーキットのリングと照合。無い表は「absent, skipped」）
  assets/                      # fetch / import-misc / bake-crowd-atlas / bake-car-atlas / sources（アセットパイプライン）、inspect-model（ドロップの中身）、retouch-glb（GLB 内画像の矩形修正・部品の削除）
  facilities/                  # build-facilities（Overpass → TS、--add-ways-from でキャッシュから役割付きの way を網なしで splice）、build-power、build-surroundings（柵の外の OSM → suzuka-surroundings.ts）、osm-common（Overpass 取得・EN 投影・DP・int16 デルタの共通部）、
                               #   dem-profile（DEM5A → 標高キーフレーム、--grid --far --write で suzuka-dem.ts、--relief で relief ゾーンの縁の検算、--verify で 34 駅の照合）
  audit/                       # 実写との突き合わせ: aerial（国土地理院の空中写真モザイク）、overlay（アプリの線と OSM を重ねて区間ごとに切り出す）、shoot（区間ごとの真上・斜めショット）、osm-edge
                               #   surface-check（面のガード）、scene-cost（三角形／メッシュ／遠景の静的コスト）、app-runtime（アプリのビルダーを Node で走らせる土台）、
                               #   stub-registry（manifest の GLB をテクスチャ無しで読むスタブ登録簿と buildSceneWith — *-smoke の --glb が使う）、
                               #   ring（サーキットのリング 775428456 の復号と内外判定、Node 用）、smoke-common（I フェーズの smoke 共通部: 遠景の失敗 0・ops-*/infield-* の頂点有限とリング内・buildMs）、
                               #   pit-smoke / paddock-smoke / ops-smoke / trackside-smoke / infield-smoke（各フェーズの smoke 雛形、`--tier high|low|both`、check には入れない）
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
- **コース周辺の線形物**（`app/data/suzuka-barriers-spec.ts`）：バリア（71 本の run）、縁石（実在する 28 本）、
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
  - 起動コスト（Node、高ティア）：プラン約 5.8 s＋メッシュ約 6.2 s、三角形約 40.4 万。ブラウザでは e2e の `setupMs` で見ます。
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
  コンクリート、カーボン、タイヤ、ホイール、リバリー、観客、ガレージ、看板、Armco、金網、タイヤバリア、TecPro、雲、火花などを生成します。
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
| −9.75…−11.05 | 歩廊（`concretePitWalkway`） | +0.5。チームの prat perch（v1、I3-c で置き換え）、ブロック境界のキャビネット 0.6 × 0.9 × 1.2（`pitCabinets`、13）、スターター台（`pitRostrum`: 3 × 2.4 × 2.6 の暗鋼キャビン、床 +3.0、脚 φ0.1 × 4、8 段の階段、金網窓、白パネル。s 5.5 = ゲートリー脚の T1 側） |
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
  実測（`pnpm sim -- --laps 8 --seeds 3 --pit-trace`、22 台が同じ周に入る混雑ケース）：停止 −23.5 ± 0.1、退出 30 m で
  中心線 +2 m 以内（交通に譲ると最大 83 m）、進入ランプの遅れは分岐点で 4.3 m・s 5300 以降 1.7 m 以下、ピットロス平均
  26.0 s（旧 25.5 s、53 周では 21.7 s で同じ）。包絡は `PIT_ENVELOPE` が持ち、ops-check §16 と `--pit-trace` が同じ表を読みます。
- ギアは 8 速（12,000 rpm リミッター、11,800 でシフトアップ、7,600 未満でシフトダウン、減速時はエンジンブレーキ側へ早めにシフトダウン）。
  1 速はローンチ専用で、最高速 332 km/h は 8 速 ≈ 11,900 rpm、ヘアピン（約 70 km/h）は 2 速 ≈ 8,200 rpm、130R は 8 速になります。
- ギャップ／インターバルは 20 m ごとのチェックポイント通過時刻から算出しています。
- 53 周のレース終了後はリザルトパネルが表示され、リスタートできます。

ドライバー名・番号・チームカラーは `app/data/drivers.ts` で編集できます。
