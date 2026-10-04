const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { unzipSync } = require('fflate')
const { XMLParser, XMLValidator } = require('fast-xml-parser')
const { pdfGrid } = require('./schedule-document-grid.mjs')
// No network, including paths accidentally requested by a parsing library.
globalThis.fetch = async () => { throw new Error('文書読取中は通信しません') }
const fail = message => { throw new Error(message) }
function validateOcrOption(ocr) {
  if (ocr === undefined) return { enabled: false }
  if (!ocr || typeof ocr !== 'object' || Array.isArray(ocr)) fail('OCR指定が不正です')
  const keys = Object.keys(ocr).sort().join(',')
  if (keys !== 'enabled' && keys !== 'enabled,language') fail('OCR指定が不正です')
  if (typeof ocr.enabled !== 'boolean') fail('OCR指定が不正です')
  if (ocr.language !== undefined && ocr.language !== 'eng+jpn') fail('OCR言語はeng+jpnだけが対象です')
  return { enabled: ocr.enabled }
}
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false })
function xml(bytes) {
  if (!bytes || bytes.length > 20 * 1024 * 1024) fail('文書内のXMLがないか大きすぎます')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) fail('文書内のXMLが不正です')
  return parser.parse(text)
}
function elements(nodes, tag, out = []) {
  for (const node of nodes ?? []) for (const [key, value] of Object.entries(node)) {
    if (key === tag) out.push({ children: value, attrs: node[':@'] ?? {} })
    if (Array.isArray(value)) elements(value, tag, out)
  }
  return out
}
const texts = (nodes, tag) => elements(nodes, tag).map(row => row.children.map(item => item['#text'] ?? '').join('')).join('')
function zipEntries(bytes) {
  const data = Buffer.from(bytes)
  let end = data.length - 22
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) fail('文書のZIP構造が壊れています')
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16)
  if (count > 5000 || start + size > end || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) fail('文書のZIPサイズ・エントリ数が上限を超えています')
  let offset = start, total = 0; const names = new Set()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) fail('文書のZIP構造が壊れています')
    const compressed = data.readUInt32LE(offset + 20), original = data.readUInt32LE(offset + 24), length = data.readUInt16LE(offset + 28)
    const name = data.subarray(offset + 46, offset + 46 + length).toString('utf8')
    total += original
    if (data.readUInt16LE(offset + 8) & 1 || original > 20 * 1024 * 1024 || total > 100 * 1024 * 1024 || original > Math.max(1024 * 1024, compressed * 200) || name.includes('..') || name.startsWith('/') || name.includes('\\') || names.has(name)) fail('暗号化・危険なZIP・展開サイズ超過の文書は読み取れません')
    names.add(name); offset += 46 + length + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32)
  }
  if (offset !== start + size) fail('文書のZIP構造が壊れています')
  return unzipSync(bytes, { filter: entry => /\.xml$|\.rels$/.test(entry.name) && !/vba|embeddings\//i.test(entry.name) })
}
async function extract({ name, bytes, schedule, yTolerance, xGap, ocr }) {
  // PDF.js can transfer/detach its input buffer. Capture original identity before parsing.
  const originalSize = bytes.length, originalSha256 = createHash('sha256').update(bytes).digest('hex')
  const ocrOption = validateOcrOption(ocr)
  const tables = []
  const extension = name.toLowerCase().split('.').pop(), locations = [], lines = [], unread = [], notices = ['原ファイルは保存せず、全文hashと抽出本文だけを保存します。外部リンク・マクロ・埋込オブジェクトを実行しません。', 'テキスト層だけを抽出します。画像・図・埋込オブジェクト・レイアウト・OCRの内容は未確認です。']
  const ocrPages = []
  let ocrEngine = null, ocrImageQueue = null, ocrPixelsTotal = 0
  const ocrNotice = () => {
    if (!ocrOption.enabled || !ocrEngine) return
    notices[1] = 'テキスト層を優先し、文字のないページだけ本人の明示選択で端末内OCRを試みます。OCR結果は候補であり、タスク・期限・点数・台帳を直接変更しません。'
    notices.push(`OCR（端末内・外部送信なし）: ${ocrEngine.name} v${ocrEngine.version}・言語${ocrEngine.languageTag}・${ocrEngine.license}・資産hash ${ocrEngine.hash.slice(0, 16)}…。対応書体はブロック体（${ocrEngine.charsetLength}文字）のみ。低confidence・未検証の行（□を含む）は本人確認が必要です。予定資料の表・回転・結合・数式は未接続です。`)
  }
  const ensureOcrImages = () => {
    if (ocrImageQueue !== null) return ocrImageQueue
    const { ENGINE, assetHash } = require('./ocr-engine.cjs')
    const { extractPdfImages } = require('./ocr-pdf-images.cjs')
    ocrEngine = { name: ENGINE.name, version: ENGINE.version, languageTag: ENGINE.languageTag, license: ENGINE.license, hash: assetHash(), charsetLength: [...ENGINE.charset].length }
    ocrImageQueue = extractPdfImages(bytes)
    return ocrImageQueue
  };
  const add = (location, value) => {
    const text = String(value).replace(/\r\n?|\n/g, ' ').normalize('NFC').trim()
    if (text) { lines.push(text); locations.push(location) }
    if (lines.length > 10000 || lines.join('\n').length > 200000) fail('抽出本文は200000文字・10000行までです')
  }
  const attemptPageOcr = pageNumber => {
    const queue = ensureOcrImages()
    const entry = queue.shift()
    if (!entry) {
      unread.push({ location: `ページ${pageNumber}`, reason: '画像を抽出できませんでした。OCRの対象画像がありません' })
      ocrPages.push({ page: pageNumber, status: 'no-image', confidence: null, chars: 0, verified: false })
      return
    }
    if (entry.unsupported) {
      unread.push({ location: `ページ${pageNumber}`, reason: `OCRで読み取れませんでした（${entry.reason}）。JPEG・回転・低品質の画像は未対応です` })
      ocrPages.push({ page: pageNumber, status: 'unsupported-image', confidence: null, chars: 0, verified: false })
      return
    }
    if (entry.width * entry.height > 8000000) {
      unread.push({ location: `ページ${pageNumber}`, reason: 'OCRで読み取れませんでした（画像がOCR上限8MPを超えています）。分割したPDFで確認してください' })
      ocrPages.push({ page: pageNumber, status: 'pixel-limit', confidence: null, chars: 0, verified: false })
      return
    }
    ocrPixelsTotal += entry.width * entry.height
    if (ocrPixelsTotal > 30000000) {
      unread.push({ location: `ページ${pageNumber}`, reason: 'OCRで読み取れませんでした（総処理量の上限30MPを超えています）。分割したPDFで確認してください' })
      ocrPages.push({ page: pageNumber, status: 'total-limit', confidence: null, chars: 0, verified: false })
      return
    }
    const { ocrBitmap } = require('./ocr-engine.cjs')
    const result = ocrBitmap({ pixels: entry.pixels, width: entry.width, height: entry.height })
    if ((result.status === 'ok' || result.status === 'low-confidence') && result.lines.length) {
      result.lines.forEach((line, index) => add(`ページ${pageNumber}・OCR行${index + 1}`, line.text))
      const verified = result.lines.every(line => line.verified)
      ocrPages.push({ page: pageNumber, status: result.status, confidence: result.confidence, chars: result.lines.reduce((sum, line) => sum + [...line.text].length, 0), verified })
      return
    }
    const reason = { blank: '白紙または文字がありません', 'rotation-suspected': '回転・傾き・ノイズの可能性があり未対応です', unreadable: '読み取れる文字がありません', 'pixel-limit': '画像が大きすぎます', 'too-many-lines': '行数が多すぎます', 'invalid-input': '画像を解読できませんでした' }[result.status] ?? '読み取れる文字がありません'
    unread.push({ location: `ページ${pageNumber}`, reason: `OCRで読み取れませんでした（${reason}）。ブロック体以外の書体・手書き・写真・低品質は未対応です` })
    ocrPages.push({ page: pageNumber, status: `failed:${result.status}`, confidence: null, chars: 0, verified: false })
  }
  if (extension === 'pdf') {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') fail('PDFの形式が不正です')
    if (schedule && ocrOption.enabled) fail('予定資料のOCRは未接続です。表のbbox照合ができるまでテキスト層のPDF/XLSXで確認してください')
    // pdfjs may detach the input buffer; extract OCR images first.
    if (ocrOption.enabled) ensureOcrImages()
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 })
    let pdf
    try {
      pdf = await task.promise
      if (pdf.numPages > 200) fail('PDFは200ページ以内にしてください')
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i), content = await page.getTextContent()
        if (schedule) {
          if (page.rotate !== 0) fail('回転したPDFページは未対応です')
          const items = content.items.filter(item => typeof item.str === 'string').map((item, index) => ({ text: item.str, index, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height, rotated: Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01 }))
          const rows = pdfGrid(items, { yTolerance, xGap })
          tables.push({ name: `ページ${i}`, page: i, width: page.view[2], height: page.view[3], rows: rows.map(row => ({ ...row, locators: row.locators.map(cell => cell && { ...cell, page: i }) })) })
        }
        let line = '', found = false
        for (const item of content.items) if (typeof item.str === 'string') { line += item.str + ' '; if (item.hasEOL) { add(`ページ${i}`, line); found ||= Boolean(line.trim()); line = '' } }
        add(`ページ${i}`, line); found ||= Boolean(line.trim())
        if (!found && !schedule && ocrOption.enabled) { try { attemptPageOcr(i) } catch { unread.push({ location: `ページ${i}`, reason: 'OCRで読み取れませんでした（画像処理を安全に中止しました）' }); ocrPages.push({ page: i, status: 'failed:aborted', confidence: null, chars: 0, verified: false }) } }
        else if (!found) unread.push({ location: `ページ${i}`, reason: 'テキスト層がありません。画像だけのページはOCR選択（既定OFF）で読み取れます' })
        page.cleanup()
      }
    } catch (error) { if (error.name === 'PasswordException') fail('暗号化PDFは読み取れません'); throw error } finally { await task.destroy() }
  } else if (['docx', 'pptx', 'xlsx'].includes(extension)) {
    if (ocrOption.enabled) fail('OCRはPDFの画像ページだけが対象です。Office埋込画像は未読範囲として残します')
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) fail('Office文書の形式が不正です')
    const files = zipEntries(bytes)
    if (!files['[Content_Types].xml']) fail('Office文書の形式が不正です')
    xml(files['[Content_Types].xml'])
    if (extension === 'docx') {
      const document = xml(files['word/document.xml'])
      elements(document, 'w:p').forEach((row, i) => {
        add(`段落${i + 1}`, texts(row.children, 'w:t'))
        if (elements(row.children, 'w:drawing').length || elements(row.children, 'w:pict').length) unread.push({ location: `段落${i + 1}`, reason: '画像・図は未読です' })
      })
      if (Object.keys(files).some(key => /word\/(header|footer|footnotes|endnotes)/.test(key))) unread.push({ location: 'ヘッダー・フッター・脚注', reason: '本文以外は今回の読取対象外です' })
    } else {
      const folder = extension === 'pptx' ? 'ppt' : 'xl'
      const mainName = extension === 'pptx' ? 'presentation' : 'workbook'
      const main = xml(files[`${folder}/${mainName}.xml`]), rels = elements(xml(files[`${folder}/_rels/${mainName}.xml.rels`]), 'Relationship')
      const items = elements(main, extension === 'pptx' ? 'p:sldId' : 'sheet')
      if (items.length > 200) fail('スライド・シートは200以内にしてください')
      let shared = []
      if (files['xl/sharedStrings.xml']) shared = elements(xml(files['xl/sharedStrings.xml']), 'si').map(row => texts(row.children, 't'))
      for (let i = 0; i < items.length; i++) {
        const item = items[i], rel = rels.find(row => row.attrs['@_Id'] === item.attrs['@_r:id'])
        const target = rel?.attrs['@_Target']
        if (typeof target !== 'string' || target.includes('..') || rel.attrs['@_TargetMode'] === 'External') fail('文書内の参照が不正です')
        const file = target.startsWith('/') ? target.slice(1) : `${folder}/${target}`
        const doc = xml(files[file])
        if (extension === 'pptx') {
          const before = lines.length
          elements(doc, 'a:p').forEach((row, p) => add(`スライド${i + 1}・段落${p + 1}`, texts(row.children, 'a:t')))
          if (before === lines.length) unread.push({ location: `スライド${i + 1}`, reason: '文字がありません。画像・図は未読です' })
          else if (elements(doc, 'p:pic').length || elements(doc, 'p:graphicFrame').length) unread.push({ location: `スライド${i + 1}`, reason: '画像・図・表のレイアウトは未確認です' })
        } else {
          const sheet = String(item.attrs['@_name'] ?? `シート${i + 1}`)
          const grid = new Map()
          if (schedule && elements(doc, 'mergeCell').length) fail('結合セルの勤務表は確認待ちです。結合を解除したCSVで確認してください')
          if (elements(doc, 'drawing').length || elements(doc, 'legacyDrawing').length) unread.push({ location: sheet, reason: '画像・図は未読です' })
          for (const cell of elements(doc, 'c')) {
            const address = cell.attrs['@_r'], type = cell.attrs['@_t'], raw = texts(cell.children, 'v'), formula = texts(cell.children, 'f')
            if (typeof address !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) fail('セル番地が不正です')
            let value = type === 's' ? shared[Number(raw)] : type === 'inlineStr' ? texts(cell.children, 't') : raw
            if (type === 's' && (!/^\d+$/.test(raw) || value === undefined)) fail('共有文字列の参照が不正です')
            if (schedule) {
              if (formula) fail('数式を含む勤務表は確認待ちです。値だけのCSVで確認してください')
              const match = address.match(/^([A-Z]+)(\d+)$/), column = [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0), row = Number(match[2])
              if (row > 1000 || column > 100) fail('予定資料の表は1000行・100列以内です')
              if (!grid.has(row)) grid.set(row, [])
              grid.get(row)[column - 1] = { text: String(value ?? ''), locator: { sheet, address, row, column } }
            }
            if (formula) { value = `数式（実行しません）: ${formula} / 保存値: ${value || 'なし'}`; if (!raw) unread.push({ location: `${sheet}!${address}`, reason: '数式の保存値がありません。再計算しません' }) }
            add(`${sheet}!${address}`, value ?? '')
          }
          if (schedule && grid.size) { const width = Math.max(...[...grid.values()].map(row => row.length)); tables.push({ name: sheet, rows: Array.from({ length: Math.max(...grid.keys()) }, (_, r) => { const row = grid.get(r + 1) ?? []; return { cells: Array.from({ length: width }, (_, c) => row[c]?.text ?? ''), locators: Array.from({ length: width }, (_, c) => row[c]?.locator ?? null) } }) }) }
        }
      }
    }
    notices.push('画像・図・埋込オブジェクトの内容は未読です。')
  } else fail('PDF/DOCX/PPTX/XLSXを選んでください')
  if (!lines.length) {
    if (ocrOption.enabled) {
      const summary = unread.map(item => `${item.location}：${item.reason}`).join(' / ').slice(0, 500)
      fail(`読み取れる本文がありません。OCRでも文字を確認できませんでした（${summary || '未読理由なし'}）`)
    }
    fail('読み取れる本文がありません。画像だけの文書はOCR選択（既定OFF）で読み取れます')
  }
  if (ocrOption.enabled) ocrNotice()
  const document = { format: extension, name, fileSha256: originalSha256, size: originalSize, locations, unread, notices }
  if (ocrOption.enabled && ocrEngine) document.ocr = { engine: ocrEngine.name, version: ocrEngine.version, languages: ocrEngine.languageTag, license: ocrEngine.license, assetHash: ocrEngine.hash, pages: ocrPages }
  return { text: lines.join('\n'), document, ...(schedule ? { tables, parameters: { yTolerance, xGap } } : {}) }
}
extract(workerData).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }))
