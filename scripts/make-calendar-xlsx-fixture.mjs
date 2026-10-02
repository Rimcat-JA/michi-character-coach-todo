import { zipSync, strToU8 } from 'fflate'
import { writeFile, readFile } from 'node:fs/promises'
const base = new URL('../docs/examples/', import.meta.url), rows = (await readFile(new URL('roster-pdf-table.csv', base), 'utf8')).trim().split(/\r?\n/).map(row => row.split(','))
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
const sheet = '<worksheet><sheetData>' + rows.map((row, r) => '<row>' + row.map((text, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${escape(text)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>'
const files = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="SyntheticRoster" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': sheet }
await writeFile(new URL('roster-xlsx-table.xlsx', base), zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))))
