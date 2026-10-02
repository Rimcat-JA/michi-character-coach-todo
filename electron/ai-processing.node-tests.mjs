import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createAIProcessingGuard } = createRequire(import.meta.url)('./ai-processing.cjs')
test('BYOK generations reject stopped/resumed responses while external-only switch changes leave the coach running', async () => {
  const settings = { profileId: 'synthetic-owner', datasetId: 'synthetic-dataset', aiEnabled: true, aiConnectionEpoch: 2, changePolicy: { epoch: 3 }, externalAI: { enabled: true, epoch: 1 } }
  const guard = createAIProcessingGuard(async () => settings), binding = await guard.begin()
  settings.externalAI = { enabled: false, epoch: 2 }; await guard.assertCurrent(binding)
  settings.aiEnabled = false; await assert.rejects(guard.begin()); await assert.rejects(guard.assertCurrent(binding))
  settings.aiEnabled = true; settings.aiConnectionEpoch++; await assert.rejects(guard.assertCurrent(binding))
  const next = await guard.begin(); settings.datasetMode = 'frozen'; await assert.rejects(guard.assertCurrent(next))
})
test('unreadable settings, invalid epochs and owner/dataset/policy changes fail closed', async () => {
  let settings = null; const guard = createAIProcessingGuard(async () => settings); await assert.rejects(guard.begin())
  settings = { profileId: 'a', datasetId: 'b', aiEnabled: true, aiConnectionEpoch: 1, changePolicy: { epoch: 2 } }
  const binding = await guard.begin()
  for (const patch of [{profileId:'other'},{datasetId:'other'},{aiConnectionEpoch:-1},{aiConnectionEpoch:NaN},{changePolicy:{epoch:3}}]) { const saved = settings; settings = {...settings,...patch}; await assert.rejects(guard.assertCurrent(binding)); settings = saved }
})
