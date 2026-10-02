/** Text geometry is data only. Reject ambiguous tables rather than infer missing cells. */
function pdfGrid(items, { yTolerance = 2, xGap = 12 } = {}) {
  if (!(yTolerance >= 0.1 && yTolerance <= 5) || !(xGap >= 2 && xGap <= 100)) throw new Error('PDFの行・列の許容幅が不正です')
  const rows = [], anchors = []
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (!item.text.trim()) continue
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.rotated) throw new Error('回転・不正な文字座標のPDFは確認待ちです')
    let row = rows.find(row => Math.abs(row.y - item.y) <= yTolerance)
    if (!row) { row = { y: item.y, items: [] }; rows.push(row) }
    row.items.push(item)
    if (!anchors.some(x => Math.abs(x - item.x) <= xGap)) anchors.push(item.x)
  }
  if (!rows.length) throw new Error('スキャンPDF/OCRは未対応です')
  anchors.sort((a, b) => a - b)
  if (anchors.length > 100 || rows.length > 1000) throw new Error('PDFの表が大きすぎます')
  const result = rows.map((row, r) => {
    const cells = anchors.map(() => ''), locators = anchors.map(() => null)
    for (const item of row.items) {
      const c = anchors.findIndex(x => Math.abs(x - item.x) <= xGap)
      if (locators[c]) throw new Error('同じセルの文字が複数に分かれています。曖昧なPDFはCSVで確認してください')
      cells[c] = item.text
      locators[c] = { row: r + 1, column: c + 1, itemIndices: [item.index], bbox: [item.x, item.y, item.x + item.width, item.y + item.height] }
    }
    return { cells, locators }
  })
  for (let r = 1; r < rows.length; r++) if (Math.abs(rows[r - 1].y - rows[r].y) < Math.max(...rows[r].items.map(item => item.height)) * 1.1) throw new Error('複数行に分かれたセルの可能性があります。曖昧な表は確認待ちです')
  return result
}
export { pdfGrid }
