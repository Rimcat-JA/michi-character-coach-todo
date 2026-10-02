import { useMemo, useState } from 'react'
import { calendarCSVHeaders } from './calendar-csv-import'
import { readCSVRawRecords, validateCSVMappingProfile, type CSVMappingProfile } from './calendar-csv-mapping'

export default function CalendarCSVMappingStep({ kind, bytes, initial, onChange }: { kind: 'calendar' | 'roster'; bytes: Uint8Array | null; initial?: CSVMappingProfile; onChange: (profile: CSVMappingProfile | null) => void }) {
  const [profile, setProfile] = useState<CSVMappingProfile>(() => initial ?? { version: 1, name: '', revision: 1, kind, encoding: 'utf-8', delimiter: ',', headerRow: 1, dataStartRow: 2, columns: {}, dateFormat: 'YYYY-MM-DD', explicitYear: null, timeFormat: 'HH:MM', endDayRule: 'explicit_end_date', statusMap: kind === 'calendar' ? { open: 'open', closed: 'closed', withdrawn: 'withdrawn' } : { scheduled: 'scheduled', cancelled: 'cancelled' }, publishedMap: kind === 'roster' ? { true: true, false: false } : {}, recordIdStrategy: 'column', revisionStrategy: 'column' })
  const [statusText, setStatusText] = useState(JSON.stringify(profile.statusMap)), [publishedText, setPublishedText] = useState(JSON.stringify(profile.publishedMap)), [error, setError] = useState('')
  const preview = useMemo(() => { try { return { rows: bytes ? readCSVRawRecords(bytes, profile.encoding, profile.delimiter) : [], error: '' } } catch (error) { return { rows: [], error: error instanceof Error ? error.message : String(error) } } }, [bytes, profile.encoding, profile.delimiter])
  const header = preview.rows[profile.headerRow - 1]?.cells ?? []
  function change(next: CSVMappingProfile) { setProfile(next); try { validateCSVMappingProfile(next); setError(''); onChange(next) } catch (error) { setError(error instanceof Error ? error.message : String(error)); onChange(null) } }
  const required = calendarCSVHeaders[kind]
  const vocabulary = (field: string) => { const column = profile.columns[field]; return column ? [...new Set(preview.rows.slice(profile.dataStartRow - 1).map(row => row.cells[column.index]))].slice(0, 100).join(' / ') : '列を選択してください' }
  return <section className="csv-preview" aria-label="任意列の対応設定"><h3>任意列の対応設定</h3>
    <p>原文と列の位置を確認し、設定を名前付きで資料に保存します。他者と下書きの行は保存しません。</p>
    <div className="form-grid">
      <label className="field">設定名<input aria-label="列対応の設定名" value={profile.name} maxLength={120} onChange={event => change({ ...profile, name: event.target.value })} /></label>
      <label className="field">設定の版<input aria-label="列対応の版" type="number" min={1} value={profile.revision} onChange={event => change({ ...profile, revision: Number(event.target.value) })} /></label>
      <label className="field">文字コード<select aria-label="資料の文字コード" value={profile.encoding} onChange={event => change({ ...profile, encoding: event.target.value as CSVMappingProfile['encoding'] })}><option value="utf-8">UTF-8</option><option value="shift_jis">Shift_JIS</option></select></label>
      <label className="field">区切り<select aria-label="資料の区切り" value={profile.delimiter} onChange={event => change({ ...profile, delimiter: event.target.value as CSVMappingProfile['delimiter'] })}><option value=",">カンマ</option><option value={'\t'}>タブ</option><option value=";">セミコロン</option></select></label>
      <label className="field">見出しのレコード番号<input aria-label="資料の見出し行" type="number" min={1} max={20} value={profile.headerRow} onChange={event => change({ ...profile, headerRow: Number(event.target.value), columns: {} })} /></label>
      <label className="field">データ開始番号<input aria-label="資料のデータ開始行" type="number" min={2} max={40} value={profile.dataStartRow} onChange={event => change({ ...profile, dataStartRow: Number(event.target.value) })} /></label>
      <label className="field">日付形式<select aria-label="資料の日付形式" value={profile.dateFormat} onChange={event => change({ ...profile, dateFormat: event.target.value as CSVMappingProfile['dateFormat'] })}>{['YYYY-MM-DD', 'YYYY/M/D', 'YYYY年M月D日', 'M/D'].map(value => <option key={value}>{value}</option>)}</select></label>
      {profile.dateFormat === 'M/D' && <label className="field">本人が確認した年<input aria-label="資料の明示した年" type="number" min={1900} max={9999} value={profile.explicitYear ?? ''} onChange={event => change({ ...profile, explicitYear: event.target.value ? Number(event.target.value) : null })} /></label>}
      <label className="field">時刻形式<select aria-label="資料の時刻形式" value={profile.timeFormat} onChange={event => change({ ...profile, timeFormat: event.target.value as CSVMappingProfile['timeFormat'] })}>{['HH:MM', 'H:MM', 'H時MM分'].map(value => <option key={value}>{value}</option>)}</select></label>
      {kind === 'roster' && <label className="field">終了日<select aria-label="資料の終了日規則" value={profile.endDayRule} onChange={event => change({ ...profile, endDayRule: event.target.value as CSVMappingProfile['endDayRule'] })}><option value="explicit_end_date">終了日の列を使う</option><option value="next_day_when_end<=start">終了時刻が開始以前なら翌日（本人の選択）</option></select></label>}
      <label className="field">安定ID<select aria-label="資料のID方式" value={profile.recordIdStrategy} onChange={event => change({ ...profile, recordIdStrategy: event.target.value as CSVMappingProfile['recordIdStrategy'] })}><option value="column">資料のID列</option><option value="derived">本人・日付・開始枠から作る（日付移動は別記録）</option></select></label>
      <label className="field">資料の版<select aria-label="資料の版方式" value={profile.revisionStrategy} onChange={event => change({ ...profile, revisionStrategy: event.target.value as CSVMappingProfile['revisionStrategy'] })}><option value="column">資料の版列</option><option value="import_order">本人確認した取込順</option></select></label>
      {required.map(field => <label className="field" key={field}>{field}{field==='end_date'&&profile.endDayRule==='next_day_when_end<=start'&&<small>翌日規則を使う場合は未指定にできます</small>}<select aria-label={`列対応 ${field}`} value={profile.columns[field]?.index ?? ''} onChange={event => { const columns = { ...profile.columns }; if (event.target.value === '') delete columns[field]; else { const index = Number(event.target.value); columns[field] = { index, headerText: header[index] } }; change({ ...profile, columns }) }}><option value="">未指定</option>{header.map((text, index) => <option key={index} value={index}>{index + 1}: {text}</option>)}</select></label>)}
    </div>
    <p>状態の値：{vocabulary('status')}<br />公開状態の値：{kind === 'roster' ? vocabulary('published') : '対象外'}</p>
    <label className="field">状態の対応（JSON）<textarea aria-label="状態の対応" value={statusText} onChange={event => { setStatusText(event.target.value); try { change({ ...profile, statusMap: JSON.parse(event.target.value) }) } catch { setError('状態のJSONを確認してください'); onChange(null) } }} /></label>
    {kind === 'roster' && <label className="field">公開状態の対応（JSON）<textarea aria-label="公開状態の対応" value={publishedText} onChange={event => { setPublishedText(event.target.value); try { change({ ...profile, publishedMap: JSON.parse(event.target.value) }) } catch { setError('公開状態のJSONを確認してください'); onChange(null) } }} /></label>}
    {(preview.error || error) && <p role="alert">{preview.error || error}</p>}
    <details><summary>原文の先頭20レコード（端末内の確認だけ）</summary>{preview.rows.slice(0, 20).map(row => <pre key={row.recordNumber}>{row.recordNumber}: {row.quote}</pre>)}</details>
    <button type="button" className="secondary-button" onClick={() => change(profile)}>この列対応設定を確認案に使う</button>
  </section>
}
