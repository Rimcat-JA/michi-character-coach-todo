import { db } from './db'
import type { WallTile } from './domain'

const WIDTH = 5, HEIGHT = 10
const validGroup = (group: string) => group.trim().length <= 100

export async function addWallTile(taskId: string, group = ''): Promise<void> {
  if (!validGroup(group)) throw new Error('グループ名は100文字以内にしてください')
  await db.transaction('rw', [db.settings, db.tasks], async () => {
    const settings = await db.settings.get('main'), task = await db.tasks.get(taskId)
    if (!settings || !task || task.deletedAt) throw new Error('対象タスクがありません')
    const tiles = settings.wallTiles ?? []
    if (tiles.some(tile => tile.taskId === taskId)) return
    let position: Pick<WallTile, 'x' | 'y'> | null = null
    for (let y = 0; y < HEIGHT && !position; y++) for (let x = 0; x < WIDTH; x++) if (!tiles.some(tile => tile.x === x && tile.y === y)) { position = { x, y }; break }
    if (!position) throw new Error('Wallは50枚までです')
    await db.settings.put({ ...settings, wallTiles: [...tiles, { taskId, ...position, group: group.trim() }] })
  })
}

export async function moveWallTile(taskId: string, dx: number, dy: number): Promise<void> {
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) + Math.abs(dy) !== 1) throw new Error('移動方向が不正です')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    const tiles = settings.wallTiles ?? [], source = tiles.find(tile => tile.taskId === taskId)
    if (!source) throw new Error('付箋がありません')
    const x = source.x + dx, y = source.y + dy
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return
    const destination = tiles.find(tile => tile.x === x && tile.y === y)
    await db.settings.put({ ...settings, wallTiles: tiles.map(tile => tile.taskId === taskId ? { ...tile, x, y } : tile.taskId === destination?.taskId ? { ...tile, x: source.x, y: source.y } : tile) })
  })
}

export async function setWallTileGroup(taskId: string, group: string): Promise<void> {
  if (!validGroup(group)) throw new Error('グループ名は100文字以内にしてください')
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings || !(settings.wallTiles ?? []).some(tile => tile.taskId === taskId)) throw new Error('付箋がありません')
    await db.settings.put({ ...settings, wallTiles: settings.wallTiles!.map(tile => tile.taskId === taskId ? { ...tile, group: group.trim() } : tile) })
  })
}

export async function removeWallTile(taskId: string): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('設定がありません')
    await db.settings.put({ ...settings, wallTiles: (settings.wallTiles ?? []).filter(tile => tile.taskId !== taskId) })
  })
}
