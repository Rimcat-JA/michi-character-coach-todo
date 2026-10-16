const { Worker } = require('node:worker_threads')
const path = require('node:path')

const MAX_FILE = 25 * 1024 * 1024
let running = false
let current = null
let generation = 0
function validOcr(value) {
  if (value === undefined) return { enabled: false, timeoutMs: 20000 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OCR選択が不正です')
  if (!Object.keys(value).every(key => ['enabled', 'language', 'timeoutMs'].includes(key)) || typeof value.enabled !== 'boolean') throw new Error('OCR選択が不正です')
  if (value.language !== undefined && value.language !== 'eng+jpn') throw new Error('OCR言語はeng+jpnだけが対象です')
  // Shortening only, capped at the 60s OCR budget: the timeout can never be relaxed.
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60000)) throw new Error('OCR選択が不正です')
  return { enabled: value.enabled, timeoutMs: value.timeoutMs ?? 60000 }
}
/** A bounded worker cannot read a renderer-chosen path or fetch external resources. */
async function runDocument(request, schedule = false) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('文書は25MiB以下のPDF/DOCX/PPTX/XLSXを選んでください')
  if (schedule && request.ocr !== undefined) throw new Error('予定資料のOCRは未接続です')
  const ocr = validOcr(request.ocr)
  const ocrEnabled = ocr.enabled
  const allowed = schedule ? ['name', 'bytes', 'yTolerance', 'xGap'] : ['name', 'bytes', 'ocr']
  if (!Object.keys(request).every(key => allowed.includes(key)) || Object.keys(request).length < (schedule ? 4 : 2) || Object.keys(request).length > (schedule ? 4 : 3)) throw new Error('文書は25MiB以下のPDF/DOCX/PPTX/XLSXを選んでください')
  if (schedule && (!['name', 'bytes', 'yTolerance', 'xGap'].every(key => Object.hasOwn(request, key)) || !(request.yTolerance >= 0.1 && request.yTolerance <= 5) || !(request.xGap >= 2 && request.xGap <= 100) || !/\.(pdf|xlsx)$/i.test(request.name)) || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 200 || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_FILE) throw new Error('文書は25MiB以下のPDF/DOCX/PPTX/XLSXを選んでください')
  if (!schedule && (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 200 || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_FILE)) throw new Error('文書は25MiB以下のPDF/DOCX/PPTX/XLSXを選んでください')
  if (running) throw new Error('文書の読取が終わってから操作してください')
  running = true
  const myGeneration = ++generation
  // Explicit OCR-only limit (60s); general intake stays at 20s and is never relaxed.
  const timeoutMs = ocrEnabled ? ocr.timeoutMs : 20000
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'document-worker.cjs'), { workerData: { ...request, schedule }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } })
      const control = { worker, timer: null, reject }
      current = control
      control.timer = setTimeout(() => { void worker.terminate(); if (myGeneration === generation) reject(new Error(ocrEnabled ? `OCRの読取が時間上限（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}秒` : `${timeoutMs}ms`}）を超えました` : '文書の読取が時間上限を超えました')) }, timeoutMs)
      const settled = fn => value => { if (myGeneration !== generation) return; clearTimeout(control.timer); void worker.terminate(); fn(value) }
      worker.once('message', settled(value => { if (value.error) reject(new Error(value.error)); else resolve(value.result) }))
      worker.once('error', settled(() => reject(new Error('文書を読み取れませんでした。破損・サイズ・形式を確認してください'))))
      // A silent exit must also settle the promise; a previous message already resolved it.
      // Late responses from a cancelled worker never overwrite a newer request (generation guard).
      worker.once('exit', settled(() => reject(new Error('文書の読取を安全に中止しました'))))
    })
  } finally { if (myGeneration === generation) { running = false; current = null } }
}
/** Cancels the in-flight extraction; a late worker response is never adopted. */
async function cancelDocument() {
  generation++
  const control = current
  current = null
  running = false
  if (control) {
    clearTimeout(control.timer)
    await control.worker.terminate()
    control.reject(new Error('文書の読取を安全に中止しました'))
  }
}
const extractDocument = request => runDocument(request)
const extractScheduleDocument = request => runDocument(request, true)
module.exports = { extractDocument, extractScheduleDocument, cancelDocument }
