# Windowsの既定設定での中継起動と試験（2026-10-22）

基準: 設計パックv1.3。Computer Useなし（CLI・ファイル編集・自動試験のみ）。外部送信・実アカウント・本番データなし。

## 1. ローカルMCPのパイプ中継がWindows 11の既定設定で起動しない

- 症状: PowerShellの実行ポリシーが未設定（実効はRestricted、Windows 11の既定）のPCでは、ローカルMCP接続の設定を発行するときに `electron/mcp-app-ipc.cjs` が起動する中継 `mcp-pipe-relay.ps1` が `PIPE_UNAVAILABLE:SCRIPT_POLICY` で止まり、接続を使えない。[2026-10-03の記録](verification-2026-10-03-remaining-agent-edit.md)で別修正とした件。
- 原因: `electron/mcp-pipe-server.cjs` が `-File` で起動する際に `-ExecutionPolicy` を指定していない。GitHubのWindowsランナーでは再現しない（同記録）。
- 修正: `-File` の前に `-ExecutionPolicy Bypass` を追加。この指定は起動したPowerShellプロセスのProcess範囲だけに効き、ユーザー・端末の実行ポリシーは変更しない。グループポリシーで実行ポリシーが決められた端末ではグループポリシーが優先され、従来どおり `SCRIPT_POLICY` で停止する（その場合も緩和しない）。
- 回帰試験: `electron/mcp-pipe-server.node-tests.mjs` に、中継へ `PSExecutionPolicyPreference=Restricted`（Process範囲）を継承させて既定のWindows 11を再現する試験を追加。スクリプト実行が許可されたCIランナーでも同じ条件になる。修正前のコードでは、外側の環境を `Bypass` にしても追加試験だけが `PIPE_UNAVAILABLE:SCRIPT_POLICY` で失敗し、修正後は成功することをこのPCで確認。
- 事前確認: このPCで `-File` だけの起動は既定・`PSExecutionPolicyPreference=Restricted` の両方で拒否され、`-ExecutionPolicy Bypass` を付けると環境変数がRestrictedでも実行されることを確認（コマンドライン指定が環境変数より優先）。

## 2. folder-watchの試験がリポジトリの置き場所によって失敗する

- 症状: リポジトリをAppData・`.claude`・`.codex`・`Default`・`Profiles` などの下に置くと（アプリが作る作業フォルダー、エージェントのworktree等）、試験用フォルダー `qa-output/folder-watch` が製品の除外規則で拒否され、2件が「専用の資料フォルダーを選んでください」で失敗する。製品の不具合ではなく、試験の前提が置き場所に依存していた。
- 修正: 試験用フォルダーの候補を `MICHI_TEST_FIXTURE_DIR` → リポジトリの `qa-output/folder-watch`（従来の場所。作業ディレクトリではなく試験ファイルを基準に解決）→ OSの一時フォルダーの順に試し、製品の `start()` で受け入れられた最初の候補を使う。どれも拒否される場合は理由付きでskipし、失敗としては扱わない。製品の除外規則は変更しない。
- CIのcheckout（Ubuntu・Windows）は従来どおり `qa-output/folder-watch` を使うため、試験の範囲は変わらない。

## 3. パイプ中継の起動待ち時間（CIの一時的な失敗）

- 症状: mainのrun `38869670764`（Windows）で、stdio host試験が `PIPE_START_TIMEOUT`（15秒）で失敗。直近約30回のWindows CIでは、同じ試験に通常7.5〜13.3秒かかっていた。
- 測定（このPC、`mcp-app-client` 試験と同じ手順を区間ごとに計測）: 負荷なしでは中継の準備完了まで0.34〜0.39秒、全体0.41〜0.47秒。2コアに制限して4つの busy loop と同居させると、中継の準備完了まで5.9〜7.1秒、全体8.4〜9.5秒でCIと同程度。時間の大半はPowerShellの起動と `Add-Type` によるC#のコンパイルで、余裕は約2倍しかなかった。
- 修正: 起動待ちを15秒から30秒にした。準備完了を報告しない中継は、従来どおり `PIPE_START_TIMEOUT` で停止する。
- 同じPRのCI（Ubuntu、run `39768783692`）で、`src/source-erasure-restore.test.ts` の最大選択の試験がVitest既定の5秒を超えて失敗した（通常はファイル全体で約0.6秒。同時に `routine-catchup` が約49秒動いていた）。今回の変更とは無関係のため、他の重い試験と同じく、このファイルの上限を30秒にした。

## 4. ポータブル版の起動と基本操作（配布版相当）

- ビルド: `npm run package:win` は成功（短いパスのgit worktreeで実行、Electron v44.4.5は端末のキャッシュから展開）。このセッションの深いcheckout（約180文字）では、Windows PowerShell 5.1の `Copy-Item` がパス長260文字の上限を超えて `dist\manifest.webmanifest` のコピーに失敗した。置き場所に依存する問題で、今回は修正していない。
- 起動: 生成した `michi.exe` を専用の `--user-data-dir`（使い捨て）と `--remote-debugging-port` で起動し、CDPで確認した。ウィンドウは画面に表示した。Computer Useは使わず、クリックと入力はCDPの入力イベントで行った。既定の保存先（`%APPDATA%`）は作成・変更していない。
  - 初回は「今日」画面と通信方針の初回カードを表示。コンソールエラー0件、読み込みは `michi://` だけで外部への通信はなかった。
  - 「この端末だけで始める」を選び、「新しいタスク」で手動25ptのタスクを保存した（すべてのタスク：1件）。
  - 再起動後もタスクと「25pt · 手動」が残っていた。完了操作で「完了を記録しました」と表示され、今日の実績は25pt・1件完了。
  - もう一度再起動した後も、実績画面に完了1件・確定25ptと完了履歴が残っていた。
- 配布物の中継: 同梱ランタイム（`ELECTRON_RUN_AS_NODE=1 michi.exe`）で `resources\app\electron\mcp-pipe-server.cjs` を読み込み、実効ポリシーがRestrictedのこのPCで347msで準備完了した（owner-only・protected DACL）。
- 未実施: MCPクライアントの実登録と接続、トレイ常駐、OS通知、バックアップと復元、ダウンロードしたzip（インターネットから取得した印付き）からの起動、別のPCでの起動。

## 自動検証（このPC: Windows 11、実行ポリシー未設定、checkoutはAppData配下）

- 修正前: `test:electron` 295件中、失敗4（パイプ中継2件 `PIPE_UNAVAILABLE:SCRIPT_POLICY`、folder-watch 2件）。
- 修正後: `test:electron` 296件、成功293・失敗0・skip 3（folder-watchの2件はcheckoutと一時フォルダーがともにAppData配下のための理由付きskip、既存のplatform skip 1）。
- `MICHI_TEST_FIXTURE_DIR` にユーザーフォルダー直下の新しいフォルダーを指定すると、folder-watchの2件は成功。試験後の残留ファイルはなく、確認後にそのフォルダーを削除した。
- `npm run check:electron`（65ファイル）、`npm run lint` 成功。
- 変更前のmainで `npx tsc -b`・`npm test`（Vitest 202ファイル／2,036件）成功。今回はElectron側の `.cjs`・`.mjs` だけを変更。

## 判定

ローカルMCP接続の中継起動の不具合を修正し、起動待ちに余裕を持たせた。ポータブル版は起動・作成・完了・再起動後の保持まで確認した。121要件の集計は変更しない（受入確認済93／一部実装19／受入未確認9）。配布版での実際のMCPクライアント接続は未確認のまま。
