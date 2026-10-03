# 小さな残課題（2026-10-03）

## 390pxの今日一覧タイトルはみ出し：mainで再現せず、変更なし

新規 `small-fixes` profileで通常・172字非切断タイトルのタスクを作り、今日一覧の全区分（午前午後・カテゴリ・時間枠・カスタム）と全タスク一覧で390px emulation測定した。`.task-row` を超える子要素も、画面幅を超える行も0件だった（`S-measure*.mjs`）。`.task-main strong` のellipsisと `min-width:0` 連鎖が効いている。対応するコード変更はしていない。

## ノートと記録の出典URL入力：labelクラスを付与して修正

`src/WebCaptureImportView.tsx:42-45,56` の bare `<label>` 4件＋1件に `className="field"` を付けた。実測（390px）：修正前は入力183pxに対しlabel 173pxで11pxはみ出し・2pxブラウザ既定罫線、修正後は173px一致・はみ出し0・1px罫線（`S-url.mjs`、`S-url-390-after.png`）。同じ欠陥の資料名・タイムゾーン・引用・メール本文も同時に直した。

## BrowserWindow closedリスナー警告：集約ヘルパーで構造対応

12箇所の `win.on('closed')` を `electron/on-window-closed.cjs` の1リスナー集約へ移行した（上限引き上げによる隠蔽はしていない）。解除・例外隔離・二重発火防止付き。新規 `electron/on-window-closed.node-tests.mjs` 4件は二重発火の実バグを検出して修正済み。起動ログの `MaxListenersExceededWarning (11 closed listeners)` は再起動後に再現しなくなった。

## S06・ファイル・MCPの3入口パリティ：配布版は未実施のまま

入口一致自体は `src/command-bus.test.ts` のK12同一シナリオ試験（S06／手書き受信箱／実MCP）がunitで担保している。配布版での実行は自動承認レビューの `blocked by policy` が継続中のため、迂回せず未実施として記録する。

## 検証

- lint、61→62 CJS syntax（helper追加）、Vitest/Electron全件はPRのCIで確認、build、PWAは影響なし（CSS 5行・CJS配線のみ）。
- Windows source DEV（専用 `small-fixes` profile）：上記の再現・修正・再測定と再起動後の警告消失を確認し、試験アプリは終了済み。
