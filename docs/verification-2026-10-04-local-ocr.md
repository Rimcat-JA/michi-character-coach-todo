# ローカルOCR batch（2026-10-04、PR66追補）

基準: 設計パックv1.3。Computer Useなし（CLI・ファイル編集・非表示自動試験のみ）。実サービス送信・実アカウント・配布版起動なし。

前head `8cf3526` の自作45文字テンプレートOCRを廃止し、一般書体の実OCRエンジンへ置換した（PR66はdraft維持）。

## 実装（N04/M06のOCR）

端末内Tesseract（tesseract.js v6.0.1＋tessdata_fast英日モデル、Apache-2.0）を実取込経路へ接続。外部送信・利用時モデルdownloadなし。

- `electron/ocr-tesseract.cjs`（新規）: `jpn`単モデルで英日を読む（`eng`単体より混合文書で高精度のため）。`langPath`は`electron/ocr-tessdata`固定＋`cacheMethod:none`＋画像はメモリ内PNG。行分割・行bbox・行confidenceを返す。0〜1に正規化して記録。
- `electron/ocr-tessdata/`（新規）: `eng.traineddata`（4,113,088B, sha256 `7d4322bd…56427170b2`）、`jpn.traineddata`（2,471,260B, sha256 `1f5de923…d83b91b4d`）。tessdata_fast（Apache-2.0）。複合資産hash `852b3ecc…93695360`（`npm run check:ocr`で表示）。
- `electron/ocr-pdf-images.cjs`（書換）: ページツリー順に各ページが描画する画像（contentの`Do`＋`/Resources`解決、間接参照対応）を対応付け。格納順・共有XObject（objid単位で1回だけ復号して共有）に対応。宣言寸法（8MP/枚・総計30MP・6000px）を展開前に検査し、超過は復号せず拒否。2400px超は縮小してからOCR。
- `electron/document-worker.cjs`: テキスト層を優先し、文字のないページだけOCR選択時に試行。ページ内で最大の描画画像を処理し、他は未読に列挙。`document.ocr`（engine/version/languages/license/assetHash/pages＋行bbox）に記録。行bboxはOCR処理画像の画素座標（ページ座標への変換は未対応）。Office埋込画像は未読のまま。予定資料（schedule）のOCRは未接続のまま拒否。
- `electron/document-extract.cjs`: OCRは明示選択（既定OFF）。一般取込20秒据え置き、OCR上限60秒（短縮のみ可の`timeoutMs`、緩和不可）。`cancelDocument()`とgeneration guardで取消後の遅延応答を不採用。
- `src/document-metadata.ts`・`src/source-library.ts`: `SnapshotDocument.ocr`に任意の行bbox（`boxes`）を追加して厳密検証。従来文書は互換。
- `src/SourceLibraryView.tsx`・`src/ai.ts`: 取込画面にOCR選択（既定OFF・外部送信なし表示）、engine情報・page別confidence・未検証警告を表示。OCR結果は検出候補への下書きであり、保存だけではタスク・期限・点数・台帳は不変。
- `electron/fixtures/ocr/`（新規）: OS一般フォント（Arial・MS Gothic・Yu Gothic、System.Drawing描画）のスキャンPDF 10件。エンジンのテンプレートとは独立。生成手順は`scripts/make-ocr-fixtures.ps1`＋`scripts/make-ocr-fixtures.mjs`に記録。
- `scripts/check-ocr-assets.mjs`＋`npm run check:ocr`: engine版・資産hash・非通信のCLI確認。
- 自作ブロック体OCR（`electron/ocr-engine.cjs`）は生産経路から削除。

## 自動試験（許容基準を明示。空文字でないだけでは合格にしない）

- `electron/document-ocr.electron-tests.mjs`（16件、`npm run test:ocr`で実行）: 英字スキャンのCER≦0.08（verified・行bbox2件）、日本語・混合のCER≦0.12、格納順と異なるPDFの正しい割当、共有画像の両頁抽出、複数画像頁の最大処理＋残り列挙、文字層頁内画像の無視（`Hello`のみ・未読0）、白紙・回転12°の未検証化（confidence<0.7）、DCTの対応外明示、宣言20000pxの展開前拒否、総計35MPの5頁目拒否（`総処理量`）、`timeoutMs`短縮での時間上限＋0/60001の拒否、実OCR中の取消→再読取成功、逐次再利用、Office/scheduleの拒否、OCRファイルの非通信静的検査。タイミング敏感な名前付きパイプ試験とのCPU競合を避けるため、`test:electron`とは別CIステップで直列実行する。
- `src/ocr-import.test.ts`（3件）: メタデータ検証（hash・confidence・bbox・余分keyの拒否＋従来互換）、OCR取込の保存・索引とタスク/台帳/候補の不変＋backup検証互換、削除・許可取消・古い版遅延応答の拒否。
- 全体Vitestは **202 files / 2036 tests成功**（失敗0）。
- Electron Node試験は合計 **311件（310成功＋既存platform skip 1、失敗0）**。内訳：`test:electron` 295件（294成功＋skip 1、旧来どおり）＋`test:ocr` 16件。CIでは直列の別ステップで実行。
- `npm run check:ocr` 成功（Windows CLI）。`npm run check:electron` 成功。`npm run lint` 警告0。`npm run build`（tsc＋Vite）成功。
- PWA offline 10/10成功（非表示Chromium、report: `qa-output/pwa-offline/2026-10-04T07-20-54-085Z/report.json`）。※前head時の記録。再実行はCIに委ねる。

## 未実施・保留（画面・実機が必要なもの）

- 取込画面のOCR選択・confidence表示・未検証警告のWindows DEV確認（本人のnative操作が必要）。
- 60秒timeoutの実時間試験（短縮試験のみ実施。設定値と上限維持を記録）。
- 手書き・写真・JPEG実写・低解像度FAX等のOCR（未読として残す）。
- 予定資料（M06/I01）のOCR接続（bbox→表行列の安全な受け渡しができるまで未接続）。
- 実モデル再観測・人手blind holdout（N04受入の残件）。

## 判定

N04は一部実装のまま（一般書体OCR接続、受入未達）。M06のOCR未接続を維持。121集計の変更なし（受入確認済93/一部実装19/受入未確認9）。
