import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { extractDocument } from './document-extract.cjs'

const office = (files) => zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': '<Types/>', ...files }).map(([name, xml]) => [name, strToU8(xml)])))
const rel = target => `<Relationships><Relationship Id="r1" Target="${target}"/></Relationships>`
test('DOCX paragraphs keep Japanese and XML entities with exact positions', async () => {
  const result = await extractDocument({ name: 'fixture.docx', bytes: office({ 'word/document.xml': '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>資料 &amp; 締切</w:t></w:r></w:p><w:p><w:r><w:t>提出してください</w:t></w:r></w:p></w:body></w:document>' }) })
  assert.equal(result.text, '資料 & 締切\n提出してください'); assert.deepEqual(result.document.locations, ['段落1', '段落2']); assert.match(result.document.fileSha256, /^[a-f0-9]{64}$/)
})
test('PPTX follows presentation relation order and XLSX keeps sheet/cell/formula locations', async () => {
  const ppt = await extractDocument({ name: 'fixture.pptx', bytes: office({ 'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>', 'ppt/_rels/presentation.xml.rels': rel('slides/slide3.xml'), 'ppt/slides/slide3.xml': '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>本日提出</a:t></a:r></a:p></p:sld>' }) })
  assert.equal(ppt.text, '本日提出'); assert.equal(ppt.document.locations[0], 'スライド1・段落1')
  const xls = await extractDocument({ name: 'fixture.xlsx', bytes: office({ 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="勤務" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': rel('worksheets/sheet1.xml'), 'xl/sharedStrings.xml': '<sst><si><t>提出</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B2"><f>SUM(A1)</f></c></row></sheetData></worksheet>' }) })
  assert.equal(xls.document.locations[0], '勤務!A1'); assert.match(xls.text, /数式（実行しません）/); assert.equal(xls.document.unread[0].location, '勤務!B2')
})
function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 42 >>\nstream\nBT /F1 12 Tf 10 100 Td (Submit report) Tj ET\nendstream', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>']
  let text = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(text))
}
test('PDF reads text layer and records a blank page as unread, without OCR claims', async () => {
  const result = await extractDocument({ name: 'fixture.pdf', bytes: pdfFixture() })
  assert.match(result.text, /Submit report/); assert.equal(result.document.locations[0], 'ページ1'); assert.equal(result.document.unread[0].location, 'ページ2')
})
test('bad magic, broken XML, DTD, oversized files and zip bombs are rejected', async () => {
  await assert.rejects(extractDocument({ name: 'x.pdf', bytes: strToU8('not PDF') }), /形式/)
  await assert.rejects(extractDocument({ name: 'x.docx', bytes: office({ 'word/document.xml': '<broken>' }) }), /XML/)
  await assert.rejects(extractDocument({ name: 'x.docx', bytes: office({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY a "a">]><x/>' }) }), /XML/)
  await assert.rejects(extractDocument({ name: 'x.pdf', bytes: new Uint8Array(25 * 1024 * 1024 + 1) }), /25MiB/)
  await assert.rejects(extractDocument({ name: 'x.docx', bytes: office({ 'word/document.xml': 'x'.repeat(2 * 1024 * 1024) }) }), /展開サイズ/)
  await assert.rejects(extractDocument({ name: 'x.docx', bytes: office({ '../outside.xml': '<x/>' }) }), /危険/)
})
