# Computer Useなしの追加開発（2026-10-03）

基準: 設計パックv1.3の18.11（ファイル引継ぎ）、17.2（期限と権限版）、4章/E01（作業・移動の見積）。PR64の未実施Windows DEVは保留し、そのhead `d141eec`から独立した `codex/non-ui-followup` で実装。Computer Useは使用していない。専用の非表示Chromiumハーネスは自動コード試験であり、画面受入確認ではない。

## I05: 同じIDの内容変更と削除の保護

従来は主要タスク項目のheadsと20表の行IDを比較し、同じIDのノート編集、pin、習慣・目標等の変更を見落とし得た。37表の完全な業務行についてcanonical SHA-256を端末内のhandoffHeadsに保存し、base/local/incomingを照合する。比較対象は `HANDOFF_ROW_TABLES` が正本。taskの式入力・固定表示・計画属性、ラベル定義、テンプレート、計画、予定規則、実績公開記録、出典証拠も含む。秘密の本文を履歴へ複写せずハッシュだけ保存。添付はBlob/Base64表現を除いたメタデータと検証対象のsha256で比較する（復元時のバイト/sha256検証は既存のまま）。

同IDのlocal_only/both_changed、ローカル削除を検出する。旧baseにはハッシュがないため違う行はneeds_reviewとして止める。incoming-onlyの変更は、基準を照合できる場合に限り従来どおり置き換え可能。取込manifestからハッシュを信用せず、端末内で行から再計算する。

直接置き換えとmove受入はrestoreの書込transaction内で再照合する。書き出してから置き換える場合は書き出し開始前の業務行と一致していることを同transaction内で確認し、書き出し中の追加編集を失わない。WebCrypto中はDexie.waitForでtransactionを維持。端末の設定・会話・資料原本等を含む全DBの自動マージではなく、指定の業務表の消失防止。サーバー接続キュー/feed/snapshot/同時編集は未提供のまま。

## I06: 共有ファイルの有効期限と競合時のfail-closed

新規共有は既定7日、有効期限は1〜365日。画面では1/7/30/90日を選び、previewの内容と期限を新規grant/初回発行に束縛する。preview後にタスクの共有値が変わったら再確認を要求する。署名・暗号化されたpayload内にexpires_atを含む。既存の期限なしファイル/保存済みgrantは互換読取を維持する。これは共有スナップショットの期限であり、サーバーの招待token/本人認証を実装したものではない。

受信時に期限切れなら本文・投影を保存せず、epoch/sequenceのtombstoneだけ保存。表示一覧/返信時、アプリ起動・60秒周期、および共有画面の起動・30秒周期で期限を確認し、expired projection/sharedFields/shareNoteを消す。期限を越えた後の時計巻き戻しで消去済み内容を復活させない。コピーの遠隔消去、信頼できるサーバー時刻、アプリ終了中の期限通りの物理消去は保証しない。

所有者側は期限切れの再発行・返信取込・提案準備/承認を拒否する。暗号化後の保存ではgrant全体とdataset/所有者/相手の指紋確認をtransaction内で再照合し、途中の権限変更や取消を古いrowで上書きしない。返信発行も同様に受信rowの権限版を再確認。返信取込は現grantをtransaction内で検査し、同じコメント/提案IDの別payloadや古いsequenceでの新しい内容を拒否する（同一返信の再取込は重複として処理）。

提案は受信時のauthorization epochに束縛し、editor→viewer→editorで古い提案を復活させない。画面の承認は `applyShareProposalFromUI` から通常のChangeSetへ進み、共有権限・期限・提案内容の検査、業務更新、applied状態を一transactionで確定する。保護チェック・本人のnative操作・版/ポリシー検査は維持。unitのisTrusted fixtureとChromiumの直接設定した合成名刺確認はnative同意の受入証拠ではない。

## E01: 保存済み見積履歴

タスク編集の必要ポイント欄に、immutable assessmentから作業分・移動分・合計・保存日時・由来・現在の評価を表示。既存の評価保存transactionとbackup/restoreを利用し、別の書込経路を増やさない。手動点数だけの変更を含め、評価ごとの記録を残す。0分と未設定は別表示。不明な内訳がある合計を0や既知の合計に偽装しない。記録済み実作業時間はsessionsのunionで集計し見積と分ける。入力中の下書きは履歴に入らない。同一日時の評価の編集順は推定しない。通常編集で完了・台帳の過去値を変更しない。

## 自動検証

- `src/handoff-row-conflicts.test.ts`: 同IDノート/pin、両側編集、local削除、旧base、ラベル定義、添付表現、確認/書き出し中の編集を保護（8件）。既存handoff/dataset-mode/画面静的描画と合わせ28件成功。
- `src/share-lifetime.test.ts`: 有効期限、期限到達、初回期限切れ、形式/期間、暗号化中の役割変更/取消、ID/sequence再生、古いepoch、通常ChangeSetの承認/期限/取消（10件）。既存sharing関連も成功。
- `src/estimate-history.test.tsx`: 30+20→45+20の履歴、manual25ptと完了/台帳不変、backup/restore、0/null、他task除外、重複作業区間の45分集計（3件）。
- `npm run check:device-data`: Windows上の非表示Electron/Chromium、別session partition A/B、実IndexedDB/WebCrypto。競合restore拒否・ノート保持・台帳0、非抽出鍵の永続化、署名/暗号化共有取込、合成の期限で内容消去、古いファイル再生拒否、個人業務表不変、HTTPリクエスト0。Electron44.4.5/Chromium152.0.7977.130。report: `qa-output/device-data/2026-10-03T12-49-13-743Z/report.json`。同ハーネスをUbuntu/Windows CIへ追加。
- Electron Node: 295件、294成功＋既存platform skip1、0失敗。CJS63件、lint、tsc/build成功。最終Vitestは201 files/2033 tests成功、PWAは10/10成功。CIの結果はPR本文・作業checkpointに記録。

## 後続の画面確認と未提供範囲

Windows source DEVで、同IDノート/pin/習慣・目標の差分表示、書き出し中編集の拒否、新規共有の期限preview/発行、期限切れ表示消去、期限/権限変更後の確認画面の拒否、見積履歴のスクロール/0と未設定を確認する。本人の指紋照合/同意は合成fixtureで代用しない。配布版起動の以前の承認レビュー拒否を迂回しない。PR64の未実施画面確認も残っている。

この追加分だけで121要件全体を完了扱いにしない。接続型サーバー・同期/移行・サーバーACL/招待・共有コーチ、実host/実provider認証、メッセンジャー実連携、実モデルblind評価、OCR、スマホ/OS遮断/配布版試験は未完了。新しい外部アカウント接続や実メッセージ送信は行っていない。Draft PRは画面確認前にマージしない。

CI初回run `37124309120` のUbuntuでは新しいChromium起動がSUID sandbox helperの所有者/4755未設定で停止した。unit/Electron Node/buildは成功。Linux CIでElectronを明示インストールし、指定helperをroot:root/4755に設定するよう修正。renderer sandboxも明示true。--no-sandbox等の保護緩和は行わない。修正後のhead/CIはPR本文・checkpointを参照。
