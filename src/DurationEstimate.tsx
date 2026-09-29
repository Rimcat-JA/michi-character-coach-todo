import type { ScoreInput } from './domain'
import { estimatedDuration } from './estimates'

export default function DurationEstimate({ score }: { score: ScoreInput }) {
  const estimate = estimatedDuration(score)
  return <div className="score-preview"><span>時間の内訳</span><strong>作業 {estimate.work === null ? '未設定' : `${estimate.work}分`} ＋ 移動 {estimate.travel === null ? '未設定' : `${estimate.travel}分`} ＝ 合計 {estimate.total === null ? '未確定' : `${estimate.total}分`}</strong><small>移動時間は合計に一度だけ加えます。今日の作業容量には作業時間だけを使います。</small></div>
}
