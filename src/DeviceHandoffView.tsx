import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Smartphone } from 'lucide-react'
import { db } from './db'
import type { Settings } from './domain'
import { cancelMove, completeMoveOnSender, DATASET_MODE_LABEL, exportFork, startMove } from './dataset-mode'
import './HandoffSharing.css'

/** S18/S19 (file handoff only): device identity, move with completion code, fork. Never described as automatic sync. */
export default function DeviceHandoffView({ settings, password, run }: { settings: Settings; password: string; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const device = useLiveQuery(() => db.localDevice.get('main'), [])
  const mode = useLiveQuery(() => db.datasetState.get('main').then(row => row?.mode ?? 'active'), [], 'active')
  const last = useLiveQuery(() => db.handoffHeads.where('datasetId').equals(settings.datasetId).toArray().then(rows => rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null), [settings.datasetId])
  const [code, setCode] = useState('')
  const lineage = settings.lineage
  return <section className="card setting-section device-handoff" aria-label="端末間の引継ぎ">
    <div className="setting-heading"><Smartphone size={20} /><div><h2>端末間の引継ぎ（ファイル）</h2><p>ファイルで手動の引継ぎ確認をします。自動同期ではありません。同時に編集し続けるにはサーバー接続が必要です（このバージョンでは未提供）。</p></div></div>
    {mode !== 'active' && <p role="status" className="dataset-mode-banner">{mode === 'frozen' ? 'この端末は移行のため凍結中です。編集・完了はできません。受入先に表示された完了コードを入力するか、移行を取り消してください。' : 'この端末のデータは別端末へ移行済みです。読み取り専用として残しています（移行先の端末で続けてください）。'}</p>}
    <div className="data-row"><span>この端末のID</span><code>{device ? `${device.deviceId.slice(0, 8)}…` : '未作成（初回の書き出しで作成）'}</code></div>
    <div className="data-row"><span>データセットの状態</span><strong>{DATASET_MODE_LABEL[mode]}</strong></div>
    {lineage?.parentDatasetId && <div className="data-row"><span>複製元</span><code>{lineage.parentDatasetId.slice(0, 8)}…</code></div>}
    <div className="data-row"><span>最終引継ぎ</span><strong>{last ? `${new Date(last.createdAt).toLocaleString('ja-JP')}（${last.direction === 'export' ? '書き出し' : '取込確認'}）` : 'なし'}</strong></div>
    <p className="muted">通常のバックアップにも引継ぎ情報が入り、別端末で取り込むと「手動の引継ぎ確認」で手動ポイントなどの違いを確認できます。下の操作は上の「バックアップ用パスワード」を使います。</p>
    {mode === 'active' && <div className="share-actions">
      <button type="button" className="secondary-button" disabled={password.length < 10} onClick={event => { const native = event.nativeEvent; if (confirm('この端末を凍結し、移行ファイルを書き出します。受入先で完了コードを確認するまで、この端末では編集できません。続けますか？')) void run(() => startMove(password, native), '移行ファイルを書き出し、この端末を凍結しました') }}>この端末から移行</button>
      <button type="button" className="secondary-button" disabled={password.length < 10} onClick={event => { const native = event.nativeEvent; if (confirm('新しいデータセットIDの独立した複製を書き出します。複製と元データは今後それぞれ別に編集され、統合されません。続けますか？')) void run(() => exportFork(password, native), '複製（fork）を書き出しました') }}>別データセットとして複製を書き出す</button>
    </div>}
    {mode === 'frozen' && device?.pendingMove && <div className="share-actions">
      <label className="field">受入先の完了コード（8文字）<input value={code} onChange={event => setCode(event.target.value)} placeholder="XXXX-XXXX" aria-label="移行の完了コード" /></label>
      <button type="button" className="primary-button" disabled={!code.trim()} onClick={event => void run(() => completeMoveOnSender(code, event.nativeEvent), '移行を完了しました。この端末は読み取り専用です')}>コードを確認して移行を完了</button>
      <button type="button" className="secondary-button" onClick={event => void run(() => cancelMove(event.nativeEvent), '移行を取り消し、この端末を再開しました')}>移行を取り消す</button>
    </div>}
    <p className="muted">別端末に残ったコピーを遠隔で停止・削除することはできません。</p>
  </section>
}
