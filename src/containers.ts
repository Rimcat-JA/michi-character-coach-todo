import { db, ensureSettings } from './db'
import { uid, type Completion, type Container, type Task } from './domain'

export class ContainerConflictError extends Error { constructor() { super('別の画面で階層が変更されました。再読み込みしてください。') } }
const now = () => new Date().toISOString()
const validName = (name: string) => { if (!name.trim() || name.trim().length > 100) throw new Error('名前は1〜100文字で入力してください'); return name.trim() }

function ancestors(id: string | null, byId: Map<string, Container>): Container[] {
  const chain: Container[] = [], seen = new Set<string>()
  while (id !== null) {
    if (seen.has(id)) throw new Error('階層に循環があります')
    seen.add(id)
    const item = byId.get(id)
    if (!item || item.deletedAt) throw new Error('親のカテゴリ・プロジェクトがありません')
    chain.unshift(item)
    id = item.parentId
  }
  return chain
}

export function containerPath(id: string, containers: Container[]): string {
  return ancestors(id, new Map(containers.map(item => [item.id, item]))).map(item => item.name).join(' / ')
}

function descendants(id: string, containers: Container[]): Container[] {
  const children = new Map<string, Container[]>()
  for (const item of containers) if (item.parentId && !item.deletedAt) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
  const result: Container[] = [], seen = new Set<string>(), queue = [id]
  while (queue.length) {
    const current = queue.shift()!
    if (seen.has(current)) throw new Error('階層に循環があります')
    seen.add(current)
    const item = containers.find(value => value.id === current)
    if (!item || item.deletedAt) throw new Error('カテゴリ・プロジェクトがありません')
    result.push(item)
    queue.push(...(children.get(current) ?? []).map(value => value.id))
  }
  return result
}

async function updateTaskPaths(containers: Container[]) {
  const ids = new Set(containers.map(item => item.id))
  const all = await db.containers.toArray()
  const tasks = await db.tasks.filter(task => Boolean(task.containerId && ids.has(task.containerId))).toArray()
  const at = now()
  for (const task of tasks) {
    const project = containerPath(task.containerId!, all)
    if (task.project === project) continue
    await db.tasks.put({ ...task, project, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId: task.id, operation: 'container_path_update', at, detail: project })
  }
}

export async function createContainer(input: { kind: Container['kind']; name: string; parentId: string | null }, key = uid()): Promise<string> {
  const settings = await ensureSettings()
  const name = validName(input.name)
  if (!['category', 'project'].includes(input.kind)) throw new Error('種類が不正です')
  const hash = JSON.stringify({ operation: 'container_create', input: { ...input, name } })
  return db.transaction('rw', db.containers, db.commands, async () => {
    const prior = await db.commands.get(key)
    if (prior) { if (prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH'); return prior.resultId }
    const all = await db.containers.toArray(), byId = new Map(all.map(item => [item.id, item]))
    const chain = ancestors(input.parentId, byId)
    if (chain.length >= 12) throw new Error('階層は12段までです')
    if (chain.some(item => item.ownerId !== settings.profileId)) throw new Error('アクセスできない親です')
    if (input.kind === 'category' && chain.at(-1)?.kind === 'project') throw new Error('プロジェクトの下にカテゴリは作れません')
    if (all.some(item => !item.deletedAt && item.parentId === input.parentId && item.kind === input.kind && item.name === name && item.ownerId === settings.profileId)) throw new Error('同じ階層に同名の項目があります')
    const id = uid(), at = now()
    await db.containers.add({ id, parentId: input.parentId, kind: input.kind, name, ownerId: settings.profileId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null })
    await db.commands.add({ key, hash, resultId: id, at })
    return id
  })
}

export async function moveContainer(id: string, expectedRevision: number, parentId: string | null): Promise<void> {
  const settings = await ensureSettings()
  await db.transaction('rw', db.containers, db.tasks, db.audits, async () => {
    const all = await db.containers.toArray(), byId = new Map(all.map(item => [item.id, item]))
    const item = byId.get(id)
    if (!item || item.deletedAt) throw new Error('カテゴリ・プロジェクトがありません')
    if (item.ownerId !== settings.profileId) throw new Error('アクセスできない項目です')
    if (item.revision !== expectedRevision) throw new ContainerConflictError()
    const subtree = descendants(id, all), subtreeIds = new Set(subtree.map(value => value.id))
    if (parentId && subtreeIds.has(parentId)) throw new Error('自分または子の下へ移動できません')
    const parentChain = ancestors(parentId, byId)
    if (parentChain.some(value => value.ownerId !== item.ownerId) || subtree.some(value => value.ownerId !== item.ownerId)) throw new Error('アクセス境界をまたぐ移動はできません')
    if (item.kind === 'category' && parentChain.at(-1)?.kind === 'project') throw new Error('プロジェクトの下にカテゴリは移せません')
    if (all.some(value => value.id !== id && !value.deletedAt && value.parentId === parentId && value.kind === item.kind && value.name === item.name && value.ownerId === item.ownerId)) throw new Error('移動先に同名の項目があります')
    const subtreeById = new Map(subtree.map(value => [value.id, value]))
    const relativeDepth = (value: Container) => { let depth = 1, current = value; while (current.id !== id) { const parent = current.parentId && subtreeById.get(current.parentId); if (!parent) throw new Error('階層が不正です'); current = parent; depth++ } return depth }
    const maxRelativeDepth = Math.max(...subtree.map(relativeDepth))
    if (parentChain.length + maxRelativeDepth > 12) throw new Error('階層は12段までです')
    await db.containers.put({ ...item, parentId, revision: item.revision + 1, updatedAt: now() })
    await updateTaskPaths(subtree)
  })
}

export async function renameContainer(id: string, expectedRevision: number, nameInput: string): Promise<void> {
  const name = validName(nameInput)
  const settings = await ensureSettings()
  await db.transaction('rw', db.containers, db.tasks, db.audits, async () => {
    const all = await db.containers.toArray(), item = all.find(value => value.id === id)
    if (!item || item.deletedAt) throw new Error('カテゴリ・プロジェクトがありません')
    if (item.ownerId !== settings.profileId) throw new Error('アクセスできない項目です')
    if (item.revision !== expectedRevision) throw new ContainerConflictError()
    if (all.some(value => value.id !== id && !value.deletedAt && value.parentId === item.parentId && value.kind === item.kind && value.name === name && value.ownerId === item.ownerId)) throw new Error('同じ階層に同名の項目があります')
    await db.containers.put({ ...item, name, revision: item.revision + 1, updatedAt: now() })
    await updateTaskPaths(descendants(id, all))
  })
}

export function containerPointTotals(containers: Container[], tasks: Task[], completions: Completion[]): Map<string, number> {
  const byId = new Map(containers.map(item => [item.id, item]))
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const totals = new Map<string, number>()
  for (const completion of completions) {
    if (!completion.currentAt || completion.netPoints === null) continue
    const id = taskById.get(completion.taskId)?.containerId
    if (!id) continue
    for (const container of ancestors(id, byId)) totals.set(container.id, (totals.get(container.id) ?? 0) + completion.netPoints)
  }
  return totals
}
