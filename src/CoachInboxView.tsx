import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import CoachConsultView, { type ConsultNotification } from './CoachConsultView'
import ReplanCandidatesView from './ReplanCandidatesView'
import { coachNotificationStateFor, currentCoachNotificationGuard, muteCoachNotificationTarget, readCoachNotification, restCoachNotificationsToday } from './coach-notification-save'
import { savedAIUsable, type CoachNotificationIntent } from './coach-notifications'
import { isCalendarIntent, isDeadlineIntent, isReplanIntent } from './coach-facts'
import type { Settings, Task } from './domain'

type Run = (fn: () => Promise<unknown>, success?: string) => Promise<boolean>
/** Fixed controls on every notification (15.2): reply to adjust, mute this target, rest today. No LLM involved. */
export function NotificationActions({ settings, tasks, notification, targetId, muteLabel = 'このタスクは通知しない', run, onEdit, extra }: { settings: Settings; tasks: Task[]; notification: ConsultNotification | null; targetId: string; muteLabel?: string; run: Run; onEdit?: (task: Task) => void; extra?: React.ReactNode }) {
  const [replying, setReplying] = useState(false)
  return <>
    <div className="export-buttons">{notification && <button className="secondary-button" onClick={() => setReplying(value => !value)}>返信して調整</button>}{extra}<button className="text-button" onClick={() => run(() => muteCoachNotificationTarget(targetId), '対象の通知を停止しました（待機中の通知も取消）')}>{muteLabel}</button><button className="text-button" onClick={() => run(() => restCoachNotificationsToday(), '今日のコーチ通知を停止しました')}>今日は休む</button></div>
    {replying && notification && <CoachConsultView settings={settings} tasks={tasks} notification={notification} onEdit={onEdit} onClose={() => setReplying(false)} />}
  </>
}
const triggerIntent = (intent: CoachNotificationIntent) => isDeadlineIntent(intent) || isCalendarIntent(intent) || isReplanIntent(intent)
/** N07 in-app inbox for fact triggers (期限・公式変更・再計画の確認). Reminders keep their own list. */
export default function CoachInboxView({ settings, tasks, run, onEdit }: { settings: Settings; tasks: Task[]; run: Run; onEdit?: (task: Task) => void }) {
  const state = coachNotificationStateFor(settings), triggers = state.triggers
  // A task notice is shown only while its task is still open at the notified revision (完了・削除・変更後は表示しない). History is kept.
  const live = (intent: CoachNotificationIntent) => { if (intent.target.kind !== 'task') return true; const task = tasks.find(item => item.id === intent.target.id); return Boolean(task && !task.deletedAt && task.status === 'open' && task.revision === intent.target.revision) }
  const items = state.intents.filter(intent => triggerIntent(intent) && !intent.readAt && live(intent) && intent.deliveries.some(delivery => delivery.destinationId === 'in-app' && delivery.state === 'accepted_by_provider')).slice(-10).reverse()
  const digests = useLiveQuery(async () => Object.fromEntries(await Promise.all(items.filter(intent => intent.text.savedAI).map(async intent => [intent.id, (await currentCoachNotificationGuard(intent.id))?.factsDigest ?? null] as const))), [JSON.stringify(items.map(intent => intent.id)), settings.aiEnabled, tasks]) ?? {}
  const [replanOpen, setReplanOpen] = useState(false)
  if (!items.length) return null
  return <section className="card reminder-center coach-inbox" aria-label="コーチからの通知">
    <h2>コーチからの通知 {items.length}件</h2>
    <div className="reminder-items">{items.map(intent => {
      const ai = Boolean(triggers?.aiText) && savedAIUsable(intent, { aiEnabled: settings.aiEnabled, aiModel: settings.aiModel ?? null, factsDigest: digests[intent.id] ?? null })
      const task = intent.target.kind === 'task' ? tasks.find(item => item.id === intent.target.id) : undefined
      return <div key={intent.id} className="setting-line coach-inbox-item"><div><strong>{ai ? intent.text.savedAI : intent.text.factual}</strong><small>{new Date(intent.reservedAt).toLocaleString('ja-JP')} · {ai ? `AI文面（保存済み・${intent.text.savedAIModel ?? 'モデル不明'}）` : '事実の定型文'} · アプリ内に表示（既読の確認ではありません）</small>
        <NotificationActions settings={settings} tasks={tasks} run={run} onEdit={onEdit} targetId={intent.target.id} muteLabel={intent.target.kind === 'task' ? 'このタスクは通知しない' : 'この通知を今日は止める'} notification={task ? { id: intent.id, title: task.title, taskIds: [task.id], revisions: { [task.id]: intent.target.revision } } : null} extra={<>{isReplanIntent(intent) && <button className="secondary-button" onClick={() => setReplanOpen(value => !value)}>再計画の候補を見る</button>}<button className="text-button" onClick={() => run(() => readCoachNotification(intent.id), '確認しました')}>確認</button></>} /></div></div>
    })}</div>
    {replanOpen && <ReplanCandidatesView settings={settings} onClose={() => setReplanOpen(false)} />}
  </section>
}
