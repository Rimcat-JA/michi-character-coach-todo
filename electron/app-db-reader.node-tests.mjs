import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { readAppDatabase } = createRequire(import.meta.url)('./app-db-reader.cjs')

test('dataset freeze state is readable through the bounded database bridge', async () => {
  let expression
  const win = { isDestroyed: () => false, webContents: { executeJavaScript: async value => { expression = value; return { id: 'main', mode: 'frozen' } } } }
  assert.equal((await readAppDatabase(win, 'datasetState', 'main')).mode, 'frozen')
  assert.ok(expression.includes('"datasetState"'))
  await assert.rejects(readAppDatabase(win, 'sourceArtifacts', 'main'), /保存領域/)
})
