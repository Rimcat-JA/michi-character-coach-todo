import { canonicalJSON, contentDigest } from './canonical'
import { validateDate, validateScore, type CalendarEvent, type ScoreInput, type Settings, type Task } from './domain'
import { calendarDateAt, type CalendarRulesState, type ScheduleFact, type ScheduleSource, type ResolvedCalendarSpec } from './calendar-resolver'
import { canonicalRRule } from './rrule'
import { validLocalDateTime } from './zoned-time'

type Row = Record<string, unknown>
function object(value: unknown, keys: string[]): asserts value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error('カレンダー資料の項目が不正です')
}
function text(value: unknown, name: string, max = 300): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}を確認してください`) }
function id(value: unknown) { text(value, 'ID', 200); if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error('IDには英数字・_ . : - を使ってください') }
function integer(value: unknown, low: number, high: number) { if (!Number.isInteger(value) || Number(value) < low || Number(value) > high) throw new Error('カレンダーの数値が範囲外です') }
function revision(value: unknown) { integer(value, 1, Number.MAX_SAFE_INTEGER) }
function hash(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('CSVの内容hashが不正です') }
function anonymousId(value: unknown) { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('CSVの外部ID・本人参照は匿名hashです') }
function date(value: unknown) { if (typeof value !== 'string') throw new Error('日付が不正です'); validateDate(value, 'カレンダー日付'); if (!value) throw new Error('日付を指定してください') }
function range(from: unknown, to: unknown) { date(from); date(to); if (String(from) > String(to)) throw new Error('有効期間の順序が不正です') }
function bool(value: unknown) { if (typeof value !== 'boolean') throw new Error('確認・公開状態が不正です') }
function choice(value: unknown, values: string[]) { if (typeof value !== 'string' || !values.includes(value)) throw new Error('カレンダー資料の種別が不正です') }
function instant(value: unknown) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('時刻はUTCのISO形式で指定してください') }
function clock(value: unknown) { if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('時刻を確認してください') }
function localDateTime(value: unknown) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('CSV勤務表の現地日時が不正です'); date(value.slice(0, 10)) }
/** CSV feeds keep at most this many import records; fully duplicated older records are pruned on import. */
export const csvSnapshotLimit = 100, csvEvidenceRowLimit = 5000
function zone(value: unknown) { text(value, 'タイムゾーン', 100); try { new Intl.DateTimeFormat('en-US', { timeZone: value }) } catch { throw new Error('タイムゾーンが不正です') } }
function array(value: unknown, max = 5000): asserts value is unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error('カレンダー資料の件数が不正です') }
function ids(value: unknown, max = 1000) { array(value, max); value.forEach(id); if (new Set(value).size !== value.length) throw new Error('IDが重複しています') }
function weekdays(value: unknown) { array(value, 7); value.forEach(day => integer(day, 0, 6)); if (new Set(value).size !== value.length) throw new Error('曜日が重複しています') }
function rows(value: unknown, keys: string[], max = 5000): asserts value is Row[] { array(value, max); value.forEach(row => object(row, keys)); const values = value as Row[]; values.forEach(row => id(row.id)); if (new Set(values.map(row => row.id)).size !== values.length) throw new Error('カレンダー資料のIDが重複しています') }
function score(value: unknown) {
  object(value, ['mode', 'manualPoints', 'minutes', 'travelMinutes', 'difficulty', 'uncertainty', 'coordination', 'physical', 'outing'])
  choice(value.mode, ['unset', 'manual', 'formula']); validateScore(value as ScoreInput)
  if (value.manualPoints !== null) integer(value.manualPoints, 0, 100000)
}
const factFields: Record<ScheduleFact['kind'], string[]> = {
  open: ['calendarId', 'date'], closed: ['calendarId', 'date'], substitute_pattern: ['calendarId', 'date', 'patternWeekday', 'mode'],
  reschedule: ['activityId', 'originalDate', 'newDate'], cancel: ['activityId', 'originalDate'],
  roster_assignment: ['activityId', 'externalId', 'personRef', 'published', 'status', 'startAt', 'endAt'],
  external_event: ['activityId', 'externalId', 'status', 'startAt', 'endAt', 'timezone', 'allDay', 'title'],
}
function fact(raw: unknown, bound = true): asserts raw is ScheduleFact {
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) throw new Error('予定の事実が不正です')
  const value = raw as Row
  choice(value.kind, Object.keys(factFields))
  object(value, ['id', 'revision', 'validity', 'supersedes', 'kind', ...(bound ? ['sourceId', 'contextId'] : []), ...factFields[value.kind as ScheduleFact['kind']]])
  id(value.id); revision(value.revision); choice(value.validity, ['active', 'withdrawn']); ids(value.supersedes)
  if ((value.supersedes as string[]).includes(String(value.id))) throw new Error('事実は自身を置換できません')
  if (bound) { id(value.sourceId); id(value.contextId) }
  if ('calendarId' in value) id(value.calendarId)
  if ('activityId' in value) id(value.activityId)
  if ('date' in value) date(value.date)
  if ('originalDate' in value) date(value.originalDate)
  if ('newDate' in value) date(value.newDate)
  if (value.kind === 'substitute_pattern') { integer(value.patternWeekday, 0, 6); choice(value.mode, ['replace', 'add']) }
  if (value.kind === 'roster_assignment') { id(value.externalId); text(value.personRef, '勤務表の本人識別子', 200); bool(value.published); choice(value.status, ['scheduled', 'cancelled']); instant(value.startAt); instant(value.endAt); if (String(value.startAt) >= String(value.endAt) || Date.parse(String(value.endAt)) - Date.parse(String(value.startAt)) > 7 * 86400000) throw new Error('勤務時間の順序・長さが不正です') }
  if (value.kind === 'external_event') { id(value.externalId); choice(value.status, ['scheduled', 'cancelled']); instant(value.startAt); instant(value.endAt); zone(value.timezone); bool(value.allDay); text(value.title, 'ICS予定名'); if (String(value.startAt) >= String(value.endAt) || Date.parse(String(value.endAt)) - Date.parse(String(value.startAt)) > 7 * 86400000) throw new Error('ICS予定の順序・長さが不正です') }
}
function spec(value: unknown): asserts value is ResolvedCalendarSpec {
  if (!value || typeof value !== 'object') throw new Error('発生回が不正です')
  object(value, ['generationKey', 'triggerKey', 'stepKey', 'contextId', 'bindingId', 'activityId', 'ruleId', 'kind', 'title', 'scheduledDate', 'dueDate', 'score', 'startAt', 'endAt', 'eventKind', 'timezone', 'sourceRefs', 'originBasis', ...('dueAt' in value ? ['dueAt'] : [])])
  if ('dueAt' in value) { instant(value.dueAt); zone(value.timezone); if (value.kind !== 'task' || typeof value.dueDate !== 'string' || calendarDateAt(String(value.dueAt), String(value.timezone)) !== value.dueDate) throw new Error('時刻付き締め切りと締め切り日が一致しません') }
  id(value.generationKey); id(value.triggerKey); id(value.stepKey); id(value.contextId); id(value.bindingId); if (value.activityId !== null) id(value.activityId); if (value.ruleId !== null) id(value.ruleId)
  choice(value.kind, ['task', 'event']); text(value.title, '発生回の名称'); zone(value.timezone); choice(value.originBasis, ['activity', 'user_instruction', 'user_approved_rule'])
  for (const field of ['scheduledDate', 'dueDate']) if (value[field] !== null) date(value[field])
  array(value.sourceRefs, 1000)
  for (const item of value.sourceRefs) { object(item, ['sourceId', 'factId', 'revision']); id(item.sourceId); id(item.factId); revision(item.revision) }
  if (value.kind === 'task') { if (value.startAt !== null || value.endAt !== null || value.eventKind !== null || value.scheduledDate === null) throw new Error('タスク発生回の日時が不正です'); score(value.score) }
  else { instant(value.startAt); instant(value.endAt); choice(value.eventKind, ['meeting', 'class', 'other']); if (String(value.startAt) >= String(value.endAt) || value.score !== null || value.scheduledDate !== null || value.dueDate !== null) throw new Error('予定発生回が不正です') }
  const expected = value.ruleId ? `calendar:rule:${value.ruleId}:${value.triggerKey}:${value.stepKey}` : `calendar:activity:${value.activityId}:${value.triggerKey}`
  if (value.generationKey !== expected || !value.ruleId && (!value.activityId || value.originBasis !== 'activity')) throw new Error('発生回キーが不正です')
}

export function emptyCalendarRulesState(ownerId: string, datasetId: string): CalendarRulesState {
  return { id: 'main', ownerId, datasetId, revision: 1, contexts: [], bindings: [], calendars: [], activities: [], sources: [], facts: [], rules: [], instances: [] }
}
export function validateCalendarRulesState(value: unknown, ownerId?: string, datasetId?: string): asserts value is CalendarRulesState {
  object(value, ['id', 'ownerId', 'datasetId', 'revision', 'contexts', 'bindings', 'calendars', 'activities', 'sources', 'facts', 'rules', 'instances'])
  if (value.id !== 'main') throw new Error('カレンダー設定IDが不正です')
  id(value.ownerId); id(value.datasetId); revision(value.revision)
  if (ownerId && value.ownerId !== ownerId || datasetId && value.datasetId !== datasetId) throw new Error('カレンダー設定の本人・データセットが一致しません')
  rows(value.contexts, ['id', 'name', 'domain', 'timezone', 'validFrom', 'validTo', 'revision'], 100)
  value.contexts.forEach(row => { text(row.name, '対象の名前'); choice(row.domain, ['education', 'work', 'other']); zone(row.timezone); range(row.validFrom, row.validTo); revision(row.revision) })
  rows(value.bindings, ['id', 'contextId', 'personId', 'personRef', 'activityIds', 'weekdays', 'validFrom', 'validTo', 'confirmed', 'revision'], 500)
  value.bindings.forEach(row => { id(row.contextId); id(row.personId); if (row.personRef !== null) text(row.personRef, '本人識別子', 200); ids(row.activityIds); weekdays(row.weekdays); range(row.validFrom, row.validTo); bool(row.confirmed); revision(row.revision) })
  rows(value.calendars, ['id', 'contextId', 'name', 'weekdays', 'validFrom', 'validTo', 'revision'], 100)
  value.calendars.forEach(row => { id(row.contextId); text(row.name, '本人選択カレンダー'); weekdays(row.weekdays); range(row.validFrom, row.validTo); revision(row.revision) })
  rows(value.activities, ['id', 'contextId', 'bindingId', 'calendarId', 'title', 'eventKind', 'weekdays', 'startTime', 'endTime', 'endDayOffset', 'validFrom', 'validTo', 'revision'], 1000)
  value.activities.forEach(row => { id(row.contextId); id(row.bindingId); id(row.calendarId); text(row.title, '活動名'); choice(row.eventKind, ['class', 'meeting', 'other']); weekdays(row.weekdays); clock(row.startTime); clock(row.endTime); integer(row.endDayOffset, 0, 6); range(row.validFrom, row.validTo); revision(row.revision); if (row.endDayOffset === 0 && String(row.startTime) >= String(row.endTime)) throw new Error('開始・終了の順序を確認してください') })
  array(value.sources, 1000)
  for (const source of value.sources) { if (!source || typeof source !== 'object') throw new Error('資料が不正です'); object(source, ['id', 'contextId', 'title', 'authorityScope', 'coverageFrom', 'coverageTo', 'status', 'revision', 'importedAt', 'bodyHash', ...('ics' in source ? ['ics'] : []), ...('csv' in source ? ['csv'] : [])]); id(source.id); if ('ics' in source && 'csv' in source) throw new Error('ICSとCSVの資料を混ぜられません') }
  if (new Set(value.sources.map(source => (source as Row).id)).size !== value.sources.length) throw new Error('資料IDが重複しています')
  const sourceRows = value.sources as Row[]
  let originalBytes = 0
  for (const source of sourceRows) if (source.ics !== undefined) {
    object(source.ics, ['feedId', 'readOnly', 'retentionUntil', 'snapshots', 'components']); text(source.ics.feedId, 'ICS取込元', 120); if (source.ics.readOnly !== true || source.authorityScope !== 'activity') throw new Error('ICSは読取専用の活動資料です')
    if (source.ics.retentionUntil !== null) instant(source.ics.retentionUntil)
    array(source.ics.snapshots, 20); if (!source.ics.snapshots.length) throw new Error('ICS原本の記録がありません')
    let prior = 0
    for (const snapshot of source.ics.snapshots) {
      object(snapshot, ['revision', 'sha256', 'originalText', 'importedAt', 'fromDate', 'toDate']); revision(snapshot.revision); if (Number(snapshot.revision) <= prior || Number(snapshot.revision) > Number(source.revision)) throw new Error('ICS原本の版が不正です'); prior = Number(snapshot.revision)
      if (typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new Error('ICS原本hashが不正です')
      if (snapshot.originalText !== null) { if (typeof snapshot.originalText !== 'string' || !snapshot.originalText || new TextEncoder().encode(snapshot.originalText).length > 1048576) throw new Error('ICS原本は1MiB以内です'); originalBytes += new TextEncoder().encode(snapshot.originalText).length }
      instant(snapshot.importedAt); range(snapshot.fromDate, snapshot.toDate)
    }
    const latest = source.ics.snapshots[source.ics.snapshots.length - 1] as Row
    if (latest.revision !== source.revision || latest.sha256 !== source.bodyHash) throw new Error('ICS原本の最新版と資料hashが一致しません')
    array(source.ics.components, 1000); const componentKeys = new Set<string>()
    for (const component of source.ics.components) {
      object(component, ['uid', 'recurrenceId', 'sequence', 'dtstamp', 'lastModified', 'digest']); if (typeof component.uid !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(component.uid)) throw new Error('保存するICS UIDは匿名hashです'); if (component.recurrenceId !== null) text(component.recurrenceId, 'ICS RECURRENCE-ID', 200); integer(component.sequence, 0, 2147483647); instant(component.dtstamp); if (component.lastModified !== null) instant(component.lastModified); if (typeof component.digest !== 'string' || !/^[a-f0-9]{64}$/.test(component.digest)) throw new Error('ICS component hashが不正です')
      const key = JSON.stringify([component.uid, component.recurrenceId]); if (componentKeys.has(key)) throw new Error('ICS componentが重複しています'); componentKeys.add(key)
    }
  }
  for (const source of sourceRows) if (source.csv !== undefined) {
    object(source.csv, ['format', 'feedId', 'readOnly', 'retentionUntil', 'retiredAt', 'target', 'heads', 'snapshots'])
    const csv = source.csv
    choice(csv.format, ['calendar', 'roster']); text(csv.feedId, 'CSV取込元', 120)
    if (csv.readOnly !== true || source.authorityScope !== csv.format) throw new Error('CSVは読取専用の会社暦・本人勤務表です')
    if (csv.retentionUntil !== null) instant(csv.retentionUntil)
    if (csv.retiredAt !== null) instant(csv.retiredAt)
    object(csv.target, ['bindingId', 'bindingRevision', 'calendarId', 'activityId', 'timezone', 'personRef', 'personRefHash'])
    id(csv.target.bindingId); revision(csv.target.bindingRevision); id(csv.target.calendarId); zone(csv.target.timezone)
    if (csv.format === 'calendar') { if (csv.target.activityId !== null || csv.target.personRef !== null || csv.target.personRefHash !== null) throw new Error('会社暦CSVには勤務表の本人情報を付けられません') }
    else { id(csv.target.activityId); if (csv.target.personRef !== null) text(csv.target.personRef, 'CSV本人識別子', 200); anonymousId(csv.target.personRefHash) }
    array(csv.snapshots, csvSnapshotLimit); if (!csv.snapshots.length) throw new Error('CSVの選択行の記録がありません')
    if ((csv.snapshots as Row[]).reduce((sum, snapshot) => sum + (Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0), 0) > csvEvidenceRowLimit) throw new Error('CSV取込元の保存行数が上限を超えています')
    let previous = 0
    for (const raw of csv.snapshots) {
      object(raw, ['revision', 'fingerprint', 'bodyHash', 'importedAt', 'fromDate', 'toDate', 'retentionUntil', 'rows'])
      revision(raw.revision); if (Number(raw.revision) <= previous || Number(raw.revision) > Number(source.revision)) throw new Error('CSV記録の版が不正です'); previous = Number(raw.revision)
      hash(raw.fingerprint); hash(raw.bodyHash); instant(raw.importedAt); range(raw.fromDate, raw.toDate); if (raw.retentionUntil !== null) instant(raw.retentionUntil)
      array(raw.rows, 1000); const rowIndices = new Set<number>(), recordIds = new Set<string>(); let priorByteEnd = 0
      for (const row of raw.rows) {
        object(row, ['recordId', 'recordRevision', 'value', 'digest', 'factId', 'rowIndex', 'lineStart', 'lineEnd', 'byteStart', 'byteEnd', 'quote', 'quoteSha256'])
        anonymousId(row.recordId); integer(row.recordRevision, 1, 2147483647); hash(row.digest); if (row.factId !== null) id(row.factId)
        if (csv.format === 'calendar') { object(row.value, ['kind', 'date', 'status']); if (row.value.kind !== 'calendar') throw new Error('CSV選択行の内容型が不正です'); date(row.value.date); choice(row.value.status, ['open', 'closed', 'withdrawn']); if ((row.value.status === 'withdrawn') !== (row.factId === null)) throw new Error('CSV撤回行と事実参照が不正です') }
        else { object(row.value, ['kind', 'status', 'startAt', 'endAt', 'startLocal', 'endLocal']); if (row.value.kind !== 'roster') throw new Error('CSV選択行の内容型が不正です'); choice(row.value.status, ['scheduled', 'cancelled']); instant(row.value.startAt); instant(row.value.endAt); localDateTime(row.value.startLocal); localDateTime(row.value.endLocal); if (String(row.value.startAt) >= String(row.value.endAt) || Date.parse(String(row.value.endAt)) - Date.parse(String(row.value.startAt)) > 7 * 86400000 || row.factId === null) throw new Error('CSV勤務表行の時刻・事実参照が不正です') }
        integer(row.rowIndex, 2, 10001); integer(row.lineStart, 2, 25000); integer(row.lineEnd, Number(row.lineStart), 25000)
        integer(row.byteStart, priorByteEnd, 1048576); integer(row.byteEnd, Number(row.byteStart) + 1, 1048576); priorByteEnd = Number(row.byteEnd)
        hash(row.quoteSha256)
        if (row.quote !== null) {
          if (typeof row.quote !== 'string' || !row.quote || new TextDecoder().decode(new TextEncoder().encode(row.quote)) !== row.quote || new TextEncoder().encode(row.quote).length !== Number(row.byteEnd) - Number(row.byteStart)) throw new Error('CSV選択行の原文・byte範囲が不正です')
          originalBytes += new TextEncoder().encode(row.quote).length
        }
        if (rowIndices.has(Number(row.rowIndex)) || recordIds.has(String(row.recordId))) throw new Error('CSV選択行が重複しています')
        rowIndices.add(Number(row.rowIndex)); recordIds.add(String(row.recordId))
      }
    }
    const latest = csv.snapshots.at(-1) as Row
    if (latest.revision !== source.revision || latest.bodyHash !== source.bodyHash || latest.retentionUntil !== csv.retentionUntil) throw new Error('CSV選択行の最新版・hash・保持期限が一致しません')
    array(csv.heads, 1000); const records = new Set<string>(), factIds = new Set<string>()
    for (const head of csv.heads) {
      object(head, ['recordId', 'recordRevision', 'digest', 'factId', 'status', 'snapshotRevision', 'rowIndex'])
      anonymousId(head.recordId); integer(head.recordRevision, 1, 2147483647); hash(head.digest); choice(head.status, ['current', 'expired', 'withdrawn']); revision(head.snapshotRevision); integer(head.rowIndex, 2, 10001)
      if (head.factId !== null) { id(head.factId); if (factIds.has(String(head.factId))) throw new Error('CSVの最新版事実が重複しています'); factIds.add(String(head.factId)) }
      if (records.has(String(head.recordId))) throw new Error('CSVの外部recordが重複しています'); records.add(String(head.recordId))
      if (head.status === 'withdrawn' && (csv.format !== 'calendar' || head.factId !== null) || head.status === 'current' && head.factId === null) throw new Error('CSV recordの撤回・最新版が不正です')
      const snapshot = (csv.snapshots as Row[]).find(row => row.revision === head.snapshotRevision), row = (snapshot?.rows as Row[] | undefined)?.find(row => row.rowIndex === head.rowIndex)
      if (!row || row.recordId !== head.recordId || row.recordRevision !== head.recordRevision || row.digest !== head.digest || row.factId !== head.factId || head.status !== 'expired' && row.quote === null) throw new Error('CSV recordの最新版と選択行の参照が一致しません')
      const versions = (csv.snapshots as Row[]).flatMap(snapshot => snapshot.rows as Row[]).filter(row => row.recordId === head.recordId)
      if (versions.some(row => Number(row.recordRevision) > Number(head.recordRevision))) throw new Error('CSV recordの古い版を最新版にできません')
    }
    if (csv.format === 'roster' && csv.target.personRef === null && (csv.heads as Row[]).some(head => head.status !== 'expired')) throw new Error('保持中のCSV勤務表の本人識別子がありません')
  }
  if (originalBytes > 8 * 1048576) throw new Error('保持するカレンダー原文は全体で8MiB以内です')
  sourceRows.forEach(row => { id(row.contextId); text(row.title, '公式資料名'); choice(row.authorityScope, ['calendar', 'activity', 'roster']); range(row.coverageFrom, row.coverageTo); choice(row.status, ['current', 'stale']); revision(row.revision); instant(row.importedAt); if (typeof row.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.bodyHash)) throw new Error('資料の内容ハッシュが不正です') })
  array(value.facts); value.facts.forEach(row => fact(row)); if (new Set(value.facts.map(row => (row as ScheduleFact).id)).size !== value.facts.length) throw new Error('事実IDが重複しています')
  array(value.rules, 1000)
  const ruleKeys = ['id', 'contextId', 'bindingId', 'calendarId', 'title', 'originBasis', 'enabled', 'validFrom', 'validTo', 'revision', 'steps', 'trigger']
  for (const row of value.rules) { if (!row || typeof row !== 'object') throw new Error('ルールが不正です'); object(row, [...ruleKeys, ...('editions' in row ? ['editions'] : [])]) }
  const ruleRows = value.rules as Row[]
  if (new Set(ruleRows.map(row => row.id)).size !== ruleRows.length) throw new Error('ルールIDが重複しています')
  const validateRule = (row: Row) => {
    id(row.id)
    id(row.contextId); id(row.bindingId); id(row.calendarId); text(row.title, 'ルール名'); choice(row.originBasis, ['user_instruction', 'user_approved_rule']); bool(row.enabled); range(row.validFrom, row.validTo); revision(row.revision)
    array(row.steps, 100); if (!row.steps.length) throw new Error('明示された定型ステップを指定してください')
    const stepKeys = new Set<string>()
    for (const step of row.steps) {
      if (!step || typeof step !== 'object') throw new Error('定型ステップが不正です')
      object(step, ['key', 'title', 'kind', 'scheduledOffsetDays', 'dueOffsetDays', 'score', 'durationMinutes', ...('dueTime' in step ? ['dueTime'] : [])]); id(step.key); text(step.title, 'ステップ名'); choice(step.kind, ['task', 'event']); integer(step.scheduledOffsetDays, -366, 366); if (step.dueOffsetDays !== null) integer(step.dueOffsetDays, -366, 366); if (step.kind === 'task') { score(step.score); if (step.durationMinutes !== null) throw new Error('タスクに予定時間を付けられません') } else { integer(step.durationMinutes, 1, 10080); if (step.score !== null || step.dueOffsetDays !== null) throw new Error('予定ステップにはタスク値を付けられません') }; if (stepKeys.has(String(step.key))) throw new Error('ステップキーが重複しています'); stepKeys.add(String(step.key))
      // A clock deadline needs a deadline day; it never replaces the date (due_kind datetime).
      if ('dueTime' in step) { clock(step.dueTime); if (step.kind !== 'task' || step.dueOffsetDays === null) throw new Error('締め切り時刻は締め切り日のあるタスクだけに設定できます') }
    }
    if (!row.trigger || typeof row.trigger !== 'object' || !('kind' in row.trigger)) throw new Error('明示周期を指定してください')
    const trigger = row.trigger as Row
    if (trigger.kind === 'weekly') { object(trigger, ['kind', 'weekdays', 'time']); weekdays(trigger.weekdays); if (!(trigger.weekdays as number[]).length) throw new Error('周期の曜日を指定してください'); clock(trigger.time) }
    else if (trigger.kind === 'monthly_business') { object(trigger, ['kind', 'ordinal', 'from', 'time']); integer(trigger.ordinal, 1, 31); choice(trigger.from, ['start', 'end']); clock(trigger.time) }
    else if (trigger.kind === 'rrule') {
      object(trigger, ['kind', 'dtstart', 'rrule', 'rdates', 'exdates', 'nonexistentTime', 'ambiguousTime'])
      if (!validLocalDateTime(trigger.dtstart)) throw new Error('繰り返しの開始日時（DTSTART）を確認してください')
      if (typeof trigger.rrule !== 'string') throw new Error('RRULEを指定してください')
      if (canonicalRRule(trigger.rrule) !== trigger.rrule) throw new Error('RRULEは正規化した形式で保存してください')
      for (const [name, values] of [['RDATE', trigger.rdates], ['EXDATE', trigger.exdates]] as const) { array(values, 1000); if (values.some(value => !validLocalDateTime(value)) || new Set(values).size !== values.length || values.some((value, index) => index > 0 && String(values[index - 1]) > String(value))) throw new Error(`${name}は重複のない現地日時を昇順で指定してください`) }
      choice(trigger.nonexistentTime, ['skip', 'next_valid']); choice(trigger.ambiguousTime, ['earlier', 'later'])
    } else if (trigger.kind === 'completion_relative') {
      object(trigger, ['kind', 'firstDate', 'time', 'afterDays', 'unfinishedPolicy']); date(trigger.firstDate); clock(trigger.time); integer(trigger.afterDays, 1, 3650); choice(trigger.unfinishedPolicy, ['keep_all', 'keep_latest', 'generate_after_completion'])
      if (String(trigger.firstDate) < String(row.validFrom) || String(trigger.firstDate) > String(row.validTo)) throw new Error('完了起点の最初の回はルールの有効期間内にしてください')
      if (!(row.steps as Row[]).some(step => step.kind === 'task')) throw new Error('完了起点の周期には完了できるタスクのステップが必要です')
    }
    else { object(trigger, ['kind', 'activityId', 'edge', 'offsetDays', 'offsetMinutes']); choice(trigger.kind, ['activity_relative']); id(trigger.activityId); choice(trigger.edge, ['start', 'end']); integer(trigger.offsetDays, -366, 366); integer(trigger.offsetMinutes, -10080, 10080) }
  }
  for (const row of ruleRows) {
    validateRule(row)
    if (row.editions !== undefined) {
      array(row.editions, 100)
      const editionIds = new Set<string>()
      let priorRevision = 1
      for (const edition of row.editions) {
        object(edition, ['id', 'revision', 'scope', 'definition']); id(edition.id); revision(edition.revision)
        if (Number(edition.revision) <= priorRevision || Number(edition.revision) > Number(row.revision) || editionIds.has(String(edition.id))) throw new Error('ルール変更版の順序が不正です')
        priorRevision = Number(edition.revision); editionIds.add(String(edition.id))
        if (!edition.scope || typeof edition.scope !== 'object' || !('kind' in edition.scope)) throw new Error('系列変更scopeが不正です')
        const scope = edition.scope as Row
        if (scope.kind === 'this_instance') { object(scope, ['kind', 'generationKey']); id(scope.generationKey); if (!String(scope.generationKey).startsWith(`calendar:rule:${row.id}:`)) throw new Error('今回だけの対象系列が一致しません') }
        else if (scope.kind === 'this_and_future') { object(scope, ['kind', 'fromDate']); date(scope.fromDate) }
        else { object(scope, ['kind']); choice(scope.kind, ['all_uncompleted']) }
        object(edition.definition, ['title', 'enabled', 'steps', 'trigger']); validateRule({ ...row, ...edition.definition })
      }
    }
  }
  array(value.instances)
  const generationKeys = new Set<string>(), entityIds = new Set<string>()
  for (const instance of value.instances) { object(instance, ['generationKey', 'entityId', 'entityRevision', 'status', 'spec']); id(instance.generationKey); id(instance.entityId); revision(instance.entityRevision); choice(instance.status, ['active', 'cancelled']); spec(instance.spec); if (instance.generationKey !== instance.spec.generationKey || generationKeys.has(String(instance.generationKey)) || entityIds.has(String(instance.entityId))) throw new Error('発生回の対応が重複・不一致です'); generationKeys.add(String(instance.generationKey)); entityIds.add(String(instance.entityId)) }
  const state = value as CalendarRulesState
  const contextExists = (contextId: string) => { if (!state.contexts.some(row => row.id === contextId)) throw new Error('対象コンテキストがありません') }
  for (const row of [...state.bindings, ...state.calendars, ...state.sources]) contextExists(row.contextId)
  const checkLinks = (row: { contextId: string; calendarId: string; bindingId: string }) => { contextExists(row.contextId); if (!state.calendars.some(item => item.id === row.calendarId && item.contextId === row.contextId) || !state.bindings.some(item => item.id === row.bindingId && item.contextId === row.contextId)) throw new Error('本人適用・カレンダーの参照が不正です') }
  state.activities.forEach(checkLinks); state.rules.forEach(checkLinks)
  for (const source of state.sources) if (source.csv) {
    const csv = source.csv, binding = state.bindings.find(row => row.id === csv.target.bindingId && row.contextId === source.contextId), calendar = state.calendars.find(row => row.id === csv.target.calendarId && row.contextId === source.contextId)
    if (!binding || binding.personId !== state.ownerId || !calendar || csv.target.bindingRevision > binding.revision) throw new Error('CSVの本人適用・会社暦参照が不正です')
    if (csv.format === 'roster') {
      const activity = state.activities.find(row => row.id === csv.target.activityId && row.contextId === source.contextId && row.bindingId === binding.id && row.calendarId === calendar.id)
      if (!activity || activity.weekdays.length) throw new Error('CSV勤務表には週次発生のない本人活動を指定してください')
    }
    const evidence = csv.snapshots.flatMap(snapshot => snapshot.rows)
    for (const row of evidence) if (row.factId !== null) {
      const fact = state.facts.find(fact => fact.id === row.factId && fact.sourceId === source.id && fact.contextId === source.contextId)
      if (!fact || fact.revision !== row.recordRevision || row.value.kind === 'calendar' && (!(fact.kind === 'open' || fact.kind === 'closed') || fact.calendarId !== calendar.id || fact.kind !== row.value.status || fact.date !== row.value.date) || row.value.kind === 'roster' && (fact.kind !== 'roster_assignment' || fact.activityId !== csv.target.activityId || fact.externalId !== row.recordId || fact.personRef !== csv.target.personRefHash || fact.published !== true || fact.status !== row.value.status || fact.startAt !== row.value.startAt || fact.endAt !== row.value.endAt)) throw new Error('CSV選択行と資料の事実が一致しません')
    }
    for (const fact of state.facts.filter(fact => fact.sourceId === source.id)) {
      if (!evidence.some(row => row.factId === fact.id)) throw new Error('CSV資料に選択行の根拠がない事実があります')
      const head = csv.heads.find(head => head.factId === fact.id)
      if (fact.validity === 'active' && (!head || head.status !== 'current')) throw new Error('CSVの旧版・期限後の事実を有効にできません')
    }
    // The reverse direction: a current record must point at its active fact of the same version.
    for (const head of csv.heads) if (head.status === 'current') {
      const fact = state.facts.find(fact => fact.id === head.factId && fact.sourceId === source.id)
      if (!fact || fact.validity !== 'active' || fact.revision !== head.recordRevision) throw new Error('CSVの最新版の事実が有効ではありません')
    }
  }
  for (const binding of state.bindings) if (binding.activityIds.some(activityId => !state.activities.some(activity => activity.id === activityId && activity.bindingId === binding.id && activity.contextId === binding.contextId))) throw new Error('本人の活動対応が不正です')
  for (const base of state.rules) for (const rule of [base, ...(base.editions ?? []).map(edition => ({ ...base, ...edition.definition }))]) if (rule.trigger.kind === 'activity_relative') { const activity = state.activities.find(item => item.id === (rule.trigger as { activityId: string }).activityId); if (!activity || activity.contextId !== rule.contextId || activity.bindingId !== rule.bindingId) throw new Error('イベント相対ルールの本人対象が一致しません') }
  for (const entry of state.facts) {
    const source = state.sources.find(row => row.id === entry.sourceId && row.contextId === entry.contextId), context = state.contexts.find(row => row.id === entry.contextId)
    if (!source || !context) throw new Error('事実の資料参照が不正です')
    if (entry.kind === 'external_event' && !source.ics) throw new Error('外部予定は本人が選んだ読取専用ICS資料に限ります')
    const target = 'calendarId' in entry ? state.calendars.find(row => row.id === entry.calendarId) : state.activities.find(row => row.id === entry.activityId)
    if (!target || target.contextId !== entry.contextId || source.authorityScope !== ('calendarId' in entry ? 'calendar' : entry.kind === 'roster_assignment' ? 'roster' : 'activity')) throw new Error('事実の適用対象・資料の範囲が不正です')
    const factDates = 'date' in entry ? [entry.date] : 'originalDate' in entry ? [entry.originalDate, ...(entry.kind === 'reschedule' ? [entry.newDate] : [])] : [calendarDateAt(entry.startAt, context.timezone)]
    if (factDates.some(day => day < source.coverageFrom || day > source.coverageTo)) throw new Error('事実が資料の取得対象期間を外れています')
    for (const superseded of entry.supersedes) if (!state.facts.some(other => other.id === superseded && other.contextId === entry.contextId)) throw new Error('置換する事実がありません')
  }
  const visited = new Set<string>(), visiting = new Set<string>()
  function visit(entry: ScheduleFact) { if (visiting.has(entry.id)) throw new Error('事実の置換が循環しています'); if (visited.has(entry.id)) return; visiting.add(entry.id); entry.supersedes.forEach(id => visit(state.facts.find(other => other.id === id)!)); visiting.delete(entry.id); visited.add(entry.id) }
  state.facts.forEach(visit)
  for (const instance of state.instances) {
    const item = instance.spec
    if (!state.contexts.some(row => row.id === item.contextId) || !state.bindings.some(row => row.id === item.bindingId && row.contextId === item.contextId) || item.ruleId && !state.rules.some(row => row.id === item.ruleId && row.contextId === item.contextId) || item.activityId && !state.activities.some(row => row.id === item.activityId && row.contextId === item.contextId)) throw new Error('発生回の系列参照が不正です')
    for (const reference of item.sourceRefs) if (!state.facts.some(entry => entry.id === reference.factId && entry.sourceId === reference.sourceId && entry.revision >= reference.revision)) throw new Error('発生回の出典が不正です')
  }
}

export type ScheduleImportPreview = { stateRevision: number; ownerId: string; datasetId: string; contextId: string; source: ScheduleSource; facts: ScheduleFact[]; newFacts: number; changedFacts: number; untouchedFacts: number; noOp: boolean; digest: string }
export async function prepareScheduleImport(state: CalendarRulesState, contextId: string, input: unknown, at = new Date().toISOString()): Promise<ScheduleImportPreview> {
  validateCalendarRulesState(state); instant(at)
  if (!state.contexts.some(context => context.id === contextId)) throw new Error('取込資料を適用する本人の対象を選択してください')
  object(input, ['format', 'version', 'source', 'facts'])
  if (input.format !== 'coach-schedule-facts' || input.version !== 1) throw new Error('対応する公式予定JSON形式ではありません')
  object(input.source, ['id', 'title', 'authorityScope', 'coverageFrom', 'coverageTo', 'revision']); id(input.source.id); text(input.source.title, '資料名'); choice(input.source.authorityScope, ['calendar', 'activity', 'roster']); range(input.source.coverageFrom, input.source.coverageTo); revision(input.source.revision)
  array(input.facts); input.facts.forEach(value => fact(value, false))
  const source: ScheduleSource = { ...(input.source as Omit<ScheduleSource, 'contextId' | 'status' | 'importedAt' | 'bodyHash'>), contextId, status: 'current', importedAt: at, bodyHash: await contentDigest(input) }
  const facts = input.facts.map(value => ({ ...(value as Omit<ScheduleFact, 'sourceId' | 'contextId'>), sourceId: source.id, contextId })) as ScheduleFact[]
  const before = state.sources.find(value => value.id === source.id)
  // CSV sources carry their own evidence; a manual JSON file can neither claim nor replace them.
  if (source.id.startsWith('csv-source:') || before?.csv) throw new Error('csv-source: はCSV取込専用の資料IDです。別の資料IDを指定してください')
  if (before && (before.contextId !== contextId || before.authorityScope !== source.authorityScope || before.revision > source.revision || before.revision === source.revision && before.bodyHash !== source.bodyHash)) throw new Error('資料の対象・範囲・版が既存資料と一致しません')
  for (const entry of facts) { const previous = state.facts.find(value => value.id === entry.id); if (previous && (previous.sourceId !== source.id || previous.contextId !== contextId || previous.revision > entry.revision || previous.revision === entry.revision && canonicalJSON(previous) !== canonicalJSON(entry))) throw new Error('事実の版・内容が既存記録と一致しません') }
  const next: CalendarRulesState = { ...state, sources: [...state.sources.filter(value => value.id !== source.id), source], facts: [...state.facts.filter(value => !facts.some(entry => entry.id === value.id)), ...facts] }
  validateCalendarRulesState(next)
  const noOp = Boolean(before?.status === 'current' && before.bodyHash === source.bodyHash && before.revision === source.revision)
  const unsigned = { stateRevision: state.revision, ownerId: state.ownerId, datasetId: state.datasetId, contextId, source, facts, newFacts: facts.filter(entry => !state.facts.some(value => value.id === entry.id)).length, changedFacts: facts.filter(entry => state.facts.some(value => value.id === entry.id && canonicalJSON(value) !== canonicalJSON(entry))).length, untouchedFacts: state.facts.filter(value => value.sourceId === source.id && !facts.some(entry => entry.id === value.id)).length, noOp }
  return { ...unsigned, digest: await contentDigest(unsigned) }
}
export function mergeScheduleImport(state: CalendarRulesState, preview: ScheduleImportPreview): CalendarRulesState {
  if (state.ownerId !== preview.ownerId || state.datasetId !== preview.datasetId || state.revision !== preview.stateRevision) throw new Error('本人・データセット・版が変わりました。取込を確認し直してください')
  if (preview.noOp) return structuredClone(state)
  const next: CalendarRulesState = { ...structuredClone(state), revision: state.revision + 1, sources: [...state.sources.filter(value => value.id !== preview.source.id), structuredClone(preview.source)], facts: [...state.facts.filter(value => !preview.facts.some(entry => entry.id === value.id)), ...structuredClone(preview.facts)] }
  validateCalendarRulesState(next); return next
}
/** Completed and manually edited entities may differ from the latest rule spec. */
export function validateCalendarRulesRecords(values: unknown, tasks: Task[], events: CalendarEvent[], settings: Settings[]): asserts values is CalendarRulesState[] {
  array(values, 1)
  const owner = settings.find(value => value.id === 'main')
  if (!owner) throw new Error('カレンダーの本人設定がありません')
  for (const value of values) {
    validateCalendarRulesState(value, owner.profileId, owner.datasetId)
    for (const instance of value.instances) {
      if (instance.spec.kind === 'task') {
        const task = tasks.find(row => row.id === instance.entityId)
        if (!task || task.generationKey !== instance.generationKey || task.revision < instance.entityRevision || instance.status === 'cancelled' && (!task.deletedAt || task.status === 'completed')) throw new Error('カレンダー発生回のタスク・取消状態・版が不正です')
      } else {
        const event = events.find(row => row.id === instance.entityId)
        if (instance.status === 'active' ? !event || event.ownerId !== owner.profileId : Boolean(event)) throw new Error('カレンダー発生回の予定・本人・取消状態が不正です')
      }
    }
  }
}
