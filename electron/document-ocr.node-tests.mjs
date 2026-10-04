// Offline general-font OCR path: Tesseract (vendored tessdata) over committed
// OS-font scan fixtures. No network, no download. Tolerances are explicit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const { extractDocument, cancelDocument } = require('./document-extract.cjs')
const { pageImages } = require('./ocr-pdf-images.cjs')

const fixture = name => ({ name, bytes: new Uint8Array(readFileSync(new URL(`./fixtures/ocr/${name}`, import.meta.url))) })
const ocr = { enabled: true, language: 'eng+jpn' }
const norm = text => String(text).normalize('NFC').replace(/\s+/g, ' ').trim()
function distance(a, b) {
  const x = [...a], y = [...b]
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array(y.length).fill(0)])
  for (let j = 1; j <= y.length; j++) dp[0][j] = j
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
  return dp[x.length][y.length]
}
const cer = (actual, expected) => distance(norm(actual), norm(expected)) / Math.max(1, [...norm(expected)].length)

const EN = 'Meeting at 10:00\nPlease submit the report'
const JA = '会議は10時からです\n提出してください'
const MIXED = 'Meeting at 10:00\n会議は10時からです'

test('engine record pins Tesseract version, license and vendored asset hashes', () => {
  const { ENGINE, version } = require('./ocr-tesseract.cjs')
  assert.equal(version(), require('tesseract.js/package.json').version)
  assert.equal(version(), '6.0.1')
  assert.equal(ENGINE.name, 'tesseract.js')
  assert.equal(ENGINE.languages, 'eng+jpn')
  assert.match(ENGINE.license, /Apache-2\.0/)
  const dir = new URL('./ocr-tessdata/', import.meta.url)
  const hash = createHash('sha256')
  for (const file of ['eng.traineddata', 'jpn.traineddata']) hash.update(readFileSync(new URL(file, dir)))
  assert.match(hash.digest('hex'), /^[a-f0-9]{64}$/)
})

test('OCR path performs no network fetch', () => {
  for (const file of ['ocr-tesseract.cjs', 'ocr-pdf-images.cjs', 'document-extract.cjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /require\(['"]node:(https?|net|http)['"]/)
    assert.doesNotMatch(source, /[^a-zA-Z]fetch\s*\(/)
  }
  const worker = readFileSync(new URL('./document-worker.cjs', import.meta.url), 'utf8')
  assert.match(worker, /globalThis\.fetch = async \(\) => \{ throw/)
})

test('English scan reads exact with word boxes (default OFF keeps old behavior)', async () => {
  await assert.rejects(extractDocument(fixture('ocr-en.pdf')), /OCR選択/)
  const result = await extractDocument({ ...fixture('ocr-en.pdf'), ocr })
  assert.ok(cer(result.text, EN) <= 0.08, `CER bound: ${result.text}`)
  assert.deepEqual(result.document.locations, ['ページ1・OCR行1', 'ページ1・OCR行2'])
  assert.equal(result.document.ocr.engine, 'tesseract.js')
  assert.equal(result.document.ocr.languages, 'eng+jpn')
  assert.equal(result.document.ocr.pages[0].status, 'ok')
  assert.equal(result.document.ocr.pages[0].verified, true)
  assert.ok(result.document.ocr.pages[0].confidence >= 0.7)
  assert.equal(result.document.ocr.pages[0].boxes.length, 2)
  for (const box of result.document.ocr.pages[0].boxes) assert.equal(box.length, 4)
  assert.ok(result.document.notices.some(notice => notice.includes('外部送信なし')))
})

test('Japanese and mixed scans read within stated CER bounds', async () => {
  const ja = await extractDocument({ ...fixture('ocr-ja.pdf'), ocr })
  assert.ok(cer(ja.text, JA) <= 0.12, `JA CER bound: ${ja.text}`)
  assert.equal(ja.document.ocr.pages[0].verified, true)
  const mixed = await extractDocument({ ...fixture('ocr-mixed.pdf'), ocr })
  assert.ok(cer(mixed.text, MIXED) <= 0.12, `mixed CER bound: ${mixed.text}`)
})

test('page mapping follows drawn references, not storage order', async () => {
  const { pages } = pageImages(fixture('ocr-shuffled.pdf').bytes)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].length, 1)
  assert.ok(!pages[0][0].unsupported)
  const result = await extractDocument({ ...fixture('ocr-shuffled.pdf'), ocr })
  assert.ok(cer(result.text, MIXED) <= 0.12)
})

test('shared image objects decode once and serve every reusing page', async () => {
  const { pages } = pageImages(fixture('ocr-reuse.pdf').bytes)
  assert.equal(pages.length, 2)
  assert.equal(pages[0][0].objid, pages[1][0].objid)
  const result = await extractDocument({ ...fixture('ocr-reuse.pdf'), ocr })
  assert.deepEqual(result.document.locations, ['ページ1・OCR行1', 'ページ1・OCR行2', 'ページ2・OCR行1', 'ページ2・OCR行2'])
  assert.ok(cer(result.text, `${EN}\n${EN}`) <= 0.08)
})

test('multi-image pages process the largest drawn image and list the rest', async () => {
  const result = await extractDocument({ ...fixture('ocr-multi.pdf'), ocr })
  assert.ok(cer(result.text, MIXED) <= 0.12)
  assert.ok(result.document.unread.some(item => item.location === 'ページ1・画像2' && /最大の画像/.test(item.reason)))
})

test('images on text-layer pages are never OCR targets', async () => {
  const result = await extractDocument({ ...fixture('ocr-logo-text.pdf'), ocr })
  assert.equal(result.text, 'Hello')
  assert.deepEqual(result.document.locations, ['ページ1'])
  assert.equal(result.document.unread.length, 0)
  assert.ok(!result.text.includes('ACME'))
})

test('blank and rotated scans never verify', async () => {
  await assert.rejects(extractDocument({ ...fixture('ocr-blank.pdf'), ocr }), /白紙または読取不可/)
  const tilted = await extractDocument({ ...fixture('ocr-rotated.pdf'), ocr })
  assert.equal(tilted.document.ocr.pages[0].verified, false)
  assert.equal(tilted.document.ocr.pages[0].status, 'low-confidence')
  assert.ok(tilted.document.ocr.pages[0].confidence < 0.7)
})

// Raw single-image PDFs for structural edge cases (no font rendering involved).
function rawImagePdf({ width, height, color, bits, filters, streamBytes }) {
  const filterPart = filters.length ? (filters.length === 1 ? `/Filter /${filters[0]}` : `/Filter [${filters.map(f => `/${f}`).join(' ')}]`) : ''
  const hex = filters.includes('ASCIIHexDecode')
  const body = hex ? `${Buffer.from(streamBytes).toString('hex')}>\n` : `${Buffer.from(streamBytes).toString('latin1')}\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im3 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${color} /BitsPerComponent ${bits} ${filterPart} /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}endstream`,
    '<< /Length 31 >>\nstream\nq 10 0 0 10 0 0 cm /Im3 Do Q\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return { name: 'edge.pdf', bytes: new Uint8Array(Buffer.from(pdf, 'latin1')) }
}

test('JPEG/DCT images stay unread with an explicit reason instead of a guess', async () => {
  await assert.rejects(extractDocument({ ...rawImagePdf({ width: 4, height: 4, color: 'DeviceGray', bits: 8, filters: ['DCTDecode'], streamBytes: new Uint8Array(8) }), ocr }), /DCTDecode/)
})

test('declared dimensions are enforced before any pixel buffer is allocated', async () => {
  const t0 = Date.now()
  await assert.rejects(
    extractDocument({ ...rawImagePdf({ width: 20000, height: 20000, color: 'DeviceGray', bits: 8, filters: ['FlateDecode'], streamBytes: new Uint8Array(100) }), ocr }),
    /上限/
  )
  assert.ok(Date.now() - t0 < 15000, 'pre-decode rejection stays fast')
})

test('document-wide declared total is enforced before decoding the excess page', async () => {
  const { deflateSync } = await import('fflate')
  // 5 pages x 7MP of zeros: tiny on disk, 35MP declared. Page 5 must refuse pre-decode.
  const zeros = Buffer.from(deflateSync(new Uint8Array(7 * 1024 * 1024))).toString('latin1')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [5 0 R 8 0 R 11 0 R 14 0 R 17 0 R] /Count 5 >>']
  for (let p = 0; p < 5; p++) {
    const img = 3 + p * 3, content = 4 + p * 3, page = 5 + p * 3
    const pad = id => { while (objects.length < id) objects.push('<< >>') }
    pad(img); objects[img - 1] = `<< /Type /XObject /Subtype /Image /Width 2800 /Height 2500 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${Buffer.byteLength(zeros, 'latin1')} >>\nstream\n${zeros}endstream`
    pad(content); objects[content - 1] = `<< /Length 30 >>\nstream\nq 10 0 0 10 0 0 cm /Im Do Q\nendstream`
    pad(page); objects[page - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im ${img} 0 R >> >> /Contents ${content} 0 R >>`
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  await assert.rejects(extractDocument({ name: 'total.pdf', bytes: new Uint8Array(Buffer.from(pdf, 'latin1')), ocr }), /総処理量/)
})

test('OCR timeout is enforced and only shortenable', async () => {
  await assert.rejects(extractDocument({ name: 'x.pdf', bytes: new Uint8Array([1]), ocr: { enabled: true, timeoutMs: 0 } }), /OCR選択が不正/)
  await assert.rejects(extractDocument({ name: 'x.pdf', bytes: new Uint8Array([1]), ocr: { enabled: true, timeoutMs: 60001 } }), /OCR選択が不正/)
  await assert.rejects(extractDocument({ ...fixture('ocr-cancel.pdf'), ocr: { enabled: true, language: 'eng+jpn', timeoutMs: 100 } }), /時間上限/)
})

test('cancel during real OCR rejects and the next extraction still succeeds', async () => {
  const pending = extractDocument({ ...fixture('ocr-cancel.pdf'), ocr })
  await new Promise(resolve => setTimeout(resolve, 30))
  await cancelDocument()
  await pending.then(
    () => assert.fail('cancelled OCR must not resolve with adopted text'),
    error => assert.match(error instanceof Error ? error.message : String(error), /中止/)
  )
  const again = await extractDocument({ ...fixture('ocr-en.pdf'), ocr })
  assert.ok(cer(again.text, EN) <= 0.08)
})

test('sequential documents reuse nothing across calls', async () => {
  const first = await extractDocument({ ...fixture('ocr-en.pdf'), ocr })
  const second = await extractDocument({ ...fixture('ocr-ja.pdf'), ocr })
  assert.ok(cer(first.text, EN) <= 0.08)
  assert.ok(cer(second.text, JA) <= 0.12)
})

test('OCR is PDF-only: Office and schedule paths refuse instead of guessing', async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const office = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>本文</w:t></w:r></w:p></w:body></w:document>') })
  await assert.rejects(extractDocument({ name: 'doc.docx', bytes: office, ocr }), /PDFの画像ページだけ/)
  const { extractScheduleDocument } = require('./document-extract.cjs')
  await assert.rejects(extractScheduleDocument({ name: 'r.pdf', bytes: new Uint8Array([1]), yTolerance: 2, xGap: 12, ocr }), /未接続/)
})
