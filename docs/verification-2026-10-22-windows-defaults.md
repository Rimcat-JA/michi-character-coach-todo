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

## 自動検証（このPC: Windows 11、実行ポリシー未設定、checkoutはAppData配下）

- 修正前: `test:electron` 295件中、失敗4（パイプ中継2件 `PIPE_UNAVAILABLE:SCRIPT_POLICY`、folder-watch 2件）。
- 修正後: `test:electron` 296件、成功293・失敗0・skip 3（folder-watchの2件はcheckoutと一時フォルダーがともにAppData配下のための理由付きskip、既存のplatform skip 1）。
- `MICHI_TEST_FIXTURE_DIR` にユーザーフォルダー直下の新しいフォルダーを指定すると、folder-watchの2件は成功。試験後の残留ファイルはなく、確認後にそのフォルダーを削除した。
- `npm run check:electron`（65ファイル）、`npm run lint` 成功。
- 変更前のmainで `npx tsc -b`・`npm test`（Vitest 202ファイル／2,036件）成功。今回はElectron側の `.cjs`・`.mjs` だけを変更。

## 判定

ローカルMCP接続の中継起動の不具合を修正。121要件の集計は変更しない（受入確認済93／一部実装19／受入未確認9）。配布版での実際のMCPクライアント接続は未確認のまま。
