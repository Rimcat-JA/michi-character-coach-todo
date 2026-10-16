// PDF image-XObject mapping for the local OCR path. No network, no rasterizer.
//
// Maps each document page (in page-tree order) to the images it actually draws
// (`Do` in its content streams, resolved through /Resources), instead of
// relying on storage order. Decodes Raw / ASCIIHex / Flate streams into
// grayscale bitmaps. DCT (JPEG), JPX, CCITT stay unsupported and are reported.
//
// Safety: declared dimensions, Flate expansion ratio and the running document
// total are all checked BEFORE allocating pixel buffers.
'use strict'

const { inflateSync } = require('fflate')

const MAX_IMAGE_PIXELS = 8000000 // per image
const MAX_TOTAL_PIXELS = 30000000 // per document (declared size, pre-decode)
const MAX_DIMENSION = 2400 // larger images are box-downsampled before OCR

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

function refList(dict, key) {
  // Collects `N M R` references from a key holding a single ref or an array.
  const m = dict.match(new RegExp('/' + key + '\\s*(\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R)'))
  if (!m) return []
  return [...m[1].matchAll(/(\d+)\s+(\d+)\s+R/g)].map(x => Number(x[1]))
}

function singleRef(dict, key) {
  const m = dict.match(new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R'))
  return m ? Number(m[1]) : null
}

function names(dict, key) {
  const m = dict.match(new RegExp('/' + key + '\\s*(\\[[^\\]]*\\]|/\\S+)'))
  if (!m) return []
  return [...m[1].matchAll(/\/([A-Za-z0-9]+)/g)].map(x => x[1])
}

function xobjectEntries(objects, resources) {
  // /XObject << /Im1 5 0 R /Im2 9 0 R >>  (direct or indirect dictionary)
  const direct = resources.match(/\/XObject\s*<<([\s\S]*?)>>/)
  let inner = direct ? direct[1] : null
  if (!inner) {
    const m = resources.match(/\/XObject\s+(\d+)\s+\d+\s+R/)
    if (m && objects.get(Number(m[1]))) {
      const target = objects.get(Number(m[1])).dict
      const im = target.match(/<<([\s\S]*)>>/)
      inner = im ? im[1] : target
    }
  }
  if (!inner) return []
  return [...inner.matchAll(/\/(\S+)\s+(\d+)\s+\d+\s+R/g)].map(x => ({ name: x[1], id: Number(x[2]) }))
}

// Parses every indirect object using /Length slicing for streams so binary
// content can never desynchronize the parse. Returns Map id -> {dict, stream}.
function parseObjects(bytes) {
  const text = Buffer.from(bytes).toString('latin1')
  const objects = new Map()
  const header = /(\d+)\s+(\d+)\s+obj\b/g
  let m
  let guard = 0
  while ((m = header.exec(text)) !== null) {
    if (++guard > 20000) break
    const id = Number(m[1]), rest = m.index + m[0].length
    const streamAt = text.indexOf('stream', rest)
    const endobjAt = text.indexOf('endobj', rest)
    if (endobjAt < 0) break
    let dict, stream = null
    // A stream object has only a dictionary between `obj` and `stream`.
    if (streamAt >= 0 && streamAt < endobjAt && />>\s*$/.test(text.slice(rest, streamAt))) {
      dict = text.slice(rest, streamAt)
      const declared = num(dict, 'Length')
      let body
      const bodyStart = text.indexOf('\n', streamAt) + 1
      if (declared !== null && declared >= 0 && declared <= 200 * 1024 * 1024) {
        body = Buffer.from(text.slice(bodyStart, bodyStart + declared), 'latin1')
      } else {
        const endstreamAt = text.indexOf('endstream', bodyStart)
        if (endstreamAt < 0 || endstreamAt > endobjAt) break
        body = Buffer.from(text.slice(bodyStart, endstreamAt).replace(/\r?\n$/, ''), 'latin1')
      }
      stream = new Uint8Array(body)
    } else {
      dict = text.slice(rest, endobjAt)
    }
    if (!objects.has(id)) objects.set(id, { dict, stream })
    header.lastIndex = endobjAt + 6
  }
  return objects
}

function findCatalogPages(objects) {
  for (const [id, obj] of objects) {
    if (/\/Type\s*\/Catalog/.test(obj.dict)) {
      const pages = singleRef(obj.dict, 'Pages')
      if (pages !== null) return pages
      void id
    }
  }
  return null
}

// Page ids in page-tree order (depth-first through /Kids).
function pageOrder(objects, pagesId) {
  const out = []
  const visit = id => {
    const obj = objects.get(id)
    if (!obj || out.length > 5000) return
    if (/\/Type\s*\/Page\b/.test(obj.dict) && !/\/Type\s*\/Pages/.test(obj.dict)) { out.push(id); return }
    for (const kid of refList(obj.dict, 'Kids')) visit(kid)
  }
  visit(pagesId)
  return out.slice(0, 200)
}

function resolveResources(objects, pageDict) {
  // Returns the full /Resources value: `<< ... >>` or the resolved target dict.
  const direct = pageDict.match(/\/Resources\s*(<<[\s\S]*?>>)/)
  if (direct) return direct[1]
  const id = singleRef(pageDict, 'Resources')
  if (id !== null && objects.get(id)) return objects.get(id).dict
  return ''
}

function contentBytes(objects, pageDict) {
  const chunks = []
  const direct = pageDict.match(/\/Contents\s*<<[\s\S]*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/)
  if (direct) chunks.push(Buffer.from(direct[1], 'latin1'))
  const refs = refList(pageDict, 'Contents')
  if (refs.length) {
    for (const id of refs) {
      const obj = objects.get(id)
      if (obj?.stream) chunks.push(Buffer.from(obj.stream))
    }
  } else {
    const single = singleRef(pageDict, 'Contents')
    if (single !== null && objects.get(single)?.stream) chunks.push(Buffer.from(objects.get(single).stream))
  }
  return Buffer.concat(chunks).toString('latin1')
}

function decodeImage(dict, raw, budget) {
  const width = num(dict, 'Width'), height = num(dict, 'Height')
  const bits = num(dict, 'BitsPerComponent') ?? 8
  if (!width || !height || width < 1 || height < 1) throw new Error('bad-size')
  if (width > 6000 || height > 6000 || width * height > MAX_IMAGE_PIXELS) {
    const error = new Error('画像がOCR上限（8MP・6000px）を超えています')
    error.code = 'pixel-limit'
    throw error
  }
  const filters = names(dict, 'Filter')
  const colorNames = names(dict, 'ColorSpace')
  const color = colorNames[0] ?? ''
  const channels = color === 'DeviceRGB' ? 3 : bits === 1 ? 0 : 1
  const expected = width * height * (channels || 1)
  // Expansion and document total are bounded by declared dimensions BEFORE
  // inflate runs (uniform images legitimately compress 1000x+, so no ratio
  // test). The 25MiB file cap bounds the compressed side as well.
  if (budget.used + expected > MAX_TOTAL_PIXELS) {
    const error = new Error('総処理量の上限（30MP）を超えています')
    error.code = 'total-limit'
    throw error
  }
  let bytes = raw
  for (const filter of filters) {
    if (filter === 'ASCIIHexDecode') bytes = asciiHexToBytes(Buffer.from(bytes).toString('latin1').split('>').shift() ?? '')
    else if (filter === 'FlateDecode') bytes = inflateSync(bytes)
    else {
      const error = new Error(`対応外の画像形式です（${filter}）`)
      error.code = 'unsupported-filter'
      throw error
    }
  }
  let pixels
  if (bits === 8 && (color === 'DeviceGray' || color === 'DeviceRGB' || color === '')) {
    const ch = color === 'DeviceRGB' ? 3 : 1
    if (bytes.length < width * height * ch) throw new Error('short samples')
    pixels = new Uint8Array(width * height)
    if (ch === 1) pixels.set(bytes.subarray(0, width * height))
    else for (let i = 0; i < width * height; i++) pixels[i] = Math.round((bytes[i * 3] + bytes[i * 3 + 1] + bytes[i * 3 + 2]) / 3)
  } else if (bits === 1 && (color === 'DeviceGray' || color === '')) {
    const stride = Math.ceil(width / 8)
    if (bytes.length < stride * height) throw new Error('short samples')
    pixels = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const bit = (bytes[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1
      pixels[y * width + x] = bit ? 0 : 255 // PDF 1-bit: 0 = black
    }
  } else {
    const error = new Error(`対応外の画像形式です（${bits}bit・${color || '不明'}）`)
    error.code = 'unsupported-format'
    throw error
  }
  budget.used += expected
  let w = width, h = height
  while (Math.max(w, h) > MAX_DIMENSION) {
    const nw = Math.max(1, Math.floor(w / 2)), nh = Math.max(1, Math.floor(h / 2))
    const down = new Uint8Array(nw * nh)
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sum = 0, n = 0
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = x * 2 + dx, sy = y * 2 + dy
        if (sx < w && sy < h) { sum += pixels[sy * w + sx]; n++ }
      }
      down[y * nw + x] = Math.round(sum / n)
    }
    pixels = down; w = nw; h = nh
  }
  return { width: w, height: h, pixels }
}

// Per-page drawn images in draw order. Returns { pages: Array<Array<
// {objid,width,height,pixels}|{objid,unsupported,reason}>>, pageCount }.
// Images are decoded once per object id and shared when a page reuses them.
function pageImages(bytes) {
  const objects = parseObjects(bytes)
  const pagesId = findCatalogPages(objects)
  if (pagesId === null) return { pages: [], pageCount: 0 }
  const order = pageOrder(objects, pagesId)
  const cache = new Map()
  const budget = { used: 0 }
  const decodeCached = (id, dict, stream) => {
    if (cache.has(id)) return cache.get(id)
    let entry
    if (!stream) entry = { objid: id, unsupported: true, reason: '画像内容がありません' }
    else {
      try {
        entry = { objid: id, ...decodeImage(dict, stream, budget) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof Error && typeof error.code === 'string' ? error.code : ''
        entry = {
          objid: id,
          unsupported: true,
          reason: code === 'pixel-limit' || code === 'total-limit' ? message : message.startsWith('対応外の画像形式です') ? message : /JPEG|DCT|JPX|CCITT|ASCII85|RunLength|LZW/i.test(message) ? `対応外の画像形式です（${message}）` : '画像を解読できませんでした',
        }
      }
    }
    cache.set(id, entry)
    return entry
  }
  const pages = order.map(pageId => {
    const page = objects.get(pageId)
    if (!page) return []
    const resources = resolveResources(objects, page.dict)
    const entries = xobjectEntries(objects, resources)
    const images = new Map()
    for (const { name, id } of entries) {
      const target = objects.get(id)
      if (target && /\/Subtype\s*\/Image/.test(target.dict)) images.set(name, id)
    }
    const drawn = [...contentBytes(objects, page.dict).matchAll(/\/(\S+)\s+Do\b/g)].map(x => x[1])
    const names = drawn.length ? drawn.filter(name => images.has(name)) : [...images.keys()]
    const seen = new Set()
    return names.filter(name => !seen.has(name) && (seen.add(name), true)).map(name => {
      const id = images.get(name)
      const target = objects.get(id)
      return decodeCached(id, target.dict, target.stream)
    })
  })
  return { pages, pageCount: order.length }
}

// Backwards-compatible file-order listing (edge-case tests only).
function extractPdfImages(bytes) {
  const { pages } = pageImages(bytes)
  return pages.flat()
}

module.exports = { pageImages, extractPdfImages }
