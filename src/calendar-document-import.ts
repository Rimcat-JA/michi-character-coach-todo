import { pdfGrid } from '../electron/schedule-document-grid.mjs'
import { csvBytesDigest } from './calendar-csv-import'
import type { SnapshotDocument } from './source-library'
import { db } from './db'
export type ScheduleCellLocator = { row: number; column: number; page?: number; sheet?: string; address?: string; itemIndices?: number[]; bbox?: number[] }
export type ScheduleDocumentTable = { name: string; page?: number; width?: number; height?: number; rows: { cells: string[]; locators: (ScheduleCellLocator | null)[] }[] }
export type ScheduleDocumentExtraction = { text: string; document: SnapshotDocument; tables: ScheduleDocumentTable[]; parameters: { yTolerance: number; xGap: number } }
export type ScheduleDocumentEvidence = { format: 'pdf' | 'xlsx'; fileSha256: string; size: number; table: string; parameters: { yTolerance: number; xGap: number }; rows: { row: number; cells: ScheduleCellLocator[] }[] }
export const tableCSVBytes = (table: ScheduleDocumentTable) => new TextEncoder().encode(table.rows.map(row => row.cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n')
export async function browserPDF(bytes: Uint8Array, name: string, yTolerance = 2, xGap = 12): Promise<ScheduleDocumentExtraction> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), enableXfa: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 })
  const tables: ScheduleDocumentTable[] = []
  try {
    const pdf = await task.promise
    if (pdf.numPages > 200) throw new Error('PDFは200ページ以内です')
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      if (page.rotate !== 0) throw new Error('回転したPDFページは未対応です')
      const content = await page.getTextContent(), items = content.items.filter(item => 'str' in item).map((item, index) => ({ text: item.str, index, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height, rotated: Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01 }))
      const rows = pdfGrid(items, { yTolerance, xGap })
      tables.push({ name: `ページ${pageNumber}`, page: pageNumber, width: page.view[2], height: page.view[3], rows: rows.map(row => ({ ...row, locators: row.locators.map(cell => cell && { ...cell, page: pageNumber }) })) })
      page.cleanup()
    }
  } catch (error) { if (error instanceof Error && error.name === 'PasswordException') throw new Error('暗号化PDFは読み取れません'); throw error } finally { await task.destroy() }
  return { text: tables.flatMap(table => table.rows.map(row => row.cells.join(' | '))).join('\n'), document: { format: 'pdf', name, size: bytes.length, fileSha256: await csvBytesDigest(bytes), locations: [], unread: [], notices: ['テキスト層の表だけを端末内で読み取ります。OCRは未対応です。'] }, tables, parameters: { yTolerance, xGap } }
}
export async function extractCalendarDocument(file: Pick<File, 'size' | 'name' | 'arrayBuffer'>, yTolerance = 2, xGap = 12) {
  const state = await db.datasetState.get('main'); if (state && state.mode !== 'active') throw new Error('移行中・読み取り専用のデータでは予定資料の読取を停止しています')
  if (!file.size || file.size > 25 * 1024 * 1024 || !/\.(pdf|xlsx)$/i.test(file.name)) throw new Error('25MiB以内のPDF/XLSXを選んでください')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) throw new Error('選択後にファイルサイズが変わりました')
  const extraction = window.michiAI?.extractScheduleDocument ? await window.michiAI.extractScheduleDocument({ name: file.name.slice(0, 200), bytes, yTolerance, xGap }) : /\.pdf$/i.test(file.name) ? await browserPDF(bytes, file.name, yTolerance, xGap) : (() => { throw new Error('XLSXの表読取はWindows版で使えます。ブラウザではCSVへ保存してください') })()
  return { extraction, bytes }
}
export function tableEvidence(extraction: ScheduleDocumentExtraction, table: ScheduleDocumentTable): ScheduleDocumentEvidence {
  if (!['pdf', 'xlsx'].includes(extraction.document.format)) throw new Error('予定資料の形式が不正です')
  return { format: extraction.document.format as 'pdf' | 'xlsx', fileSha256: extraction.document.fileSha256, size: extraction.document.size, table: table.name, parameters: extraction.parameters, rows: table.rows.map((row, index) => ({ row: index + 1, cells: row.locators.filter((cell): cell is ScheduleCellLocator => cell !== null) })) }
}
