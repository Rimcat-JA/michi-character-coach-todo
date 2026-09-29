import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { addWallTile, moveWallTile, removeWallTile, setWallTileGroup } from './wall'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

it('付箋の追加・交換・グループ変更でタスク状態と必要ポイントを変えない', async () => {
  const first = await createTask({ ...newTaskInput(), title: '一枚目', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
  const second = await createTask({ ...newTaskInput(), title: '二枚目', score: { ...emptyScore(), mode: 'manual', manualPoints: 10 } })
  await addWallTile(first, '仕事')
  await addWallTile(second)
  await moveWallTile(first, 1, 0)
  await setWallTileGroup(first, '今日')
  const tiles = (await db.settings.get('main'))!.wallTiles!
  expect(tiles.find(tile => tile.taskId === first)).toMatchObject({ x: 1, y: 0, group: '今日' })
  expect(tiles.find(tile => tile.taskId === second)).toMatchObject({ x: 0, y: 0 })
  expect((await db.tasks.get(first))?.status).toBe('open')
  expect((await db.tasks.get(first))?.effectivePoints).toBe(25)
  expect((await db.tasks.get(second))?.effectivePoints).toBe(10)
  expect(await db.completions.count()).toBe(0)
  expect(await db.ledger.count()).toBe(0)
  await removeWallTile(first)
  expect((await db.tasks.get(first))?.title).toBe('一枚目')
})
