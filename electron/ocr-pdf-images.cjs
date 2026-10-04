// Minimal PDF image-XObject extractor for the local OCR path. No network, no
// rasterizer: parses image XObject dictionaries and decodes Raw / ASCIIHex /
// Flate streams into grayscale bitmaps. DCT (JPEG), JPX, CCITT stay unsupported
// and are reported instead of guessed.
'use strict'

const { inflateSync } = require('fflate')

function asciiHexToBytes(text) {
  const clean = String(text).replace(/[\s>]/g, '')
  if (/[^0-9a-fA-F]/.test(clean)) throw new Error('bad hex')
  const padded = clean.length % 2 ? clean + '0' : clean
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  return out
}

function num(dict, key) {
  const m = dict.match(new RegExp('/' + key + '\\s+(\\d+)'))
  return m ? Number(m[1]) : null
}

function names(dict, key) {
  // Returns filter/color names in order, e.g. [/ASCIIHexDecode /FlateDecode] or /FlateDecode.
  const m = dict.match(new RegExp('/' + key + '\\s*(\\[[^\\]]*\\]|/\\S+)'))
  if (!m) return []
  return [...m[1].matchAll(/\/([A-Za-z0-9]+)/g)].map(x => x[1])
}

function decodeStream(raw, filters) {
  let bytes = raw
  for (const filter of filters) {
    if (filter === 'ASCIIHexDecode') bytes = asciiHexToBytes(Buffer.from(bytes).toString('latin1').split('>').shift() ?? '')
    else if (filter === 'FlateDecode') bytes = inflateSync(bytes)
    else if (filter === 'ASCII85Decode') throw new Error('unsupported:ASCII85Decode')
    else if (filter === 'DCTDecode') throw new Error('unsupported:DCTDecode')
    else if (filter === 'JPXDecode') throw new Error('unsupported:JPXDecode')
    else if (filter === 'CCITTFaxDecode') throw new Error('unsupported:CCITTFaxDecode')
    else if (filter === 'RunLengthDecode') throw new Error('unsupported:RunLengthDecode')
    else if (filter === 'LZWDecode') throw new Error('unsupported:LZWDecode')
    else throw new Error('unsupported:' + filter)
  }
  return bytes
}

// Returns image entries in file order: {width,height,pixels} or {unsupported,reason}.
function extractPdfImages(bytes) {
  const text = Buffer.from(bytes).toString('latin1')
  const results = []
  const re = /(\d+)\s+(\d+)\s+obj([\s\S]*?)stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m
  let guard = 0
  while ((m = re.exec(text)) !== null) {
    if (++guard > 5000) break
    const dict = m[3]
    if (!/\/Subtype\s*\/Image/.test(dict)) continue
    const width = num(dict, 'Width'), height = num(dict, 'Height')
    const bits = num(dict, 'BitsPerComponent') ?? 8
    if (!width || !height || width < 1 || height < 1 || width > 6000 || height > 6000) {
      results.push({ unsupported: true, reason: '画像サイズが範囲外です' })
      continue
    }
    const filters = names(dict, 'Filter')
    const colorNames = names(dict, 'ColorSpace')
    const color = colorNames[0] ?? ''
    let raw
    try {
      // m[4] is the latin1 stream body; re-encode to bytes.
      raw = Uint8Array.from(Buffer.from(m[4], 'latin1'))
      const decoded = decodeStream(raw, filters)
      let pixels
      if (bits === 8 && (color === 'DeviceGray' || color === 'DeviceRGB' || color === '')) {
        const channels = color === 'DeviceRGB' ? 3 : 1
        if (decoded.length < width * height * channels) throw new Error('short samples')
        pixels = new Uint8Array(width * height)
        if (channels === 1) pixels.set(decoded.subarray(0, width * height))
        else for (let i = 0; i < width * height; i++) pixels[i] = Math.round((decoded[i * 3] + decoded[i * 3 + 1] + decoded[i * 3 + 2]) / 3)
      } else if (bits === 1 && (color === 'DeviceGray' || color === '')) {
        const stride = Math.ceil(width / 8)
        if (decoded.length < stride * height) throw new Error('short samples')
        pixels = new Uint8Array(width * height)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const bit = (decoded[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1
          pixels[y * width + x] = bit ? 0 : 255 // PDF 1-bit: 0 = black
        }
      } else {
        results.push({ unsupported: true, reason: `対応外の画像形式です（${bits}bit・${color || '不明'}` + '）' })
        continue
      }
      results.push({ width, height, pixels })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ unsupported: true, reason: message.startsWith('unsupported:') ? `対応外の画像形式です（${message.slice(12)}）` : '画像を解読できませんでした' })
    }
  }
  return results
}

module.exports = { extractPdfImages }
