# ローカルOCR batch（2026-10-04）

基準: 設計パックv1.3。Computer Useなし（CLI・ファイル編集・非表示自動試験のみ）。実サービス送信・実アカウント・配布版起動なし。

## 実装（N04/M06のOCR初 slice）

端末内ブロック体OCR `michi-local-block-ocr v1.0.0` を実取込経路へ接続した。外部送信・モデルdownloadなし。

- `electron/ocr-engine.cjs`（新規）: 純JSのオフラインOCR。5x7ブロック大文字・数字・記号＋16x16ブロック日本語4文字（本人確認）ほか計45文字。Otsu二値化→投影分割→正規化（tight bbox→正方形→バイリニア24px）→Dice係数照合。対応外（手書き・一般書体・写真・回転・JPEG・高ノイズ）は未読・低confidence・□表示で明示し、推測値を捏造しない。
- `electron/ocr-pdf-images.cjs`（新規）: PDF画像XObjectの軽量抽出。Raw/ASCIIHex/Flate、Gray/RGB、1/8bitに対応。DCT（JPEG）/JPX/CCITT等は対応外として報告。
- `electron/document-worker.cjs`: テキスト層を優先し、文字のないページだけOCR選択時に試行。ページ単位のconfidence・verified・statusを `document.ocr`（engine/version/languages/license/assetHash/pages）に記録。Office埋込画像は未読のまま。予定資料（schedule）のOCRは未接続のまま拒否。
- `electron/document-extract.cjs`: OCRは明示選択（既定OFF）。一般取込20秒据え置き、OCR専用60秒。画素上限（8MP/枚・30MP/合計）。`cancelDocument()` と generation guard で取消後の遅延応答を不採用。
- `src/document-metadata.ts`・`src/source-library.ts`: `SnapshotDocument.ocr` を任意項目として厳密検証（engine・版・言語・license・64hex資産hash・page配列・confidence 0〜1）。従来文書は互換。
- `src/SourceLibraryView.tsx`・`src/ai.ts`: 取込画面にOCR選択（既定OFF・外部送信なし表示）、engine情報・page別confidence・未検証警告を表示。OCR結果は検出候補への下書きであり、保存だけではタスク・期限・点数・台帳は不変。
- `scripts/check-ocr-assets.mjs`＋`npm run check:ocr`: engine記録・資産hash・charset・非通信のCLI確認。
  - 資産hash: `4f118f53c7399d3c303afa0f0332de5cd2e6f221643fe7a9c3493b10e7fcaa4d`

## 自動試験（許容基準を明示。空文字でないだけでは合格にしない）

- `electron/document-ocr.node-tests.mjs`（11件）: 英字スキャンPDFの完全一致（confidence≧0.95・verified）、日本語スキャンの完全一致、混合ページ（テキスト層保持＋OCR行のページタグ）、既定OFFの拒否、白紙・回転12°の拒否（捏造なし）、2%ノイズの段階劣化（□混じり・未検証・confidence低下＋8文字以上残存）、DCTの対応外明示、抽出器のGray/RGB/1bit/Flate、取消後の再読取成功、Office/scheduleの拒否、OCRファイルの非通信静的検査。
- `src/ocr-import.test.ts`（3件）: メタデータ検証（hash・confidence・余分keyの拒否＋従来互換）、OCR取込の保存・索引とタスク/台帳/候補の不変＋backup検証互換、削除・許可取消・古い版遅延応答の拒否。
- 回帰: `document-extract`・`schedule-document`の既存9件成功。`source-library`等30件成功。全体Vitestは **202 files / 2036 tests成功**（前回201/2033＋本batch 1 file/3 tests、失敗0）。
- `npm run check:ocr` 成功（Windows CLI）。`npm run check:electron` 65 files成功。`npm run lint` 警告0。`npm run build`（tsc＋Vite）成功。
- Electron Node試験は **306件（305成功＋既存platform skip 1、失敗0）**。前回295件＋本batch 11件。
- PWA offline 10/10成功（非表示Chromium、report: `qa-output/pwa-offline/2026-10-04T07-20-54-085Z/report.json`）。

## 未実施・保留（画面・実機が必要なもの）

- 取込画面のOCR選択・confidence表示・未検証警告のWindows DEV確認（本人のnative操作が必要）。
- タイムアウト60秒の実時間試験（待機が長いため未実施。設定値のみ記録）。
- 一般書体・手書き・実スキャナ画質・JPEG写真のOCR（本batchの対象外。未読として残す）。
- 予定資料（M06/I01）のOCR接続（bbox→表行列の安全な受け渡しができるまで未接続）。
- 実モデル再観測・人手blind holdout（N04受入の残件）。

## 判定

N04は一部実装のまま（OCR slice追加、受入未達）。M06のOCR未接続を維持。121集計の変更なし（受入確認済93/一部実装19/受入未確認9）。
