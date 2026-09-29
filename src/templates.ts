import { db, ensureSettings } from './db'
import { addTask, newTaskInput } from './commands'
import { uid, type Container, type SavedTemplate, type Task, type TemplateTask } from './domain'

const at = () => new Date().toISOString()
function title(name: string) {
  const value = name.trim()
  if (!value || value.length > 100) throw new Error('テンプレート名は1〜100文字で入力してください')
  return value
}
async function templateTask(task: Task, containerKey: string | null): Promise<TemplateTask> {
  const checklist = await db.checklistItems.where('taskId').equals(task.id).toArray()
  return { title: task.title, notes: task.notes, labels: [...task.labels], importance: task.importance, energyNeed: task.energyNeed ?? null, focusNeed: task.focusNeed ?? null, positiveFeeling: task.positiveFeeling ?? null, score: { ...task.score }, checklistTexts: checklist.filter(item => !item.convertedTaskId).map(item => item.text), containerKey }
}
async function save(kind: SavedTemplate['kind'], name: string, containers: SavedTemplate['containers'], tasks: TemplateTask[]) {
  const settings = await ensureSettings(), clean = title(name)
  return db.transaction('rw', db.savedTemplates, async () => {
    const versions = (await db.savedTemplates.where('ownerId').equals(settings.profileId).toArray()).filter(value => value.kind === kind && value.name.normalize('NFKC').toLocaleLowerCase('ja-JP') === clean.normalize('NFKC').toLocaleLowerCase('ja-JP'))
    const version = Math.max(0, ...versions.map(value => value.version)) + 1
    const row: SavedTemplate = { id: uid(), familyId: versions[0]?.familyId ?? uid(), ownerId: settings.profileId, name: clean, version, kind, containers, tasks, createdAt: at() }
    await db.savedTemplates.add(row)
    return row.id
  })
}
export async function saveTaskTemplate(taskId: string, name: string) {
  const task = await db.tasks.get(taskId)
  if (!task || task.deletedAt) throw new Error('タスクが見つかりません')
  return save('task', name, [], [await templateTask(task, null)])
}
export async function saveProjectTemplate(containerId: string, name: string) {
  const settings = await ensureSettings(), all = await db.containers.toArray()
  const root = all.find(item => item.id === containerId)
  if (!root || root.deletedAt || root.kind !== 'project' || root.ownerId !== settings.profileId) throw new Error('プロジェクトにアクセスできません')
  const descendants: Container[] = []
  const visit = (item: Container) => {
    descendants.push(item)
    for (const child of all.filter(value => value.parentId === item.id && !value.deletedAt && value.ownerId === settings.profileId)) visit(child)
  }
  visit(root)
  if (descendants.length > 100) throw new Error('テンプレートの階層は100件以内にしてください')
  const keyById = new Map(descendants.map((item, index) => [item.id, `c${index}`]))
  const containers = descendants.map(item => ({ key: keyById.get(item.id)!, parentKey: item.id === root.id ? null : keyById.get(item.parentId!)!, kind: item.kind, name: item.name }))
  const included = new Set(descendants.map(item => item.id))
  const sourceTasks = (await db.tasks.toArray()).filter(task => !task.deletedAt && task.containerId && included.has(task.containerId))
  if (sourceTasks.length > 200) throw new Error('テンプレートのタスクは200件以内にしてください')
  const tasks = await Promise.all(sourceTasks.map(task => templateTask(task, keyById.get(task.containerId!)!)))
  return save('project', name, containers, tasks)
}

export async function instantiateTemplate(templateId: string, requestKey: string = uid()) {
  const settings = await ensureSettings()
  const tables = [db.savedTemplates, db.tasks, db.assessments, db.audits, db.checklistItems, db.containers, db.settings, db.labelGroups, db.labelDefinitions, db.commands]
  return db.transaction('rw', tables, async () => {
    const template = await db.savedTemplates.get(templateId)
    if (!template || template.ownerId !== settings.profileId) throw new Error('テンプレートにアクセスできません')
    const hash = JSON.stringify({ operation: 'instantiate_template', templateId })
    const prior = await db.commands.get(requestKey)
    if (prior) {
      if (prior.hash !== hash) throw new Error('IDEMPOTENCY_MISMATCH')
      return JSON.parse(prior.resultId) as { containerId: string | null; taskIds: string[] }
    }
    const containerIds = new Map<string, string>(), existing = await db.containers.where('ownerId').equals(settings.profileId).toArray()
    let rootId: string | null = null
    for (const item of template.containers) {
      const parentId = item.parentKey ? containerIds.get(item.parentKey) : null
      if (item.parentKey && !parentId) throw new Error('テンプレートの階層が不正です')
      let name = item.name
      if (!item.parentKey) {
        const used = new Set(existing.filter(value => !value.deletedAt && value.parentId === null).map(value => value.name))
        let number = 2
        while (used.has(name)) name = `${item.name} (${number++})`
        if (name.length > 100) throw new Error('複製先のプロジェクト名が長すぎます')
      }
      const id = uid(), createdAt = at()
      await db.containers.add({ id, parentId: parentId ?? null, kind: item.kind, name, ownerId: settings.profileId, revision: 1, createdAt, updatedAt: createdAt, deletedAt: null })
      containerIds.set(item.key, id)
      if (!item.parentKey) rootId = id
    }
    const taskIds: string[] = []
    for (const [index, source] of template.tasks.entries()) {
      const containerId = source.containerKey ? containerIds.get(source.containerKey) : null
      if (source.containerKey && !containerId) throw new Error('テンプレートのタスク参照が不正です')
      const input = { ...newTaskInput(), title: source.title, notes: source.notes, labels: [...source.labels], importance: source.importance, energyNeed: source.energyNeed ?? null, focusNeed: source.focusNeed ?? null, positiveFeeling: source.positiveFeeling ?? null, score: { ...source.score }, containerId: containerId ?? null }
      const taskId = await addTask(input, `template:${template.id}:${requestKey}:${index}`, null)
      taskIds.push(taskId)
      for (const text of source.checklistTexts) {
        const createdAt = at()
        await db.checklistItems.add({ id: uid(), taskId, text, done: false, convertedTaskId: null, createdAt, updatedAt: createdAt })
      }
      await db.audits.add({ id: uid(), taskId, operation: 'instantiate_template', at: at(), detail: `テンプレート ${template.id} v${template.version}` })
    }
    const result = { containerId: rootId, taskIds }
    await db.commands.add({ key: requestKey, hash, resultId: JSON.stringify(result), at: at() })
    return result
  })
}
