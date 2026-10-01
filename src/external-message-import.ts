import { db } from './db'
import Dexie from 'dexie'
import { contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { validateDate } from './domain'
import { defaultSourcePermissions, importLocalSource, sourceSpans } from './source-library'
import { defaultSourceRetention } from './retention-defaults'

export type ExternalImportProvider = 'line' | 'discord'
export type ImportedMessageSpan = { id: string; index: number; start: number; end: number; text: string; kind: 'body' | 'quoted' | 'uncertain' }
export type ImportedMessagePreview = {
  id: string; externalMessageId: string | null; conversationExternalId: string | null; actorKey: string | null; authorLabel: string | null
  sentAt: string; localDate: string; localTime: string; editedAt: string | null; kind: 'message' | 'system' | 'attachment-only'
  rawStart: number; rawEnd: number; rawExcerpt: string; pointer: string | null; lineFrom: number | null; lineTo: number | null; dateHeader: string | null
  body: string; bodySha256: string; spans: ImportedMessageSpan[]; referencedQuote: { externalMessageId: string; authorLabel: string | null; body: string } | null; warnings: string[]
}
export type PreparedExternalMessageImport = {
  version: 1; id: string; ownerId: string; datasetId: string; policyEpoch: number; sourcePermissionRevision: number; createdAt: string; expiresAt: string
  provider: ExternalImportProvider; filename: string; fileSha256: string; timezone: string; fromDate: string; toDate: string; conversation: string
  originalMessageCount: number; excludedCount: number; messages: ImportedMessagePreview[]; speakers: { key: string; label: string; idBased: boolean }[]; digest: string
}
export type ExternalImportInput = { provider: ExternalImportProvider; filename: string; raw: string; timezone: string; fromDate: string; toDate: string; conversation?: string }
export type ExternalImportResult = { sourceIds: string[]; created: number; duplicates: number; suppressed: number; notice: string }
type ExternalImportReceipt = { version: 1; ownerId: string; datasetId: string; provider: ExternalImportProvider; fileSha256: string; messageDigest: string; sourceId: string }
type RawMessage = Omit<ImportedMessagePreview, 'id' | 'bodySha256' | 'spans'>
const prepared = new WeakMap<PreparedExternalMessageImport, Map<string, string>>()
const maxMessages = 1000, maxSelected = 200
const normalized = (value: string) => value.replace(/\r\n?/g, '\n').normalize('NFC')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{16,22}$/.test(value)
async function textSha256(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function trustedClick(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || event.type !== 'click') throw new Error('本人がアプリの確認ボタンから操作してください')
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  if (!getter || getter.call(event) !== 'click') throw new Error('本人の確認操作がありません')
}
function limited(value: unknown, label: string, max = 200, empty = false): asserts value is string { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\u0000')) throw new Error(`${label}を確認してください`) }
function validTimezone(timezone: string) { limited(timezone, 'タイムゾーン', 100); try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()) } catch { throw new Error('タイムゾーンを確認してください') } }
function clock(at: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)), part = (key: string) => parts.find(value => value.type === key)!.value
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}:${part('second')}` }
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}はオフセット付きISO日時にしてください`)
  const date = value.slice(0, 10); validateDate(date, label)
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value.slice(11, 19))) throw new Error(`${label}が不正です`)
  return new Date(value).toISOString()
}
function lineWallTime(date: string, time: string, timezone: string): string {
  const expected = `${date}T${time}:00`, estimate = Date.parse(`${expected}Z`), offsets = new Set<number>()
  for (let shift = -36; shift <= 36; shift += 12) {
    const sample = estimate + shift * 3600000, local = clock(new Date(sample).toISOString(), timezone)
    offsets.add(Date.parse(`${local.date}T${local.time}Z`) - sample)
  }
  const candidates = [...offsets].map(offset => new Date(estimate - offset).toISOString()).filter(at => { const local = clock(at, timezone); return `${local.date}T${local.time}` === expected })
  if (candidates.length !== 1) throw new Error(candidates.length ? '夏時間の切替で日時が二通りあります。オフセット付き日時の資料へ分けてください' : '指定タイムゾーンに存在しない日時です')
  return candidates[0]
}
function wrapped(body: string) {
  if (!body.startsWith('"')) return { open: false, body }
  let index = 1
  while (index < body.length) {
    if (body[index] !== '"') { index++; continue }
    if (body[index + 1] === '"') { index += 2; continue }
    if (index !== body.length - 1) return { open: false, body }
    return { open: false, body: body.slice(1, -1).replace(/""/g, '"') }
  }
  return { open: true, body }
}
function lineMessages(raw: string, timezone: string): { conversation: string; messages: RawMessage[] } {
  const lines: { text: string; start: number; end: number; line: number }[] = []
  for (let start = 0, line = 1; start < raw.length; line++) {
    const found = /\r\n|\r|\n/.exec(raw.slice(start)), end = found ? start + found.index : raw.length
    lines.push({ text: raw.slice(start, end), start, end, line }); start = found ? end + found[0].length : raw.length
  }
  const first = lines[0]?.text.replace(/^\uFEFF/, ''), header = first?.match(/^\[LINE\] (.+?)(?:とのトーク履歴|とのチャット履歴)$/) ?? first?.match(/^\[LINE\] Chat history with (.+)$/i)
  if (!header) throw new Error('対応LINE形式は[LINE]の履歴見出し、日付行、時刻・話者・本文のタブ区切りです')
  const messages: RawMessage[] = [], conversation = header[1].trim()
  let date: string | null = null, dateHeader: string | null = null, current: { first: typeof lines[number]; last: typeof lines[number]; body: string; author: string | null; time: string; date: string; dateHeader: string; quotedWrapper: boolean; kind: 'message' | 'system' } | null = null
  function finish() {
    if (!current) return
    const decoded = current.quotedWrapper ? wrapped(current.body) : { open: false, body: current.body }
    if (decoded.open) throw new Error(`LINE ${current.first.line}行の複数行本文が閉じていません`)
    const body = normalized(decoded.body), sentAt = lineWallTime(current.date, current.time, timezone)
    if (!body.trim()) throw new Error(`LINE ${current.first.line}行の本文が空です`)
    messages.push({ externalMessageId: null, conversationExternalId: null, actorKey: current.author ? `line-name:${current.author.normalize('NFC')}` : null, authorLabel: current.author, sentAt, localDate: current.date, localTime: `${current.time}:00`, editedAt: null, kind: current.kind, rawStart: current.first.start, rawEnd: current.last.end, rawExcerpt: raw.slice(current.first.start, current.last.end), pointer: null, lineFrom: current.first.line, lineTo: current.last.line, dateHeader: current.dateHeader, body, referencedQuote: null, warnings: ['LINEの表示名はアカウントIDではありません。同名の別人・転送・返信の引用は原文だけでは確定できません。', ...(current.kind === 'system' ? ['話者列がない時刻付き行です。system等の記録として扱い、本人の約束とは確認しません。'] : []), ...(current.quotedWrapper ? ['複数行のexport用引用符を展開しました。本文内の意味上の引用・転送は別に確認してください。'] : [])] })
    current = null
    if (messages.length > maxMessages) throw new Error('1000発言を超えています。期間またはファイルを分けてください')
  }
  for (const line of lines.slice(1)) {
    if (current?.quotedWrapper && wrapped(current.body).open) { current.body += `\n${line.text}`; current.last = line; continue }
    const day = line.text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:\s*(?:\(([日月火水木金土])\)|([日月火水木金土])曜日?|\(?([A-Za-z]{3,9})\)?))?$/)
    if (day) {
      finish(); date = `${day[1]}-${day[2].padStart(2, '0')}-${day[3].padStart(2, '0')}`; validateDate(date, `LINE ${line.line}行の日付`); dateHeader = line.text
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(), label = day[4] ?? day[5], english = day[6]
      if (label && '日月火水木金土'[weekday] !== label || english && !['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][weekday].startsWith(english.slice(0, 3).toLowerCase())) throw new Error(`LINE ${line.line}行の日付と曜日が一致しません`)
      continue
    }
    const message = line.text.match(/^(\d{1,2}):([0-5]\d)\t([^\t]*)\t(.*)$/), system = message ? null : line.text.match(/^(\d{1,2}):([0-5]\d)\t([^\t]+)$/)
    if (message || system) {
      finish(); if (!date || !dateHeader) throw new Error(`LINE ${line.line}行の発言より前に日付が必要です`)
      const record = message ?? system!, hour = Number(record[1]); if (hour > 23) throw new Error(`LINE ${line.line}行の時刻が不正です`)
      const author = message?.[3].trim() || null, body = message ? message[4] : system![3]; if (author && author.length > 100) throw new Error('LINEの話者名は100文字以内にしてください')
      current = { first: line, last: line, body, author, time: `${String(hour).padStart(2, '0')}:${record[2]}`, date, dateHeader, quotedWrapper: body.startsWith('"'), kind: message ? 'message' : 'system' }
      continue
    }
    if (/^\d{1,2}:\d{2}\t/.test(line.text)) throw new Error(`LINE ${line.line}行の時刻・話者境界が不正です`)
    if (current) { current.body += `\n${line.text}`; current.last = line; continue }
    if (!line.text.trim() || !date && /^(保存日時[:：]|Saved on[:：]?)/i.test(line.text)) continue
    throw new Error(`LINE ${line.line}行の日時・話者境界を確認できません。対応形式へ分けてください`)
  }
  finish(); if (!messages.length) throw new Error('LINEの発言を確認できませんでした。0件の全履歴確認としては保存しません')
  return { conversation, messages }
}

/** Strict JSON reader also rejects duplicate keys, rather than silently taking the last value. */
function jsonRecords(raw: string): { value: unknown; start: number; end: number }[] {
  let at = raw.charCodeAt(0) === 0xfeff ? 1 : 0, nodes = 0
  const space = () => { while (/\s/.test(raw[at] ?? '') && at < raw.length) at++ }
  const fail = (): never => { throw new Error(`Discord JSONの構造が不正です（文字位置${at}）`) }
  function string(): string { const start = at++; while (at < raw.length) { const char = raw[at++]; if (char === '\\') { at++; continue } if (char === '"') { try { return JSON.parse(raw.slice(start, at)) as string } catch { fail() } } }; return fail() }
  function value(depth: number): unknown {
    space(); if (++nodes > 50000 || depth > 15) throw new Error('Discord JSONの入れ子・項目数が上限を超えています')
    if (raw[at] === '"') return string()
    if (raw[at] === '{') {
      at++; space(); const result: Record<string, unknown> = Object.create(null), keys = new Set<string>()
      if (raw[at] === '}') { at++; return result }
      while (at < raw.length) { space(); if (raw[at] !== '"') fail(); const key = string(); if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Discord JSONの重複キー・特殊キーは取り込めません'); keys.add(key); space(); if (raw[at++] !== ':') fail(); result[key] = value(depth + 1); space(); const next = raw[at++]; if (next === '}') return result; if (next !== ',') fail() }
      return fail()
    }
    if (raw[at] === '[') { at++; space(); const result: unknown[] = []; if (raw[at] === ']') { at++; return result }; while (at < raw.length) { result.push(value(depth + 1)); space(); const next = raw[at++]; if (next === ']') return result; if (next !== ',') fail() }; return fail() }
    const scalar = raw.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]; if (!scalar) return fail(); at += scalar.length; const parsed: unknown = JSON.parse(scalar); if (typeof parsed === 'number' && !Number.isFinite(parsed)) return fail(); return parsed
  }
  space(); if (raw[at++] !== '[') throw new Error('Discordは公式メッセージ項目を持つJSON配列を選択してください。ZIP・別exporter形式は未対応です')
  space(); const records: { value: unknown; start: number; end: number }[] = []
  if (raw[at] === ']') { at++; space(); if (at !== raw.length) fail(); return records }
  while (at < raw.length) { space(); const start = at, parsed = value(1); records.push({ value: parsed, start, end: at }); if (records.length > maxMessages) throw new Error('1000発言を超えています。選択JSONを分けてください'); space(); const next = raw[at++]; if (next === ']') break; if (next !== ',') fail() }
  space(); if (raw[at - 1] !== ']' && !raw.trimEnd().endsWith(']') || at !== raw.length) fail()
  return records
}
function discordMessages(raw: string, timezone: string): RawMessage[] {
  const records = jsonRecords(raw), seen = new Set<string>()
  if (!records.length) throw new Error('Discordの選択発言がありません')
  return records.map(({ value, start, end }, index) => {
    const allowed = ['id', 'channel_id', 'author', 'content', 'timestamp', 'edited_timestamp', 'type', 'message_reference', 'referenced_message', 'attachments', 'embeds', 'mentions', 'mention_roles', 'tts', 'mention_everyone', 'pinned', 'flags', 'webhook_id']
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || !snowflake(value.id) || !snowflake(value.channel_id) || !object(value.author) || !snowflake(value.author.id)) throw new Error(`Discord /${index} の文字列ID・公式メッセージ項目を確認してください`)
    if (Object.keys(value.author).some(key => !['id', 'username', 'global_name', 'discriminator', 'avatar', 'bot', 'system', 'public_flags'].includes(key))) throw new Error(`Discord /${index}/author の対応外項目があります`)
    limited(value.author.username, 'Discord話者名', 100); if (value.author.global_name !== undefined && value.author.global_name !== null) limited(value.author.global_name, 'Discord表示名', 100)
    limited(value.content, 'Discord本文', 100000, true)
    const key = `${value.channel_id}:${value.id}`; if (seen.has(key)) throw new Error('Discordの同じchannel/message IDが重複しています。編集版を一つ選んでください'); seen.add(key)
    const sentAt = timestamp(value.timestamp, 'Discord送信日時'), editedAt = value.edited_timestamp === undefined || value.edited_timestamp === null ? null : timestamp(value.edited_timestamp, 'Discord編集日時')
    if (editedAt && editedAt < sentAt) throw new Error('Discordの編集日時が送信日時より前です')
    for (const flag of ['tts', 'mention_everyone', 'pinned']) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error('Discordのフラグが不正です')
    for (const flag of ['bot', 'system']) if (value.author[flag] !== undefined && typeof value.author[flag] !== 'boolean') throw new Error('Discord話者の種別が不正です')
    for (const count of ['type', 'flags']) if (value[count] !== undefined && (!Number.isSafeInteger(value[count]) || Number(value[count]) < 0 || Number(value[count]) > 1000000000)) throw new Error('Discordメッセージ種別が不正です')
    for (const list of ['attachments', 'embeds', 'mentions', 'mention_roles']) if (value[list] !== undefined && (!Array.isArray(value[list]) || value[list].length > 100)) throw new Error('Discordの付随項目が不正です')
    let referencedQuote: RawMessage['referencedQuote'] = null
    if (value.referenced_message !== undefined && value.referenced_message !== null) {
      const quote = value.referenced_message
      if (!object(quote) || !snowflake(quote.id) || typeof quote.content !== 'string' || quote.content.length > 100000 || !object(quote.author)) throw new Error('Discordの引用先項目が不正です')
      referencedQuote = { externalMessageId: quote.id, authorLabel: typeof quote.author.username === 'string' ? quote.author.username.slice(0, 100) : null, body: normalized(quote.content) }
    }
    if (value.message_reference !== undefined) {
      const ref = value.message_reference
      if (!object(ref) || Object.keys(ref).some(key => !['message_id', 'channel_id', 'guild_id', 'type', 'fail_if_not_exists'].includes(key)) || ['message_id', 'channel_id', 'guild_id'].some(key => ref[key] !== undefined && !snowflake(ref[key])) || ref.type !== undefined && (!Number.isInteger(ref.type) || ![0, 1].includes(Number(ref.type))) || ref.fail_if_not_exists !== undefined && typeof ref.fail_if_not_exists !== 'boolean' || referencedQuote && ref.message_id !== referencedQuote.externalMessageId) throw new Error('Discordの返信・転送参照が不正です')
    }
    if (value.webhook_id !== undefined && !snowflake(value.webhook_id)) throw new Error('DiscordのWebhook IDを確認してください')
    const attachmentCount = (value.attachments as unknown[] | undefined)?.length ?? 0, embedCount = (value.embeds as unknown[] | undefined)?.length ?? 0
    const body = normalized(value.content), local = clock(sentAt, timezone)
    if (!body.trim() && !attachmentCount && !embedCount) throw new Error('Discordの本文が空です。未取得本文を発言なしとは扱いません')
    return { externalMessageId: value.id, conversationExternalId: value.channel_id, actorKey: `discord-id:${value.author.id}`, authorLabel: value.author.global_name as string | null | undefined ?? value.author.username, sentAt, localDate: local.date, localTime: local.time, editedAt, kind: value.author.bot === true || value.author.system === true || value.webhook_id !== undefined || value.type !== undefined && ![0, 19].includes(Number(value.type)) ? 'system' : !body.trim() ? 'attachment-only' : 'message', rawStart: start, rawEnd: end, rawExcerpt: raw.slice(start, end), pointer: `/${index}`, lineFrom: null, lineTo: null, dateHeader: null, body: body || '[添付・埋込あり。本文なし。添付の取得はしていません]', referencedQuote, warnings: [...(attachmentCount || embedCount ? ['添付・埋込の取得、URLへの接続、実行はしません。'] : []), ...(value.message_reference && !referencedQuote ? ['返信・転送先の本文は未取得です。'] : []), ...(value.edited_timestamp ? ['保存できるのは選択JSONの編集版だけです。過去の編集・削除履歴は未取得です。'] : [])] }
  })
}

export async function prepareExternalMessageImport(input: ExternalImportInput): Promise<PreparedExternalMessageImport> {
  if (!input || !['line', 'discord'].includes(input.provider)) throw new Error('LINEかDiscordを選択してください')
  limited(input.filename, 'ファイル名', 200); limited(input.raw, '選択した原文', 200000)
  if (new TextEncoder().encode(input.raw).length > 2 * 1024 * 1024) throw new Error('2MiB以下のUTF-8ファイルを選択してください')
  validTimezone(input.timezone); validateDate(input.fromDate, '取込開始日'); validateDate(input.toDate, '取込終了日'); if (!input.fromDate || !input.toDate || input.fromDate > input.toDate) throw new Error('取込期間を確認してください')
  const settings = await db.settings.get('main'); if (!settings) throw new Error('本人の設定がありません')
  const policy = changePolicyFor(settings), fileSha256 = await textSha256(input.raw), parsed = input.provider === 'line' ? lineMessages(input.raw, input.timezone) : { conversation: input.conversation ?? '本人が選択したDiscord会話', messages: discordMessages(input.raw, input.timezone) }
  const conversation = input.conversation?.trim() || parsed.conversation; limited(conversation, '会話名', 100)
  const messages: ImportedMessagePreview[] = []
  for (const raw of parsed.messages) {
    if (raw.localDate < input.fromDate || raw.localDate > input.toDate) continue
    const id = await contentDigest([input.provider, fileSha256, raw.rawStart, raw.rawEnd, raw.sentAt]), spans = sourceSpans(id, raw.body).map(span => ({ ...span, kind: /^\s*>/.test(span.text) ? 'quoted' as const : /[「」“”]|(?:引用|転送)[:：]/.test(span.text) || raw.warnings.some(warning => warning.includes('export用引用符')) ? 'uncertain' as const : 'body' as const }))
    messages.push({ ...raw, id, bodySha256: await textSha256(raw.body), spans })
  }
  if (!messages.length) throw new Error('選択期間に解析できた発言がありません。未取得期間の確認済みとは扱いません')
  const speakers = [...new Map(messages.filter(message => message.actorKey).map(message => [message.actorKey!, { key: message.actorKey!, label: message.authorLabel ?? '話者未確認', idBased: input.provider === 'discord' }])).values()]
  const payload = { version: 1 as const, id: crypto.randomUUID(), ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), provider: input.provider, filename: input.filename, fileSha256, timezone: input.timezone, fromDate: input.fromDate, toDate: input.toDate, conversation, originalMessageCount: parsed.messages.length, excludedCount: parsed.messages.length - messages.length, messages, speakers }
  const result = freeze({ ...payload, digest: await contentDigest(payload) }); prepared.set(result, new Map()); return result
}
async function assertPrepared(value: PreparedExternalMessageImport) {
  if (!prepared.has(value)) throw new Error('取込プレビューをこの画面で作り直してください')
  const settings = await db.settings.get('main'), policy = settings && changePolicyFor(settings)
  if (!settings || settings.profileId !== value.ownerId || settings.datasetId !== value.datasetId || policy!.epoch !== value.policyEpoch || policy!.sourcePermissionRevision !== value.sourcePermissionRevision || Date.parse(value.expiresAt) <= Date.now()) throw new Error('本人・保存先・資料権限または有効期限が変わりました。プレビューを作り直してください')
  return settings
}
/** A matching display name in material never confirms an actor. */
export async function confirmImportedSpeakerFromUI(value: PreparedExternalMessageImport, actorKey: string, event: Event): Promise<void> {
  trustedClick(event); await assertPrepared(value)
  if (!value.speakers.some(speaker => speaker.key === actorKey) || value.messages.filter(message => message.actorKey === actorKey).some(message => message.kind !== 'message')) throw new Error('選択した通常発言の話者を確認してください。Bot・system発言を本人として確認できません')
  prepared.get(value)!.set(actorKey, new Date().toISOString())
}
export function confirmedImportedSpeakers(value: PreparedExternalMessageImport): string[] { return [...(prepared.get(value)?.keys() ?? [])] }
/** retentionUntil omitted = 90-day default for imported conversations (design 23.2); null = owner chose no expiry. */
export async function importSelectedExternalMessagesFromUI(value: PreparedExternalMessageImport, selectedIds: string[], event: Event, retentionUntil?: string | null): Promise<ExternalImportResult> {
  trustedClick(event); await assertPrepared(value)
  const retention = retentionUntil === undefined ? defaultSourceRetention(value.provider) : retentionUntil
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > maxSelected || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !value.messages.some(message => message.id === id))) throw new Error('プレビュー内の発言を1〜200件選択してください')
  const confirmed = prepared.get(value)!, selected = value.messages.filter(message => selectedIds.includes(message.id))
  const result = await db.transaction('rw', db.contextSources, db.contextSnapshots, db.commands, db.settings, async () => {
    await assertPrepared(value)
    const existing = await db.contextSources.where('ownerId').equals(value.ownerId).toArray(), sources = new Map(existing.filter(source => source.provider === value.provider).map(source => [source.externalId, source]))
    const result: ExternalImportResult = { sourceIds: [], created: 0, duplicates: 0, suppressed: 0, notice: '' }
    for (const message of selected) {
      const externalId = `selected-message:${message.id}`, receiptKey = `external-import:${value.ownerId}:${value.datasetId}:${value.provider}:${message.id}`, savedReceipt = await db.commands.get(receiptKey)
      let receipt: ExternalImportReceipt | null = null
      if (savedReceipt) {
        try {
          const parsed: unknown = JSON.parse(savedReceipt.resultId)
          if (!object(parsed) || Object.keys(parsed).length !== 7 || parsed.version !== 1 || parsed.ownerId !== value.ownerId || parsed.datasetId !== value.datasetId || parsed.provider !== value.provider || parsed.fileSha256 !== value.fileSha256 || parsed.messageDigest !== message.id || typeof parsed.sourceId !== 'string' || !parsed.sourceId || await Dexie.waitFor(contentDigest(parsed)) !== savedReceipt.hash) throw new Error()
          receipt = parsed as ExternalImportReceipt
        } catch { throw new Error('選択履歴の重複防止記録が破損しています。上書きせず取込を停止しました') }
      }
      const previous = receipt ? await db.contextSources.get(receipt.sourceId) : sources.get(externalId)
      if (receipt && (!previous || previous.ownerId !== value.ownerId || previous.provider !== value.provider)) { result.suppressed++; continue }
      if (previous) {
        if (previous.deletedAt || !previous.permissions.retain || previous.retentionUntil && Date.parse(previous.retentionUntil) <= Date.now()) result.suppressed++
        else {
          if (previous.externalId !== externalId) throw new Error('選択履歴の重複防止記録と資料が一致しません')
          result.duplicates++; result.sourceIds.push(previous.id)
        }
        continue
      }
      const confirmedAt = message.actorKey ? confirmed.get(message.actorKey) ?? null : null
      const envelope = { format: 'michi-selected-external-message', version: 1, provider: value.provider, originalFile: { filename: value.filename, sha256: value.fileSha256, fullFileStored: false }, position: { start: message.rawStart, end: message.rawEnd, jsonPointer: message.pointer, lineFrom: message.lineFrom, lineTo: message.lineTo }, externalMessageId: message.externalMessageId, conversationExternalId: message.conversationExternalId, timezone: value.timezone, sentAt: message.sentAt, localDate: message.localDate, localTime: message.localTime, editedAt: message.editedAt, dateHeader: message.dateHeader, author: { key: message.actorKey, displayName: message.authorLabel, identity: confirmedAt ? 'owner-confirmed-by-person' : 'unverified', confirmedOwnerId: confirmedAt ? value.ownerId : null, confirmedAt }, messageKind: message.kind, rawExcerpt: message.rawExcerpt, normalizedBody: message.body, bodySha256: message.bodySha256, bodySpans: message.spans, referencedQuote: message.referencedQuote, warnings: message.warnings, coverage: { fromDate: value.fromDate, toDate: value.toDate, complete: false, method: 'selected-file-import' } }
      const text = JSON.stringify(envelope, null, 2)
      if (text.length > 200000) throw new Error('1発言の原文・引用情報が保存上限を超えます。資料を分けてください')
      const sourceId = await importLocalSource({ title: `${value.provider.toUpperCase()} ${value.conversation} ${message.localDate} ${message.localTime} ${message.id.slice(0, 12)}`.slice(0, 200), provider: value.provider, externalId, conversation: value.conversation, author: `${confirmedAt ? '本人が明示確認した話者' : '話者未確認'}: ${message.authorLabel ?? '話者情報なし'}`.slice(0, 200), sourceUrl: null, date: message.localDate, timezone: value.timezone, fromDate: value.fromDate, toDate: value.toDate, text, permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: retention })
      const imported: ExternalImportReceipt = { version: 1, ownerId: value.ownerId, datasetId: value.datasetId, provider: value.provider, fileSha256: value.fileSha256, messageDigest: message.id, sourceId }
      await db.commands.add({ key: receiptKey, hash: await Dexie.waitFor(contentDigest(imported)), resultId: JSON.stringify(imported), at: new Date().toISOString() })
      result.sourceIds.push(sourceId); result.created++
    }
    result.notice = `新規${result.created}件、同じ原本・位置・日時の既存${result.duplicates}件、削除・期限・保存取消による再取込抑止${result.suppressed}件。選択した手動snapshotだけです。全履歴・全DM同期ではありません。AI送信・通知・外部変更は許可していません。既存発言の話者確認・版は上書きしません。`
    return result
  })
  prepared.delete(value)
  return result
}
