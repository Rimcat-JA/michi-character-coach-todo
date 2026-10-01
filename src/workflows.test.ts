import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { applyWorkflowPreset, exportWorkflowPreset, importWorkflowPreset, saveWorkflowPreset } from './workflows'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

it('版付きプリセットを共有・適用してもAPIと通知の許可を持ち込まない', async () => {
  await db.settings.update('main', { navDesktop: ['today', 'tasks'], navMobile: ['today'], hiddenFeatures: ['wall'], daySectionMode: 'category', taskListLimit: 5, dailyMinutes: 120, dailyPoints: 25, aiEnabled: true, aiModel: 'private-model', notifications: true, automation: 'A2' })
  const id = await saveWorkflowPreset('仕事')
  await saveWorkflowPreset('仕事', id)
  const saved = (await db.settings.get('main'))!.workflowPresets![0]
  expect(saved.version).toBe(2)
  const shared = exportWorkflowPreset(saved)
  expect(shared).not.toContain('private-model')
  expect(shared).not.toContain('notifications')
  expect(shared).not.toContain('aiEnabled')
  expect(shared).not.toContain('automation')
  const injected = JSON.parse(shared)
  injected.preset.config.apiKey = 'foreign-secret'
  await expect(importWorkflowPreset(JSON.stringify(injected))).rejects.toThrow('ワークフロー設定')
  const importedId = await importWorkflowPreset(shared)
  await db.settings.update('main', { navDesktop: [], dailyPoints: 99, aiEnabled: false, notifications: false, automation: 'A0' })
  await applyWorkflowPreset(importedId)
  const applied = (await db.settings.get('main'))!
  expect(applied).toMatchObject({ navDesktop: ['today', 'tasks'], navMobile: ['today'], hiddenFeatures: ['wall'], daySectionMode: 'category', taskListLimit: 5, dailyMinutes: 120, dailyPoints: 25, aiEnabled: false, notifications: false, automation: 'A0', aiModel: 'private-model' })
})

it('画面内の機能を隠すプリセットも、キー・許可・自動化設定を持ち込まずに適用できる', async () => {
  await db.settings.update('main', { hiddenFeatures: ['voice', 'localActions', 'externalImport'], aiEnabled: true, aiModel: 'private-model', notifications: true })
  const presetId = await saveWorkflowPreset('静かな画面')
  const shared = exportWorkflowPreset((await db.settings.get('main'))!.workflowPresets!.find(preset => preset.id === presetId)!)
  expect(JSON.parse(shared).preset.config.hiddenFeatures).toEqual(['voice', 'localActions', 'externalImport'])
  await db.settings.update('main', { hiddenFeatures: [], aiEnabled: false, notifications: false, automation: 'A1' })
  const before = (await db.settings.get('main'))!.changePolicy
  await applyWorkflowPreset(await importWorkflowPreset(shared))
  const applied = (await db.settings.get('main'))!
  expect(applied).toMatchObject({ hiddenFeatures: ['voice', 'localActions', 'externalImport'], aiEnabled: false, notifications: false, automation: 'A1' })
  expect(applied.changePolicy).toEqual(before)
  const injected = JSON.parse(shared); injected.preset.config.hiddenFeatures.push('unknownPanel')
  await expect(importWorkflowPreset(JSON.stringify(injected))).rejects.toThrow('ワークフロー設定')
})
