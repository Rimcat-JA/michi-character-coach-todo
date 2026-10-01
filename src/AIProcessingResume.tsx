import { useState } from 'react'
import type { Settings } from './domain'
import type { ChangeContext } from './change-set'
import { previewResume, resumeAuthorityFromUI, type ResumePreview } from './automation-control'

const ownerChangeContext = (settings: Settings): ChangeContext => ({ principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'notes', 'scheduledDate', 'dueDate', 'manualPoints'], sourceRevisions: [] })
/** Same resume as S20: the effects are shown first, then a second native click resumes and records automation.resume. */
export default function AIProcessingResume({ settings, label }: { settings: Settings; label: string }) {
  const [preview, setPreview] = useState<ResumePreview | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  async function act(action: () => Promise<unknown>, success = '') {
    if (busy) return
    setBusy(true); setNotice('')
    try { await action(); if (success) setNotice(success) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  return <div className="ai-resume">
    {!preview && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(async () => setPreview(await previewResume('aiProcessing')))}>{label}</button>}
    {preview && <div role="group" aria-label="AI処理の再開の確認"><p>AI処理を再開すると：</p><ul>{preview.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><div className="change-set-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setPreview(null)}>やめる</button><button type="button" className="primary-button" disabled={busy} onClick={event => { const native = event.nativeEvent; void act(async () => { await resumeAuthorityFromUI(ownerChangeContext(settings), native, 'aiProcessing', preview.token); setPreview(null) }, 'AI処理を再開しました。') }}>本人としてAI処理を再開する</button></div></div>}
    {notice && <small role="status">{notice}</small>}
  </div>
}
