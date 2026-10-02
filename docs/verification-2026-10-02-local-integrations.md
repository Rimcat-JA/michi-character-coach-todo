# バッチK：ローカル連携（作業中）

起点 main: `23038747b7ab9e6cb92c73ac3575ad16dba68748`（バッチJ、PR #59）。
Kの実装・受入は作業中。以下は完成扱いではなく、確認済みの範囲と残作業の記録。

## このPC内のAPI

- 既定OFF、127.0.0.1限定、Host検証、Origin/Sec-Fetch-Site拒否、CORSなし。
- scoped tokenの秘密は初回のみ表示。safeStorage暗号化設定には秘密のSHA-256のみ保存。
- task.createは共通コマンドバス・本人のネイティブクリック・期限付きmain承認を通す。
- HMAC署名のclaim/resultはtoken/command/種別に結び付ける。設定索引の書込み中断でもclaimから受信箱を復旧。
- タスクとAPI receiptは同じIndexedDBトランザクション。点数と本当の締め切りは未設定のまま。
- datasetの凍結、本人/epoch/取得権限変更、取消、期限切れを検証。restore時はAPIも取消。
- `electron/local-api.node-tests.mjs`: 7件成功。実際のloopback HTTPと暗号化ディスクを使用。
  読取専用拒否、同一要求の再送、再起動後のreceipt復旧、変更後409、読取範囲、
  Host/Origin拒否、chunked 64KB上限、61回目429、署名ファイルの移替え拒否を確認。
  テスト暗号化はAES-GCM fixtureであり、Windows safeStorageの実画面確認は別途必要。
- API client/UI/restore/file bridge regression: 37件成功。Nodeの合成Eventを使用。
  ネイティブWindowsでのクリック・タスク作成・取消はまだ未確認。

## 残作業

- 署名Webhookとtransactional outbox、共通通信ゲートウェイを通す配送・再送・受信検証。
- System Triggersの期限付きイベント委任・IDのみの事実確認・再起動時の遡及実行防止。
- マイク許可ポリシー、音声/モデル障害後のタスク編集確認。
- 選択引用だけを保存するMV3拡張とJSON取込・手動タスク化。
- K全体のレビュー、Windows DEV試験、全チェック、PR、両OS CI、マージ。

実Zapier、実マイク/日本語ASR資産、ライセンス済みLive2D、日常ブラウザへの導入、
OSアカウント分離、別端末transportは本確認に含まない。
ポータブル起動は前バッチで自動承認レビューに拒否されたため、別経路で起動を迂回しない。
DEV試験はポータブルの受入確認と区別して記録する。
