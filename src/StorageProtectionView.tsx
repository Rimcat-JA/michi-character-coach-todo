import { Database } from 'lucide-react'
import { formatMegabytes, protectionLabel, type StorageProtection } from './storage-status'

/** 18.10: storage limits are shown, never used to block input; the backup route stays visible when protection is refused. */
export function StorageProtectionCard({ protection, unbacked, lastBackupAt, datasetId, electron, onPersist, onBackup }: { protection: StorageProtection | null; unbacked: number | null; lastBackupAt: string | null; datasetId: string; electron: boolean; onPersist: () => void; onBackup: () => void }) {
  const unprotected = protection !== null && protection.persisted !== true
  return <section className="card setting-section storage-protection" aria-label="ローカルデータ">
    <div className="setting-heading"><Database size={20} /><div><h2>ローカルデータ</h2><p>タスクと台帳はこの端末のIndexedDBが正本です。{electron ? 'Windows版はアプリのユーザーデータフォルダー内に保存します。' : ''}</p></div></div>
    <div className="data-row"><span>データセット</span><code>{datasetId.slice(0, 8)}…</code></div>
    <div className="data-row"><span>保存保護</span><strong data-storage-persisted={protection?.persisted === true ? 'granted' : protection?.requested === 'denied' ? 'denied' : protection?.persisted === false ? 'not-granted' : 'unknown'}>{protectionLabel(protection)}</strong></div>
    <div className="data-row"><span>保存使用量</span><strong>{protection ? `${formatMegabytes(protection.usage)} / ${formatMegabytes(protection.quota)}` : '確認中'}</strong></div>
    <div className="data-row"><span>最後の書き出し</span><strong>{lastBackupAt ? new Date(lastBackupAt).toLocaleString('ja-JP') : 'まだありません'}</strong></div>
    <div className="data-row"><span>未バックアップ変更数</span><strong data-unbacked-changes>{unbacked === null ? '確認中' : `${unbacked}件`}</strong></div>
    <p className="muted">サイトデータの消去、アプリのアンインストール、端末の故障・紛失でこの端末のデータは失われます。同じPC内に置いたバックアップは故障対策になりません。USBや別の端末へ書き出してください。</p>
    {unprotected && <p role="note">保存保護がなくても入力はこれまでどおり続けられます。暗号化バックアップで定期的に書き出してください。</p>}
    <div className="export-buttons"><button className="secondary-button" onClick={onPersist}>保存保護を要求</button><button className={unprotected || (unbacked ?? 0) > 0 ? 'primary-button' : 'secondary-button'} onClick={onBackup}>バックアップを書き出す</button></div>
  </section>
}
