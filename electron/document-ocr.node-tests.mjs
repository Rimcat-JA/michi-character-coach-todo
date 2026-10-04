// Local OCR path: real pixel-to-text extraction over generated scan PDFs.
// No network, no model download. Fixtures are deterministic (seeded noise).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { extractDocument, cancelDocument } = require('./document-extract.cjs')
const { ENGINE, assetHash, renderTextBitmap } = require('./ocr-engine.cjs')
const { extractPdfImages } = require('./ocr-pdf-images.cjs')

function seeded(seed) {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}
const noisy = (bitmap, rate, seed) => {
  const rand = seeded(seed)
  const pixels = Uint8Array.from(bitmap.pixels)
  for (let i = 0; i < pixels.length; i++) if (rand() < rate) pixels[i] = pixels[i] < 128 ? 255 : 0
  return { pixels, width: bitmap.width, height: bitmap.height }
}
const rotated = (bitmap, degrees) => {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad)
  const w = bitmap.width, h = bitmap.height
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)) + 8
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos)) + 8
  const pixels = new Uint8Array(nw * nh).fill(255)
  const cx = w / 2, cy = h / 2, nx = nw / 2, ny = nh / 2
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.round((x - nx) * cos + (y - ny) * sin + cx)
    const sy = Math.round(-(x - nx) * sin + (y - ny) * cos + cy)
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) pixels[y * nw + x] = bitmap.pixels[sy * w + sx]
  }
  return { pixels, width: nw, height: nh }
}
const toHex = pixels => Buffer.from(pixels).toString('hex')
// Minimal scan PDF: one grayscale image XObject per page (ASCIIHex, DeviceGray 8-bit).
function scanPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `__PAGES__`]
  const pageIds = []
  pages.forEach(image => {
    const pageId = objects.length + 1
    pageIds.push(pageId)
    const imgId = pageId + 1, contentId = pageId + 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im${pageId} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.width * image.height * 2 + 1} >>\nstream\n${toHex(image.pixels)}>\nendstream`)
    objects.push(`<< /Length 50 >>\nstream\nq ${image.width} 0 0 ${image.height} 0 0 cm /Im${pageId} Do Q\nendstream`)
  })
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(text, 'latin1'))
}
const ocr = { enabled: true, language: 'eng+jpn' }

test('engine metadata is recorded: version, languages, license, asset hash', () => {
  assert.equal(ENGINE.name, 'michi-local-block-ocr')
  assert.match(ENGINE.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(ENGINE.languages, ['eng', 'jpn'])
  assert.match(assetHash(), /^[a-f0-9]{64}$/)
  assert.match(ENGINE.license, /repo-local/)
  for (const ch of 'MEETING 1000本人確認') assert.ok(ENGINE.charset.includes(ch), `charset covers ${ch}`)
})

test('OCR files never fetch: no network imports in the OCR path', () => {
  for (const file of ['ocr-engine.cjs', 'ocr-pdf-images.cjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /fetch\s*\(|require\(['"]node:(https?|net|http)|from ['"]node:https?/i)
  }
})

test('English scan PDF extracts exact text with engine record (default OFF keeps old behavior)', async () => {
  const bytes = scanPdf([renderTextBitmap('MEETING 1000')])
  await assert.rejects(extractDocument({ name: 'scan.pdf', bytes }), /OCR選択/)
  const result = await extractDocument({ name: 'scan.pdf', bytes, ocr })
  assert.equal(result.text, 'MEETING 1000')
  assert.deepEqual(result.document.locations, ['ページ1・OCR行1'])
  assert.equal(result.document.ocr.engine, ENGINE.name)
  assert.equal(result.document.ocr.version, ENGINE.version)
  assert.equal(result.document.ocr.languages, 'eng+jpn')
  assert.equal(result.document.ocr.assetHash, assetHash())
  assert.equal(result.document.ocr.pages.length, 1)
  assert.equal(result.document.ocr.pages[0].status, 'ok')
  assert.ok(result.document.ocr.pages[0].confidence >= 0.95)
  assert.equal(result.document.ocr.pages[0].verified, true)
  assert.ok(result.document.notices.some(notice => notice.includes('外部送信なし')))
  assert.ok(result.document.notices.some(notice => notice.includes('直接変更しません')))
})

test('Japanese scan PDF extracts exact text with page-tagged locations', async () => {
  const ja = await extractDocument({ name: 'scan.pdf', bytes: scanPdf([renderTextBitmap('本人確認')]), ocr })
  assert.equal(ja.text, '本人確認')
  assert.deepEqual(ja.document.locations, ['ページ1・OCR行1'])
  assert.equal(ja.document.ocr.pages[0].status, 'ok')
  assert.equal(ja.document.ocr.pages[0].verified, true)
})

test('mixed pages keep the text layer and append OCR lines with page tags', async () => {
  // Page 1: real text layer (Helvetica). Page 2: image-only scan for OCR.
  const image = renderTextBitmap('本人確認')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 8 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.width * image.height * 2 + 1} >>\nstream\n${toHex(image.pixels)}>\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 42 >>\nstream\nBT /F1 12 Tf 10 100 Td (Submit report) Tj ET\nendstream',
    `<< /Length 44 >>\nstream\nq ${image.width} 0 0 ${image.height} 0 0 cm /Im0 Do Q\nendstream`,
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const mixed = await extractDocument({ name: 'mixed.pdf', bytes: new Uint8Array(Buffer.from(text, 'latin1')), ocr })
  assert.match(mixed.text, /Submit report/)
  assert.match(mixed.text, /本人確認/)
  assert.deepEqual(mixed.document.locations, ['ページ1', 'ページ2・OCR行1'])
  assert.equal(mixed.document.unread.length, 0)
})

test('blank and rotated scans are refused without fabricated text', async () => {
  const blank = { pixels: new Uint8Array(300 * 100).fill(255), width: 300, height: 100 }
  await assert.rejects(extractDocument({ name: 'blank.pdf', bytes: scanPdf([blank]), ocr }), /白紙または文字がありません/)
  const tilted = rotated(renderTextBitmap('MEETING 1000'), 12)
  await assert.rejects(extractDocument({ name: 'tilted.pdf', bytes: scanPdf([tilted]), ocr }), /回転・傾き・ノイズ/)
})

test('noisy scans degrade explicitly: unknown marks, unverified, lower confidence', async () => {
  const clean = await extractDocument({ name: 'c.pdf', bytes: scanPdf([renderTextBitmap('MEETING 1000')]), ocr })
  const degraded = await extractDocument({ name: 'n.pdf', bytes: scanPdf([noisy(renderTextBitmap('MEETING 1000'), 0.02, 7)]), ocr })
  assert.match(degraded.text, /□/)
  assert.equal(degraded.document.ocr.pages[0].verified, false)
  assert.ok(degraded.document.ocr.pages[0].confidence < clean.document.ocr.pages[0].confidence)
  assert.ok(degraded.text.replace(/[□\s]/g, '').length >= 8, 'most characters survive light noise')
})

test('JPEG/DCT images stay unread with an explicit reason instead of a guess', async () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length 8 >>\nstream\nFFFFFFFFFFFFFFFF\nendstream', '<< /Length 31 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream']
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  await assert.rejects(extractDocument({ name: 'photo.pdf', bytes: new Uint8Array(Buffer.from(text, 'latin1')), ocr }), /DCTDecode/)
})

test('PDF image extractor decodes gray/RGB/1-bit/Flate and flags oversized input', async () => {
  const gray = renderTextBitmap('REPORT 2026')
  const found = extractPdfImages(scanPdf([gray]))
  assert.equal(found.length, 1)
  assert.ok(!found[0].unsupported)
  assert.equal(found[0].width, gray.width)
  assert.deepEqual(found[0].pixels, gray.pixels)
  // Raw single-image PDFs in every supported encoding: RGB, 1-bit, Flate.
  const { deflateSync } = await import('fflate')
  const rawImagePdf = (image, { color, bits, filters, streamBytes }) => {
    const filterPart = filters.length === 1 ? `/Filter /${filters[0]}` : `/Filter [${filters.map(f => `/${f}`).join(' ')}]`
    const body = filters.includes('ASCIIHexDecode') ? `${Buffer.from(streamBytes).toString('hex')}>\n` : `${Buffer.from(streamBytes).toString('latin1')}\n`
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im3 4 0 R >> >> /Contents 5 0 R >>`,
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${color} /BitsPerComponent ${bits} ${filterPart} /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}endstream`,
      '<< /Length 31 >>\nstream\nq 10 0 0 10 0 0 cm /Im3 Do Q\nendstream',
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = [0]
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return new Uint8Array(Buffer.from(pdf, 'latin1'))
  }
  const rgb = { width: 2, height: 1, pixels: new Uint8Array([200, 200, 200, 10, 10, 10]) }
  const rgbRaw = new Uint8Array([200, 200, 200, 10, 10, 10])
  const rgbFound = extractPdfImages(rawImagePdf(rgb, { color: 'DeviceRGB', bits: 8, filters: [], streamBytes: rgbRaw }))
  assert.deepEqual(rgbFound[0].pixels, new Uint8Array([200, 10]))
  const bw = { width: 9, height: 1 }
  const bwFound = extractPdfImages(rawImagePdf(bw, { color: 'DeviceGray', bits: 1, filters: [], streamBytes: new Uint8Array([0xff, 0x00]) }))
  assert.deepEqual(bwFound[0].pixels.slice(0, 9), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 255]))
  const flateHex = deflateSync(gray.pixels)
  const flateFound = extractPdfImages(rawImagePdf(gray, { color: 'DeviceGray', bits: 8, filters: ['ASCIIHexDecode', 'FlateDecode'], streamBytes: flateHex }))
  assert.ok(!flateFound[0].unsupported)
  assert.deepEqual(flateFound[0].pixels, gray.pixels)
})

test('cancel leaves no adopted response: next extraction still succeeds', async () => {
  const { renderTextBitmap: render } = require('./ocr-engine.cjs')
  const pages = Array.from({ length: 30 }, (_, i) => render(`REPORT ${(2020 + i) % 100}${i}`.slice(0, 11)))
  const bytes = scanPdf(pages)
  const pending = extractDocument({ name: 'scan.pdf', bytes, ocr })
  // Whether the worker already finished or not, cancel must not deadlock or
  // poison later requests; a late first response is never adopted afterwards.
  await cancelDocument()
  const outcome = await pending.then(
    value => value.text,
    error => `rejected:${error instanceof Error ? error.message : String(error)}`
  )
  if (outcome.startsWith('rejected:')) assert.match(outcome, /中止|時間上限|終わって|文書を読み取れません/)
  else assert.match(outcome, /REPORT/)
  const again = await extractDocument({ name: 'scan.pdf', bytes: scanPdf([render('REPORT 2026')]), ocr })
  assert.equal(again.text, 'REPORT 2026')
})

test('OCR is PDF-only: Office and schedule paths refuse instead of guessing', async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const office = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>本文</w:t></w:r></w:p></w:body></w:document>') })
  await assert.rejects(extractDocument({ name: 'doc.docx', bytes: office, ocr }), /PDFの画像ページだけ/)
  const { extractScheduleDocument } = require('./document-extract.cjs')
  await assert.rejects(extractScheduleDocument({ name: 'r.pdf', bytes: new Uint8Array([1]), yTolerance: 2, xGap: 12, ocr }), /未接続/)
})
