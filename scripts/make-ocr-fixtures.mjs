// Builds committed scan-PDF fixtures from OS-font BMPs (see make-ocr-fixtures.ps1).
// Usage: node scripts/make-ocr-fixtures.mjs   (reads ocr-fixture-bmp/, writes electron/fixtures/ocr/)
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bmpDir = join(root, 'ocr-fixture-bmp')
const outDir = join(root, 'electron', 'fixtures', 'ocr')
mkdirSync(outDir, { recursive: true })

// 24/32-bit BI_RGB BMP -> {width,height,gray}
function readBmp(file) {
  const bytes = readFileSync(file)
  const bpp = bytes.readUInt16LE(28)
  if (bytes.readUInt16LE(0) !== 0x4d42 || (bpp !== 24 && bpp !== 32) || bytes.readUInt32LE(30) !== 0) throw new Error(`unsupported BMP ${file}`)
  const width = bytes.readInt32LE(18)
  let height = bytes.readInt32LE(22)
  const offset = bytes.readUInt32LE(10)
  const topDown = height < 0
  height = Math.abs(height)
  const channels = bpp / 8
  const stride = Math.floor((width * channels + 3) / 4) * 4
  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const i = offset + row * stride + x * channels
      gray[y * width + x] = Math.round((bytes[i + 2] + bytes[i + 1] + bytes[i]) / 3)
    }
  }
  return { width, height, gray }
}

const white = (width, height) => ({ width, height, gray: new Uint8Array(width * height).fill(255) })

function rotate(image, degrees, seed = 7) {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad)
  const nw = Math.ceil(Math.abs(image.width * cos) + Math.abs(image.height * sin)) + 8
  const nh = Math.ceil(Math.abs(image.width * sin) + Math.abs(image.height * cos)) + 8
  const gray = new Uint8Array(nw * nh).fill(255)
  const cx = image.width / 2, cy = image.height / 2
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.round((x - nw / 2) * cos + (y - nh / 2) * sin + cx)
    const sy = Math.round(-(x - nw / 2) * sin + (y - nh / 2) * cos + cy)
    if (sx >= 0 && sy >= 0 && sx < image.width && sy < image.height) gray[y * nw + x] = image.gray[sy * image.width + sx]
  }
  void seed
  return { width: nw, height: nh, gray }
}

// objects: array of {dict, stream?: Uint8Array}. Returns full PDF bytes.
function assemble(objects, rootId = 1) {
  const enc = s => Buffer.from(s, 'latin1')
  const parts = [enc('%PDF-1.4\n')]
  const offsets = [0]
  objects.forEach((obj, i) => {
    offsets.push(parts.reduce((n, p) => n + p.length, 0))
    parts.push(enc(`${i + 1} 0 obj\n${obj.dict}\n`))
    if (obj.stream) parts.push(enc('stream\n'), Buffer.from(obj.stream), enc('\nendstream\n'))
    parts.push(enc('endobj\n'))
  })
  const xrefAt = parts.reduce((n, p) => n + p.length, 0)
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  parts.push(enc(xref + `trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`))
  return new Uint8Array(Buffer.concat(parts))
}

const flateImage = image => {
  const data = deflateSync(image.gray)
  return { dict: `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, stream: data }
}
const drawOps = (id, image, dx = 0, dy = 0, dw = null, dh = null) => {
  const w = dw ?? image.width, h = dh ?? image.height
  return `q ${w} 0 0 ${h} ${dx} ${dy} cm /${id} Do Q`
}

// pages: [{images: [{image, name?, dx?, dy?}], text?: string, resourcesIndirect?: bool}]
// options: {shuffle?: bool} writes image objects before page objects;
// {shareFirstWithSecond?: bool} makes page 2 reference page 1's first image object.
function scanPdf(pages, options = {}) {
  const objects = [null] // 1-based; objects[0] unused
  const add = obj => { objects.push(obj); return objects.length - 1 }
  const catalogId = add({ dict: '<< /Type /Catalog /Pages 2 0 R >>' })
  const pagesId = add({ dict: '__PAGES__' })
  void catalogId
  const imageJobs = []
  pages.forEach((page, pi) => page.images.forEach((entry, ii) => imageJobs.push({ ...entry, page: pi, slot: ii })))
  if (options.shuffle) for (const job of imageJobs) job.objId = add(flateImage(job.image))
  const pageIds = []
  pages.forEach((page, pi) => {
    if (!options.shuffle) {
      for (const job of imageJobs.filter(j => j.page === pi)) {
        if (options.shareFirstWithSecond && pi === 1 && job.slot === 0) {
          job.objId = imageJobs.find(j => j.page === 0 && j.slot === 0).objId
        } else job.objId = add(flateImage(job.image))
      }
    }
    const xrefs = page.images.map((_, ii) => {
      const job = imageJobs.find(j => j.page === pi && j.slot === ii)
      return `/X${pi}_${ii} ${job.objId} 0 R`
    }).join(' ')
    const ops = []
    if (page.text) ops.push(`BT /F1 24 Tf 40 1400 Td (${page.text}) Tj ET`)
    page.images.forEach((entry, ii) => ops.push(drawOps(`X${pi}_${ii}`, entry.image, entry.dx ?? 0, entry.dy ?? 0)))
    const content = new Uint8Array(Buffer.from(ops.join('\n'), 'latin1'))
    const contentId = add({ dict: `<< /Length ${content.length} >>`, stream: content })
    let fontId = null
    if (page.text) fontId = add({ dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' })
    const resInner = `/XObject << ${xrefs} >>${fontId ? ` /Font << /F1 ${fontId} 0 R >>` : ''}`
    let resPart
    if (page.resourcesIndirect) {
      const resId = add({ dict: `<< ${resInner} >>` })
      resPart = `${resId} 0 R`
    } else resPart = `<< ${resInner} >>`
    const maxH = Math.max(...page.images.map(e => e.image.height), 1500)
    pageIds.push(add({ dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1700 ${maxH}] /Resources ${resPart} /Contents ${contentId} 0 R >>` }))
  })
  objects[pagesId] = { dict: `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` }
  return { bytes: assemble(objects.slice(1)), pageIds }
}

const en = readBmp(join(bmpDir, 'ocr-en.bmp'))
const ja = readBmp(join(bmpDir, 'ocr-ja.bmp'))
const mixed = readBmp(join(bmpDir, 'ocr-mixed.bmp'))
const logo = readBmp(join(bmpDir, 'ocr-logo.bmp'))

// NOTE: content-id bookkeeping above is fragile; verify by re-parsing below.
function write(name, pages, options) {
  const { bytes } = scanPdf(pages, options)
  writeFileSync(join(outDir, name), Buffer.from(bytes))
  console.log(name, bytes.length, 'bytes')
}

write('ocr-en.pdf', [{ images: [{ image: en }] }])
write('ocr-ja.pdf', [{ images: [{ image: ja }] }])
write('ocr-mixed.pdf', [{ images: [{ image: mixed }] }])
write('ocr-blank.pdf', [{ images: [{ image: white(800, 600) }] }])
write('ocr-rotated.pdf', [{ images: [{ image: rotate(mixed, 12) }] }])
write('ocr-multi.pdf', [{ images: [{ image: mixed }, { image: logo, dx: 0, dy: 0 }] }])
write('ocr-reuse.pdf', [{ images: [{ image: en }] }, { images: [{ image: en }] }], { shareFirstWithSecond: true })
write('ocr-shuffled.pdf', [{ images: [{ image: mixed }] }], { shuffle: true })
write('ocr-logo-text.pdf', [{ images: [{ image: logo }], text: 'Hello' }])
write('ocr-cancel.pdf', Array.from({ length: 10 }, () => ({ images: [{ image: mixed }] })))
console.log('BMP inputs:', readdirSync(bmpDir).join(', '))
