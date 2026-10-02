import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import SharingView, { SharedItemCard } from './SharingView'
import type { Settings } from './domain'
import type { SharedInbound } from './share-types'

const settings: Settings = { id: 'main', profileId: 'owner', datasetId: 'dataset', createdAt: '2026-10-01T00:00:00.000Z', coachName: 'コーチ', dailyMinutes: 480, dailyPoints: 100, notifications: false, aiEnabled: false, automation: 'A0', lastBackupAt: null }
const item: SharedInbound = { id: 'share-1', ownerFp: 'f'.repeat(64), ownerLabel: '所有者A', role: 'viewer', epoch: 1, sequence: 1, replySequence: 0, sharedFields: ['title', 'scheduled_date'], projection: { share_task_id: 'share-1', title: '見積を送る', scheduled_date: '2026-10-05' }, shareNote: '確認をお願いします', receivedAt: '2026-10-02T03:00:00.000Z', revokedAt: null }

describe('I06 共有画面', () => {
  it('受け取った項目は共有された項目だけを読み取り専用で表示し、出典は開けない', () => {
    const html = renderToStaticMarkup(<SharedItemCard item={item} onSource={() => undefined} />)
    expect(html).toContain('見積を送る'); expect(html).toContain('予定日: 2026-10-05'); expect(html).toContain('共有元: 所有者A')
    expect(html).not.toContain('締め切り'); expect(html).not.toContain('ポイント'); expect(html).not.toContain('<input')
    expect(html).toContain('出典を開く')
  })
  it('ファイルでの共有スナップショットと呼び、遠隔削除できないことと共有しない項目を明示する', () => {
    const html = renderToStaticMarkup(<SharingView settings={settings} tasks={[]} run={async () => true} />)
    for (const text of ['ファイルでの共有スナップショット', '相手の端末にあるコピーは遠隔削除できません', 'メモ・コメント・添付・履歴・出典は共有しません', '自分のタスク・今日の予定・ポイント・台帳・資料検索には入りません', '共有用の名刺を作成']) expect(html).toContain(text)
    expect(html).not.toMatch(/同期済|リアルタイムで共有中/)
  })
})
