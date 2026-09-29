import { assignTaskToTimeBlock } from './calendar-planning'
import { bulkUpdateTasksAtomic } from './commands'
import { validateDate, type Task, type TimeBlock } from './domain'

export type DrawerMove = { taskId: string; taskRevision: number; title: string; fromDate: string | null; toDate: string; blockId: string | null; blockRevision: number | null; blockLabel: string | null; externalWrite: false }

export function groupDrawerTasks(tasks: Task[], date: string) {
  const open = tasks.filter(task => !task.deletedAt && task.status === 'open')
  return {
    overdue: open.filter(task => task.dueDate && task.dueDate < date),
    unscheduled: open.filter(task => !task.scheduledDate && !(task.dueDate && task.dueDate < date)),
    planned: open.filter(task => !!task.scheduledDate && !(task.dueDate && task.dueDate < date))
  }
}

export function previewDrawerMove(task: Task, date: string, block: TimeBlock | null = null): DrawerMove {
  validateDate(date, '移動先の日付')
  if (task.deletedAt || task.status !== 'open') throw new Error('未完了タスクだけ移動できます')
  if (block && (block.date !== date || block.closed)) throw new Error('移動先の時間枠が不正です')
  return { taskId: task.id, taskRevision: task.revision, title: task.title, fromDate: task.scheduledDate, toDate: date, blockId: block?.id ?? null, blockRevision: block?.revision ?? null, blockLabel: block ? `${String(Math.floor(block.startMinute / 60)).padStart(2, '0')}:${String(block.startMinute % 60).padStart(2, '0')}〜${String(Math.floor(block.endMinute / 60)).padStart(2, '0')}:${String(block.endMinute % 60).padStart(2, '0')} ${block.category}` : null, externalWrite: false }
}

export async function applyDrawerMove(plan: DrawerMove) {
  if (plan.externalWrite !== false) throw new Error('外部カレンダーへの書込には別途承認が必要です')
  if (plan.blockId) await assignTaskToTimeBlock(plan.blockId, plan.blockRevision!, plan.taskId, plan.taskRevision)
  else await bulkUpdateTasksAtomic([{ id: plan.taskId, revision: plan.taskRevision }], { scheduledDate: plan.toDate })
}
