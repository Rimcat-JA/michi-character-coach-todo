const fs = require('node:fs/promises')
const { watch } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { extractDocument } = require('./document-extract.cjs')
const excluded = /^(\.git|node_modules|\.env.*|\.(ssh|aws|codex|claude)|.*\.(pem|key)|AppData|Windows|Program Files.*|ProgramData|System Volume Information|\$Recycle\.Bin|Default|Profile \d+|User Data|Profiles)$/i
const supported = /\.(pdf|docx|pptx|xlsx|txt|md|csv)$/i
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }
function createFolderWatch({ active = async () => true, onError = () => {} } = {}) {
  const roots = new Map()
  async function bytesFor(root, relative) {
    if (relative.split(/[\\/]/).some(name => excluded.test(name)) || !supported.test(relative)) throw new Error('監視対象外のファイルです')
    const file = path.resolve(root, relative)
    if (!inside(root, file)) throw new Error('選んだフォルダーの外は読みません')
    // Refuse links in every path component, including Windows junctions.
    let component = root
    for (const part of relative.split(path.sep)) { component = path.join(component, part); if ((await fs.lstat(component)).isSymbolicLink()) throw new Error('リンク・junctionは読みません') }
    if (!inside(root, await fs.realpath(file))) throw new Error('選んだフォルダーの外は読みません')
    const before = await fs.stat(file)
    if (!before.isFile() || before.nlink > 1 || before.size > 25 * 1024 * 1024 || before.size < 1) throw new Error('ファイルのサイズ・ハードリンクを確認してください')
    await new Promise(resolve => setTimeout(resolve, 100))
    const stable = await fs.stat(file)
    if (stable.size !== before.size || stable.mtimeMs !== before.mtimeMs) throw new Error('ファイルの更新が終わっていません')
    const handle = await fs.open(file, 'r')
    try {
      const actual = await handle.stat()
      if (actual.ino !== before.ino || actual.size !== before.size || actual.mtimeMs !== before.mtimeMs) throw new Error('ファイルが変わりました')
      // Fixed-size buffer: growth cannot create an unbounded read allocation.
      const bytes = Buffer.alloc(before.size); let offset = 0
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead }
      const after = await handle.stat()
      if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !inside(root, await fs.realpath(file))) throw new Error('ファイルが変わりました')
      return { bytes: new Uint8Array(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }
    } finally { await handle.close() }
  }
  async function scan(root) {
    if (root.scanning || !roots.has(root.id) || !await active()) return
    root.scanning = true
    try {
      const found = new Set(); let count = 0
      async function walk(directory, depth = 0) {
        if (depth > 20 || !roots.has(root.id) || !await active()) return
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (++count > 1000) throw new Error('監視は1000エントリまでです。狭いフォルダーを選んでください')
          if (excluded.test(entry.name) || entry.isSymbolicLink()) continue
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) { await walk(file, depth + 1); continue }
          if (!entry.isFile() || !supported.test(entry.name)) continue
          const relative = path.relative(root.path, file); found.add(relative)
          try {
            const read = await bytesFor(root.path, relative), id = createHash('sha256').update(relative).digest('hex')
            if (!roots.has(root.id) || !await active()) return
            if (root.accepted.get(relative) !== read.sha256) root.pending.set(id, { id, name: entry.name, relative, sha256: read.sha256, state: 'changed' })
          } catch (error) { root.error = error.message }
        }
      }
      await walk(root.path)
      for (const [relative] of root.accepted) if (!found.has(relative)) {
        const id = createHash('sha256').update(relative).digest('hex')
        root.pending.set(id, { id, relative, name: path.basename(relative), sha256: null, state: 'missing' })
      }
      for (const [id, pending] of root.pending) if (pending.state === 'changed' && !found.has(pending.relative)) root.pending.delete(id)
    } catch (error) { root.error = error.message; onError(error) } finally { root.scanning = false }
  }
  async function start(directory) {
    if (!await active()) throw new Error('凍結中はフォルダー監視を停止します')
    if (roots.size >= 3) throw new Error('監視フォルダーは3件までです')
    const canonical = await fs.realpath(directory)
    if ((await fs.lstat(directory)).isSymbolicLink() || canonical === path.parse(canonical).root || canonical.split(/[\\/]/).some(name => excluded.test(name)) || canonical.toLowerCase() === (process.env.USERPROFILE ?? '').toLowerCase()) throw new Error('専用の資料フォルダーを選んでください')
    const id = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')
    if (roots.has(id)) return id
    const root = { id, path: canonical, pending: new Map(), accepted: new Map(), error: null, scanning: false }
    roots.set(root.id, root)
    try {
      root.watcher = watch(canonical, { recursive: true }, () => { clearTimeout(root.debounce); root.debounce = setTimeout(() => void scan(root), 500) })
      root.watcher.on('error', error => { root.error = error.message })
      root.timer = setInterval(() => void scan(root), 10000); root.timer.unref()
      await scan(root); return root.id
    } catch (error) { stop(root.id); throw error }
  }
  function stop(id) { const root = roots.get(id); if (root) { roots.delete(id); root.watcher?.close(); clearInterval(root.timer); clearTimeout(root.debounce); root.pending.clear(); root.accepted.clear() } }
  function list() { return [...roots.values()].map(root => ({ id: root.id, name: path.basename(root.path), error: root.error, pending: [...root.pending.values()].map(({ relative: _relative, ...item }) => item) })) }
  async function read(id, candidateId) {
    if (!await active()) throw new Error('凍結中は再解析しません')
    const root = roots.get(id), candidate = root?.pending.get(candidateId)
    if (!candidate || candidate.state !== 'changed') throw new Error('読み取る更新がありません。欠落から取消はしません')
    const read = await bytesFor(root.path, candidate.relative)
    if (read.sha256 !== candidate.sha256) throw new Error('ファイルが変わりました。次の監視確認を待ってください')
    const result = /\.(pdf|docx|pptx|xlsx)$/i.test(candidate.name) ? await extractDocument({ name: candidate.name, bytes: read.bytes }) : { text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) }
    if (!await active() || !roots.has(id)) throw new Error('監視を停止しました')
    if (!result.text.trim() || result.text.length > 200000) throw new Error('資料本文は200000文字以内にしてください')
    return { ...result, name: candidate.name, sha256: read.sha256 }
  }
  function accept(id, candidateId, sha256) {
    const root = roots.get(id), item = root?.pending.get(candidateId)
    if (!item || item.sha256 !== sha256) throw new Error('監視対象が変わりました')
    if (item.state === 'changed') root.accepted.set(item.relative, sha256)
    root.pending.delete(candidateId)
  }
  return { start, stop, list, read, accept, close: () => { for (const id of roots.keys()) stop(id) }, rescan: async id => { const root = roots.get(id); if (root) await scan(root) } }
}
module.exports = { createFolderWatch }
