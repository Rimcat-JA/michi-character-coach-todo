import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HandoffReviewTable, LocalOnlyRows } from './HandoffReviewView'
import DeviceHandoffView from './DeviceHandoffView'
import type { HandoffPreview } from './handoff'
import type { Settings } from './domain'

const preview: HandoffPreview = {
  manifest: { bundle_id: 'bundle-2', kind: 'backup', dataset_id: 'dataset', source_device_id: 'device-b', exported_at: '2026-10-02T03:00:00.000Z', base_bundle_id: 'bundle-1' }, sameDataset: true, localDatasetId: 'dataset', incomingDatasetId: 'dataset', alreadyImported: false,
  counts: { localTasks: 1, incomingTasks: 1, localCompletions: 1, incomingCompletions: 0, localLedger: 1, incomingLedger: 0 },
  comparison: { baseKnown: true, blocking: true, localOnlyRows: { ledger: 1 }, tasks: [
    { taskId: 'task-1', title: '資料作成', state: 'both_changed', manualConflict: true, completionConflict: true, localRevision: 3, diffs: [
      { field: 'manualPoints', base: 25, local: 40, incoming: 30, changedBy: 'both' },
      { field: 'completed', base: false, local: true, incoming: false, changedBy: 'local' },
    ] },
    { taskId: 'task-2', title: '同じタスク', state: 'identical', manualConflict: false, completionConflict: false, localRevision: 1, diffs: [] },
  ] },
}
const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: false, aiEnabled: false, automation: 'A0', lastBackupAt: null }

describe('I05 手動の引継ぎ確認画面', () => {
  it('基準・この端末・取込ファイルを並べ、手動ポイントを強調し、完了の違いは要手動対応にする', () => {
    const html = renderToStaticMarkup(<HandoffReviewTable preview={preview} selected={{}} onToggle={() => undefined} onAdopt={() => undefined} onAdoptTask={() => undefined} busy={false} />)
    for (const text of ['基準', 'この端末', '取込ファイル', '資料作成', '両方で変更', '手動ポイント', '>25<', '>40<', '>30<', '要手動対応', '台帳は統合しません', '選んだ項目を取り込む']) expect(html).toContain(text)
    expect(html).toContain('handoff-manual'); expect(html).toContain('<span class="status-tag">手動</span>')
    expect(html).not.toContain('同じタスク')
    expect(html).not.toMatch(/同期済|マージ済/)
    expect(renderToStaticMarkup(<LocalOnlyRows preview={preview} />)).toContain('ポイント台帳1件')
  })
  it('端末間の引継ぎ欄は自動同期と言わず、サーバー接続が未提供であることを示す', () => {
    const html = renderToStaticMarkup(<DeviceHandoffView settings={settings} password="" run={async () => true} />)
    expect(html).toContain('同時に編集し続けるにはサーバー接続が必要です（このバージョンでは未提供）')
    expect(html).toContain('自動同期ではありません'); expect(html).toContain('この端末から移行'); expect(html).toContain('別データセットとして複製を書き出す')
    expect(html).not.toMatch(/同期済|マージ済/)
  })
})
