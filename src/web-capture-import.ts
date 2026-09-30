import Dexie from 'dexie'
import { canonicalJSON, contentDigest } from './canonical'
import { changePolicyFor } from './change-set'
import { defaultSourcePermissions, importLocalSource, normalizeSourceText, sourceDb } from './source-library'
import type { SourceImport, SourcePermissions } from './source-library'

export const MAX_EMAIL_BYTES = 100 * 1024
export const MAX_CAPTURE_TEXT = 50000
export type WebCaptureCapsule = {
  version: 1; kind: 'web-selection'; title: string; url: string; capturedAt: string; timezone: string
  selection: { quote: string; start: number; end: number; coordinate: 'document-utf16' | 'selected-fragment-utf16' }
  coverage: { complete: false; kind: 'selected-quote' }
}
export type ParsedLocalEmail = {
  kind: 'email-file'; filename: string; subject: string; sender: string; messageId: string | null
  date: { raw: string; instant: string; localDate: string; timezone: string }
  text: string; rawBase64: string; rawSha256: string; textSha256: string
  ignoredHtmlParts: number; attachmentParts: number
}
export type CaptureImportPreview = {
  version: 1; kind: 'web-selection' | 'email-file'; ownerId: string; datasetId: string
  policyEpoch: number; sourcePermissionRevision: number; expiresAt: string
  title: string; author: string | null; messageId: string | null; sourceUrl: string | null
  date: string; timezone: string; quote: string; start: number; end: number
  coordinate: 'document-utf16' | 'selected-fragment-utf16' | 'decoded-email-utf16'
  positionVerified: boolean; digest: string
}
export type CaptureImportReceipt = { sourceId: string; sourceRevision: number; provenanceId: string; selectedSha256: string; duplicate: boolean; permissions: SourcePermissions }
type PreparedRecord = { input: SourceImport; provenance: Record<string, unknown>; artifactId: string; selectedSha256: string; previewPayload: Omit<CaptureImportPreview, 'digest'> }
const prepared = new WeakMap<CaptureImportPreview, PreparedRecord>()
const parsedEmails = new WeakSet<ParsedLocalEmail>()
function fail(message = '取込データの形式を確認してください。'): never { throw new Error(message) }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
// Literal data can contain arbitrary words, but terminal and header controls are rejected.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some(char => char.length === 1 && /[\ud800-\udfff]/.test(char)) || controls.test(value) || !multiline && /[\r\n\t\u202a-\u202e\u2066-\u2069]/.test(value)) fail('取込テキストに未対応の文字または長さがあります。')
  return value
}
function zone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) fail('タイムゾーンを確認してください。')
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format() } catch { fail('タイムゾーンを確認してください。') }
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('取得日時はISO形式の日時で指定してください。')
  return value
}
function calendarDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant))
  const value = (key: string) => parts.find(part => part.type === key)?.value
  const date = `${value('year')}-${value('month')}-${value('day')}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('資料の日付を確認してください。')
  return date
}
function range(start: unknown, end: unknown, length: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > length) fail('引用の文字範囲を確認してください。')
  return { start: start as number, end: end as number }
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
function byteString(bytes: Uint8Array): string { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return value }
function fromByteString(value: string) { return Uint8Array.from(value, char => char.charCodeAt(0)) }
async function bytesHash(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
async function stringHash(value: string) { return bytesHash(new TextEncoder().encode(value)) }

/** A capsule carries only the selected quote. Document coordinates are sender reported. */
export function parseWebCaptureCapsule(value: unknown): WebCaptureCapsule {
  if (typeof value === 'string') { if (value.length > 120000) fail('引用データが大きすぎます。'); try { value = JSON.parse(value) } catch { fail('引用データはJSON形式で指定してください。') } }
  const root = object(value, ['version', 'kind', 'title', 'url', 'capturedAt', 'timezone', 'selection', 'coverage'])
  if (root.version !== 1 || root.kind !== 'web-selection') fail()
  const title = text(root.title, 200), url = text(root.url, 2000), capturedAt = timestamp(root.capturedAt), timezone = zone(root.timezone)
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error() } catch { fail('出典は認証情報を含まないhttp/https URLで指定してください。') }
  const selection = object(root.selection, ['quote', 'start', 'end', 'coordinate']), quote = text(selection.quote, MAX_CAPTURE_TEXT, true)
  const bounds = range(selection.start, selection.end, 1000000000)
  if (!['document-utf16', 'selected-fragment-utf16'].includes(selection.coordinate as string) || bounds.end - bounds.start !== quote.length || selection.coordinate === 'selected-fragment-utf16' && bounds.start !== 0) fail('引用の文字位置と長さが一致していません。')
  const coverage = object(root.coverage, ['complete', 'kind'])
  if (coverage.complete !== false || coverage.kind !== 'selected-quote') fail('取込範囲は本人が選んだ引用だけです。')
  return freeze({ version: 1, kind: 'web-selection', title, url, capturedAt, timezone, selection: { quote, ...bounds, coordinate: selection.coordinate as WebCaptureCapsule['selection']['coordinate'] }, coverage: { complete: false, kind: 'selected-quote' } })
}
export function makeWebCaptureCapsule(input: { title: string; url: string; quote: string; timezone: string; capturedAt?: string }): WebCaptureCapsule {
  return parseWebCaptureCapsule({ version: 1, kind: 'web-selection', title: input.title, url: input.url, capturedAt: input.capturedAt ?? new Date().toISOString(), timezone: input.timezone, selection: { quote: input.quote, start: 0, end: input.quote.length, coordinate: 'selected-fragment-utf16' }, coverage: { complete: false, kind: 'selected-quote' } })
}

function base64Bytes(value: string): Uint8Array {
  const clean = value.replace(/[\r\n\t ]/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean) || clean.length > MAX_EMAIL_BYTES * 2) fail('Base64の形式を確認してください。')
  let decoded: string
  try { decoded = atob(clean) } catch { fail('Base64の形式を確認してください。') }
  if (btoa(decoded) !== clean) fail('Base64の末尾が不正です。')
  return fromByteString(decoded)
}
function quotedPrintable(value: string, header = false): Uint8Array {
  if (header) value = value.replace(/_/g, ' ')
  else value = value.replace(/[\t ]+(?=\r?\n|$)/g, '').replace(/=\r?\n/g, '')
  const result: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=') { const hex = value.slice(i + 1, i + 3); if (!/^[\da-f]{2}$/i.test(hex)) fail('Quoted-Printableの形式を確認してください。'); result.push(parseInt(hex, 16)); i += 2 }
    else { const code = value.charCodeAt(i); if (code > 126 || code < 32 && ![9, 10, 13].includes(code) || header && [10, 13].includes(code)) fail('Quoted-Printableに未対応の文字があります。'); result.push(code) }
  }
  return new Uint8Array(result)
}
function charsetText(bytes: Uint8Array, charset: string): string {
  const name = charset.toLowerCase()
  if (name === 'utf-8' || name === 'utf8') { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('UTF-8の内容が不正です。') } }
  if (name === 'us-ascii' || name === 'ascii') { if (bytes.some(byte => byte > 127)) fail('ASCII以外の文字に文字コードの指定がありません。'); return byteString(bytes) }
  if (name === 'iso-8859-1') return byteString(bytes)
  return fail(`未対応のメール文字コードです（${name.slice(0, 40)}）。UTF-8・ASCII・ISO-8859-1に対応しています。`)
}
function decodeHeader(value: string): string {
  const words = /=\?([^?\s]+)\?([bq])\?([^?\r\n]+)\?=/gi
  let result = '', cursor = 0, priorEncoded = false
  for (const match of value.matchAll(words)) {
    const between = value.slice(cursor, match.index)
    if (between.includes('=?') || match[0].length > 75 || /\s/.test(match[3])) fail('メールヘッダーの符号化が不正です。')
    if (!(priorEncoded && /^[\t ]*$/.test(between))) result += between
    const encoded = charsetText(match[2].toLowerCase() === 'b' ? base64Bytes(match[3]) : quotedPrintable(match[3], true), match[1])
    if (/[\r\n\t]/.test(encoded) || controls.test(encoded)) fail('メールヘッダーに改行や制御文字があります。')
    result += encoded; cursor = match.index! + match[0].length; priorEncoded = true
  }
  const rest = value.slice(cursor)
  if (rest.includes('=?')) fail('メールヘッダーの符号化が不正です。')
  return result + rest
}
type MimePart = { headers: Map<string, string>; body: string }
function splitPart(value: string): MimePart {
  const boundary = value.indexOf('\n\n')
  if (boundary < 0 || boundary > 32000) fail('メールヘッダーと本文を分けられません。')
  const header = value.slice(0, boundary), lines = header.split('\n')
  // RFC header bytes are ASCII; SMTPUTF8 headers are outside this import subset.
  // eslint-disable-next-line no-control-regex
  if (lines.length > 200 || lines.some(line => line.length > 998 || /[^\x09\x20-\x7e]/.test(line))) fail('未対応のメールヘッダーです。')
  const unfolded: string[] = []
  for (const line of lines) { if (/^[\t ]/.test(line)) { if (!unfolded.length) fail('メールヘッダーの折返しが不正です。'); unfolded[unfolded.length - 1] += ` ${line.trim()}` } else unfolded.push(line) }
  const headers = new Map<string, string>(), critical = ['from', 'date', 'subject', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition']
  for (const line of unfolded) {
    const match = /^([\w!#$%&'*+.^`|~-]+):[\t ]*(.*)$/.exec(line)
    if (!match) fail('メールヘッダーの形式を確認してください。')
    const name = match[1].toLowerCase()
    if (headers.has(name) && critical.includes(name)) fail('メールの識別ヘッダーが重複しています。')
    if (!headers.has(name)) headers.set(name, match[2].trim())
  }
  return { headers, body: value.slice(boundary + 2) }
}
function mediaType(value: string): { type: string; params: Map<string, string> } {
  const match = /^([\w!#$&^.+-]+\/[\w!#$&^.+-]+)(.*)$/.exec(value)
  if (!match) fail('メールのContent-Typeを確認してください。')
  const params = new Map<string, string>(); let rest = match[2]
  while (rest) {
    const part = /^\s*;\s*([\w-]+)\s*=\s*(?:"([^"\\\r\n]*)"|([\w!#$%&'+.^`|~:-]+))\s*/.exec(rest)
    if (!part) fail('未対応のMIMEパラメーターです。')
    const key = part[1].toLowerCase()
    if (params.has(key)) fail('MIMEパラメーターが重複しています。')
    params.set(key, part[2] ?? part[3]); rest = rest.slice(part[0].length)
  }
  return { type: match[1].toLowerCase(), params }
}
function emailDate(raw: string): ParsedLocalEmail['date'] {
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? ([+-])(\d{2})(\d{2})(?: \([^()\r\n]*\))?$/.exec(raw)
  if (!match) fail('メール日時は数値の時差を持つRFC形式で指定してください。')
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[3]), day = Number(match[2]), year = Number(match[4]), hour = Number(match[5]), minute = Number(match[6]), second = Number(match[7] ?? 0), offsetHour = Number(match[9]), offsetMinute = Number(match[10])
  if (year < 1900 || year > 2100 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || match[8] === '-' && offsetHour === 0 && offsetMinute === 0) fail('未対応または不明なメール日時・時差です。')
  const local = new Date(Date.UTC(year, month, day, hour, minute, second))
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day || match[1] && ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][local.getUTCDay()] !== match[1]) fail('メールの日付が不正です。')
  const timezone = zone(`${match[8]}${match[9]}:${match[10]}`), minutes = (offsetHour * 60 + offsetMinute) * (match[8] === '+' ? 1 : -1)
  return { raw, instant: new Date(local.getTime() - minutes * 60000).toISOString(), localDate: local.toISOString().slice(0, 10), timezone }
}
function plainParts(root: MimePart): { body: string; ignoredHtmlParts: number; attachmentParts: number } {
  const bodies: string[] = []; let count = 0, ignoredHtmlParts = 0, attachmentParts = 0
  function visit(part: MimePart, depth: number) {
    if (++count > 20 || depth > 4) fail('MIMEパート数または深さが上限を超えています。')
    const content = mediaType(part.headers.get('content-type') ?? 'text/plain; charset=us-ascii'), disposition = part.headers.get('content-disposition') ?? ''
    if (disposition && !/^(?:inline|attachment)(?:\s*;|$)/i.test(disposition)) fail('未対応のContent-Dispositionです。')
    if (/^attachment(?:\s*;|$)/i.test(disposition)) { attachmentParts++; return }
    const transfer = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase()
    if (content.type.startsWith('multipart/')) {
      if (!['multipart/alternative', 'multipart/mixed'].includes(content.type) || !['7bit', '8bit'].includes(transfer)) fail('未対応の複合メール形式です。')
      const boundary = content.params.get('boundary')
      if (!boundary || boundary.length > 70 || /[^\x20-\x7e]/.test(boundary) || boundary.endsWith(' ')) fail('MIME境界が不正です。')
      let active = false, closed = false; const current: string[] = []
      for (const line of part.body.split('\n')) {
        if (line.replace(/[\t ]+$/, '') === `--${boundary}` || line.replace(/[\t ]+$/, '') === `--${boundary}--`) {
          if (closed) fail('MIME境界が重複しています。')
          if (active) { if (!current.length) fail('空のMIMEパートです。'); visit(splitPart(current.join('\n')), depth + 1); current.length = 0 }
          if (line.replace(/[\t ]+$/, '') === `--${boundary}--`) { closed = true; active = false } else active = true
        } else if (active) current.push(line)
      }
      if (!closed) fail('MIME終端がありません。')
      return
    }
    if (content.type === 'text/html') { ignoredHtmlParts++; return }
    if (content.type !== 'text/plain') fail('未対応の本文形式です。text/plainを含むメールを選択してください。')
    let bytes: Uint8Array
    if (transfer === 'base64') bytes = base64Bytes(part.body)
    else if (transfer === 'quoted-printable') bytes = quotedPrintable(part.body)
    else if (transfer === '7bit' || transfer === '8bit') { bytes = fromByteString(part.body); if (transfer === '7bit' && bytes.some(byte => byte > 127)) fail('7bit本文に非ASCII文字があります。') }
    else fail('未対応のContent-Transfer-Encodingです。')
    bodies.push(charsetText(bytes, content.params.get('charset') ?? 'us-ascii').replace(/\r\n?/g, '\n'))
  }
  visit(root, 0)
  if (bodies.length !== 1) fail(bodies.length ? '複数の本文があるメールは引用範囲を一意にできません。' : '選べるtext/plain本文がありません。HTMLは実行・取込しません。')
  const body = text(bodies[0], MAX_CAPTURE_TEXT, true)
  if (body.split('\n').length > 10000) fail('メール本文は10000行までです。')
  return { body, ignoredHtmlParts, attachmentParts }
}

/** Decode a bounded local .eml. Sender and Message-ID are source claims, not authentication. */
export async function parseLocalEmailFile(input: Uint8Array | ArrayBuffer, filename = 'mail.eml'): Promise<ParsedLocalEmail> {
  const bytes = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input))
  if (!bytes.length || bytes.length > MAX_EMAIL_BYTES) fail('メールファイルは100KBまでです。')
  text(filename, 200)
  const raw = byteString(bytes)
  if (/\r(?!\n)/.test(raw) || raw.includes('\0')) fail('メールファイルに未対応の改行や制御文字があります。')
  const root = splitPart(raw.replace(/\r\n/g, '\n')), sender = text(decodeHeader(root.headers.get('from') ?? ''), 200), subject = text(decodeHeader(root.headers.get('subject') ?? 'メール（件名なし）'), 200), date = emailDate(root.headers.get('date') ?? '')
  if (!/^(?:[^<>]*<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/.test(sender) || /[,;]/.test(sender.replace(/"[^"\r\n]*"/g, ''))) fail('単一の送信者アドレスを持つメールを選択してください。')
  const messageId = root.headers.get('message-id') ?? null
  if (messageId !== null && (messageId.length > 200 || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId))) fail('メールのMessage-IDが不正です。')
  const mimeVersion = root.headers.get('mime-version')
  if (mimeVersion !== undefined && mimeVersion !== '1.0') fail('未対応のMIMEバージョンです。')
  const parts = plainParts(root)
  const email: ParsedLocalEmail = { kind: 'email-file', filename, subject, sender, messageId, date, text: parts.body, rawBase64: btoa(raw), rawSha256: await bytesHash(bytes), textSha256: await stringHash(parts.body), ignoredHtmlParts: parts.ignoredHtmlParts, attachmentParts: parts.attachmentParts }
  freeze(email); parsedEmails.add(email); return email
}

async function prepare(input: SourceImport, provenance: Record<string, unknown>, fields: Pick<CaptureImportPreview, 'kind' | 'messageId' | 'start' | 'end' | 'coordinate' | 'positionVerified'>): Promise<CaptureImportPreview> {
  const settings = await sourceDb.settings.get('main')
  if (!settings) fail('本人の設定がありません。')
  const policy = changePolicyFor(settings), selectedSha256 = await stringHash(normalizeSourceText(input.text))
  const previewPayload: Omit<CaptureImportPreview, 'digest'> = { version: 1, ...fields, ownerId: settings.profileId, datasetId: settings.datasetId, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, expiresAt: new Date(Date.now() + 86400000).toISOString(), title: input.title, author: input.author, sourceUrl: input.sourceUrl, date: input.date, timezone: input.timezone!, quote: input.text }
  const artifactId = `capture:${await contentDigest({ ownerId: settings.profileId, datasetId: settings.datasetId, provenance, selectedSha256 })}`
  if (canonicalJSON(provenance).length > 195000) fail('元データと引用の保存サイズが上限を超えています。')
  const digest = await contentDigest({ preview: previewPayload, input, provenance, artifactId, selectedSha256 }), preview = freeze({ ...previewPayload, digest })
  prepared.set(preview, { input: freeze(input), provenance: freeze(provenance), artifactId, selectedSha256, previewPayload: freeze(previewPayload) })
  return preview
}
export async function prepareWebCaptureImport(value: unknown): Promise<CaptureImportPreview> {
  const capsule = parseWebCaptureCapsule(value), date = calendarDate(capsule.capturedAt, capsule.timezone), externalId = `web:${await contentDigest({ url: capsule.url, quote: normalizeSourceText(capsule.selection.quote), selection: { start: capsule.selection.start, end: capsule.selection.end, coordinate: capsule.selection.coordinate } })}`
  return prepare({ title: capsule.title, provider: 'other', externalId, conversation: '本人が選んだWeb引用', author: null, sourceUrl: capsule.url, date, timezone: capsule.timezone, text: capsule.selection.quote, fromDate: date, toDate: date, permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null }, { version: 1, kind: 'web-selection', capsule, pageFetched: false, positionVerified: false, coverageComplete: false }, { kind: 'web-selection', messageId: null, ...capsule.selection, positionVerified: false })
}
export async function prepareEmailCaptureImport(email: ParsedLocalEmail, start: number, end: number): Promise<CaptureImportPreview> {
  if (!parsedEmails.has(email)) fail('この端末で解析したメールを選択してください。')
  const bounds = range(start, end, email.text.length)
  const splitSurrogate = (position: number) => position > 0 && /[\ud800-\udbff]/.test(email.text[position - 1]) && /[\udc00-\udfff]/.test(email.text[position] ?? '')
  if (splitSurrogate(start) || splitSurrogate(end)) fail('引用範囲が文字の途中で分かれています。')
  const quote = text(email.text.slice(start, end), MAX_CAPTURE_TEXT, true), date = email.date.localDate, externalId = `eml:${await contentDigest(email.messageId ?? email.rawSha256)}`
  return prepare({ title: email.subject, provider: 'other', externalId, conversation: '本人が選んだローカルメール', author: email.sender, sourceUrl: null, date, timezone: email.date.timezone, text: quote, fromDate: date, toDate: date, permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null }, { version: 1, kind: 'email-file', filename: email.filename, messageId: email.messageId, sender: email.sender, senderAuthenticated: false, date: email.date, rawBase64: email.rawBase64, rawSha256: email.rawSha256, textSha256: email.textSha256, decodedTextLength: email.text.length, selection: { quote, ...bounds, coordinate: 'decoded-email-utf16' }, ignoredHtmlParts: email.ignoredHtmlParts, attachmentParts: email.attachmentParts, coverageComplete: false }, { kind: 'email-file', messageId: email.messageId, ...bounds, coordinate: 'decoded-email-utf16', positionVerified: true })
}

function nativeClick(event: Event) {
  if (!(event instanceof Event) || !event.isTrusted || event.type !== 'click') fail('本人の取込確認ボタンから保存してください。')
  try { const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get; if (!getter || getter.call(event) !== 'click') throw new Error() } catch { fail('本人の取込確認ボタンから保存してください。') }
}
/** Source and immutable provenance commit together. Import has no task execution authority. */
export async function saveCaptureImportFromUI(preview: CaptureImportPreview, event: Event): Promise<CaptureImportReceipt> {
  nativeClick(event)
  const record = prepared.get(preview)
  if (!record) fail('この画面で確認した取込案を選んでください。')
  return sourceDb.transaction('rw', sourceDb.contextSources, sourceDb.contextSnapshots, sourceDb.sourceArtifacts, sourceDb.settings, async () => {
    if (Date.parse(preview.expiresAt) <= Date.now() || preview.digest !== await Dexie.waitFor(contentDigest({ preview: record.previewPayload, input: record.input, provenance: record.provenance, artifactId: record.artifactId, selectedSha256: record.selectedSha256 }))) fail('取込案の期限または内容が変わりました。もう一度確認してください。')
    const settings = await sourceDb.settings.get('main')
    if (!settings || settings.profileId !== preview.ownerId || settings.datasetId !== preview.datasetId) fail('本人またはデータが切り替わりました。もう一度確認してください。')
    const existingArtifact = await sourceDb.sourceArtifacts.get(record.artifactId)
    if (!existingArtifact) {
      const policy = changePolicyFor(settings)
      if (policy.epoch !== preview.policyEpoch || policy.sourcePermissionRevision !== preview.sourcePermissionRevision) fail('取込の権限が変わりました。もう一度確認してください。')
    }
    const prior = await sourceDb.contextSources.where('ownerId').equals(settings.profileId).toArray(), sourceId = await importLocalSource(record.input), source = await sourceDb.contextSources.get(sourceId), snapshot = source ? await sourceDb.contextSnapshots.get(`${source.id}:${source.latestRevision}`) : null
    if (!source || !snapshot || source.ownerId !== preview.ownerId || snapshot.ownerId !== preview.ownerId || snapshot.sha256 !== record.selectedSha256) fail('選んだ引用の保存を確認できません。')
    if (existingArtifact && (existingArtifact.sourceId !== sourceId || existingArtifact.ownerId !== preview.ownerId)) fail('元データの保存先が一致しません。')
    const payload = canonicalJSON({ ...record.provenance, ownerId: preview.ownerId, datasetId: preview.datasetId, selectedSha256: record.selectedSha256 })
    if (payload.length > 200000) fail('元データの保存サイズが上限を超えています。')
    if (!existingArtifact) await sourceDb.sourceArtifacts.add({ id: record.artifactId, ownerId: preview.ownerId, sourceId, sourceRevision: source.latestRevision, permissionRevision: source.permissionRevision, kind: 'cache', payload, createdAt: new Date().toISOString() })
    else if (existingArtifact.payload !== payload) fail('保存済みの元データが一致しません。')
    return { sourceId, sourceRevision: source.latestRevision, provenanceId: record.artifactId, selectedSha256: record.selectedSha256, duplicate: prior.some(row => row.id === sourceId), permissions: { ...source.permissions } }
  })
}
