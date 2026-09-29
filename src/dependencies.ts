import { db } from './db'
import { uid, type Container, type Task, type TaskDependency } from './domain'

export function validateDependencyGraph(dependencies: TaskDependency[], taskIds: Set<string>) {
  const byTask = new Map<string, string[]>(), pairs = new Set<string>()
  for (const edge of dependencies) {
    if (!taskIds.has(edge.taskId) || !taskIds.has(edge.dependsOnId) || edge.taskId === edge.dependsOnId) throw new Error('依存先のタスクが不正です')
    const key = `${edge.taskId}:${edge.dependsOnId}`
    if (pairs.has(key)) throw new Error('依存関係が重複しています')
    pairs.add(key)
    byTask.set(edge.taskId, [...(byTask.get(edge.taskId) ?? []), edge.dependsOnId])
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('依存関係に循環があります')
    if (visited.has(id)) return
    visiting.add(id)
    for (const prerequisite of byTask.get(id) ?? []) visit(prerequisite)
    visiting.delete(id); visited.add(id)
  }
  for (const id of byTask.keys()) visit(id)
}

export async function addTaskDependency(taskId: string, dependsOnId: string) {
  return db.transaction('rw', db.tasks, db.taskDependencies, db.audits, async () => {
    const [task, prerequisite] = await Promise.all([db.tasks.get(taskId), db.tasks.get(dependsOnId)])
    if (!task || task.deletedAt || task.status !== 'open' || !prerequisite || prerequisite.deletedAt) throw new Error('タスクにアクセスできません')
    const current = await db.taskDependencies.toArray()
    const edge: TaskDependency = { id: uid(), taskId, dependsOnId, createdAt: new Date().toISOString() }
    validateDependencyGraph([...current, edge], new Set((await db.tasks.toArray()).map(value => value.id)))
    await db.taskDependencies.add(edge)
    await db.audits.add({ id: uid(), taskId, operation: 'add_dependency', at: edge.createdAt, detail: dependsOnId })
    return edge.id
  })
}

export async function removeTaskDependency(id: string) {
  await db.transaction('rw', db.taskDependencies, db.audits, async () => {
    const edge = await db.taskDependencies.get(id)
    if (!edge) throw new Error('依存関係がありません')
    await db.taskDependencies.delete(id)
    await db.audits.add({ id: uid(), taskId: edge.taskId, operation: 'remove_dependency', at: new Date().toISOString(), detail: edge.dependsOnId })
  })
}

export function executableTasks(tasks: Task[], dependencies: TaskDependency[]) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const prerequisites = new Map<string, string[]>()
  for (const edge of dependencies) prerequisites.set(edge.taskId, [...(prerequisites.get(edge.taskId) ?? []), edge.dependsOnId])
  return tasks.filter(task => !task.deletedAt && task.status === 'open' && (prerequisites.get(task.id) ?? []).every(id => byId.get(id)?.status === 'completed' && !byId.get(id)?.deletedAt))
}

export function projectNextStepStatus(containers: Container[], tasks: Task[], dependencies: TaskDependency[]) {
  const byId = new Map(containers.map(item => [item.id, item]))
  const executable = new Set(executableTasks(tasks, dependencies).map(task => task.id))
  const belongsTo = (containerId: string | null | undefined, projectId: string) => {
    let id = containerId ?? null
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      if (id === projectId) return true
      seen.add(id); id = byId.get(id)?.parentId ?? null
    }
    return false
  }
  const status = new Map<string, 'empty' | 'all_done' | 'blocked' | 'ready'>()
  for (const project of containers.filter(item => item.kind === 'project' && !item.deletedAt)) {
    const ownTasks = tasks.filter(task => !task.deletedAt && belongsTo(task.containerId, project.id))
    status.set(project.id, ownTasks.length === 0 ? 'empty' : ownTasks.every(task => task.status === 'completed') ? 'all_done' : ownTasks.some(task => executable.has(task.id)) ? 'ready' : 'blocked')
  }
  return status
}
