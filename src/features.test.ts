import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { createTask, newTaskInput } from './commands'
import { db, ensureSettings } from './db'
import { featureEnabled, setFeatureVisible } from './features'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

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
