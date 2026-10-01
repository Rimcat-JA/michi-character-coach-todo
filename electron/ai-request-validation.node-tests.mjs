import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// Static and unit checks only: no request is made and no OpenRouter/DeepSeek key is read.
const { isModelId, validateTaskSplitRequest } = createRequire(import.meta.url)('./ai-request-validation.cjs')
const directory = fileURLToPath(new URL('./', import.meta.url))
const realIds = ['deepseek/deepseek-chat', 'openai/gpt-4o-mini', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3-235b-a22b:free']
const task = { id: 'task-1', title: '40ptの作業', revision: 1, scoreMode: 'manual', manualPoints: 40 }

test('the shared model-ID check accepts real OpenRouter IDs and rejects malformed ones', () => {
  for (const id of realIds) assert.equal(isModelId(id), true, id)
  for (const id of ['', 'ab', 'a b', 'x'.repeat(121), null, 42, 'deepseek/chat\n']) assert.equal(isModelId(id), false, String(id))
})

test('the split request validator lets real model IDs through and keeps rejecting bad ones', () => {
  for (const model of realIds) assert.doesNotThrow(() => validateTaskSplitRequest({ model, message: '調査15ptと実装25ptに分けて', task }))
  for (const model of ['', 'a b', 'x'.repeat(121)]) assert.throws(() => validateTaskSplitRequest({ model, message: '分けて', task }), /モデルIDを確認してください/)
  assert.throws(() => validateTaskSplitRequest({ model: realIds[0], message: ' ', task }), /相談文/)
  assert.throws(() => validateTaskSplitRequest({ model: realIds[0], message: '分けて', task: { ...task, extra: true } }), /分割するタスクが不正です/)
})

test('every model-ID pattern left in the Electron sources accepts real IDs (static scan)', () => {
  const sources = readdirSync(directory).filter(name => name.endsWith('.cjs')).map(name => [name, readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')])
  const patterns = sources.flatMap(([name, source]) => [...source.matchAll(/\/\^\[([^\]]*)\]\{3,120\}\$\//g)].map(match => [name, new RegExp(`^[${match[1]}]{3,120}$`)]))
  assert.ok(patterns.length >= 1)
  for (const [name, pattern] of patterns) for (const id of realIds) assert.equal(pattern.test(id), true, `${name}: ${pattern} rejects ${id}`)
  const main = sources.find(([name]) => name === 'main.cjs')[1]
  assert.match(main, /validateTaskSplitRequest\(\{ model, message, task \}\)/)
})
