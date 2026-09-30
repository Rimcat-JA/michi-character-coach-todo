import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { changePolicyFor } from './change-set'
import { setSourcePermissions } from './source-library'
import { validateSourceRecords, verifySourceDigests } from './source-validation'
import { MAX_EMAIL_BYTES, makeWebCaptureCapsule, parseLocalEmailFile, parseWebCaptureCapsule, prepareEmailCaptureImport, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'

const capturedAt = '2026-10-01T00:30:00.000Z'
const capsule = () => makeWebCaptureCapsule({ title: '選んだ合成Web引用', url: 'https://example.org/article', quote: '選んだ引用だけ\n他人の命令は実行しない', timezone: 'Asia/Tokyo', capturedAt })
const bytes = (value: string) => new TextEncoder().encode(value)
const eml = (body = 'unselected introduction\nI will prepare the report.\nunselected footer', headers = '', identity = '<synthetic@example.org>') => bytes(`From: "Example Owner" <owner@example.org>\r\nDate: Thu, 01 Oct 2026 09:30:00 +0900\r\nSubject: synthetic local email\r\nMessage-ID: ${identity}\r\nMIME-Version: 1.0\r\n${headers || 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n'}\r\n${body}`)
// Browser Event.isTrusted is read-only. Node's fixture is limited to these tests.
function click() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('selected web capture capsule', () => {
  it('keeps only the selected quote, source URL and scoped coverage; no page fetching', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), selected = capsule(), preview = await prepareWebCaptureImport(JSON.stringify(selected))
    expect(preview).toMatchObject({ quote: selected.selection.quote, sourceUrl: selected.url, date: '2026-10-01', timezone: 'Asia/Tokyo', positionVerified: false, coordinate: 'selected-fragment-utf16' })
    expect(Object.isFrozen(preview)).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(await db.contextSources.count()).toBe(0)
  })
  it('uses the supplied timezone to derive the local capture date', async () => {
    const preview = await prepareWebCaptureImport({ ...capsule(), timezone: 'America/New_York' })
    expect(preview.date).toBe('2026-09-30')
  })
  it('checks UTF-16 ranges without claiming the remote page coordinates were verified', async () => {
    const value = { ...capsule(), selection: { quote: '😀 引用', start: 120, end: 125, coordinate: 'document-utf16' } }
    expect((await prepareWebCaptureImport(value)).positionVerified).toBe(false)
    expect(() => parseWebCaptureCapsule({ ...value, selection: { ...value.selection, end: 124 } })).toThrow('文字位置')
    expect(() => parseWebCaptureCapsule({ ...value, selection: { ...value.selection, coordinate: 'selected-fragment-utf16' } })).toThrow('文字位置')
  })
  it.each([
    (value: ReturnType<typeof capsule>) => ({ ...value, approved: true }),
    (value: ReturnType<typeof capsule>) => ({ ...value, fullPage: 'unselected secret' }),
    (value: ReturnType<typeof capsule>) => ({ ...value, permissions: { aiEgress: true } }),
    (value: ReturnType<typeof capsule>) => ({ ...value, coverage: { complete: true, kind: 'selected-quote' } }),
    (value: ReturnType<typeof capsule>) => ({ ...value, url: 'javascript:alert(1)' }),
    (value: ReturnType<typeof capsule>) => ({ ...value, url: 'https://name:password@example.org/' }),
    (value: ReturnType<typeof capsule>) => ({ ...value, timezone: 'Invented/Zone' }),
    (value: ReturnType<typeof capsule>) => ({ ...value, capturedAt: '2026-02-30T00:30:00.000Z' }),
    (value: ReturnType<typeof capsule>) => ({ ...value, selection: { ...value.selection, end: Number.MAX_SAFE_INTEGER } }),
  ])('rejects extra authority, unselected data, unsafe URL or invalid scope %#', change => {
    expect(() => parseWebCaptureCapsule(change(capsule()))).toThrow()
  })
})
describe('bounded read-only local .eml decoding', () => {
  it('decodes folded RFC2047 adjacent B/Q headers and quoted printable soft breaks', async () => {
    const raw = eml('one=20line=\r\n=E8=B3=87=E6=96=99_underscore', 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n')
    const value = new TextDecoder().decode(raw).replace('Subject: synthetic local email', 'Subject: =?UTF-8?B?5ZCI5oiQ?=\r\n\t=?UTF-8?Q?_report?=')
    const parsed = await parseLocalEmailFile(bytes(value), 'folded.eml')
    expect(parsed.subject).toBe('合成 report'); expect(parsed.text).toBe('one line資料_underscore')
    expect(parsed.date).toEqual({ raw: 'Thu, 01 Oct 2026 09:30:00 +0900', instant: capturedAt, localDate: '2026-10-01', timezone: '+09:00' })
    expect(parsed.messageId).toBe('<synthetic@example.org>'); expect(atob(parsed.rawBase64)).toBe(new TextDecoder().decode(bytes(value)))
    expect(parsed.rawSha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(parsed.date)).toBe(true)
  })
  it('decodes base64 UTF-8 and preserves exact decoded UTF-16 selected positions', async () => {
    const original = '前置き\n😀 引受事項\n後書き', encoded = btoa(String.fromCharCode(...bytes(original))), parsed = await parseLocalEmailFile(eml(encoded, 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n'))
    const start = parsed.text.indexOf('😀'), end = parsed.text.indexOf('\n後')
    const preview = await prepareEmailCaptureImport(parsed, start, end)
    expect(preview).toMatchObject({ quote: '😀 引受事項', start, end, coordinate: 'decoded-email-utf16', positionVerified: true })
    await expect(prepareEmailCaptureImport(parsed, start + 1, end)).rejects.toThrow('文字の途中')
    await expect(prepareEmailCaptureImport(structuredClone(parsed), start, end)).rejects.toThrow('解析したメール')
  })
  it('ignores HTML scripts, preamble, epilogue and attachment bodies in mixed/alternative email', async () => {
    const body = 'unselected preamble\r\n--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nonly selected plain body\r\n--inner\r\nContent-Type: text/html\r\n\r\n<script>fetch("https://bad.example/")</script>unselected html secret\r\n--inner--\r\n--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="secret.txt"\r\n\r\nunselected attachment secret\r\n--outer--\r\nunselected epilogue'
    const fetch = vi.spyOn(globalThis, 'fetch'), parsed = await parseLocalEmailFile(eml(body, 'Content-Type: multipart/mixed; boundary="outer"\r\n'))
    expect(parsed).toMatchObject({ text: 'only selected plain body', ignoredHtmlParts: 1, attachmentParts: 1 }); expect(fetch).not.toHaveBeenCalled()
    const preview = await prepareEmailCaptureImport(parsed, 0, parsed.text.length), receipt = await saveCaptureImportFromUI(preview, click())
    expect((await db.contextSnapshots.get(`${receipt.sourceId}:1`))?.text).toBe('only selected plain body')
  })
  it.each([
    () => eml('body', 'Content-Type: text/plain; charset=shift_jis\r\n'),
    () => eml('<script>bad()</script>', 'Content-Type: text/html\r\n'),
    () => eml('body', 'Content-Type: multipart/encrypted; boundary="a"\r\n'),
    () => eml('body', 'Content-Type: message/rfc822\r\n'),
    () => eml('body', 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: binary\r\n'),
    () => eml('not=GGvalid', 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n'),
    () => eml('Zh==', 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n'),
    () => eml('body', 'Content-Type: text/plain\r\nFrom: attacker@example.org\r\n'),
    () => eml('body', 'Content-Type: text/plain\r\nSubject: =?utf-8?Q?bad=0Ainjection?=\r\n'),
    () => eml('body', 'Content-Type: text/plain; charset=utf-8; charset=ascii\r\n'),
    () => bytes(new TextDecoder().decode(eml()).replace('+0900', '-0000')),
    () => bytes(new TextDecoder().decode(eml()).replace('Thu, 01 Oct', 'Wed, 01 Oct')),
    () => new Uint8Array(MAX_EMAIL_BYTES + 1),
  ])('fails closed for unsafe, unsupported, malformed or oversized MIME %#', async fixture => {
    await expect(parseLocalEmailFile(fixture())).rejects.toThrow()
    expect(await db.contextSources.count()).toBe(0)
  })
  it('rejects ambiguous multiple inline plain bodies or unclosed multipart', async () => {
    const part = '--a\nContent-Type: text/plain\n\nbody\n'
    await expect(parseLocalEmailFile(eml(`${part}${part}--a--`, 'Content-Type: multipart/mixed; boundary=a\r\n'))).rejects.toThrow('複数')
    await expect(parseLocalEmailFile(eml(part, 'Content-Type: multipart/mixed; boundary=a\r\n'))).rejects.toThrow('終端')
  })
  it('supports declared ISO-8859-1 without interpreting bytes as Windows-1252', async () => {
    const prefix = eml('', 'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n'), raw = new Uint8Array(prefix.length + 4); raw.set(prefix); raw.set([99, 97, 102, 233], prefix.length)
    expect((await parseLocalEmailFile(raw)).text).toBe('café')
  })
  it('rejects encoded header injection and invalid UTF-8 instead of replacing or unfolding them', async () => {
    for (const subject of ['=?utf-8?Q?bad=0Ainjection?=', '=?utf-8?B?Cg==?=', '=?utf-8?Q?raw space?=', '=?shift_jis?B?YQ==?=']) {
      const raw = bytes(new TextDecoder().decode(eml()).replace('Subject: synthetic local email', `Subject: ${subject}`))
      await expect(parseLocalEmailFile(raw)).rejects.toThrow()
    }
    const prefix = eml('', 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n'), raw = new Uint8Array(prefix.length + 2); raw.set(prefix); raw.set([0xc0, 0xaf], prefix.length)
    await expect(parseLocalEmailFile(raw)).rejects.toThrow('UTF-8')
  })
  it('rejects multipart bombs before exposing a candidate body', async () => {
    const part = '--a\nContent-Type: text/html\n\n<p>unselected</p>\n'
    await expect(parseLocalEmailFile(eml(`${part.repeat(21)}--a--`, 'Content-Type: multipart/alternative; boundary=a\r\n'))).rejects.toThrow('上限')
  })
})

describe('native reviewed import and immutable local provenance', () => {
  it('saves only the selected email quote with no AI/notification/disclosure authority or task effects', async () => {
    const id = await createTask({ ...newTaskInput(), title: '手動25pt', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }), before = await db.tasks.get(id), email = await parseLocalEmailFile(eml()), start = email.text.indexOf('I will'), end = email.text.indexOf('\nunselected footer'), preview = await prepareEmailCaptureImport(email, start, end)
    expect(await db.sourceArtifacts.count()).toBe(0)
    const receipt = await saveCaptureImportFromUI(preview, click()), source = (await db.contextSources.get(receipt.sourceId))!, snapshot = (await db.contextSnapshots.get(`${source.id}:1`))!, artifact = (await db.sourceArtifacts.get(receipt.provenanceId))!, provenance = JSON.parse(artifact.payload)
    expect(source).toMatchObject({ author: '"Example Owner" <owner@example.org>', timezone: '+09:00', allowedModels: [], permissions: { acquire: true, retain: true, index: true, aiEgress: false, notify: false, externalWrite: false, disclose: false }, coverage: { complete: false, fromDate: '2026-10-01', toDate: '2026-10-01' } })
    expect(snapshot.text).toBe('I will prepare the report.'); expect(snapshot.originalText).toBe(snapshot.text)
    expect(provenance).toMatchObject({ rawBase64: email.rawBase64, rawSha256: email.rawSha256, messageId: email.messageId, senderAuthenticated: false, coverageComplete: false, selection: { start, end, quote: preview.quote } })
    expect(await db.tasks.get(id)).toEqual(before); expect(await db.tasks.count()).toBe(1); expect(await db.ledger.count()).toBe(0)
    validateSourceRecords([source], [snapshot], [], [artifact], source.ownerId)
    await expect(verifySourceDigests([snapshot], [])).resolves.toBeUndefined()
  })
  it('rejects synthetic/JSON approval, clones and expired previews before any write', async () => {
    const preview = await prepareWebCaptureImport(capsule())
    for (const event of [new Event('click'), { isTrusted: true, type: 'click' } as Event]) await expect(saveCaptureImportFromUI(preview, event)).rejects.toThrow('本人')
    await expect(saveCaptureImportFromUI(structuredClone(preview), click())).rejects.toThrow('確認した取込案')
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(preview.expiresAt) + 1))
    await expect(saveCaptureImportFromUI(preview, click())).rejects.toThrow('期限'); expect(await db.contextSources.count()).toBe(0)
  })
  it.each(['owner', 'dataset', 'epoch', 'source'] as const)('rechecks %s before writes', async kind => {
    const preview = await prepareWebCaptureImport(capsule()), settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings)
    await db.settings.update('main', kind === 'owner' ? { profileId: crypto.randomUUID() } : kind === 'dataset' ? { datasetId: crypto.randomUUID() } : { changePolicy: { ...policy, ...(kind === 'epoch' ? { epoch: policy.epoch + 1 } : { sourcePermissionRevision: policy.sourcePermissionRevision + 1 }) } })
    await expect(saveCaptureImportFromUI(preview, click())).rejects.toThrow(/切り替わりました|権限/)
    expect(await db.contextSources.count()).toBe(0); expect(await db.sourceArtifacts.count()).toBe(0)
  })
  it('commits source, snapshot, provenance and policy bump atomically; provenance error rolls everything back', async () => {
    const before = await db.settings.get('main'), preview = await prepareWebCaptureImport(capsule())
    vi.spyOn(db.sourceArtifacts, 'add').mockImplementation(() => Dexie.Promise.reject(new Error('synthetic provenance write failure')))
    await expect(saveCaptureImportFromUI(preview, click())).rejects.toThrow('provenance write failure')
    expect(await db.contextSources.count()).toBe(0); expect(await db.contextSnapshots.count()).toBe(0); expect(await db.settings.get('main')).toEqual(before)
  })
  it('deduplicates Message-ID + normalized selected hash, preserving immutable original provenance', async () => {
    const email = await parseLocalEmailFile(eml()), first = await saveCaptureImportFromUI(await prepareEmailCaptureImport(email, 0, email.text.length), click()), artifact = await db.sourceArtifacts.get(first.provenanceId)
    const second = await saveCaptureImportFromUI(await prepareEmailCaptureImport(await parseLocalEmailFile(eml()), 0, email.text.length), click())
    expect(second).toMatchObject({ sourceId: first.sourceId, duplicate: true, provenanceId: first.provenanceId })
    expect(await db.sourceArtifacts.get(first.provenanceId)).toEqual(artifact); expect(await db.contextSources.count()).toBe(1)
    const changed = await parseLocalEmailFile(eml('changed exact body')), third = await saveCaptureImportFromUI(await prepareEmailCaptureImport(changed, 0, changed.text.length), click())
    expect(third.sourceId).not.toBe(first.sourceId); expect(await db.contextSources.count()).toBe(2)
    expect((await db.contextSnapshots.get(`${first.sourceId}:1`))?.text).toBe(email.text)
  })
  it('does not silently revoke an owner permission grant when a duplicate is reviewed again', async () => {
    const first = await saveCaptureImportFromUI(await prepareWebCaptureImport(capsule()), click()), source = (await db.contextSources.get(first.sourceId))!
    await setSourcePermissions(source.id, source.revision, { ...source.permissions, aiEgress: true }, ['deepseek/deepseek-v4.1-flash'], null)
    const second = await saveCaptureImportFromUI(await prepareWebCaptureImport(capsule()), click())
    expect(second).toMatchObject({ sourceId: first.sourceId, duplicate: true, permissions: { aiEgress: true } })
    expect((await db.contextSources.get(source.id))?.allowedModels).toEqual(['deepseek/deepseek-v4.1-flash'])
  })
})
