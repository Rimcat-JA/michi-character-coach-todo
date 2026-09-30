import { createTask, updateTask, type TaskInput } from './commands'
import { db } from './db'
import { uid, type Audit, type ScoreInput, type Task } from './domain'
import { scoreAttributeKeys, type ScoreAcceptanceProvenance } from './score-assist'

export type SavedScoreProvenance = ScoreAcceptanceProvenance & { assessmentId: string }

export function finalScoreProvenance(score: ScoreInput, accepted: ScoreAcceptanceProvenance): ScoreAcceptanceProvenance {
  const fields = accepted.fields.map(field => score[field.field] === field.value ? field : { ...field, value: score[field.field], origin: 'human' as const, evidence: null })
  return { ...accepted, fields, estimated: fields.some(field => field.origin === 'ai_estimate') }
}

export function assessmentProvenance(audits: Audit[], assessmentId: string | undefined): SavedScoreProvenance | null {
  if (!assessmentId) return null
  for (const audit of [...audits].sort((a, b) => b.at.localeCompare(a.at))) {
    if (audit.operation !== 'score.ai_attributes') continue
    try {
      const record = JSON.parse(audit.detail) as SavedScoreProvenance
      if (record.assessmentId === assessmentId && record.ruleVersion === 'v1' && typeof record.model === 'string' && typeof record.sourceText === 'string' && typeof record.estimated === 'boolean' && Array.isArray(record.fields) && record.fields.every(field => scoreAttributeKeys.includes(field.field) && ['human', 'ai_estimate'].includes(field.origin) && (field.evidence === null || typeof field.evidence === 'string'))) return record
    } catch { /* Older audit descriptions are plain text. */ }
  }
  return null
}

export async function saveTaskWithScoreProvenance(task: Task | null, input: TaskInput, accepted: ScoreAcceptanceProvenance | null): Promise<string> {
  return db.transaction('rw', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions], async () => {
    const id = task ? await updateTask(task.id, task.revision, input) : await createTask(input)
    if (accepted) {
      const saved = await db.tasks.get(id)
      if (!saved) throw new Error('保存したタスクが見つかりません')
      const provenance: SavedScoreProvenance = { ...finalScoreProvenance(input.score, accepted), assessmentId: saved.assessmentId }
      await db.audits.add({ id: uid(), taskId: id, operation: 'score.ai_attributes', at: new Date().toISOString(), detail: JSON.stringify(provenance) })
    }
    return id
  })
}
