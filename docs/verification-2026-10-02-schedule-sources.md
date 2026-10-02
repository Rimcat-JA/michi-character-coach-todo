# バッチJ：予定資料・読取と書込の検証

予定資料の列対応、Shift_JIS、端末内PDF/XLSX、ICSの出典と本人編集、承認付き更新取得、CalDAVを共通resolverへ接続しました。以下の受入確認はATの例と明記した端末内・合成の範囲です。実Google/Outlook/CalDAVアカウント、実公開URL、Android、OCR、任意文書をAIで推測する解析は確認していません。

## 実装

- CSV/TSV/セミコロン区切りの列名と位置、文字コード、日付・時刻、翌日規則、公開・取消語彙、本人参照、識別子と版の方針を本人が確定します。未知の状態、変更したヘッダー、年不明を推測しません。他人・未公開行は原文を保持しません。原本bytesの範囲・hash、選択行、プロファイルのdigestを復元時にも検証します。移動で派生IDが変わる場合は以前の回を欠落取消にしません。
- Hの隔離workerを再利用してテキスト層PDFの表とXLSXのセルを読みます。PDFはページ/bbox、XLSXはシート/セル番地を示します。本人が確認する決定的な表解析だけです。暗号化、画像だけ、回転、曖昧な行、評価が必要な数式・結合セルを保留します。元ファイル全体を予定資料のDBへ保存せず、選択行の根拠だけを保持します。PDF表示workerもローカルに束ね、PWAのprecacheへ含めます。XLSXはデスクトップ版だけです。
- ICSはIANA/CLDR release-48のWindowsゾーン、VTIMEZONEの各参照日時のoffset検証、VALARMの警告付き除外に対応します。不明・不一致のゾーンを文字置換で受け入れません。読取・書込を別表示し、端末内の編集は版・外部未反映・通信なしのauditを保存します。同じ資料の再取込でも本人編集を保持し、その回だけの資料採用を別承認にします。
- URL/本人選択ファイルの更新はmanual/daily/weekly/開始前後14日の頻度、条件付きGET、同一hash、同一originの限定redirect、timeout、サイズ、Retry-After、失敗時stale、fs.watchとSHA pollを扱います。アプリ起動中だけです。取得本文はRAMの容量・24時間上限付きで、DBの受信箱はmetadata/body:nullです。設定と資格情報はsafeStorageの端末専用暗号化領域で、バックアップに含みません。
- 取得は予定も台帳も変更しません。確認した資料の保存と発生回の反映を別に承認します。新しい取得、取得失敗、権限epoch、停止、保持期限で古い確認案を失効させます。再起動後は未承認本文を再取得し、保存済みhashだけで最新承認済みとはしません。変更不要な候補も、本人の確認ボタンで採用せず確認待ちから外せます。
- CalDAVはprincipal/home/collectionのPROPFIND、sync-collection/multiget、query+ETag fallback、invalid-token再取得、既知hrefの404だけの取消確認を実装します。欠落だけでは取消しません。読取先と異なるアプリ専用の書込先、実DBの予定/版/hash、毎回のnative確認、If-None-Match/If-Matchを要求します。412は現状GETと新しい差分・承認に戻し、再送しません。認証情報とmirrorの原文はrenderer永続領域やbackupへ出しません。
- 全外部取得はN10 NetworkGatewayを通り、offline_onlyは下位HTTP前に止めます。通常はHTTPS/public IP/DNS pinningだけです。127.0.0.1 HTTPは開発版かつ専用QA profile・明示環境変数の合成試験に限定し、画面にも合成と表示します。N09の停止・I05の凍結・本人/dataset/epochを取得・保存・書込で確認します。

[CalDAV RFC 4791](https://www.rfc-editor.org/info/rfc4791/)、[同期RFC 6578](https://www.rfc-editor.org/info/rfc6578/)、[CLDRのWindowsゾーン](https://raw.githubusercontent.com/unicode-org/cldr/release-48/common/supplemental/windowsZones.xml)、[Unicode license](https://www.unicode.org/license.txt)を参照しています。Google/Graphの権限表示は接続実装済みを意味しません。

## 自動試験とレビュー

アプリ1826件、Electron224件、CJS40ファイルの構文、TypeScript/build、lint警告0、PWA offlineのPCエミュレーション10段階を確認しました。最終PR headのUbuntu/Windows CIも確認します。

AT-M06の授業振替（JSON）、会社休日（実PDF fixture）、勤務日変更（JSON）、本人公開夜勤（Shift_JISの実bytes）を一つのDBとresolverで照合する横断試験を追加しました。完了task/台帳/completionの全行を保持し、勤務変更が同じevent IDを更新し、重複生成なし、休日と公表夜勤の矛盾は確認待ちになります。その他、mapping改変・旧版・保持期限、PDF画像/暗号化、XLSX、VTIMEZONE、原本hash改変backup、本人確認、凍結、offline、SSRF、CalDAV XML攻撃/412/応答不明/明示404を試験しています。

仕様・根拠/保持・通信/認証・非同期/復元・画面の観点で自己レビューしました。PDF.jsへ渡したbufferがdetachされた後のhash計算、context追加後の選択初期値、確認画面の幅、保持日時の表示、失敗/停止で未承認本文が残る経路、再起動で未承認同hashを見失う経路を修正しました。Windowsで再現した「この回だけ」の操作を別feedのstaleが妨げる問題も修正し、対象seriesのstaleは拒否する回帰試験を追加しました。

## Windows画面

Windows開発版Electron・専用qa-reminders-profile/schedule-sources・合成資料/loopbackだけで33項目を記録しました。保存と採用はCDPのtrusted mouse event、native確認は実ダイアログを通しました。最後のURL取得先登録は実nativeダイアログの登録結果を読み取りましたが、Esc停止によりcomputer useのその操作証跡は未取得です。

PDFのcanvas/bbox、他人除外、資料保存時の予定不変と1件の夜勤生成、CalDAV discovery、読取のPUTなし、原文非永続、別の生成承認、端末内編集のPUTなし・外部未反映、本人編集の再取込保護、専用PUTのIf-None-Match、412の再送なし/現状差分/新しいETagの再承認、507時の予定保持、XLSX番地と同ID、Shift_JIS原文bytes・他人/未公開除外・保存profileを確認しました。ICSの正確な端末内編集toast/禁止同期文言なし、再起動で版/本人変更/ID保持、バックアップpayloadと復元で版保持・pending承認除外、URL変更の確認待ち・保存時の予定不変・別承認後の同ID更新も確認しました。

バックアップ試験はアプリのJSON出力BlobをQA側で保存して、実ファイル入力・検証・復元確認へ戻したものです。Windowsのダウンロードダイアログの保存完了を確認したとは扱いません。native文件選択の監視登録・四種AT全手順のWindows横断は自動試験のみの箇所を含みます。実アカウント、実外部資料、Android実機試験ではありません。

配布用ポータブル版の起動は前バッチで自動承認レビューに拒否されました。返された理由は「blocked by policy」のみです。別経路で起動を再試行せず、配布版の新機能画面は未確認とします。開発版の結果を配布版の受入結果に置き換えません。

## 要件の状態と残り

M06/I01はAT例を自動試験とWindows開発版で確認した範囲として受入確認済に更新します。M06は同resolver・矛盾・過去完了不変、I01はICS編集の架空の双方向同期表示なしが対象です。実provider相互運用、OAuth、複雑/不規則PDF・OCR、ASRやAndroid、配布版画面の未確認を残します。受入確認済は要件本文に含まれる全外部サービスが完成したという意味ではありません。

計: 121件（受入確認済91、一部実装17、受入未確認13）。
