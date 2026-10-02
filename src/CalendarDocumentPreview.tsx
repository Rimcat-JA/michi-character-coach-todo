import { useEffect, useRef, useState } from 'react'
import type { ScheduleDocumentExtraction, ScheduleDocumentTable } from './calendar-document-import'

export default function CalendarDocumentPreview({ bytes, extraction, table, onTable }: { bytes: Uint8Array; extraction: ScheduleDocumentExtraction; table: ScheduleDocumentTable; onTable: (table: ScheduleDocumentTable) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), [row, setRow] = useState(2), [error, setError] = useState('')
  useEffect(() => {
    if (extraction.document.format !== 'pdf' || !canvas.current) return
    let disposed = false, loading: { destroy: () => Promise<void> } | null = null
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist'); pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes), enableXfa: false, useWorkerFetch: false, verbosity: 0 }); loading = task
        const pdf = await task.promise, page = await pdf.getPage(table.page!), viewport = page.getViewport({ scale: 0.8 })
        if (disposed || !canvas.current) return
        const target = canvas.current, context = target.getContext('2d')!; target.width = viewport.width; target.height = viewport.height
        await page.render({ canvas: target, canvasContext: context, viewport }).promise
        if (disposed) return
        context.strokeStyle = '#cd3261'; context.lineWidth = 2
        for (const cell of table.rows[row - 1]?.locators ?? []) if (cell?.bbox) { const [a, b, c, d, e, f] = viewport.transform, [x1, y1, x2, y2] = cell.bbox, box = [a * x1 + c * y1 + e, b * x1 + d * y1 + f, a * x2 + c * y2 + e, b * x2 + d * y2 + f]; context.strokeRect(Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.abs(box[2] - box[0]), Math.abs(box[3] - box[1])) }
        setError('')
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : String(error)) }
    })()
    return () => { disposed = true; void loading?.destroy() }
  }, [bytes, table, row, extraction.document.format])
  return <section className="csv-preview" aria-label="文書の出典位置"><h3>文書の表と出典位置</h3>
    <label className="field">対象ページ・シート<select aria-label="文書の対象表" value={table.name} onChange={event => { setRow(2); onTable(extraction.tables.find(table => table.name === event.target.value)!) }}>{extraction.tables.map(table => <option key={table.name}>{table.name}</option>)}</select></label>
    <label className="field">強調する行<input type="number" aria-label="文書の強調行" min={1} max={table.rows.length} value={row} onChange={event => setRow(Number(event.target.value))} /></label>
    <p>テキスト層・値だけの表を決定的に読み取ります。OCR、回転ページ、結合セル、数式、曖昧な複数行は確認待ちです。数値のExcel日付は解釈せず、表示文字をCSVへ保存して確認してください。</p>
    {extraction.document.format === 'pdf' && <><p>行の許容幅 {extraction.parameters.yTolerance} / 列の許容幅 {extraction.parameters.xGap}（PDF座標）。設定を変える場合は読み取り直してください。</p><canvas ref={canvas} style={{ maxWidth: '100%', height: 'auto' }} aria-label="PDFの行範囲を強調したページ" /></>}
    {error && <p role="alert">ページ表示を確認できません：{error}</p>}
    <pre>{table.rows[row - 1]?.cells.join(' | ')}</pre>
    <p>{table.rows[row - 1]?.locators.filter(Boolean).map(cell => cell!.address ? `${cell!.sheet}!${cell!.address}` : `ページ${cell!.page}・行${cell!.row}・列${cell!.column}`).join(' / ')}</p>
    <p>元ファイルは保存しません。資料保存には、選択行の抽出文字・原ファイルhash・位置だけを保持します。</p>
  </section>
}
