import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { calculateScore, type ScoreInput, type Settings } from './domain'
import { db } from './db'
import { egressNotice, recordEgressAudit, type OwnerNotesEgress } from './egress-policy'
import { acceptScoreCandidate, parseScoreCandidate, scoreAttributeKeys, scoreReferencePreview, type ScoreAcceptanceProvenance, type ScoreAttributeKey, type ScoreAttributeValues, type ScoreCandidate } from './score-assist'

const labels: Record<ScoreAttributeKey, string> = { minutes: '作業時間（分）', travelMinutes: '移動時間（分）', difficulty: '難易度（0〜4）', uncertainty: '不確実性（0〜3）', coordination: '対人調整（0〜3）', physical: '身体負荷（0〜3）', outing: '独立した外出' }
type Proposal = { candidate: ScoreCandidate; edited: ScoreAttributeValues; selected: ScoreAttributeKey[]; scoreSnapshot: string; sourceText: string; model: string }

/** selectedText must already be egress-filtered by the caller (ownerNotesForEgress); egress only describes what was withheld. */
export default function ScoreAssistView({ score, onAccepted, onProvenance, settings, selectedText, taskId = null, egress = null }: {
  score: ScoreInput; onAccepted: (score: ScoreInput) => void; onProvenance?: (provenance: ScoreAcceptanceProvenance) => void; settings: Settings; selectedText: string; taskId?: string | null; egress?: OwnerNotesEgress | null
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const available = Boolean(settings.aiEnabled && settings.aiModel && window.michiAI?.assessScore)
  // Evidence rows are never part of selectedText; they are counted so the notice states what stays home.
  const evidenceCount = useLiveQuery(() => taskId ? db.taskSourceEvidence.where('taskId').equals(taskId).count() : 0, [taskId]) ?? 0
  const withheld: OwnerNotesEgress = { notes: egress?.notes ?? '', withheldQuotes: (egress?.withheldQuotes ?? 0) + evidenceCount, notesWithheld: egress?.notesWithheld ?? false }
  const stale = Boolean(proposal && (proposal.sourceText !== selectedText || proposal.scoreSnapshot !== JSON.stringify(score)))
  let preview = null
  let validationError = ''
  if (proposal) {
    const proposed = { ...score }
    for (const field of proposal.selected) {
      if (field === 'outing') proposed.outing = proposal.edited.outing
      else proposed[field] = proposal.edited[field]
    }
    try { preview = scoreReferencePreview(proposed) }
    catch (error) { validationError = error instanceof Error ? error.message : String(error) }
  }
  async function ask() {
    if (!available || busy) return
    const sourceText = selectedText
    const model = settings.aiModel!
    const snapshot = JSON.stringify(score)
    setBusy(true); setNotice(''); setProposal(null)
    try {
      await db.transaction('rw', db.audits, () => recordEgressAudit({ kind: 'ai-model', route: 'score-assist', model }, [{ taskId, egress: withheld }]))
      const answer = await window.michiAI!.assessScore({ model, text: sourceText })
      const candidate = parseScoreCandidate(sourceText, answer)
      setProposal({ candidate, edited: { ...candidate.values }, selected: scoreAttributeKeys.filter(field => score[field] === null && candidate.values[field] !== null), scoreSnapshot: snapshot, sourceText, model })
      setNotice('推定を含む属性候補です。根拠と値を確認し、採用する項目を選んでください。')
    } catch (error) { setNotice(`${error instanceof Error ? error.message : String(error)} 現在の点数と属性は残っています。`) }
    finally { setBusy(false) }
  }
  function change(field: ScoreAttributeKey, value: number | boolean | null) {
    setProposal(current => current && { ...current, edited: { ...current.edited, [field]: value } })
  }
  function accept() {
    if (!proposal || stale) return
    try {
      const accepted = acceptScoreCandidate(score, proposal.candidate, proposal.edited, proposal.selected, proposal.model, proposal.sourceText)
      onProvenance?.(accepted.provenance)
      onAccepted(accepted.score)
      setProposal(null); setNotice('確認した属性を編集欄へ反映しました。タスクの保存で確定します。')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  let currentLabel = '入力値を確認してください'
  try {
    const current = calculateScore(score)
    currentLabel = `${current.effective === null ? '未確定' : `${current.effective}pt`}（${current.label}）`
  } catch { /* The parent editor can temporarily contain incomplete numeric input. */ }
  return <section className="card score-assist">
    <h3>AIで負荷属性を見積もる</h3>
    <p className="muted">このタスクの選択本文だけをOpenRouterへ送ります。候補の点数は端末内の式 v1で計算し、採用した属性と根拠を保存時に記録します。資料から検出したタスクの引用（資料の根拠）は送りません。</p>
    {egressNotice(withheld) && <p role="note">{egressNotice(withheld)}</p>}
    <details><summary>見積もりに使う選択本文</summary><p style={{ whiteSpace: 'pre-wrap' }}>{selectedText || '本文がありません'}</p></details>
    <p>現在の必要ポイント：{currentLabel}</p>
    {!available && <p className="muted">AIは停止中、またはこの環境では利用できません。属性は通常の編集欄から入力できます。</p>}
    <button type="button" className="secondary-button" disabled={!available || busy || !selectedText.trim() || selectedText.length > 6000} onClick={ask}>{busy ? '属性候補を待っています…' : '選択本文から属性候補を作る'}</button>
    {notice && <p role="status">{notice}</p>}
    {proposal && <div className="score-assist-preview">
      <div className="form-grid">{scoreAttributeKeys.map(field => <div className="field" key={field}>
        <label><input type="checkbox" checked={proposal.selected.includes(field)} onChange={event => setProposal(current => current && { ...current, selected: event.target.checked ? [...current.selected, field] : current.selected.filter(item => item !== field) })} /> {labels[field]}を採用</label>
        {field === 'outing' ? <select aria-label="候補・独立した外出" value={proposal.edited.outing === null ? '' : String(proposal.edited.outing)} onChange={event => change(field, event.target.value === '' ? null : event.target.value === 'true')}><option value="">不明</option><option value="true">必要</option><option value="false">不要</option></select> : <input aria-label={`候補・${labels[field]}`} type="number" min={0} max={field === 'minutes' || field === 'travelMinutes' ? 10080 : field === 'difficulty' ? 4 : 3} step={1} value={proposal.edited[field] ?? ''} onChange={event => change(field, event.target.value === '' ? null : Number(event.target.value))} />}
        <small>現在：{score[field] === null ? '不明' : typeof score[field] === 'boolean' ? score[field] ? '必要' : '不要' : score[field]}</small>
        <small>{proposal.candidate.evidence[field] === null ? 'AIは根拠を判断できませんでした。空欄は不明のままです。' : `AI推定の根拠：「${proposal.candidate.evidence[field]}」`}</small>
      </div>)}</div>
      {preview && <p>参考計算（式 v1）：{preview.effective !== null ? `${preview.effective}pt` : preview.upper === null ? `${preview.lower}pt〜（上限不明）` : `${preview.lower}〜${preview.upper}pt`}{score.mode === 'manual' || score.mode === 'allocated' ? `。採用後も現在の${score.mode === 'manual' ? '手動' : '配分'}${score.manualPoints}ptを使用します。` : '。採用後も現在の点数モードを維持します。'}</p>}
      {validationError && <p role="alert">{validationError}</p>}
      {stale && <p role="alert">見積もり後に本文または属性が変わりました。新しい内容で候補を作り直してください。</p>}
      <button type="button" className="primary-button" disabled={!proposal.selected.length || stale || Boolean(validationError)} onClick={accept}>選んだ属性を編集欄へ反映</button>
    </div>}
  </section>
}
