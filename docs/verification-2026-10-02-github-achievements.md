# バッチI：GitHub実績の検証

M07の端末内で実装・確認できる残りを接続し、M08の「ポイントをcommit数へ分割しない」「API成功だけで標準contribution graphへの反映を断言しない」を確認しました。実アカウントへの実績投稿・作者帰属・草への実反映は試験していません。

## 実装と境界

- 合成GitHubは127.0.0.1のランダムポートだけで待受し、専用の一時bare repositoryに実際のblob/tree/commit/refを作ります。既定の無関係ファイルを残し、1実績を1件の到達可能なcommitにします。応答消失、空repository、保護、外部変更、メール権限を試験できます。実GitHubには接続しません。
- QA overrideは開発版・Documents/Codex配下のwork/qa-reminders-profile・IPリテラル127.0.0.1のHTTPに限定します。合成tokenだけを受け付け、実tokenと別hostを下位fetch前に拒否します。配布版では無効です。N10の通信ゲートウェイを保ち、offline_onlyでは合成サーバーにも送信しません。画面に合成GitHubの表示を出します。
- 空repositoryには本人が内容・SHA256・送信先を確認したREADMEだけを作ります。実績や証拠を含めません。暗号化した初期化記録をPUT前に保存し、応答不明なら再送せず、READMEと実際のroot commitを読み取って照合します。非空repositoryへの初期化は拒否します。
- 保護された既定branchは直接更新せず、michi-achievements/publicIdの専用branchに1件のcommitを作り、本人が承認した公開文のPRを作成します。Pull requests書込権限が必要です。各変更前に記録と本人・データセット・公開設定を再確認します。途中で保護が外れてもこの経路を維持し、既存の専用branchは上書きしません。PR応答消失はhead指定の読取照合で復旧します。未マージのPRは公開ポイントに加えず、閉じられた未マージPRも公開済みとしません。squash/rebase等は既定branchへの到達と公開ファイルの内容を照合します。
- 訂正は同じrecordに別の承認と1件のcommitを追加します。前回commit、前回record blob、連番を承認digestへ含めます。記録の連番0は従来の保存キーを維持します。外部で変えられたrecordを上書きせず、応答不明は再送停止・読取照合とします。取消しは正味0ptと訂正理由を残し、過去commitや過去の草を消したとは表示しません。
- 公開を確認したmanifest/commitと公開ポイントは、保留中の訂正案から分離して保持します。別実績の公開集計や次の訂正は最後の確認済み公開を基準にし、未公開の実績は集計に含めません。Electronは端末内の原本bytes・台帳・評価・選択を読み、画面側と同じ全5ファイルを再構築して承認digestを検査します。対象切替で過去実績への同意・訂正理由・原本選択を解除します。
- 集計条件は本人の確認操作で読み取ります。作者の確認済みメール（メール権限がない場合は本人IDとloginのnoreply）、非fork、既定branchへの到達、過去365日の作者日時を調べます。メール権限不足や非公開contributionの表示設定は確認不能にします。条件確認・条件不足・確認不能・未マージを区別し、反映済みの状態は定義しません。履歴のポイント図もGitHub標準の草と別の集計と明記します。
- N09の毎回本人確認、N10の通信許可、I05の凍結を維持します。公開予約・証拠・公開設定のテーブルも凍結の書込ガードに加え、native側でも変更前にactiveを確認します。復元は公開承認を無効にし、集計条件を再確認扱いにします。

GitHubの[Contents API](https://docs.github.com/en/rest/repos/contents)、[Refs API](https://docs.github.com/en/rest/git/refs)、[contribution条件](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)を参照しました。条件を満たすことと、当該commitが標準グラフへ独立に反映されたことは別です。

## 自動試験とレビュー

アプリテスト1792件、Electronテスト204件、Electron CJS 34ファイルの構文確認、TypeScript/build、lint（警告0）が通過しました。PWA offlineのPCエミュレーションは10段階を通過しました。実スマホ試験ではありません。

実Git objectを用いる模擬試験では、100ptの1commit、base_treeの無関係ファイル保持、ref/初期化/PRの応答消失、squash merge、未マージclose、branch衝突、初期化後の保護branch、途中の保護解除、連続訂正と取消し、外部record変更の拒否を確認しました。メール一致/不一致/403/noreply、fork、古い日時、非公開設定不明も読取だけで検査します。画面とnativeの訂正ファイルのbytes一致、本人承認・復元・凍結、改変backupと不正な反映状態の拒否、初期化/QA表示と履歴captionのSSRも確認しました。

仕様、認証・通信、非同期と応答不明、公開集計、復元と凍結、Windows表示の観点で自己レビューしました。保留訂正から公開集計を作らない基準、PR待ちを公開receiptと扱わない保存経路、対象切替時の同意解除、記録予約前の確認失敗の区別を修正しました。空repositoryを初期化した後の存在しないbranchの模擬応答も404へ修正し、回帰例を追加しました。

## Windows画面

開発版Electronを専用のqa-reminders-profile/github-emulatorで起動し、合成サーバーと合成の100pt/40pt実績だけを使用しました。保存・初期化・公開・訂正はCDPのtrusted mouse eventで操作し、実際のnative IPC、safeStorage記録、HTTP、Git objectを通しました。対象データの準備だけを専用QA DBへ投入しました。

27項目を確認しました。合成GitHubの表示、オフライン時の下位fetch前遮断、合成クリック拒否、READMEの内容/hash、応答消失後の初期化照合、READMEだけの初期commit、100ptでも証拠なしなら待機、原本を含まない全5ファイルの確認、承認だけでは未送信、100ptの1commit、未公開40ptの集計除外、集計条件確認と反映未確認の表示、100→60ptの本人訂正と追加1commit、訂正の応答消失と読取復旧、過去commit保持、専用branchと実際の合成PR、未マージ時の公開値/既定branch保持、PRの応答消失と照合、squash merge後の公開確認、正味100ptの集計を確認しました。対象切替で同意/理由を解除し、凍結状態を維持した保存がエラーとなり行数を増やさないことも確認しました。

証跡は作業フォルダーのI-ui-evidence.json、I-*.png、I-*.logと模擬bare repositoryです。確認後は接続を解除し、通信をoffline_only、データセットをactiveへ戻してQAアプリとサーバーを終了しました。AI呼出は0件です。元の本番プロファイル・ghの実績投稿認証は使用していません。

配布用michi-portable-20261002-170717の作成は成功しました。その起動は自動承認レビューにより拒否され、返された理由は「blocked by policy」のみでした。配布版の実画面確認は未実施です。配布版でQA overrideが無効になる境界は単体試験で確認し、上記のWindows画面試験は開発版で行ったものとして区別しています。

## 要件の状態と残り

- M07は一部実装のままです。空repository・保護branch PR・訂正送信の端末内実装と合成Windows確認は完了しました。実アカウントでの投稿、fine-grained PAT/Pull requestsの実権限、GitHub App OAuth、Storageの証拠upload/検査/公開用画像派生物は未確認です。
- M08は受入確認済へ更新します。AT-M08の二つの否定条件を自動試験とWindows画面で確認したためです。github.comでの実作者帰属・実際の草反映・非公開設定は確認していません。
- 計は121件（受入確認済89、一部実装19、受入未確認13）です。
