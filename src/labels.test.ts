import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { createLabelDefinition, createLabelGroup } from './labels'

beforeEach(async () => { await db.delete(); await db.open() })

describe('ラベルグループ', () => {
  it('single場所グループの二値指定を拒否し、multiは複数許す', async () => {
    const location = await createLabelGroup('場所', 'single')
    await createLabelDefinition('自宅', location)
    await createLabelDefinition('外出先', location)
    const category = await createLabelGroup('種類', 'multi')
    await createLabelDefinition('事務', category)
    await createLabelDefinition('買物', category)
    const input = { ...newTaskInput(), title: '準備', labels: ['自宅', '外出先'] }
    await expect(createTask(input)).rejects.toThrow('1つだけ')
    expect(await db.tasks.count()).toBe(0)
    const id = await createTask({ ...input, labels: ['自宅', '事務', '買物'] })
    const current = (await db.tasks.get(id))!
    await expect(updateTask(id, current.revision, { ...current, labels: ['外出先', '自宅'] })).rejects.toThrow('1つだけ')
    expect((await db.tasks.get(id))?.labels).toEqual(['自宅', '事務', '買物'])
  })
  it('大文字小文字・全角半角違いの重複を拒否する', async () => {
    await createLabelGroup('場所', 'single')
    await expect(createLabelGroup('場所', 'multi')).rejects.toThrow('同じ名前')
    await createLabelDefinition('ABC')
    await expect(createLabelDefinition('ＡＢＣ')).rejects.toThrow('同じ名前')
    await expect(createTask({ ...newTaskInput(), title: '確認', labels: ['ABC', 'ＡＢＣ'] })).rejects.toThrow('重複')
  })
  it('既存タスクの自由ラベルがsingle制約に違反する後付け登録を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: '移動', labels: ['家', '外'] })
    const group = await createLabelGroup('場所', 'single')
    await createLabelDefinition('家', group)
    await expect(createLabelDefinition('外', group)).rejects.toThrow('1つだけ')
    expect(await db.labelDefinitions.count()).toBe(1)
  })
})
