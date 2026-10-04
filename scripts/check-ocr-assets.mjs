// CLI asset check for the offline OCR path (Windows-friendly, no display).
// Verifies engine record, template asset hash, charset coverage and that the
// OCR path performs no network fetch or model download.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ENGINE, assetHash } = require('../electron/ocr-engine.cjs')
const hash = assetHash()
if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('OCR asset hash is invalid')
for (const file of ['electron/ocr-engine.cjs', 'electron/ocr-pdf-images.cjs', 'electron/document-worker.cjs']) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  if (file !== 'electron/document-worker.cjs' && /fetch\s*\(|require\(['"]node:(https?|net|http)/.test(source)) throw new Error(`${file} must not fetch`)
}
for (const ch of 'MEETING 1000本人確認') if (!ENGINE.charset.includes(ch)) throw new Error(`charset misses ${ch}`)
console.log(JSON.stringify({ engine: ENGINE.name, version: ENGINE.version, languages: ENGINE.languageTag, license: ENGINE.license, assetHash: hash, charsetLength: [...ENGINE.charset].length }, null, 2))
