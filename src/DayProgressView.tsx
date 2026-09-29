import { dayProgress } from './progress'
import type { Completion, DayProgressBaseline, Task } from './domain'

export default function DayProgressView({ baseline, date, tasks, completions }: { baseline?: DayProgressBaseline; date: string; tasks: Task[]; completions: Completion[] }) {
  const progress = dayProgress(baseline, date, tasks, completions)
  return <section className="card day-progress"><div className="card-heading"><h2>今日の進捗</h2><span className="subtle">基準を固定して表示</span></div>
    {baseline?.date === date ? <><p>初回表示時の計画：{progress.baselineDone} / {progress.baselineTotal}件完了（{progress.baselinePercent}%）</p><progress value={progress.baselineDone} max={Math.max(1, progress.baselineTotal)} aria-label="初回表示時の計画の完了率" /><p className="muted">基準：作業 {progress.baselineMinutes}分{progress.baselineUnknownMinutes ? `＋未設定${progress.baselineUnknownMinutes}件` : ''}、必要 {progress.baselinePoints}pt{progress.baselineUnknownPoints ? `＋未設定${progress.baselineUnknownPoints}件` : ''}。{new Date(baseline.capturedAt).toLocaleString('ja-JP')}に記録。</p><p>途中で追加・再計画：{progress.addedDone} / {progress.addedTotal}件（作業 {progress.addedMinutes}分、必要 {progress.addedPoints}pt）。初回の分母には加えません。</p></> : <p className="muted">今日の基準を準備しています…</p>}
  </section>
}
