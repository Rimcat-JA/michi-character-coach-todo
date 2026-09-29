import { newTaskInput, type TaskInput } from './commands'
import { emptyScore, validateDate, validateTaskInput } from './domain'

export type QuickAddResult = { ok: true; input: TaskInput } | { ok: false; error: string }

export function parseQuickAddLine(raw: string): QuickAddResult {
  const input = newTaskInput()
  const title: string[] = []
  const seen = new Set<string>()
  try {
    for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
      let field: string | null = null
      if (token.startsWith('#')) {
        field = 'project'
        if (token.length < 2) throw new Error('「#」の後にプロジェクト名を入力してください')
        input.project = token.slice(1)
      } else if (token.startsWith('@')) {
        field = 'scheduledDate'
        input.scheduledDate = token.slice(1)
        validateDate(input.scheduledDate, '予定日')
      } else if (token.startsWith('!')) {
        field = 'dueDate'
        if (!token.startsWith('!due:')) throw new Error(`不明な期限構文: ${token}`)
        input.dueDate = token.slice(5)
        validateDate(input.dueDate, '締め切り')
      } else if (token.startsWith('~')) {
        field = 'minutes'
        if (!/^~\d+m$/.test(token)) throw new Error(`所要時間の構文が不正です: ${token}`)
        input.score.minutes = Number(token.slice(1, -1))
      } else if (token.startsWith('pt:')) {
        field = 'points'
        if (!/^pt:\d+$/.test(token)) throw new Error(`ポイントの構文が不正です: ${token}`)
        input.score = { ...emptyScore(), mode: 'manual', manualPoints: Number(token.slice(3)), minutes: input.score.minutes }
      } else {
        title.push(token)
      }
      if (field) {
        if (seen.has(field)) throw new Error(`${field}が重複しています`)
        seen.add(field)
      }
    }
    input.title = title.join(' ')
    validateTaskInput(input)
    return { ok: true, input }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function parseBraindump(raw: string) {
  const lines = raw.split(/\r?\n/).map((text, index) => ({ line: index + 1, text: text.trim() })).filter(row => row.text)
  if (lines.length > 100) throw new Error('一括入力は100行までです。分けて登録してください')
  return lines.map(row => ({ ...row, result: parseQuickAddLine(row.text) }))
}

export function setQuickAddPoints(input: TaskInput, value: string): QuickAddResult {
  if (!value.trim()) return { ok: true, input: { ...input, score: { ...input.score, mode: 'unset', manualPoints: null } } }
  if (!/^\d+$/.test(value.trim())) return { ok: false, error: '手動ポイントは0〜100000の整数にしてください' }
  const points = Number(value.trim())
  const updated: TaskInput = { ...input, score: { ...input.score, mode: 'manual', manualPoints: points } }
  try {
    validateTaskInput(updated)
    return { ok: true, input: updated }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
