import { useState } from 'react'
import ReplanCandidatesView from './ReplanCandidatesView'
import { restCoachNotificationsToday } from './coach-notification-save'
import type { Settings } from './domain'

export default function SelfReportOptions({ settings }: { settings: Settings }) {
  const [choice, setChoice] = useState<'open' | 'replan' | 'kept'>('open'), [notice, setNotice] = useState('')
  if (choice === 'kept') return <p className="muted" role="status">そのままにしました。予定も通知も変えていません。</p>
  return <div className="card self-report-options" role="group" aria-label="本人申告の選択肢">
    <p>無理をしなくて大丈夫です。必要なものだけ選べます（まだ何も変更していません）。</p>
    <div className="export-buttons">
      <button className="secondary-button" onClick={async event => { if (!event.nativeEvent.isTrusted) return; try { await restCoachNotificationsToday(); setNotice('今日のコーチ通知を休みにしました。待機中の通知も取り消しました。本人への返信と本人が始めたタイマーは対象外です。') } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }}>今日のコーチ通知を休む</button>
      <button className="secondary-button" onClick={() => setChoice('replan')}>今日の予定から選んで移す</button>
      <button className="text-button" onClick={() => setChoice('kept')}>このままにする</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {choice === 'replan' && <ReplanCandidatesView settings={settings} selfReport onClose={() => setChoice('open')} />}
  </div>
}
