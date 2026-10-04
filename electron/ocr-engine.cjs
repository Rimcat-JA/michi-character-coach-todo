// Offline constrained block-glyph OCR engine (v1).
// End-device only: pure JS, no network, no model download, no external send.
// Reads printed block glyphs rendered from its own template table (ASCII 5x7
// block capitals/digits + a small Japanese block subset). Anything else
// (handwriting, proportional fonts, photos, rotated pages) is reported as
// unread/low-confidence instead of guessed. General-purpose OCR stays future work.
'use strict'

const { createHash } = require('node:crypto')

const ENGINE = {
  name: 'michi-local-block-ocr',
  version: '1.0.0',
  languages: ['eng', 'jpn'],
  languageTag: 'eng+jpn',
  license: 'repo-local (templates: ASCII 5x7 block glyphs drawn for this repo, public-domain dedication; Japanese 16x16 block glyphs drawn for this repo, same terms)',
  asset: 'electron/ocr-engine.cjs template table',
  charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :.-/本人確認',
  cell: 24,
}

// 5x7 block capitals/digits/punct, one byte per row (low 5 bits). Drawn for this repo.
const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x19, 0x15, 0x13, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0, 0x04, 0x04, 0, 0x04, 0x04, 0],
  '.': [0, 0, 0, 0, 0, 0x04, 0x04],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
}

// Japanese 16x16 block glyphs, 16 rows of 16-bit hex. Drawn for this repo (bold
// block style: every column carries ink so a glyph never splits under vertical
// projection; variants differ by bar placement).
const FONT_JA_16 = {
  '本': [0x0180, 0x0180, 0x0180, 0xffff, 0xffff, 0x0180, 0x0180, 0x0180, 0x0180, 0x07e0, 0x0db0, 0x1998, 0x198c, 0x3186, 0x3186, 0x6182],
  '人': [0x03c0, 0x03c0, 0x06c0, 0x0660, 0x0c60, 0x0c30, 0x1830, 0x1818, 0x3018, 0x300c, 0x600c, 0x6006, 0x6006, 0x6006, 0x6006, 0x6006],
  '確': [0x7ffe, 0x7ffe, 0x6036, 0x6036, 0x6036, 0x6036, 0x7ffe, 0x7ffe, 0x7ffe, 0x6c36, 0x6c36, 0x6c36, 0x6c36, 0x6c36, 0x7ffe, 0x7ffe],
  '認': [0x7ffc, 0x7ffc, 0x60c6, 0x60c6, 0x60c6, 0x7cc6, 0x7cc6, 0x60c6, 0x63fe, 0x63fe, 0x60c6, 0x60c6, 0x60c6, 0x60c6, 0x7ffc, 0x7ffc],
}

const CELL = ENGINE.cell // 24
function blankCell() { return new Uint8Array(CELL * CELL) }
function drawAscii(cell, rows) {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
    if ((rows[r] >> (4 - c)) & 1) {
      const x0 = 4 + c * 3, y0 = 1 + r * 3
      for (let y = y0; y < y0 + 3 && y < CELL; y++) for (let x = x0; x < x0 + 3 && x < CELL; x++) cell[y * CELL + x] = 1
    }
  }
}
function drawJa(cell, rows) {
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) {
    if ((rows[r] >> (15 - c)) & 1) {
      const x0 = 4 + c, y0 = 4 + r
      if (x0 < CELL && y0 < CELL) cell[y0 * CELL + x0] = 1
    }
  }
}
const RAW = new Map()
const TEMPLATES = new Map()
for (const [ch, rows] of Object.entries(FONT_5X7)) {
  if (ch === ' ') continue
  const cell = blankCell(); drawAscii(cell, rows); RAW.set(ch, cell)
}
for (const [ch, rows] of Object.entries(FONT_JA_16)) {
  const cell = blankCell(); drawJa(cell, rows); RAW.set(ch, cell)
}
for (const [ch, cell] of RAW) TEMPLATES.set(ch, canonical({ data: cell, w: CELL, h: CELL }))
TEMPLATES.set(' ', blankCell())

function assetHash() {
  const hash = createHash('sha256')
  for (const ch of [...RAW.keys()].sort()) hash.update(ch + ':' + Buffer.from(RAW.get(ch)).toString('hex'))
  return hash.digest('hex')
}

// Fixture/test-only renderer: same templates, fixed grid. Not used by the OCR path.
function renderTextBitmap(text, { scale = 2, gap = 8, lineGap = 16 } = {}) {
  const lines = String(text).split('\n')
  const cols = Math.max(1, ...lines.map(l => [...l].length))
  const cw = CELL * scale + gap, chh = CELL * scale + lineGap
  const width = cols * cw + gap, height = lines.length * chh + lineGap
  const pixels = new Uint8Array(width * height).fill(255)
  lines.forEach((line, li) => {
    let ci = 0
    for (const ch of line) {
      if (ch !== ' ' && !RAW.has(ch)) throw new Error(`OCR fixture文字が対応外です: ${ch}`)
      const tpl = RAW.get(ch) ?? blankCell()
      const x0 = gap + ci * cw, y0 = lineGap + li * chh
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
        if (!tpl[y * CELL + x]) continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const px = x0 + x * scale + sx, py = y0 + y * scale + sy
          if (px < width && py < height) pixels[py * width + px] = 0
        }
      }
      ci++
    }
  })
  return { pixels, width, height }
}

function otsu(pixels) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < pixels.length; i++) hist[pixels[i]]++
  const total = pixels.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = 0, threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; threshold = t }
  }
  return threshold
}

function resampleToCell(sample) {
  // Bilinear resample of binary ink, thresholded at 0.5: smooth approximation
  // of the same glyph at any integer scale, so a template and its scaled copy
  // converge instead of aliasing apart like nearest-neighbor does.
  const out = new Uint8Array(CELL * CELL)
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const sx = (x + 0.5) * sample.w / CELL - 0.5, sy = (y + 0.5) * sample.h / CELL - 0.5
    const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sample.w - 1, x0 + 1)
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sample.h - 1, y0 + 1)
    const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0))
    const v = sample.data[y0 * sample.w + x0] * (1 - fx) * (1 - fy) + sample.data[y0 * sample.w + x1] * fx * (1 - fy) + sample.data[y1 * sample.w + x0] * (1 - fx) * fy + sample.data[y1 * sample.w + x1] * fx * fy
    out[y * CELL + x] = v >= 0.5 ? 1 : 0
  }
  return out
}

// Canonical form: tight ink bbox padded to a square at native resolution, then
// resampled to CELL. Templates and runtime samples go through the same form so
// tight projection crops match the padded template cells without aspect distortion.
function squarePad(sample) {
  const { data, w, h } = sample
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  if (x1 < 0) return sample
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh)
  const px = x0 - Math.floor((side - bw) / 2), py = y0 - Math.floor((side - bh) / 2)
  const squared = { data: new Uint8Array(side * side), w: side, h: side }
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sx = px + x, sy = py + y
    squared.data[y * side + x] = sx >= 0 && sy >= 0 && sx < w && sy < h && data[sy * w + sx] ? 1 : 0
  }
  return squared
}
function canonical(sample) { return resampleToCell(squarePad(sample)) }

function matchCell(cell) {
  // Dice coefficient over ink pixels: sparse templates must overlap real ink,
  // so blank background agreement never decides a match.
  let best = null, second = -1
  for (const [ch, tpl] of TEMPLATES) {
    if (ch === ' ') continue
    let inter = 0, a = 0, b = 0
    for (let i = 0; i < cell.length; i++) { if (cell[i]) a++; if (tpl[i]) b++; if (cell[i] && tpl[i]) inter++ }
    const ratio = a + b ? (2 * inter) / (a + b) : 0
    if (best === null || ratio > best.ratio) { second = best === null ? -1 : best.ratio; best = { ch, ratio } } else if (ratio > second) second = ratio
  }
  return { ch: best.ch, ratio: best.ratio, margin: best.ratio - second }
}

function ocrBitmap({ pixels, width, height }) {
  if (!(pixels instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || pixels.length !== width * height) {
    return { status: 'invalid-input', lines: [], confidence: null }
  }
  if (width * height > 8000000) return { status: 'pixel-limit', lines: [], confidence: null }
  const threshold = otsu(pixels)
  const ink = new Uint8Array(pixels.length)
  let inkCount = 0
  for (let i = 0; i < pixels.length; i++) if (pixels[i] <= threshold) { ink[i] = 1; inkCount++ }
  const density = inkCount / pixels.length
  if (density < 0.0005) return { status: 'blank', lines: [], confidence: null }
  if (density > 0.6) return { status: 'unreadable', lines: [], confidence: null }
  // Line bands via horizontal projection. Thresholds float above the image's own
  // noise floor (median row/column ink) so salt noise neither erases thin
  // strokes nor fuses every row into one band.
  const rowCounts = new Array(height).fill(0)
  for (let y = 0; y < height; y++) { let n = 0; for (let x = 0; x < width; x++) if (ink[y * width + x]) n++; rowCounts[y] = n }
  const sortedRows = [...rowCounts].sort((a, b) => a - b)
  // Noise floor = a low quantile (most pages are mostly blank); the median
  // would mistake dense text for noise and erase thin strokes.
  const rowFloor = Math.max(width * 0.004, sortedRows[Math.floor(height * 0.1)] * 1.5 + 2)
  const rowHas = rowCounts.map(n => n > rowFloor)
  const bands = []
  for (let y = 0; y < height;) {
    if (!rowHas[y]) { y++; continue }
    const start = y
    while (y < height && rowHas[y]) y++
    if (y - start >= 4) bands.push([start, y])
  }
  if (!bands.length) return { status: 'rotation-suspected', lines: [], confidence: null }
  if (bands.length > 200) return { status: 'too-many-lines', lines: [], confidence: null }
  const lines = []
  for (const [y0, y1] of bands) {
    const bandH = y1 - y0
    if (bandH < 6 || bandH > height * 0.6) return { status: 'rotation-suspected', lines: [], confidence: null }
    // Character cells via vertical projection inside the band.
    const colCounts = new Array(width).fill(0)
    for (let x = 0; x < width; x++) { let n = 0; for (let y = y0; y < y1; y++) if (ink[y * width + x]) n++; colCounts[x] = n }
    const sortedCols = [...colCounts].sort((a, b) => a - b)
    const colFloor = Math.max(2, sortedCols[Math.floor(width * 0.1)] * 1.5 + 1)
    const colHas = colCounts.map(n => n > colFloor)
    const cells = []
    for (let x = 0; x < width;) {
      if (!colHas[x]) { x++; continue }
      const start = x
      while (x < width && colHas[x]) x++
      if (x - start >= 2) cells.push([start, x])
    }
    if (!cells.length || cells.length > 200) return { status: 'unreadable', lines: [], confidence: null }
    const crop = (x0, x1) => {
      const w = x1 - x0, sample = { data: new Uint8Array(w * bandH), w, h: bandH }
      for (let y = 0; y < bandH; y++) for (let x = 0; x < w; x++) sample.data[y * w + x] = ink[(y0 + y) * width + x0 + x] ? 1 : 0
      return sample
    }
    // CJK glyphs split into radicals by blank columns. Look ahead up to three
    // adjacent cells and take the widest span that matches a template
    // decisively; true inter-character gaps never match when merged.
    const scored = (x0, x1) => matchCell(canonical(crop(x0, x1)))
    const groups = []
    for (let ci = 0; ci < cells.length; ci++) {
      let best = { span: 1, match: scored(cells[ci][0], cells[ci][1]) }
      for (let span = 2; span <= 3 && ci + span - 1 < cells.length; span++) {
        const [sx0] = cells[ci], [, ex1] = cells[ci + span - 1]
        if (ex1 - sx0 > bandH * 1.8) break
        if (cells.slice(ci, ci + span - 1).some(([, e1], k) => cells[ci + k + 1][0] - e1 > bandH * 0.35)) break
        const match = scored(sx0, ex1)
        if (match.ratio >= 0.8 && match.margin >= 0.005 && match.ratio > best.match.ratio + 0.05) best = { span, match }
      }
      groups.push([cells[ci][0], cells[ci + best.span - 1][1]])
      ci += best.span - 1
    }
    let text = '', sum = 0, minMargin = 1, counted = 0
    const boxes = []
    const widths = groups.map(([x0, x1]) => x1 - x0).filter(w => w >= bandH * 0.5).sort((a, b) => a - b)
    const medianW = widths.length ? widths[widths.length >> 1] : bandH
    const gaps = groups.slice(1).map(([x0], gi) => x0 - groups[gi][1]).sort((a, b) => a - b)
    const medianGap = gaps.length ? gaps[gaps.length >> 1] : 0
    groups.forEach(([x0, x1], gi) => {
      const w = x1 - x0
      if (gi > 0) {
        const gap = x0 - groups[gi - 1][1]
        const spaced = gaps.length >= 2
          ? gap > medianGap * 2.5 && gap > bandH * 0.6
          : gap > Math.max(bandH, medianW * 1.5)
        if (spaced) text += ' '
      }
      if (w < 3 || w > Math.max(width * 0.5, bandH * 4) || bandH < 6) { text += '□'; return }
      const match = matchCell(canonical(crop(x0, x1)))
      sum += match.ratio; counted++
      minMargin = Math.min(minMargin, match.margin)
      if (match.ratio >= 0.8 && match.margin >= 0.005) text += match.ch
      else text += '□'
      boxes.push([x0, y0, x1, y1])
    })
    if (!text.replace(/[□\s]/g, '').trim()) continue
    const confidence = counted ? Math.round((sum / counted) * 1000) / 1000 : 0
    const verified = !text.includes('□') && confidence >= 0.88 && minMargin >= 0.005
    const xs = boxes.map(b => b[0]), ys = boxes.map(b => b[1]), xe = boxes.map(b => b[2]), ye = boxes.map(b => b[3])
    lines.push({ text, confidence, verified, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xe), Math.max(...ye)] })
  }
  if (!lines.length) return { status: 'unreadable', lines: [], confidence: null }
  const confidence = Math.round((lines.reduce((s, l) => s + l.confidence, 0) / lines.length) * 1000) / 1000
  return { status: lines.every(l => l.verified) ? 'ok' : 'low-confidence', lines, confidence }
}

module.exports = { ENGINE, assetHash, renderTextBitmap, ocrBitmap }
