import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFolderWatch } from './folder-watch.cjs'
// The service refuses roots below AppData, .claude, .codex, Default and similar folders, so a checkout there (profile folders, agent worktrees) cannot hold the fixtures.
async function acceptedBase(candidates) {
  for (const candidate of candidates.filter(Boolean).map(directory => path.resolve(directory))) {
    await fs.mkdir(candidate, { recursive: true })
    const probe = await fs.mkdtemp(path.join(candidate, 'probe-')), service = createFolderWatch()
    try { await service.start(probe); return candidate } catch (error) { if (!/専用/.test(error.message)) throw error } finally { service.close(); await fs.rm(probe, { recursive: true, force: true }) }
  }
  return null
}
const fixtureBase = await acceptedBase([process.env.MICHI_TEST_FIXTURE_DIR, fileURLToPath(new URL('../qa-output/folder-watch', import.meta.url)), path.join(os.tmpdir(), 'michi-folder-watch')])
const skip = fixtureBase ? false : 'checkout and temp folders are both inside folders the service refuses; set MICHI_TEST_FIXTURE_DIR to a plain folder'
async function temporary(prefix) { return fs.mkdtemp(path.join(fixtureBase, prefix)) }
async function cleanup(directory) { if (!directory.startsWith(fixtureBase + path.sep)) throw new Error('fixture path escaped'); await fs.rm(directory, { recursive: true, force: true }) }
test('selected-root changes wait for owner acceptance, missing files never cancel, frozen scans stop', { skip }, async () => {
  const root = await temporary('michi-watch-'); let active = true
  const service = createFolderWatch({ active: async () => active })
  try {
    await fs.writeFile(path.join(root, 'selected.txt'), '資料の確認'); await fs.writeFile(path.join(root, '.env.txt'), 'not read'); await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'not read')
    const id = await service.start(root); assert.equal(service.list()[0].pending.length, 1)
    let pending = service.list()[0].pending[0], read = await service.read(id, pending.id)
    assert.equal(read.text, '資料の確認'); service.accept(id, pending.id, read.sha256); assert.equal(service.list()[0].pending.length, 0)
    await fs.writeFile(path.join(root, 'selected.txt'), '新しい版'); await service.rescan(id)
    pending = service.list()[0].pending[0]; assert.equal(pending.state, 'changed')
    active = false; await assert.rejects(service.read(id, pending.id), /凍結/)
    active = true; read = await service.read(id, pending.id); service.accept(id, pending.id, read.sha256)
    await fs.unlink(path.join(root, 'selected.txt')); await service.rescan(id)
    assert.equal(service.list()[0].pending[0].state, 'missing'); await assert.rejects(service.read(id, pending.id), /取消/)
    service.stop(id); assert.equal(service.list().length, 0)
    assert.equal(await service.start(root), id)
  } finally { service.close(); await cleanup(root) }
})
test('root escape, junctions, stale file contents and system roots are refused', { skip }, async () => {
  const root = await temporary('michi-watch-'), outside = await temporary('michi-watch-outside-'), service = createFolderWatch()
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside'); await fs.symlink(outside, path.join(root, 'link'), 'junction')
    await fs.writeFile(path.join(root, 'selected.txt'), 'before')
    const id = await service.start(root), pending = service.list()[0].pending[0]
    assert.equal(service.list()[0].pending.length, 1)
    await fs.writeFile(path.join(root, 'selected.txt'), 'after')
    await assert.rejects(service.read(id, pending.id), /変わりました/)
    await assert.rejects(service.start(path.parse(root).root), /専用/)
    await assert.rejects(service.start(path.join(root, 'link')), /専用/)
  } finally { service.close(); await cleanup(root); await cleanup(outside) }
})
