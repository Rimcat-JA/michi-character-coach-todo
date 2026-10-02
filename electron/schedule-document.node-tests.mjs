import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { extractScheduleDocument } from './document-extract.cjs'
import { pdfGrid } from './schedule-document-grid.mjs'

const input = (name, bytes) => ({ name, bytes, yTolerance: 2, xGap: 12 })
const office = (extra = '') => zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="勤務" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>勤務日</t></is></c><c r="B1" t="inlineStr"><is><t>氏名</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>2026-10-03</t></is></c><c r="B2" t="inlineStr"><is><t>本人</t></is></c></row></sheetData>${extra}</worksheet>` }).map(([name, text]) => [name, strToU8(text)])))
test('PDF table extraction keeps cell geometry and exact row order deterministically', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../docs/examples/roster-pdf-table.pdf', import.meta.url)))
  const first = await extractScheduleDocument(input('roster.pdf', bytes)), second = await extractScheduleDocument(input('roster.pdf', bytes))
  assert.deepEqual(first.tables, second.tables); assert.equal(first.tables.length, 1)
  assert.equal(first.document.size, bytes.length); assert.equal(first.document.fileSha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(first.tables[0].rows[0].cells, ['shift_id', 'record_revision', 'person_ref', 'published', 'status', 'start_date', 'start_time', 'end_date', 'end_time'])
  assert.equal(first.tables[0].rows[1].cells[0], 'night'); assert.equal(first.tables[0].rows[1].locators[0].page, 1); assert.equal(first.tables[0].rows[1].locators[0].bbox.length, 4)
})
test('PDF calendar twin has the same deterministic values as CSV', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../docs/examples/calendar-pdf-table.pdf', import.meta.url))), result = await extractScheduleDocument(input('calendar.pdf', bytes))
  assert.deepEqual(result.tables[0].rows.map(row => row.cells.join(',')), readFileSync(new URL('../docs/examples/calendar-pdf-table.csv', import.meta.url), 'utf8').trim().split(/\r?\n/))
})
test('XLSX table rows retain sheet and cell addresses without evaluating formulas', async () => {
  const result = await extractScheduleDocument(input('roster.xlsx', office()))
  assert.deepEqual(result.tables[0].rows[1].cells, ['2026-10-03', '本人']); assert.deepEqual(result.tables[0].rows[1].locators[0], { sheet: '勤務', address: 'A2', row: 2, column: 1 })
  await assert.rejects(extractScheduleDocument(input('merge.xlsx', office('<mergeCells><mergeCell ref="A2:B2"/></mergeCells>'))), /結合/)
  const formula = office(); const files = (await import('fflate')).unzipSync(formula); files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet><sheetData><row><c r="A1"><f>NOW()</f><v>2</v></c></row></sheetData></worksheet>')
  await assert.rejects(extractScheduleDocument(input('formula.xlsx', zipSync(files))), /数式/)
})
test('ambiguous, rotated, scanned and oversized grids are held rather than guessed', async () => {
  const item = (patch = {}) => ({ text: 'cell', index: 0, x: 10, y: 100, width: 30, height: 10, rotated: false, ...patch })
  assert.throws(() => pdfGrid([], {}), /OCR/); assert.throws(() => pdfGrid([item({ rotated: true })], {}), /回転/)
  assert.throws(() => pdfGrid([item(), item({ index: 1, x: 12 })], {}), /複数/)
  assert.throws(() => pdfGrid([item(), item({ index: 1, y: 92 })], {}), /複数行/)
  await assert.rejects(extractScheduleDocument(input('huge.pdf', new Uint8Array(25 * 1024 * 1024 + 1))), /25MiB/)
  await assert.rejects(extractScheduleDocument({ ...input('bad.pdf', new Uint8Array([1])), yTolerance: Infinity }), /25MiB/)
})

function imageOnlyPDF(encrypted=false){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>','<< /Length 31 >>\nstream\nq 100 0 0 100 0 0 cm /Im1 Do Q\nendstream','<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 8 >>\nstream\nFF0000>\nendstream'];if(encrypted)objects.push('<< /Filter /Standard /V 1 /R 2 /O <'+ '00'.repeat(32)+'> /U <'+ '00'.repeat(32)+'> /P -4 >>')
 let text='%PDF-1.4\n',offsets=[0];for(const [index,value]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${value}\nendobj\n`}const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R ${encrypted?'/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]':''} >>\nstartxref\n${xref}\n%%EOF`;return new Uint8Array(Buffer.from(text))
}
test('actual image-only and encrypted PDF bytes are refused in the worker, without OCR or a password prompt',async()=>{
 await assert.rejects(extractScheduleDocument(input('scan.pdf',imageOnlyPDF())),/OCR/)
 await assert.rejects(extractScheduleDocument(input('encrypted.pdf',imageOnlyPDF(true))),/password|パスワード|暗号/i)
})
