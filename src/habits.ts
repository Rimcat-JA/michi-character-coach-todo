import { db, ensureSettings } from './db'
import { today, uid, validateDate, type Habit, type HabitLog, type Task } from './domain'

const amountValid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1000000

export async function createHabit(input: Pick<Habit, 'title' | 'direction' | 'unit' | 'targetAmount' | 'cadence' | 'weekdays' | 'timezone' | 'routineId'>): Promise<string> {
  const title = input.title.trim(), unit = input.unit.trim()
  if (!title || title.length > 100 || !unit || unit.length > 30) throw new Error('習慣名と単位を入力してください')
  if (!['increase', 'decrease'].includes(input.direction) || !['daily', 'weekly', 'monthly'].includes(input.cadence) || !amountValid(input.targetAmount)) throw new Error('習慣の目標が不正です')
  if (!Array.isArray(input.weekdays) || new Set(input.weekdays).size !== input.weekdays.length || input.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('対象曜日が不正です')
  try { new Intl.DateTimeFormat('ja-JP', { timeZone: input.timezone }) } catch { throw new Error('timezoneが不正です') }
  return db.transaction('rw', [db.habits, db.routines, db.settings], async () => {
    const settings = await ensureSettings()
    if (input.routineId && !await db.routines.get(input.routineId)) throw new Error('関連ルーティンがありません')
    const id = uid(), at = new Date().toISOString()
    await db.habits.add({ ...input, id, ownerId: settings.profileId, title, unit, active: true, createdAt: at, updatedAt: at })
    return id
  })
}

export async function recordHabitLog(habitId: string, date: string, amount: number, reason = '本人が記録'): Promise<string> {
  validateDate(date, '記録日')
  if (!amountValid(amount)) throw new Error('記録量は0〜1000000で指定してください')
  if (!reason.trim() || reason.length > 300) throw new Error('訂正理由を入力してください')
  return db.transaction('rw', [db.habits, db.habitLogs, db.tasks, db.settings], async () => {
    const habit = await db.habits.get(habitId), settings = await db.settings.get('main')
    if (!habit || !settings || habit.ownerId !== settings.profileId || !habit.active) throw new Error('習慣がありません')
    const task = habit.routineId ? (await db.tasks.where('routineId').equals(habit.routineId).toArray()).find(item => !item.deletedAt && item.scheduledDate === date) : undefined
    const id = `${habitId}:${date}`, at = new Date().toISOString(), old = await db.habitLogs.get(id)
    if (old?.amount === amount) return id
    const history = old ? [...old.history, { amount: old.amount, at: old.updatedAt, reason }] : []
    await db.habitLogs.put({ id, habitId, date, amount, source: 'manual', taskId: task?.id ?? null, revision: (old?.revision ?? 0) + 1, updatedAt: at, history })
    return id
  })
}

export function habitWindow(habit: Habit, date: string): { start: string; end: string } {
  validateDate(date, '対象日')
  if (habit.cadence === 'daily') return { start: date, end: date }
  const day = new Date(`${date}T12:00:00`)
  if (habit.cadence === 'weekly') {
    const offset = (day.getDay() + 6) % 7
    day.setDate(day.getDate() - offset)
    const start = today(day)
    day.setDate(day.getDate() + 6)
    return { start, end: today(day) }
  }
  const start = `${date.slice(0, 7)}-01`
  day.setMonth(day.getMonth() + 1, 0)
  return { start, end: today(day) }
}

export function habitProgress(habit: Habit, date: string, logs: HabitLog[], tasks: Task[]): { amount: number | null; metTarget: boolean; linkedTaskCompleted: boolean; achievementKey: string } {
  const window = habitWindow(habit, date)
  const matching = logs.filter(log => log.habitId === habit.id && log.date >= window.start && log.date <= window.end)
  const amount = matching.length ? matching.reduce((sum, log) => sum + log.amount, 0) : null
  const linkedTaskCompleted = !!habit.routineId && tasks.some(task => task.routineId === habit.routineId && task.scheduledDate !== null && task.scheduledDate >= window.start && task.scheduledDate <= window.end && task.status === 'completed' && !task.deletedAt)
  return { amount, metTarget: amount !== null && (habit.direction === 'increase' ? amount >= habit.targetAmount : amount <= habit.targetAmount), linkedTaskCompleted, achievementKey: `habit:${habit.id}:${window.start}` }
}
