import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, completeTask, correctCompletion, undoCompletion } from './commands'
import { emptyScore } from './domain'
import { inspectBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

async function snapshot(): Promise<Snapshot> {
  return {
    format: 'coachbundle', version: 1, exportedAt: new Date().toISOString(),
    tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(),
    completions: await db.completions.toArray(), ledger: await db.ledger.toArray(),
    routines: await db.routines.toArray(), sessions: await db.sessions.toArray(),
    commands: await db.commands.toArray(), audits: await db.audits.toArray(),
    settings: await db.settings.toArray()
  }
}

describe('バックアップの復元前検証', () => {
  it('有効な実績と取消履歴を復元できる', async () => {
    const input = { ...newTaskInput(), title: '復元するタスク', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 20 } }
    const id = await createTask(input)
    await completeTask(id, 1)
    await correctCompletion(id, 25, '実績を訂正')
    await undoCompletion(id, 2)
    const saved = await snapshot()
    expect(() => validateSnapshot(saved)).not.toThrow()
    await db.tasks.clear()
    await restoreBackup(saved)
    expect((await db.tasks.get(id))?.title).toBe('復元するタスク')
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(0)
  })

  it('台帳の不一致を拒否し現在のデータを保持する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '保護対象', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    await completeTask(id, 1)
    const corrupt = await snapshot()
    corrupt.ledger[0].delta = 99
    await expect(restoreBackup(corrupt)).rejects.toThrow('台帳の合計')
    expect((await db.tasks.get(id))?.title).toBe('保護対象')
    expect((await db.ledger.toArray())[0].delta).toBe(20)
  })

  it('重複キー、欠落した評価、不正な日時を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: '一件目' })
    await createTask({ ...newTaskInput(), title: '二件目' })
    const valid = await snapshot()
    const duplicate = structuredClone(valid)
    duplicate.tasks[1].generationKey = duplicate.tasks[0].generationKey
    expect(() => validateSnapshot(duplicate)).toThrow('重複')
    const missing = structuredClone(valid)
    missing.assessments = []
    expect(() => validateSnapshot(missing)).toThrow('評価参照')
    const badDate = structuredClone(valid)
    badDate.tasks[0].createdAt = 'yesterday'
    expect(() => validateSnapshot(badDate)).toThrow('履歴')
  })
  it('認証情報のような未対応設定を取り込まない', async () => {
    const data = await snapshot()
    const injected = { ...data, settings: [{ ...data.settings[0], apiKey: 'synthetic-test-only' }] }
    expect(() => validateSnapshot(injected)).toThrow('未対応の項目')
  })
  it('version付きJSONを検証して復元候補を返す', async () => {
    await createTask({ ...newTaskInput(), title: 'JSONの対象' })
    const data = await snapshot()
    const file = new File([JSON.stringify(data)], 'portable.json', { type: 'application/json' })
    const inspected = await inspectBackup(file, '')
    expect(inspected.tasks[0].title).toBe('JSONの対象')
    expect(inspected.format).toBe('coachbundle')
  })
})
