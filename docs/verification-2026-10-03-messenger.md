# Messenger連携 — 模擬なし・記録済みデータの手動取込（2026-10-03）

実アカウント・実送信・同期・Webhook・Bot APIは未接続であり、この記録は受入確認の完成を意味しない。検証したのは本人が選んだexportファイルの手動snapshot取込だけであり、自動収集・新着同期・送信・組織ポリシー取得は未提供のままである。

## 実装：TelegramとSlackの選択ファイル取込

`src/external-message-import.ts` に `telegram` と `slack` を追加し、LINE・Discordと同じ厳格な手動取込経路（プレビュー・話者確認・選択保存・重複抑止・削除復活防止・保持期限）へ載せた。

- Telegramは公式exportの `result.json`（`name`・`type`・`messages`）だけを受け付ける。日時はオフセットを持たないため選択timezoneの壁時刻として解釈し、プレビューで本人に確認させる（LINEと同一規則）。文字列本文と文字列要素だけの配列を保存し、装飾の意味は解釈しない。service通知は本人確認の対象外、メディアのみは添付扱いで取得しない。
- Slackはチャンネル1日分のメッセージJSON配列（`ts`・`user`・`text`）だけを受け付ける。`ts` はUTC epoch秒（確定仕様）として解釈する。スレッド返信は前後関係を取得せず警告に残し、Bot・subtype付きは本人確認の対象外にする。記法の解決はしない。
- 話者キーはprovider接頭辞付き（`telegram-id:`／`telegram-name:`／`slack-id:`）で名前空間を分け、他providerと統合しない。`idBased` はID由来キーだけが真になる。
- Telegramは同一秒の別発言を区別するため発言IDを織り込んだdigestで重複判定する（LINE・Discordの原文位置方式は変更なし。既存の重複防止記録と互換性を保つ）。
- `SourceProvider` に `telegram` を追加し、表示名・検証・会話保持期限（90日既定）・能力表へ反映した。ネットワーク能力（履歴backfill・新着・編集・削除・送信・認証・ポリシー）は全providerで未対応のままである。

## K02：providerをまたぐ本人確認の非統合

LINE個人DMとTelegram個人DMをそれぞれ取り込み、各原本の話者だけを本人が明示確認しても、話者キーはprovider接頭辞のまま統合されない。共有グループの取込は警告付きで保存されるが、個人DMへ無条件に展開しない。生きた複数チャンネルでの継続会話（実Bot・実アカウント）は未確認のままである。

## 検証

- Vitest 1,967件／195ファイル、Electron 290件＋platform skip 1件、lint、61 CJS syntax、build、PWA 10/10（Chromiumオフラインemulation）。
- 新規 `src/external-message-import-messenger.test.ts` 4件：Telegramの壁時刻・ID・装飾・service・添付の区別と再取込no-op、不正形式の拒否、SlackのUTC・スレッド・botと範囲外除外、K02の非統合と共有グループ警告。
- Windows source DEV（専用 `messenger` profile、新規）：実ファイル選択・実クリックでTelegram 2件（1件を本人確認）・Slack 2件を保存し、provider分離とタスク・台帳不変を確認（`work/M-qa.mjs`、5 checks）。実アカウント・実送信・ packaged・物理オフラインは未確認。
- 残り：LINE Bot新着・Telegram Bot・Discordチャンネル履歴・Slack履歴API・Gmail・Google Calendar予定・Teams/Outlook一式の実連携はアカウントが必要なため未実施。Gmail mbox等の追加の手動代替は今回見送り、理由を要件表に記録した。
