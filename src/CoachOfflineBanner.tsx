import { AI_OFFLINE_MESSAGE } from './coach-offline'

export function CoachOfflineBanner({ reason }: { reason: string }) {
  return <p role="alert" className="coach-offline-banner"><strong>{AI_OFFLINE_MESSAGE}</strong>（{reason}）。入力は下書きとして保存できます。送信ボタンは下書きの保存だけを行い、架空の応答やタスク検出は作りません。</p>
}
