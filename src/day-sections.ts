import { db } from './db'
import { uid, type Settings, type Task, type TimeBlock } from './domain'

export type DaySectionMode = NonNullable<Settings['daySectionMode']>
export type DaySection = { key: string; label: string; tasks: Task[] }

function blockLabel(block: TimeBlock) {
  const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  return `${hhmm(block.startMinute)}–${hhmm(block.endMinute)} ${block.category}`
}

export function groupTodayTasks(tasks: Task[], mode: DaySectionMode, date: string, blocks: TimeBlock[]) {
  const unique = [...new Map(tasks.map(task => [task.id, task])).values()]
  const dayBlocks = blocks.filter(block => block.date === date).sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id))
  const groups = new Map<string, DaySection>()
  for (const task of unique) {
    const block = mode === 'timeblock' ? dayBlocks.find(item => item.taskIds.includes(task.id)) : undefined
    const key = mode === 'halfday' ? (task.dayHalf ?? 'none') : mode === 'category' ? (task.project || '未分類') : mode === 'timeblock' ? (block?.id ?? 'none') : (task.customSection?.trim() || '未分類')
    const label = mode === 'halfday' ? ({ morning: '午前', afternoon: '午後', none: '未指定' }[key] ?? '未指定') : mode === 'timeblock' ? (block ? blockLabel(block) : '時間枠なし') : key
    if (!groups.has(key)) groups.set(key, { key, label, tasks: [] })
    groups.get(key)!.tasks.push(task)
  }
  const sections = [...groups.values()].sort((a, b) => {
    if (mode === 'halfday') return ['morning', 'afternoon', 'none'].indexOf(a.key) - ['morning', 'afternoon', 'none'].indexOf(b.key)
    if (mode === 'timeblock') return (dayBlocks.findIndex(block => block.id === a.key) + 1 || 999) - (dayBlocks.findIndex(block => block.id === b.key) + 1 || 999)
    return a.label.localeCompare(b.label, 'ja')
  })
  return { sections, taskIds: unique.map(task => task.id), points: unique.reduce((sum, task) => sum + (task.effectivePoints ?? 0), 0), unknownPoints: unique.filter(task => task.effectivePoints === null).length }
}

export async function setDaySectionMode(mode: DaySectionMode) {
  if (!['halfday', 'category', 'timeblock', 'custom'].includes(mode)) throw new Error('表示区分が不正です')
  await db.settings.update('main', { daySectionMode: mode })
}

export async function assignDaySection(taskId: string, expectedRevision: number, field: 'dayHalf' | 'customSection', value: string | null) {
  if (field === 'dayHalf' && value !== null && value !== 'morning' && value !== 'afternoon') throw new Error('午前午後の指定が不正です')
  if (field === 'customSection' && value !== null && (!value.trim() || value.length > 60)) throw new Error('カスタム区分は1〜60文字にしてください')
  await db.transaction('rw', db.tasks, db.audits, async () => {
    const task = await db.tasks.get(taskId)
    if (!task || task.deletedAt || task.status !== 'open') throw new Error('タスクがありません')
    if (task.revision !== expectedRevision) throw new Error('別の画面で更新されました')
    const at = new Date().toISOString()
    await db.tasks.put({ ...task, [field]: field === 'customSection' ? value?.trim() ?? null : value, revision: task.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId, operation: 'day_section', at, detail: `${field}=${value ?? '未指定'}` })
  })
}
