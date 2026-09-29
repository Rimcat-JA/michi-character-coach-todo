import { useState } from 'react'
import { createTask, createTasksAtomic } from './commands'
import { parseBraindump, parseQuickAddLine, setQuickAddPoints } from './quick-add'

type Candidate = { line: number; source: string; selected: boolean; manual: string; edited: boolean }

function candidateResult(candidate: Candidate) {
  const parsed = parseQuickAddLine(candidate.source)
  if (!parsed.ok || !candidate.edited) return parsed
  return setQuickAddPoints(parsed.input, candidate.manual)
}

export default function Braindump() {
  const [draft, setDraft] = useState('')
  const [rows, setRows] = useState<Candidate[]>([])
  const [mode, setMode] = useState<'atomic' | 'valid_only'>('atomic')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const preview = rows.map(row => ({ ...row, result: candidateResult(row) }))
  const selected = preview.filter(row => row.selected && row.result.ok)
  const invalid = preview.filter(row => !row.result.ok)

  function inspect() {
    try {
      const parsed = parseBraindump(draft)
      if (!parsed.length) throw new Error('1行以上入力してください')
      setRows(parsed.map(row => ({
        line: row.line, source: row.text, selected: row.result.ok,
        manual: row.result.ok && row.result.input.score.mode === 'manual' ? String(row.result.input.score.manualPoints) : '',
        edited: false
      })))
      setNotice(`${parsed.length}行を確認しました。エラーのある行は登録対象から外しています。`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  function editSource(line: number, source: string) {
    const parsed = parseQuickAddLine(source)
    setRows(current => current.map(row => row.line === line ? {
      ...row, source, selected: row.selected && parsed.ok,
      manual: parsed.ok && parsed.input.score.mode === 'manual' ? String(parsed.input.score.manualPoints) : '',
      edited: false
    } : row))
  }

  async function submit() {
    if (saving) return
    const badSelected = preview.filter(row => row.selected && !row.result.ok)
    if (mode === 'atomic' && badSelected.length) {
      setNotice('選択行にエラーがあります。修正するか選択を外してください。')
      return
    }
    if (!selected.length) { setNotice('登録する正常な行を選んでください'); return }
    setSaving(true)
    try {
      if (mode === 'atomic') {
        const inputs = selected.flatMap(row => row.result.ok ? [row.result.input] : [])
        await createTasksAtomic(inputs)
        const remaining = rows.filter(row => !selected.some(saved => saved.line === row.line))
        setRows(remaining)
        setDraft(remaining.map(row => row.source).join('\n'))
        setNotice(`${selected.length}件をまとめて保存しました。エラー行や未選択行は残しています。`)
      } else {
        const succeeded = new Set<number>()
        const failed: string[] = []
        for (const row of selected) {
          if (!row.result.ok) continue
          try { await createTask(row.result.input); succeeded.add(row.line) }
          catch (error) { failed.push(`${row.line}行目: ${error instanceof Error ? error.message : String(error)}`) }
        }
        const remaining = rows.filter(row => !succeeded.has(row.line))
        setRows(remaining)
        setDraft(remaining.map(row => row.source).join('\n'))
        setNotice(`${succeeded.size}件を個別に保存しました。${failed.length ? `失敗: ${failed.join(' / ')}` : 'エラー行や未選択行は残しています。'}`)
      }
    } catch (error) {
      setNotice(`保存できませんでした。変更は確定していません。${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return <div className="bulk-box">
    <p>1行につき1件。例：<code>図書館へ返却 #生活 @2026-10-01 !due:2026-10-03 ~45m pt:25</code>。AIなしで解析します。</p>
    <textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)} placeholder={'資料を読む ~45m pt:25\n連絡する pt:0'} />
    <button className="secondary-button" onClick={inspect} disabled={!draft.trim() || saving}>候補を確認</button>
    {preview.length > 0 && <>
      <div className="bulk-summary">{preview.length}行中、正常 {preview.length - invalid.length}件・要修正 {invalid.length}件・登録選択 {selected.length}件</div>
      <div className="bulk-preview">
        {preview.map(row => <div className="bulk-preview-row" key={row.line}>
          <label className="bulk-check"><input type="checkbox" checked={row.selected && row.result.ok} disabled={!row.result.ok || saving} onChange={event => setRows(current => current.map(item => item.line === row.line ? { ...item, selected: event.target.checked } : item))} /><span>{row.line}行</span></label>
          <input aria-label={`${row.line}行目の内容`} value={row.source} disabled={saving} onChange={event => editSource(row.line, event.target.value)} />
          <label className="bulk-points">手動pt<input aria-label={`${row.line}行目の手動ポイント`} inputMode="numeric" value={row.manual} disabled={saving || !parseQuickAddLine(row.source).ok} onChange={event => setRows(current => current.map(item => item.line === row.line ? { ...item, manual: event.target.value, edited: true } : item))} placeholder="未設定" /></label>
          <small className={row.result.ok ? 'bulk-valid' : 'bulk-error'}>{row.result.ok ? '登録可能' : row.result.error}</small>
        </div>)}
      </div>
      <div className="bulk-actions">
        <label>登録方法 <select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="atomic">選択行をまとめて保存（全件成功）</option><option value="valid_only">正常な選択行を個別に保存</option></select></label>
        <button className="primary-button" onClick={submit} disabled={!selected.length || saving}>{saving ? '保存中…' : `${selected.length}件を登録`}</button>
      </div>
    </>}
    {notice && <p role="status" className="bulk-notice">{notice}</p>}
  </div>
}
