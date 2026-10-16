// Offline general-font OCR via vendored Tesseract (tesseract.js + tessdata_fast).
// No network: language data comes from electron/ocr-tessdata only
// (langPath + cacheMethod none), images are passed as in-memory PNG buffers.
// The worker process already turns global fetch into a thrower, so any
// accidental remote fetch fails closed instead of leaving the device.
'use strict'

const path = require('node:path')
const { zlibSync } = require('fflate')

const ENGINE = {
  name: 'tesseract.js',
  languages: 'eng+jpn',
  model: 'jpn (tessdata_fast, reads English and Japanese)',
  license: 'Apache-2.0 (tesseract.js, tesseract.js-core, tessdata_fast eng+jpn)',
}
const CONFIDENCE_OK = 70 // mean word confidence below this marks the page unverified

function version() {
  return require('tesseract.js/package.json').version
}

function tessdataDir() {
  return path.join(__dirname, 'ocr-tessdata')
}

// Minimal 8-bit grayscale PNG writer (no new dependency).
function crc32Table() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
}
const CRC = crc32Table()
const crc32 = bytes => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])), 8 + data.length)
  return out
}
function grayPng(pixels, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0 // 8-bit grayscale
  const raw = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1)
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function createEngine() {
  const { createWorker } = require('tesseract.js')
  const worker = await createWorker('jpn', 1, {
    langPath: tessdataDir(),
    cacheMethod: 'none',
    gzip: false,
    logger: () => {},
  })
  let closed = false
  return {
    async recognizePage(pixels, width, height) {
      if (closed) throw new Error('OCR engine is closed')
      const { data } = await worker.recognize(grayPng(pixels, width, height), {}, { text: true, blocks: true })
      const lines = []
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
          for (const line of paragraph.lines ?? []) {
            const text = String(line.text ?? '').replace(/\s+/g, ' ').trim()
            if (text) lines.push({ text, confidence: Math.round(line.confidence), bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1] })
          }
        }
      }
      const text = lines.map(line => line.text).join('\n')
      const mean = lines.length
        ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
        : data.confidence
      // 0..1 scale for storage; the validator rejects anything outside.
      const confidence = Math.round((mean / 100) * 1000) / 1000
      const rounded = lines.map(line => ({ ...line, confidence: Math.round((line.confidence / 100) * 1000) / 1000 }))
      return { text, lines: rounded, confidence }
    },
    async close() {
      if (!closed) { closed = true; await worker.terminate() }
    },
  }
}

module.exports = { ENGINE, CONFIDENCE_OK, version, tessdataDir, grayPng, createEngine }
