const { Worker } = require('node:worker_threads')
const path = require('node:path')

const MAX_FILE = 25 * 1024 * 1024
let running = false
/** A bounded worker cannot read a renderer-chosen path or fetch external resources. */
async function extractDocument(request) {
  if (!request || typeof request !== 'object' || Object.keys(request).length !== 2 || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 200 || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_FILE) throw new Error('文書は25MiB以下のPDF/DOCX/PPTX/XLSXを選んでください')
  if (running) throw new Error('文書の読取が終わってから操作してください')
  running = true
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'document-worker.cjs'), { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } })
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('文書の読取が時間上限を超えました')) }, 20000)
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); if (value.error) reject(new Error(value.error)); else resolve(value.result) })
      worker.once('error', () => { clearTimeout(timer); reject(new Error('文書を読み取れませんでした。破損・サイズ・形式を確認してください')) })
      // A silent exit must also settle the promise; a previous message already resolved it.
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('文書の読取を安全に中止しました')) })
    })
  } finally { running = false }
}
module.exports = { extractDocument }
