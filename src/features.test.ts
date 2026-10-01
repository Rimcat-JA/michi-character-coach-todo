import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { completeTask, createTask, newTaskInput } from './commands'
import { db, ensureSettings } from './db'
import { emptyScore } from './domain'
import { featureEnabled, OPTIONAL_FEATURE_IDS, PANEL_FEATURE_IDS, setFeatureVisible, type FeatureId } from './features'
import { applyWorkflowConfig, saveWorkflowPreset } from './workflows'
import { makeWebCaptureCapsule, prepareWebCaptureImport, saveCaptureImportFromUI } from './web-capture-import'
import { achievementDB } from './achievements-save'

// Node-only fixture: production browsers never let page code set isTrusted.
function click() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
/** Every table, with only settings.hiddenFeatures removed: hiding must leave the rest byte-identical. */
async function everythingButVisibility() {
  const tables = await Promise.all(db.tables.map(async table => [table.name, await table.toArray()] as const))
  return JSON.stringify(Object.fromEntries(tables.map(([name, rows]) => [name, name === 'settings' ? rows.map(row => ({ ...row, hiddenFeatures: undefined })) : rows])))
}

it('機能をOFFにしてもタスクと通知設定は変えず、設定から再表示できる', async () => {
  const id = await createTask({ ...newTaskInput(), title: '残るタスク' })
  await db.settings.update('main', { notifications: true })
  await setFeatureVisible('wall', false)
  const disabled = (await db.settings.get('main'))!
  expect(featureEnabled(disabled.hiddenFeatures, 'wall')).toBe(false)
  expect(featureEnabled(disabled.hiddenFeatures, 'settings')).toBe(true)
  expect(disabled.notifications).toBe(true)
  expect((await db.tasks.get(id))?.title).toBe('残るタスク')
  await setFeatureVisible('wall', true)
  expect(featureEnabled((await db.settings.get('main'))?.hiddenFeatures, 'wall')).toBe(true)
})

describe('H01 画面内の機能のON/OFF', () => {
  it('registers the in-screen capabilities next to the navigation features', () => {
    expect(PANEL_FEATURE_IDS).toEqual(['voice', 'avatar', 'achievements', 'localActions', 'fileBridge', 'captureImport', 'externalImport'])
    for (const id of PANEL_FEATURE_IDS) expect(OPTIONAL_FEATURE_IDS).toContain(id)
    expect(OPTIONAL_FEATURE_IDS).not.toContain('settings')
  })
  it('hiding voice or PC operations keeps tasks, ledger, notifications, AI, policy epoch, achievement policies and presets byte-identical', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '40ptの作業', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(taskId, 1)
    await db.settings.update('main', { notifications: true, aiEnabled: true, aiModel: 'synthetic/model', changePolicy: { epoch: 7, sourcePermissionRevision: 2, aiChangesEnabled: true, taskUpdate: 'require_approval', bounds: { maxTasks: 20, maxScheduledDayShift: 3, maxNotesCharacters: 1000 }, locks: {} } })
    await achievementDB.achievementPolicies.put({ id: 'repository:1', ownerId: 'synthetic' } as never)
    await saveWorkflowPreset('いつもの')
    const before = await everythingButVisibility()
    for (const id of ['voice', 'localActions'] as FeatureId[]) {
      await setFeatureVisible(id, false)
      expect(featureEnabled((await db.settings.get('main'))!.hiddenFeatures, id)).toBe(false)
      expect(await everythingButVisibility()).toBe(before)
    }
    for (const id of ['voice', 'localActions'] as FeatureId[]) await setFeatureVisible(id, true)
    expect((await db.settings.get('main'))!.hiddenFeatures).toEqual([])
    expect(await everythingButVisibility()).toBe(before)
    expect(await db.ledger.count()).toBe(1)
  })
  it('rejects unknown or non-hideable IDs and keeps the previous value', async () => {
    await setFeatureVisible('avatar', false)
    for (const id of ['unknown', 'settings', '__proto__']) await expect(setFeatureVisible(id as FeatureId, false)).rejects.toThrow('非表示にできません')
    await expect(setFeatureVisible('voice', 'false' as unknown as boolean)).rejects.toThrow('表示の指定')
    expect((await db.settings.get('main'))!.hiddenFeatures).toEqual(['avatar'])
  })
  it('hiding revokes unsaved import previews, and showing again never replays them', async () => {
    const capsule = () => makeWebCaptureCapsule({ title: '合成Web引用', url: 'https://example.org/a', quote: '選んだ引用だけ', timezone: 'Asia/Tokyo', capturedAt: '2026-10-01T00:30:00.000Z' })
    const preview = await prepareWebCaptureImport(capsule())
    await setFeatureVisible('captureImport', false)
    await setFeatureVisible('captureImport', true)
    await expect(saveCaptureImportFromUI(preview, click())).rejects.toThrow('確認した取込案')
    expect(await db.contextSources.count()).toBe(0)
    // A workflow preset that hides the feature revokes the same way.
    const again = await prepareWebCaptureImport(capsule()), settings = (await db.settings.get('main'))!
    await applyWorkflowConfig({ navDesktop: ['today', 'settings'], navMobile: ['today'], hiddenFeatures: ['captureImport', 'voice'], daySectionMode: 'halfday', taskListLimit: null, dailyMinutes: settings.dailyMinutes, dailyPoints: settings.dailyPoints })
    await expect(saveCaptureImportFromUI(again, click())).rejects.toThrow('確認した取込案')
    const fresh = await prepareWebCaptureImport(capsule())
    await expect(saveCaptureImportFromUI(fresh, click())).resolves.toMatchObject({ duplicate: false })
  })
})
