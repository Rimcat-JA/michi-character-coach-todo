import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, trashTask, updateTask } from './commands'
import { emptyScore } from './domain'
import { coachNotificationStateFor, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import { runCoachTriggers } from './coach-triggers'
import CoachInboxView from './CoachInboxView'

describe('N07 アプリ内の通知一覧は完了・削除・変更後のタスクの通知を表示しない（履歴は残す）', () => {
  const at = new Date(2026, 9, 1, 9, 30).toISOString()
  let id: string
  beforeEach(async () => {
    await db.delete(); await db.open(); await ensureSettings()
    await db.settings.update('main', { notifications: true }); await setCoachNotificationPolicy({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    await setCoachNotificationTriggers({ deadlineNear: { enabled: true, leadDays: 1, time: '09:00', os: true } })
    id = await createTask({ ...newTaskInput(), title: '週次報告書', scheduledDate: '2026-10-01', dueDate: '2026-10-02', score: emptyScore() })
    await runCoachTriggers({}, at)
  })
  const inbox = async () => renderToStaticMarkup(<CoachInboxView settings={(await db.settings.get('main'))!} tasks={await db.tasks.toArray()} run={async () => true} />)
  it.each([
    ['完了', async (task: { revision: number }) => { await completeTask(id, task.revision) }],
    ['期限の変更', async (task: { revision: number }) => { const current = (await db.tasks.get(id))!; await updateTask(id, task.revision, { ...current, dueDate: '2026-10-09' }) }],
    ['削除', async (task: { revision: number }) => { await trashTask(id, task.revision) }],
  ])('%sの後は通知を表示せず、アプリ内の記録は accepted_by_provider のまま、OSは取消', async (_label, change) => {
    expect(await inbox()).toContain('期限が近いタスク: 週次報告書（期限 2026-10-02）')
    await change((await db.tasks.get(id))!)
    expect(await inbox()).not.toContain('期限が近いタスク: 週次報告書')
    const intent = coachNotificationStateFor((await db.settings.get('main'))!).intents[0]
    expect(intent.deliveries.find(item => item.destinationId === 'in-app')?.state).toBe('accepted_by_provider')
    expect(intent.deliveries.find(item => item.destinationId === 'os')?.state).toBe('canceled')
    expect(intent.readAt ?? null).toBeNull()
  })
})
