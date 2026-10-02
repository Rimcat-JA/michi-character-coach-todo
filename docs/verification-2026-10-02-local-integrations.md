# バッチK：ローカル連携の検証

起点main: `23038747b7ab9e6cb92c73ac3575ad16dba68748`（J、PR #59）。2026-10-02〜03のWindows開発版・合成データによる確認。配布版、実Zapier、実ASR/マイク/Live2D、日常ブラウザ、実外部アカウントの受入は含めません。

## 実装とレビュー

- APIは既定OFF・127.0.0.1限定、Host/Origin/Sec-Fetch検証、CORSなし、64KiB/60回毎分の制限。期限・project・scope付きtokenは一度だけ表示し、safeStorageには秘密のSHA-256だけ保存。作成は共通コマンドバス、native確認、main lease、同一DB transactionのreceiptを通り、点数・期限は未設定です。HMAC claim/resultをtoken/command/digestへ結び付け、索引書込中断と結果書込中断から復旧します。
- WebhookはsafeStorageの送信先・イベント・公開項目だけ。通常payloadはID・日時・ポイント、タイトルは個別許可時だけでメモ・引用なし。DBCoreで実タスクの作成/完了/取消と同一transactionにoutboxを作り、rollback/復元/保持処理は送信事実を作りません。完了台帳を読めない単独writerはpoints:nullです。両新テーブル・端末grant・秘密はbackup対象外。
- 配送は共通gateway、HTTPS/public IP/DNS pinning、redirect拒否。明示checkboxでHTTP loopbackだけ検証先として許可。送信claimを暗号化ディスクへ先に保存し、2xxだけdelivered、中断/応答不明はunknown、offlineはfetchなし。初回＋最大6回、1/2/4/8/16/30分とRetry-After。試験pingは一回だけ。失効/凍結/停止は再送予定より優先。受信fixtureはHMAC・±5分・ID一致・重複を検証しますが重複記憶はプロセス内で、本番の永続管理は別実装が必要です。
- System Triggersはmainが実DBの事実IDを検証。本人登録のイベント・固定型付き引数・低リスク許可・30日以内・毎時1〜6回だけをshellなしで実行。実行前journal、再送防止、60秒以前/起動以前/許可以前の事実除外。非低リスクは60秒以内の別native確認。署名結果/receipt/本文なしauditを保存し、結果から完了やポイントを変更しません。
- MV3はactiveTab/scripting/contextMenus/downloadsだけで履歴・host permissions・常駐content script・通信なし。選択引用を確認してJSON保存→アプリで再確認→空の手動editor。タイトル/点数/日付を推測しません。引用は既存taskSourceEvidenceに2000 UTF-16文字以下・surrogate境界を守る断片で原子保存し、削除/保持期限/復元の既存消去経路を共用。
- マイクは本人PTTの5秒proof・main frame・audioだけ。video/display/foreign拒否、停止/hide/navigationで取消。拒否と一般認識障害を分け、原音保存・資産の自動取得なし。
- AI停止・本人/dataset/epoch/資料権限・凍結・復元をmainで再検証。接続一覧にAPI/Webhookと個別停止を追加。

レビューで、taskNotes追加による保持期限transactionのロック競合を再現し既存evidence経路へ統合して解消。待機/配送済み100件が後続を妨げる経路、未完成operation tableの権限拡大、ping再送表示、期限切れカード、共通受信API履歴、イベント結果receiptも修正しました。通信応答待ち中の取消は永続化queueを待たず権限を縮小し、batchの残りを止める回帰試験を追加。

[Electron Session](https://www.electronjs.org/docs/latest/api/session)、[Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[Dexie DBCore](https://dexie.org/docs/DBCore/DBCore)を参照。

## 自動試験

最終ローカルチェック：Vitest1847件、Electron244件、CJS48ファイルの構文、TypeScript/build、lint警告0、PWA offline10段階成功。その後、通信応答待ち中の停止が残るbatchへ即時反映する修正と回帰試験を追加し、Webhook9件成功。最終PR headの両OS CIを確認します。

APIの実HTTP/rate/Host/Origin/size/署名receipt復旧、triggerの一回実行/事実/引数/期限/回数/再起動/停止、音声permission matrix/障害、引用26000文字の順序/backup/消去、Webhook固定vector/改変/時刻/重複/SSRF/実HTTP/offline/失効/再起動/後続公平性/transaction rollbackを含みます。Node暗号化fixtureはAES-GCMで実Windows safeStorageと区別。

## Windows開発版

専用qa-reminders-profile/local-integrations、app.isPackaged=false、合成DB/loopback receiver。窓は原則非表示、Chromium CDP trusted mouse eventsで実画面を操作。OSマウス操作の証拠とは扱いません。元checkout・普段のアプリ・アカウントは使用していません。

32項目をK-ui-evidence.jsonに記録：readonly403、二回POST202/承認前不変更、DOM click拒否、trusted入力で一件/再送200同ID、未知点数/台帳0、本文変更409、notes/sourceなし、Host/Origin403、Windows safeStorage非平文、署名ping、手動25pt、実node.exe --version一回/終了0/台帳25一回、完了/取消Webhook一回、受信再送409、委任停止/次完了不発火、非低リスク未実行/60秒失効、offline追加fetch0、AI停止で委任/Webhook取消/API listener停止を確認。

実Chrome headlessの使い捨てQA profileに拡張を読み、非選択段落/別ページ/履歴を含まないcapsuleを保存。QAコピーだけloopback host権限と呼出し口を追加し配布manifestには入りません。このファイルをWindowsアプリで読み込み、選択範囲/位置未検証/AI送信OFF、空の手動editorから引用付きタスク保存を確認。配布版activeTabのOS gesture・保存ダイアログ・日常ブラウザ導入は未確認。

Windows実画面へ合成SpeechRecognitionを差し込み、not-allowed/audio-capture後の相談下書き維持を確認。壊れたmodel3.json・欠落moc3・フォルダー外参照を拒否し、参照だけ揃えた合成モデルはSDK未提供で静止表示。障害後の手動25ptタスク保存も確認。実OSマイク拒否・実Live2Dの受入ではありません。

配布用ポータブル起動は前バッチで自動承認レビューに拒否され、理由は「blocked by policy」のみ。別経路で迂回せず、新機能の配布版画面は未確認。DEV結果で置き換えません。

## 要件と残り

AT-I03/I08は自動試験とWindows DEV・このPC内API/固定実行の範囲で確認。実Zapier/公開到達・OSアカウント分離・別端末transportは未確認/未提供。I02はnative activeTab手順と転送受信/送信者認証が残るため一部実装。K10は実ASR/マイク/Live2D未提供のため一部実装を維持。

追加TTS停止試験はQA/CDP待機がタイムアウトして完了証跡を取れず、成功に数えていません。アプリ応答と応答本文は維持され、QA音声を取消して専用プロセス/receiverを終了しました。実音声停止の追加受入は未確認です。

初回PR CIはUbuntu成功・Windowsの試験fixtureで失敗。一時TEMPの8.3表記をcanonical pathにしてprivate storeの厳格チェックを維持し、base64url秘密内のunderscoreを誤って分割する検査を43文字全体の検査へ修正。製品の認証/path拒否は緩和せず、両OSの最終headを再確認します。
