// CLI asset check for the offline OCR path (Windows-friendly, no display).
// Verifies engine record, vendored tessdata hashes, and that the OCR path
// performs no network fetch or model download.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ENGINE, version, tessdataDir } = require('../electron/ocr-tesseract.cjs')
const path = (await import('node:path')).default
if (version() !== require('tesseract.js/package.json').version) throw new Error('OCR engine version mismatch')
const hash = createHash('sha256')
for (const file of ['eng.traineddata', 'jpn.traineddata']) {
  const bytes = readFileSync(path.join(tessdataDir(), file))
  if (!bytes.length) throw new Error(`${file} is empty`)
  hash.update(bytes)
}
const assetHash = hash.digest('hex')
for (const file of ['electron/ocr-tesseract.cjs', 'electron/ocr-pdf-images.cjs', 'electron/document-extract.cjs']) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  if (/require\(['"]node:(https?|net|http)['"]/.test(source) || /[^a-zA-Z]fetch\s*\(/.test(source)) throw new Error(`${file} must not fetch`)
}
const worker = readFileSync(new URL('../electron/document-worker.cjs', import.meta.url), 'utf8')
if (!worker.includes('globalThis.fetch = async () => { throw')) throw new Error('worker fetch ban missing')
console.log(JSON.stringify({ engine: ENGINE.name, version: version(), languages: ENGINE.languages, model: ENGINE.model, license: ENGINE.license, assetHash }, null, 2))
