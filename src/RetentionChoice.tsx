import type { RetentionDraft } from './retention-defaults'

/** The default date is shown filled in; "no expiry" is never implied by an empty field. */
export default function RetentionChoice({ label, value, onChange, defaultNote, disabled = false }: { label: string; value: RetentionDraft; onChange: (next: RetentionDraft) => void; defaultNote: string; disabled?: boolean }) {
  return <fieldset className="retention-choice" disabled={disabled}>
    <legend>{label}</legend>
    <label className="field">保持期限（この日の終わりに本文と派生情報を消去）<input type="date" aria-label={`${label}の日付`} value={value.date} disabled={value.unlimited} onChange={event => onChange({ ...value, date: event.target.value })} /></label>
    <label><input type="checkbox" aria-label={`${label}を期限なし（長期保存）にする`} checked={value.unlimited} onChange={event => onChange({ ...value, unlimited: event.target.checked })} /> 期限なし（長期保存）を本人が選ぶ</label>
    <small className="muted">{defaultNote}</small>
  </fieldset>
}
