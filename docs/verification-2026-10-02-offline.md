# 端末単独・オフライン利用（N10）

対象はN10（AT-N10-01〜24）です。設計18.1〜18.15とcontracts/runtime-profile.schema.jsonに合わせ、PC（Windows版・PWA）で端末内に閉じる範囲を実装しました。スマホのネイティブアプリ、サーバー接続型（personal-pc・hosted）とその移行は、この版にありません。

この記録の確認は、自動テスト（合成データ・fake-indexeddb・記録用fetch）と、PC上のChromium(Electron)エミュレーションです。スマホ実機、OSのネットワーク遮断、OSの再起動、実アカウントでの試験ではありません。

## runtime profileと通信の許可

- 設定に`runtimeProfile`（`schema_version`、`kind`、`dataset_id`、`authority`、`network_policy`、`server_url`）を追加しました。検査（`src/runtime-profile.ts`）はschemaのif/thenをそのまま写し、`standalone`ならauthority=local・server_url=null、接続型ならauthority=server・https URLを必須にします。この版が保存するのは、現在のdatasetに結び付いた`standalone`だけです。接続型は「この版では未提供」として拒否します。Dexieの版は上げていません（設定行の項目追加だけ）。
- 新しいdatasetは、アカウント・APIキー・サーバーURLなしで作られます。今日の画面の初回カードで「この端末だけで始める」（`offline_only`）を主な選択肢にし、「この端末だけで始め、必要な時だけ通信を許可」（`explicit_online`）を並べます。「自分のPCサーバーへ接続」「クラウドへ接続」は隠さず「未提供」のボタンとして表示します。選ぶまでは`offline_only`として扱い、入力は止めません。
- 既にAIの有効化（`aiEnabled`）、保存済みのAIキー、GitHub実績の登録があるdatasetは、起動時に`explicit_online`へ移行し、`runtime.migrate`監査を残します。設定済みのAIを黙って止めません。判定はメインプロセスの`policyFromSettings`と`effectiveNetworkPolicy`と同じ規則です。AIを止めてモデルIDだけが残るdatasetは移行せず、今日の画面で初回の選択を出します。
- GitHubの判定は、メインプロセスが暗号化済みファイル（`connection.bin`）の有無だけを見ます。キーやトークンは復号しません。このファイルは本人が実際に登録したときだけ作られます。登録したことのない状態でAIのオン/オフ・モデル保存・停止・復元から呼ばれる接続の無効化は、ファイルを作りません（`revoked.bin`だけを書きます）。一度登録して後で停止した接続は、従来どおり登録ありと数えます。
- 移行も選択も、送信は行いません。通信が戻っても下書きや資料を自動送信しません。
- 壊れたprofile（別dataset、接続型、未知の値、項目の過不足）は通信を許可しません（fail closed）。
- `runtimeProfile`と繰り返しの展開位置（下記）はバックアップの検査に追加しました。別datasetや接続型のprofileを含むバックアップは拒否します。
- 復元は、この端末で本人が選んだ通信の許可を広げず、消しません。端末にprofileがあるときは、端末とバックアップのうち厳しい方（どちらかが`offline_only`なら`offline_only`）を、復元したdatasetに結び直して保存します。profileのない旧バックアップでも端末の選択を引き継ぐため、旧規則への後戻りや起動時の`runtime.migrate`で通信が開くことはありません。バックアップと違う方針になったときは`runtime.network_policy`監査（`reason: restore`）を残します。まだ選んでいない端末は、従来どおりバックアップのprofileを使います。

## NetworkGateway（メインプロセスの一つの通信経路）

- `electron/network-gateway.cjs`を追加しました。用途は`openrouter`（openrouter.aiのみ）、`github`（api.github.comのみ）、`webhook`（登録先なし）です。https・既定ポート・資格情報なしのURLだけを許可し、`redirect:'error'`を強制します。
- `offline_only`では、URLの解釈・DNS・下位のfetchより前に`NETWORK_POLICY_OFFLINE`で止めます。方針は要求ごとにアプリのDB（`readAppDatabase('settings')`）から読み直し、読めない場合は`offline_only`として扱います。
- OpenRouterの全呼出し（会話・要約・入力補助・点数補助・変更案・周期補助・検出/検証）は`openRouterCompletion`経由でこの経路を通ります。`offline_only`ではキーの読み込みと利用上限の予約より前に止め、「AIはオフラインのため利用できません（オフライン専用の設定）」を返します。GitHub実績の`fetchImpl`もこの経路の`github`用途に置き換えました。OpenRouter/DeepSeekのキー保存・モデル設定・利用上限の仕組みは変えていません。
- 新しいIPC`michi:network-status`（preloadの`michiNetwork.status()`）は、方針・その出所・用途別の回数（送信・設定で遮断・送信先で遮断・失敗）と移行判定だけを返します。URLや秘密は含めません。
- Chromiumのスペルチェック（辞書の取得経路）を無効にしました。
- 回数の表示には、OSや他のアプリの通信は対象外と書いています。本アプリの経路の制御であり、OSのネットワーク遮断ではありません。

## S17「接続とバックグラウンド」との統合

- N09/H01で入った「接続とバックグラウンド」（`src/FeatureConnectionsView.tsx`）に、OpenRouter AIとGitHub実績の行の「外部通信」を追加しました。`offline_only`では「オフライン専用のため送信前に遮断」、`explicit_online`では「本人の操作時だけ許可」と、今回の起動後の送信・設定で遮断の回数を出します。用途別の回数の一覧もこの欄の見出しの下に移しました。能力表の側は「接続ごとの状態・送信回数・個別停止は『接続とバックグラウンド』に表示します」と案内し、同じ表示を二か所に持ちません。
- `offline_only`では、GitHub実績の行の「GitHubに接続して状態を確認」ボタンを出さず、「状態確認は通信が必要です（オフライン専用のため確認しません）」と表示します。接続ごとの個別停止・AI処理停止の動作は変えていません。
- 「証拠付きGitHub実績」の画面を開いたときは、端末に保存した接続だけを読み（`storedStatus`、GitHubへの要求なし）、「保存済みの接続があります。『接続状態をGitHubで確認』を押したときだけGitHubに接続します」と表示します。GitHubへの状態確認は、そのボタンの本人のクリックからだけ行います。公開・照合・トークンの扱いは変えていません。`offline_only`で状態確認を押した場合は、リポジトリの権限ではなく「オフライン専用の設定のためGitHubの状態は確認していません」と表示します。
- コーチ画面の停止・取り消しの依頼（N09の縮小専用コマンド）は、AIがオフラインでも端末内で処理します。オフラインで下書きだけを保存する分岐は、そのコマンド処理の後に置きました。

## 能力表とAIのオフライン表示

- 「設定とデータ」に「端末単独で使える機能」（通信の許可の選択と能力表）を追加しました。設計18.3の16行を、`○`／`条件付き`／`通信が必要`／`このPCでは未提供`（ブラウザ版は`この環境では未提供`）で表示します。判定はprofile、Electronかどうか、キーの有無、`navigator.onLine`から計算します（`src/capabilities.ts`）。
- 通知の行は、Windowsでは「アプリ起動中のみ判定（OS予約通知は未実装のため、終了中は通知しない）」、通知を拒否してもToDoは使えること、確実な送達とは表示しないことを示します。
- 外部AIだけを設定した状態で`offline_only`またはネットワーク未接続のとき、コーチ画面に「AIはオフラインのため利用できません」を表示します。送信ボタンは「下書きを保存」になり、会話の応答待ち・`live_ai`・定型文・応答状況の行を作りません。以前は`navigator.onLine`がfalseのとき定型文へ切り替えていましたが、外部AIを設定している場合はやめました。キー未設定・AI OFFでは従来どおり`template`の定型文です。
- `offline_only`では、Live2Dの条件ページとGitHub実績の確認リンクを、リンクではなく「通信が必要」の文字として表示します。

## 保存保護と容量不足

- 「ローカルデータ」に、`persisted()`の状態、使用量/上限、最後の書き出し、未バックアップ変更数（最後の暗号化書き出し以降に変わった行の数。監査・コマンド記録に加え、習慣・習慣記録・目標・チェックイン・日のメモ・記録・時間枠・予定・メモ・コメント・添付など、時刻を持つ本人データの表の行。書き出したことがなければ全行）を表示します。サイトデータの消去・アンインストール・故障・紛失でデータを失うこと、同じPC内のバックアップは故障対策にならないことを常に表示します。
- 「保存保護を要求」が拒否されても入力は止めません。「保存保護は許可されませんでした」と表示し、「バックアップを書き出す」を主ボタンにします（暗号化バックアップの欄へ移動）。
- IndexedDBの`QuotaExceededError`（Dexieが包んだ形と、内側に容量エラーを持つ`AbortError`を含む）を「保存容量が不足しています。既存データは変更していません」と表示します。容量と無関係な`AbortError`は「書き込みが中断されました」と分けます。タスク編集は失敗時にフォームを保持し（`saveKeepingDraft`）、添付の入力欄も選択を保持します。
- 添付はIndexedDBの行内のBlobで、DB外の一時ファイルを作りません。そのため「孤立添付の回収」の対象になるファイルは発生しません。設計18.5の`staged → ready`の二段階はこの版にありません。

## 長期未起動後の繰り返し

- 系列ごとの展開済み位置（`routineCatchup.checkpoints`、最後に展開した日付）を設定に保存します。起動時と、画面への復帰時（10分に1回まで）に`catchUpRoutines`を実行します。
- 展開済み位置の翌日から通常の窓（今日の30日前〜89日後）の手前までを、`expandRoutines`と同じgeneration key（`routineId:日付`）で作ります（keep_all）。既存のキーの回は作り直さず、完了済みの回・ポイント・台帳は変えません。窓の中も同じキーで作り、完了後周期は従来の`expandRoutines`です。
- 1系列1回の実行で最大1,000回、1回の実行で全系列合計5,000回です（設計5.4・11.6）。超える場合は新しい回を優先して作り、古い過去の回を「未展開」として数えます。展開位置はその回を越えて進むため、後の実行で黙って作ったり二重に数えたりしません。窓（30日前〜89日後）だけで5,000回を超えるときは、窓の遠い先の回を次の実行へ回し（`routine.catchup.deferred`監査）、その系列の展開位置を回した回の手前に置きます。次の実行までに窓から外れた回は、そこで「未展開」として一度だけ数えます。
- 展開位置のない既存系列は従来の窓だけを展開し、過去を大量に作りません。前回の展開の後に保存した系列（作成日時が前回の実行より後）は、保存した日の窓から続きを作ります。保存した日に終了して長く起動しなかった場合も、間の日付を飛ばしません。
- N09の「ルーティン・繰り返し生成を停止」中は、長期未起動の後でも回を作らず、展開位置・前回の実行日時・報告を書き換えません。再開後の最初の実行で、停止中の分を同じgeneration keyで一度だけ作ります。
- 未確認の報告は、後の実行で作成があっても置き換えず、作成数・未展開数・切り詰めた系列を積み上げます。日数は最初の前回起動から数えます。
- 端末の時計が前回の実行より過去に戻った場合は、前回の実行日時を今の時刻にし、先の日付にある展開位置を使わず、窓より前の最後の回（なければ系列の開始日）から続けます。時計が先に進んでいた間に作った先の日付の回は削除せず、「端末の時計が前回記録(…)より過去です」と先の回の数を`routine.catchup.clock`監査に残します。
- 「前回起動から N 日：作成 X 回／未展開 Y 回」のカードを今日の画面に出し、「確認した」で閉じます。過去の回は行を作るだけで、通知予約・通知は作りません。
- 勤務表などの`weekdays=[]`の系列は回を作らず、通常の週次系列の設定は変えません。

## 自動テストで確認したこと

すべて合成データです。OpenRouter・GitHub・OS通知・実機には接続していません。

- `electron/network-gateway.node-tests.mjs`（7件）：`offline_only`で3用途とも下位fetch 0回・`NETWORK_POLICY_OFFLINE`、方針が読めない/不正なら止めること、用途別の送信先・https・ポート・資格情報の検査と`redirect:'error'`の強制、送信・遮断・失敗の回数、要求ごとの方針の読み直し、GitHubのリポジトリ確認が`offline_only`で通信しないこと、`policyFromSettings`がschemaと同じ規則で既存AI利用者を`explicit_online`、壊れたprofileを`offline_only`にすること。回数の表示にURLや秘密が入らないこと。
- `electron/github-publish-service.node-tests.mjs`（このバッチで3件追加）：登録したことのない保存場所で接続の無効化を2回しても`connection.bin`ができず（メインプロセスの判定と同じファイルの有無）、通信0回。サービスの登録の後の無効化は`configuration:null`でrevisionが進むこと。`storedStatus`はGitHubへ要求せずトークンを返さないこと。`offline_only`のNetworkGatewayでは状態確認がオフラインの案内になり、リポジトリ権限の文言を出さず、下位fetch 0回。`explicit_online`では`storedStatus`で0回、状態確認で初めて要求すること。記録用のfetchだけで、GitHubには接続していません。
- `src/achievements-status.test.ts`（2件）：実績画面を開いたときの読み込みが保存済みの接続だけを呼び、状態確認を呼ばないこと。合成のクリックやfocusでは状態確認を呼ばず、本人のクリックでだけ呼ぶこと。
- `src/runtime-profile.test.ts`（12件）：standaloneのauthority/server_urlの制約、接続型のhttps必須とこの版での拒否、新規datasetにキー・URL・アカウントの項目がないこと、選択の保存と監査、AI設定済み・GitHubだけ設定済みの移行と未設定時の非移行、AIを止めてモデルIDだけが残るdatasetを移行しないこと、壊れたprofileのfail closed、設定のバックアップ往復と別dataset・接続型profileの拒否。復元では、`explicit_online`のバックアップを`offline_only`の端末へ戻しても`offline_only`（`policyFromSettings`も同じ、復元監査あり）、`offline_only`のバックアップは`explicit_online`の端末でも`offline_only`、profileのない旧バックアップ（AI有効）を`offline_only`の端末へ戻しても`migrateRuntimeProfile(true)`が移行しないこと、未選択の端末は未選択のままであること。
- `src/CapabilityView.test.tsx`（11件）：通常ToDo・ポイント・繰り返し・バックアップが全環境で○、AIの`offline_only`／ネットなし／未設定／ブラウザ版の出し分け、GitHub投稿の表示、通知が「アプリ起動中のみ」で拒否してもToDoを使えること、表示ラベル、回数表示にURLが出ないこと、初回カードの並びと未提供表示、`offline_only`の外部リンクが文字になること。S17の接続行で、`offline_only`ならAI・GitHubに送信前の遮断と回数を表示し、GitHubの状態確認ボタンを出さず、URLを出さないこと（`explicit_online`ではボタンを出すこと）。AT-N10-11として、オフラインの送信で下書きを保存し、会話の行（`live_ai`を含む）を一件も作らず、応答待ちにならないこと。
- `src/storage-status.test.tsx`（6件）：`tasks.add`へ`QuotaExceededError`を注入すると既存のタスク・完了・台帳を変えず、日本語の表示を返し、下書きを同じ値で保持すること。同じトランザクションの後半（監査）で失敗してもタスク・評価を残さないこと。`taskAttachments.add`の失敗で添付行を作らず、完了・台帳（40pt）を保つこと。Dexieの包んだ形・`AbortError`の判別。未バックアップ変更数が書き出しで0になり、その後の作成・完了と、監査を書かない習慣・習慣記録・目標の行を数えること。保存保護の拒否表示とバックアップ導線、許可時の表示。fake-indexeddbには容量がないため、容量不足は書込み口への注入です。
- `src/routine-catchup.test.ts`（13件）：繰り返し起動しても重複しないこと、200日ぶりに起動して作成200回・未展開0回と表示すること、1500日ぶりで1,000回の上限と未展開数、既存のgeneration keyと完了済みの回・台帳を変えないこと、展開位置のない既存系列を過去へ広げないこと、通常の週次系列と`weekdays=[]`の系列、過去の回で通知を作らないこと。N09の停止（`reduceAuthority('routines')`）中は200日後でも作成0・展開位置と報告が不変で、本人のクリックで再開した後に300件・重複なし。前回の展開の後に保存した系列が200日後に290件を隙間なく持つこと。未確認の未展開500回が翌日の実行後も残ること（作成1001回）。時計を+3000日へ進めてから+1日へ戻し、+200日で前回の実行日時が未来でなく、+91〜+169日の回が重複なく作られ、報告と時計の監査が残ること。8系列・1500日ぶりで作成5,000回、作成＋未展開＝12,000回、全系列を切り詰めとして表示し再実行で重複しないこと。43系列で窓だけが5,000回を超える場合に先の回を次へ回し、窓から外れた回を一度だけ未展開に数えること。すべて`vi.setSystemTime`の合成の時計とfake-indexeddbで、実機で端末を放置した試験ではありません。
- `src/offline-time.test.ts`（4件）：`vi.setSystemTime`で+30日・+400日に進めても、設定が変わらず（ロック・認証・期限の項目なし）、作成・編集・完了と0pt/25ptの台帳が通ること。+400日後のsmart-dailyは一度だけ、期限切れの予約がまとめて来ても日次上限以内であること。時計を進めた合成試験で、端末を400日放置した試験ではありません。
- `src/offline-restore-refire.test.ts`（2件）：完了済みのタスク、公開状態が`queued`または`committing`の実績、OS宛ての通知予約を含むバックアップ（通信の許可を選ぶ前に取ったもの）を、`offline_only`を選んだ新しい端末へ復元。復元後のdatasetが`offline_only`であることを確かめ、NetworkGatewayの方針は復元後の設定から`policyFromSettings`で読みます。繰り返しの展開・実績の照合・通知の判定を実行しても、GitHubの公開/照合の呼出し0回、NetworkGatewayのGitHub送信0回、`fetch`0回、OS通知の送出0件。実績は`awaiting_review`／`unknown`になり承認日時を消します。完了・台帳は変わらず、同じバックアップの再取込でも二重の完了・加点がないこと。

origin/main（N09/H01を含む）へ載せ替えた後、Vitest 120ファイル1,213件（このバッチの追加50件）、Electron/Node 145件（追加10件）が通過しました（レビュー指摘の修正後の再実行）。`npx tsc -b`、`npm run lint`（oxlint、警告0件）、Electron CJS 22ファイルの構文確認、Vite・PWAビルドも成功しています。

## Chromium(Electron)エミュレーション・PC

`npm run build`の後に`npm run check:pwa-offline`（`scripts/pwa-offline-check.mjs`）を実行しました（載せ替え後のビルドで再実行し、同じ結果）。distをNodeの`http`で127.0.0.1の空きポートから配信し、ElectronのChromium（Electron 44.4.5、Chromium 152）で新しい保存領域（使い捨てのuserDataと新しいpartition）を開きます。結果のJSONと画面写しは`qa-output/pwa-offline/<時刻>/`（Git対象外）に出力します。報告には`Chromium(Electron)エミュレーション・PC`と記録します。10段階すべて通過しました。

1. 初回取得後、Service Workerがページを制御し、precache 7件をCache Storageに保存。
2. 初回カードの「この端末だけで始める」で、`standalone`・`offline_only`・`server_url=null`のprofileを保存。アカウント・キー・URLの入力なし。
3. オンライン中にタスクを作成。
4. 配信サーバーを停止し、`session.enableNetworkEmulation({offline:true})`。
5. 実際の再読込（クエリ付きのURLで同一文書の移動を避ける）で、SWのキャッシュからshellを表示し、保存済みタスクを表示、新しいタスクの作成と完了ができた。停止後のサーバーへの要求は0件。Electronのネットワークエミュレーションは`navigator.onLine`をfalseにしないため、その値はtrueのままでした。
6. `navigator.storage.persist/persisted`をfalseに置き換えて「保存保護を要求」を押すと「保存保護は許可されませんでした」と表示し、「バックアップを書き出す」は有効、「入力はこれまでどおり続けられます」を表示。
7. 容量不足：CDPの`Storage.overrideQuotaForOrigin`で上限を1バイトにすると`estimate()`の上限は1になりましたが、このChromiumのIndexedDBは書込みを拒否せず、添付が保存されました（観測として記録）。そのため、同じ`DOMException('QuotaExceededError')`をページ内の`IDBObjectStore.add/put`（添付の表だけ）で発生させ、実際の画面経路で確認しました。「保存容量が不足しています。既存データは変更していません」を表示し、添付・タスク・完了・台帳は変わらず、編集画面は開いたまま。実ディスクやブラウザの実容量の枯渇ではありません。
8. 同じpartitionの二画面で同じタスク（同じrevision）を開き、画面Aのメモを保存した後、画面Bの保存は「別の画面で更新されました」で拒否。保存値は画面Aのrevision 2とメモのままで、画面Bの入力は残りました。
9. 390×844のデバイスエミュレーションで今日・ローカルデータ・能力表の画面写しを撮影し、横スクロールなし（表示幅390、文書幅375）。レイアウト確認のみで、スマホ実機の受入ではありません。
10. 全工程で127.0.0.1以外への通信要求は0件（partitionのwebRequestで記録・遮断）。

また、Windows版のElectron本体（このブランチ、使い捨ての`--user-data-dir`、`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"`）をCDPから操作し、新規dataset（profileなし）で`michiNetwork.status()`が`offline_only`・全回数0、初回カードの表示、`michiAI.chat`が「AIはオフラインのため利用できません（オフライン専用の設定）」で失敗し、`openrouter`の送信0回・設定で遮断1回になることを確認しました（origin/mainへの載せ替え後のビルドで再実行し、同じ結果）。キーは未登録（`configured:false`）で、GitHub実績の状態確認は未設定のため通信しませんでした。これはアプリの経路の確認で、OSのネットワーク遮断ではありません。

## AT-N10-01〜24の対応

| ID | 状態 | 根拠 |
|---|---|---|
| 01 | PC：自動テスト・Electron/Chromium・Windows画面で確認 | 新規datasetにアカウント・キー・URLなし（`runtime-profile.test.ts`）、ハーネス2、Windows画面（新しいプロファイルの初回カード）。スマホは未実施 |
| 02 | PC：既存の証拠＋ハーネス5＋Windows画面（アプリの再起動後の保持） | 単一トランザクションと再送抑止（`src/commands.test.ts`の「再送しても一回だけ作成・加点する」）。スマホは未実施 |
| 03 | 既存の証拠 | `src/domain.test.ts`「未設定と手動0ptを分ける」、`src/commands.test.ts`の25pt。`offline-time.test.ts`で0pt/25ptの台帳 |
| 04 | 既存の証拠 | `src/domain.test.ts`の計算例・外出最低点、`src/trip-bundles.test.ts`、`src/allocation-completion.test.ts`。AI不要 |
| 05 | 既存の証拠 | `src/commands.test.ts`、40→35→取消→再完了の正味35pt（[本人再確認の検証記録](verification-2026-10-01-completion-reconfirmation.md)） |
| 06 | 確認（Chromiumエミュレーション） | ハーネス8、`src/commands.test.ts`「旧revisionの編集を拒否する」 |
| 07 | 既存の証拠 | `src/coach-notification-save.test.ts`・`src/calendar-rules-save.test.ts`の終盤失敗rollback、`storage-status.test.tsx`の監査での失敗 |
| 08 | 確認（注入による） | `storage-status.test.tsx`、ハーネス7。孤立ファイルは構造上発生しない（上記）。実容量の枯渇は未実施 |
| 09 | 確認（合成の時計） | `routine-catchup.test.ts`（時計を進めた後に戻す場合、N09の停止、1回5,000回の上限を含む）、`offline-restore-refire.test.ts`。実機で端末を放置した試験ではありません |
| 10 | 既存の証拠 | `src/calendar-resolver.test.ts`ほかM06・CSV取込の試験（[CSV取込の検証記録](verification-2026-10-01-calendar-csv-import.md)） |
| 11 | 確認（unit・Electron本体のCDP・Windows画面） | `CapabilityView.test.tsx`、Electron本体で`michiAI.chat`の遮断、Windows画面のコーチの表示・下書き保存（キー設定済みの状態はQAの仮応答で再現） |
| 12 | 対象外（Windows）・表示のみ確認 | WindowsのOS予約通知は未実装のため、OS予約の取消・照合は該当なし。制約の表示を`CapabilityView.test.tsx`で確認。スマホは未実施 |
| 13 | 表示のみ確認 | 通知拒否でもToDoを使える表示（`CapabilityView.test.tsx`）。exact alarm・省電力はスマホの項目で未実施 |
| 14 | 一部（アプリの再起動のみ） | 端末（OS）の再起動はしていません。アプリの再起動後の保持はWindows画面で確認 |
| 15 | 確認（Chromiumエミュレーション・PC） | ハーネス1〜6・9。スマホのブラウザは未実施 |
| 16 | 確認（アプリの経路・プロセスの接続の観測） | `network-gateway.node-tests.mjs`、ハーネス10、Electron本体のCDP確認、Windows画面の`Get-NetTCPConnection`（loopback以外0件）。OSのネットワーク遮断ではありません |
| 17 | 既存の証拠 | I04の別Windowsプロファイルへの復元（[要件別の進捗](requirements-status.md)のI04行、[検証記録](verification-2026-10-01.md)）、`offline-restore-refire.test.ts` |
| 18 | 既存の証拠＋確認 | `src/backup.test.ts`の改ざん拒否、`offline-restore-refire.test.ts`の同じバックアップの再取込 |
| 19 | 未実施 | 接続型（personal-pc・hosted）が未提供のため |
| 20 | 未実施（関連の確認のみ） | 接続型への移行が未提供。復元では過去の完了からGitHub・通知を再発火しないことを`offline-restore-refire.test.ts`で確認 |
| 21 | 未実施 | 接続型が未提供のため、サーバーのキャッシュからの救出はありません |
| 22 | 未実施 | 接続型のログインがないため |
| 23 | 既存の証拠 | `electron/local-file-bridge.node-tests.mjs`・`electron/file-bridge-service.node-tests.mjs`の偽承認・余分な項目・期限の拒否（[取込とMCPの検証記録](verification-2026-10-01-imports-mcp.md)） |
| 24 | 確認（合成の時計） | `offline-time.test.ts`（+30日・+400日） |

## Windows画面

2026-10-02に、Windows 11のポータブル版`C:\toodoapp\app\release\michi-portable-20261001-095727\michi.exe`で確認しました。`resources\app\dist`と`resources\app\electron`を、このブランチ（N05への載せ替えとN05との組み合わせの修正の後、コミット`9f0a09c`）の`npm run build`の出力と`electron\`で置き換え、コピー後のSHA-256が全ファイル（dist 9件・electron 37件）で一致することを確かめました（画面のbundleは`index-BeknS04r.js`）。electron側に、作業ツリーにない古いファイルはありませんでした。

操作はQA用スクリプト`work\test-offline-ui.mjs`（CDP、`work\qa-cdp.mjs`を使用）です。本人の操作に当たるボタン・ラジオ・チェックはすべてCDPのマウス入力（ネイティブのクリック）で押しました。試験中はメインプロセスに次の見張りを入れ、終了時に元へ戻しました。

- メインプロセスの`fetch`を遮断して回数を数える。OpenRouterのキーファイル（`openrouter-key.bin`）の読み込みを遮断して回数を数える。
- 送信に当たる`michi:ai-*`（`ai-usage`系を除く）と、GitHub実績の`michi:githubpublish-*`（端末内だけを読む`storedStatus`を除く）のIPCを遮断して回数を数える。
- `michi:ai-status`はQAの仮応答に置き換えました（新しいプロファイルでは`configured:true`、既存のQAプロファイルでは`configured:false`）。キーファイルは作らず、読んでいません。
- 画面側はCDPの`Network`イベントで、`michi:`・`data:`・`blob:`以外の要求を数える。
- あわせて`michiNetwork.status()`でNetworkGatewayの回数（起動後の送信・設定で遮断・送信先で遮断・失敗）を読む。

結果の記録（JSONと画面写し）は作業フォルダーの`work\offline-1790872299575-*`（既存QAプロファイル）と`work\offline-1790872439170-*`（新しいプロファイル）です。

### 新しいプロファイル（初回起動・オフライン）

試験用の新しい`--user-data-dir`（`work\qa-offline-fresh-1790872439170`）、`--remote-debugging-port=29920 --inspect=29922`、`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"`で起動しました。この引数はアプリ内（Chromium）の名前解決を止めるもので、システムの設定は変えていません。試験の後にこのインスタンスは停止しました（プロファイルのフォルダーは残しています）。

- 起動直後の設定に`runtimeProfile`はなく、`aiEnabled=false`・モデルなし・タスク0件・設定にURLなし。キーファイルなし。`michiNetwork.status()`は`offline_only`・移行判定false。
- 今日の画面の初回カード「この端末での使い方」：「この端末だけで始める」（主ボタン）、「この端末だけで始め、必要な時だけ通信を許可」、無効の「自分のPCサーバーへ接続（未提供）」「クラウドへ接続（未提供）」の4つで、「アカウント・APIキー・サーバーURLなしで」と表示。「この端末だけで始める」を押すと、`standalone`・`authority=local`・`network_policy=offline_only`・`server_url=null`・現在の`dataset_id`のprofileと`runtime.network_policy`監査（`previous:null`）が保存され、カードは消えました。
- タスク：今日の予定日・手動25ptで作成（revision 1）、編集画面で名前とメモを変更（revision 2）、一覧の完了ボタンで完了（revision 3）。台帳は`award +25`の1行、完了記録あり。
- コーチ：試験用DBに`aiEnabled=true`・モデル`qa/offline-stub-model`を直接書き、上記の仮応答でキー設定済みの状態にしました（AIを設定して`offline_only`の状態の再現です）。見出しは「AIはオフライン」、会話欄に「AIはオフラインのため利用できません（オフライン専用の設定です）。…」を表示し、送信ボタンは「下書きを保存」でした。
  - 「通知を止めて」を送ると、AIを使わずに通知の停止（`stops.notifications=true`）を実行し、本人の文章と「端末内の定型文」の応答の2行を作りました。
  - 続けて「オフラインの相談 …」で「下書きを保存」を押すと、「AIはオフラインのため利用できません。入力は下書きとして保存しました。通信が戻っても自動では送信しません。」を表示し、下書きを保存して入力欄にも残し、会話の行は2行のまま増えませんでした（応答・応答状況の行なし）。
  - コーチ画面のLive2Dの条件ページは、`offline_only`では「Live2DのSDK利用・公開条件を確認（通信が必要・オフライン専用のため開きません）」という文字で、リンクではありませんでした。
- 設定とデータ：
  - 「端末単独で使える機能」は16行で、「通信の許可」は`offline_only`が選択済み。タスク・ポイント・ビュー・繰り返し・計測・ファイル・履歴・バックアップは○、新しいLLM会話とGitHubへの投稿は「通信が必要」（投稿は「オフライン専用の設定のため送信しません…」）、通知・音声・ファイルブリッジは「条件付き」、新着取得・LINE等・同期は「このPCでは未提供」。サーバー接続は未提供と表示。
  - 「接続とバックグラウンド」は、OpenRouter AIとGitHub実績の「外部通信」がともに「オフライン専用のため送信前に遮断（今回の起動後 送信0回・設定で遮断0回）」で、用途別の一覧も3用途とも送信0回。GitHub実績の行に「GitHubに接続して状態を確認」ボタンはなく、「状態確認は通信が必要です（オフライン専用のため確認しません）」を表示。
  - 「ローカルデータ」は、保存保護「保存保護あり」（`persisted()`がtrue）、使用量「0 MB / 104702 MB」、最後の書き出し「まだありません」、未バックアップ変更数「16件」、データセットの先頭8文字。
  - 「通信の許可」で「必要な時だけ通信を許可」を押すと`explicit_online`が保存され、GitHub実績の行に状態確認ボタンが戻り、外部通信の表示は「本人の操作時だけ許可…」、能力表のGitHub投稿は「本人の確認ボタンから送るときだけ通信します…」に変わりました。コーチ画面のLive2Dの条件ページはリンクになりました。どのボタンも押していません。「オフライン専用」に戻すと、状態確認ボタンは再び消えました。
- アプリの再起動：このインスタンスを停止して同じプロファイルで起動し直し、`offline_only`のまま、タスク（行全体が一致）・台帳・完了記録・コーチの下書き（入力欄にも表示）・会話の行数が同じで、初回カードは出ず、一覧の「完了」に同じタスクがあり、外部通信の表示は今回の起動後の回数（送信0回）でした。1回目の再起動では、確認の途中で画面写しの指定（QAスクリプトのセレクター）を誤って止まったため、もう一度起動し直して全項目を確認しました。
- 新しいプロファイルでの確認は、最初のプロファイル（`work\qa-offline-fresh-1790872299575`）で、QAスクリプトが試験用DBへの直接の書き込みの後に再読込をしていなかったためコーチの確認で止まりました。スクリプトを直し、別の新しいプロファイルで最初からやり直しました（最初のプロファイルのインスタンスも停止済み）。

### 既存のQAプロファイル（移行・既存データ）

`work\qa-reminders-profile`（ポート29910/29912）です。差し替え前の版で起動中だったインスタンスから、読み取りだけで状態を記録してから停止し、新しい版で起動し直しました。このプロファイルにはOpenRouterのキーファイルはなく、GitHub実績の登録（`connection.bin`）があります。`aiEnabled`はfalseでした。

- 移行：差し替え前は`runtimeProfile`なし。新しい版の起動時に、GitHubの登録があるため`explicit_online`（`standalone`・`authority=local`・`server_url=null`・同じ`dataset_id`）へ移行し、`runtime.migrate`監査（`previous:null`）が1件残りました。初回カードは出ません。`aiEnabled`・モデルID・`profileId`・`datasetId`は変わりませんでした。
- 既存データ：タスク174件・完了52件・台帳107行（合計600pt）・評価204件・旧ルーティン7件・コーチの会話の行10件・予定18件を、行ごとに差し替え前と比べて、変更・欠落0件、追加0件。共通ルーティンの状態（`calendarRules`）も一致し、generation keyの重複はありませんでした。繰り返しの展開は今回0回作成で、今日の画面に報告カードは出ませんでした。
- 「接続とバックグラウンド」は、OpenRouter AIとGitHub実績とも「本人の操作時だけ許可（今回の起動後 送信0回・設定で遮断0回）」で、状態確認ボタンあり（押していません）。「通信の許可」は「必要な時だけ通信を許可」が選択済み。「ローカルデータ」は保存保護あり、使用量「6 MB / 104744 MB」、最後の書き出し「まだありません」、未バックアップ変更数「1600件」（書き出したことがないため全行）。コーチ画面はキーがないためオフラインの表示を出さず、Live2Dの条件ページはリンクでした。
- 「オフライン専用」へ切り替えると、GitHub実績の状態確認ボタンが消え、外部通信は「オフライン専用のため送信前に遮断…」、Live2Dの条件ページは文字になりました。その後「必要な時だけ通信を許可」へ戻し、移行後と同じ`explicit_online`に戻しました。この往復で`runtime.network_policy`監査が2件（`explicit_online→offline_only`、`offline_only→explicit_online`）残っています。

### 通信・キー・AIの見張り

- 新しいプロファイル（初回・再起動後）と既存QAプロファイルのいずれも、メインプロセスの`fetch`0回、キーファイルの読み込み0回、送信に当たるAIのIPC 0回、GitHub実績のIPC（`storedStatus`以外）0回、画面側の外部要求0件でした。NetworkGatewayの回数も、起動時（見張りを入れる前の分を含む）と終了時のどちらも全用途で送信0回・失敗0回でした。
- 新しいプロファイルの各回の終了時と既存QAプロファイルで、そのインスタンスの全`michi.exe`のPIDについて`Get-NetTCPConnection`を読みました。あったのはCDPとインスペクターの待受（127.0.0.1）だけで、loopback以外の接続先は0件でした。これはその時点のプロセスの接続の観測で、OSのネットワーク遮断ではありません。

### 390px幅のエミュレーション

CDPの`Emulation.setDeviceMetricsOverride`（390×844）で、初回カード、「端末単独で使える機能」、「接続とバックグラウンド」、「ローカルデータ」、コーチのオフライン表示（新しいプロファイル）と、既存QAプロファイルの前の3つを表示し、各要素と文字がカードの幅を超えず、文書の幅が390以下であることを確かめました。Windows版の画面幅を変えたエミュレーションで、Android・iPhoneの実機の試験ではありません。PWAのハーネス（上記）もChromium(Electron)のエミュレーションです。

### Windows画面で確認していないこと

- ポモドーロの時刻と通知ルールの、アプリ再起動後の保持。
- 古い展開位置を入れたプロファイルでの「前回起動から N 日」のカードの表示（合成の時計の自動テストだけです）。
- コーチの「接続テスト」ボタン、`explicit_online`でのGitHubの状態確認（実際の通信になるため押していません）。
- OSのネットワーク遮断、OSの再起動。

試験の後、既存QAプロファイルの設定は試験前と同じ（`explicit_online`、`aiEnabled=false`、モデルIDは同じ）で、このインスタンスは起動したままです。新しいプロファイルのインスタンスは停止しました。

## 残る範囲

- スマホ（Android/iOS）のネイティブアプリはありません。AT-01/02/12/13/14のスマホ部分、OS予約通知、exact alarm、省電力は未実施です。
- OSのネットワーク遮断（機内モード・ケーブルを抜く等）と、OSの再起動は試験していません。この記録の遮断は、アプリのNetworkGatewayとChromiumのエミュレーションです。
- サーバー接続型（personal-pc・hosted）と、その移行・救出・ログアウト（AT-19〜22）は未提供です。移行の業務キー、baseline、`migration_sessions`はありません。
- ブラウザの実容量の枯渇は再現していません。CDPの上限上書きはこのChromiumのIndexedDBで強制されなかったため、容量不足は書込み口への注入で確認しました。添付の`staged → ready`と孤立ファイルの回収はありません。
- Webhook（I03）は経路の用途だけを用意し、送信先の登録はありません。
- 未バックアップ変更数は変わった行の数で、編集の回数ではありません（一つの操作で監査とタスクの行の両方が増えます）。設定（`settings`）の変更と、時刻を持たない行（チェックリスト・ラベル・依存関係など）の書き出し後の変更は数えません。
- N10は「一部実装」のままにしています。
