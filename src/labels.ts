import { db, ensureSettings } from './db'
import { uid, type LabelDefinition, type LabelGroup } from './domain'

const normalized = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('ja-JP')
function validName(name: string) {
  if (!name.trim() || name.trim().length > 100) throw new Error('名前は1〜100文字で入力してください')
  return name.trim()
}

export async function createLabelGroup(name: string, selectionMode: LabelGroup['selectionMode']) {
  const settings = await ensureSettings(), clean = validName(name)
  if (selectionMode !== 'single' && selectionMode !== 'multi') throw new Error('選択方式が不正です')
  return db.transaction('rw', db.labelGroups, async () => {
    const groups = await db.labelGroups.where('ownerId').equals(settings.profileId).toArray()
    if (groups.some(group => normalized(group.name) === normalized(clean))) throw new Error('同じ名前のラベルグループがあります')
    const group: LabelGroup = { id: uid(), ownerId: settings.profileId, name: clean, selectionMode, createdAt: new Date().toISOString() }
    await db.labelGroups.add(group)
    return group.id
  })
}

export async function createLabelDefinition(name: string, groupId: string | null = null) {
  const settings = await ensureSettings(), clean = validName(name)
  return db.transaction('rw', [db.labelGroups, db.labelDefinitions, db.tasks, db.savedTemplates], async () => {
    if (groupId) {
      const group = await db.labelGroups.get(groupId)
      if (!group || group.ownerId !== settings.profileId) throw new Error('ラベルグループにアクセスできません')
    }
    const definitions = await db.labelDefinitions.where('ownerId').equals(settings.profileId).toArray()
    if (definitions.some(label => normalized(label.name) === normalized(clean))) throw new Error('同じ名前のラベルがあります')
    const label: LabelDefinition = { id: uid(), ownerId: settings.profileId, groupId, name: clean, createdAt: new Date().toISOString() }
    if (groupId) {
      const groups = await db.labelGroups.where('ownerId').equals(settings.profileId).toArray()
      const proposed = [...definitions, label]
      for (const task of await db.tasks.toArray()) validateLabelSelection(task.labels, groups, proposed)
      for (const template of await db.savedTemplates.toArray()) for (const task of template.tasks) validateLabelSelection(task.labels, groups, proposed)
    }
    await db.labelDefinitions.add(label)
    return label.id
  })
}

export function validateLabelSelection(labels: string[], groups: LabelGroup[], definitions: LabelDefinition[]) {
  if (!Array.isArray(labels) || labels.length > 30 || labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('ラベルは30件以内、各100文字以内で指定してください')
  const keys = labels.map(normalized)
  if (new Set(keys).size !== keys.length) throw new Error('同じラベルを重複して指定できません')
  const byName = new Map(definitions.map(label => [normalized(label.name), label]))
  const groupById = new Map(groups.map(group => [group.id, group]))
  const used = new Set<string>()
  for (const key of keys) {
    const label = byName.get(key)
    if (!label?.groupId) continue
    const group = groupById.get(label.groupId)
    if (!group || group.selectionMode !== 'single') continue
    if (used.has(group.id)) throw new Error(`「${group.name}」は1つだけ選択できます`)
    used.add(group.id)
  }
}

export async function validateLabelsForOwner(labels: string[]) {
  const settings = await ensureSettings()
  const [groups, definitions] = await Promise.all([
    db.labelGroups.where('ownerId').equals(settings.profileId).toArray(),
    db.labelDefinitions.where('ownerId').equals(settings.profileId).toArray()
  ])
  validateLabelSelection(labels, groups, definitions)
}
